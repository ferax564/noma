export const AWS_EU_REGION = "eu-central-1";
export const AWS_EU_ALLOWED_REGIONS = ["eu-central-1", "eu-west-1", "eu-south-1"] as const;

export interface AwsEuReference {
  region: string;
  kmsKeyAlias: string;
  rdsEncrypted: boolean;
  s3PublicAccessBlocked: boolean;
  secretsManager: boolean;
  /** Bedrock inference profile IDs the app may call. Empty unless the operator supplies one. */
  bedrockAllowedProfiles: string[];
  processes: Array<"app" | "realtime" | "worker">;
}

export interface AwsEuReferenceOptions {
  bedrockInferenceProfileId?: string;
}

export function awsEuReferenceStack(options: AwsEuReferenceOptions = {}): AwsEuReference {
  return {
    region: AWS_EU_REGION,
    kmsKeyAlias: "alias/noma-enterprise-eu",
    rdsEncrypted: true,
    s3PublicAccessBlocked: true,
    secretsManager: true,
    bedrockAllowedProfiles: options.bedrockInferenceProfileId ? [options.bedrockInferenceProfileId] : [],
    processes: ["app", "realtime", "worker"],
  };
}

/** `Fn::Sub` with `#{Name}` placeholders, rewritten to `${Name}` (keeps `${` out of plain string literals). */
const sub = (template: string): { "Fn::Sub": string } => ({ "Fn::Sub": template.replace(/#\{/g, "$" + "{") });
const ref = (name: string): { Ref: string } => ({ Ref: name });

/**
 * Deployable CloudFormation for the EU reference stack: a rotating KMS CMK,
 * a TLS-only SSE-KMS S3 bucket, an encrypted Multi-AZ PostgreSQL instance in
 * caller-supplied private subnets with an RDS-managed master password, an
 * application secret, and an optional Bedrock invoke policy scoped to one
 * inference profile. A `Rules` assertion refuses non-EU regions.
 */
export function awsEuCloudFormation(): Record<string, unknown> {
  const stack = awsEuReferenceStack();
  const profileArn =
    "arn:#{AWS::Partition}:bedrock:#{AWS::Region}:#{AWS::AccountId}:inference-profile/#{BedrockInferenceProfileId}";
  return {
    AWSTemplateFormatVersion: "2010-09-09",
    Description: "Noma enterprise AWS/EU reference: KMS, encrypted Multi-AZ RDS PostgreSQL, private S3, Secrets Manager",
    Parameters: {
      VpcId: { Type: "AWS::EC2::VPC::Id", Description: "VPC that hosts the database" },
      PrivateSubnetIds: {
        Type: "List<AWS::EC2::Subnet::Id>",
        Description: "At least two private subnets in different AZs for the DB subnet group",
      },
      AppSecurityGroupId: {
        Type: "AWS::EC2::SecurityGroup::Id",
        Description: "Security group of the app/realtime/worker tasks allowed to reach PostgreSQL",
      },
      KmsKeyAliasName: {
        Type: "String",
        Default: stack.kmsKeyAlias,
        AllowedPattern: "^alias/[a-zA-Z0-9/_-]+$",
      },
      DbInstanceClass: { Type: "String", Default: "db.m7g.large", AllowedPattern: "^db\\.[a-z0-9]+\\.[a-z0-9]+$" },
      DbAllocatedStorage: { Type: "Number", Default: "100", MinValue: 20, MaxValue: 65536 },
      DbEngineVersion: { Type: "String", Default: "16.6", AllowedPattern: "^[0-9]+(\\.[0-9]+)?$" },
      DbName: { Type: "String", Default: "noma", AllowedPattern: "^[a-zA-Z][a-zA-Z0-9_]{0,62}$" },
      DbMasterUsername: { Type: "String", Default: "noma_admin", AllowedPattern: "^[a-zA-Z][a-zA-Z0-9_]{0,62}$" },
      DbBackupRetentionDays: { Type: "Number", Default: "14", MinValue: 1, MaxValue: 35 },
      BedrockInferenceProfileId: {
        Type: "String",
        Default: "",
        Description: "Optional Bedrock inference profile ID (e.g. an eu.* profile). Empty disables the Bedrock policy.",
        AllowedPattern: "^[a-zA-Z0-9._:-]*$",
      },
    },
    Rules: {
      EuRegionOnly: {
        Assertions: [
          {
            Assert: { "Fn::Contains": [[...AWS_EU_ALLOWED_REGIONS], ref("AWS::Region")] },
            AssertDescription: `Deploy only to ${AWS_EU_ALLOWED_REGIONS.join(", ")}`,
          },
        ],
      },
    },
    Conditions: {
      HasBedrockProfile: { "Fn::Not": [{ "Fn::Equals": [ref("BedrockInferenceProfileId"), ""] }] },
    },
    Resources: {
      EnterpriseKey: {
        Type: "AWS::KMS::Key",
        DeletionPolicy: "Retain",
        UpdateReplacePolicy: "Retain",
        Properties: {
          Description: "Noma enterprise CMK",
          EnableKeyRotation: true,
          KeyPolicy: {
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "AccountAdministration",
                Effect: "Allow",
                Principal: { AWS: sub("arn:#{AWS::Partition}:iam::#{AWS::AccountId}:root") },
                Action: "kms:*",
                Resource: "*",
              },
            ],
          },
        },
      },
      EnterpriseKeyAlias: {
        Type: "AWS::KMS::Alias",
        Properties: { AliasName: ref("KmsKeyAliasName"), TargetKeyId: ref("EnterpriseKey") },
      },
      AssetsBucket: {
        Type: "AWS::S3::Bucket",
        DeletionPolicy: "Retain",
        UpdateReplacePolicy: "Retain",
        Properties: {
          BucketEncryption: {
            ServerSideEncryptionConfiguration: [
              {
                ServerSideEncryptionByDefault: { SSEAlgorithm: "aws:kms", KMSMasterKeyID: { "Fn::GetAtt": ["EnterpriseKey", "Arn"] } },
                BucketKeyEnabled: true,
              },
            ],
          },
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: true,
            BlockPublicPolicy: true,
            IgnorePublicAcls: true,
            RestrictPublicBuckets: true,
          },
          OwnershipControls: { Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }] },
          VersioningConfiguration: { Status: "Enabled" },
        },
      },
      AssetsBucketPolicy: {
        Type: "AWS::S3::BucketPolicy",
        Properties: {
          Bucket: ref("AssetsBucket"),
          PolicyDocument: {
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "DenyInsecureTransport",
                Effect: "Deny",
                Principal: "*",
                Action: "s3:*",
                Resource: [{ "Fn::GetAtt": ["AssetsBucket", "Arn"] }, sub("#{AssetsBucket.Arn}/*")],
                Condition: { Bool: { "aws:SecureTransport": "false" } },
              },
            ],
          },
        },
      },
      DatabaseSubnetGroup: {
        Type: "AWS::RDS::DBSubnetGroup",
        Properties: {
          DBSubnetGroupDescription: "Noma enterprise private database subnets",
          SubnetIds: ref("PrivateSubnetIds"),
        },
      },
      DatabaseSecurityGroup: {
        Type: "AWS::EC2::SecurityGroup",
        Properties: {
          GroupDescription: "Noma enterprise PostgreSQL: app tasks only",
          VpcId: ref("VpcId"),
          SecurityGroupIngress: [
            { IpProtocol: "tcp", FromPort: 5432, ToPort: 5432, SourceSecurityGroupId: ref("AppSecurityGroupId") },
          ],
        },
      },
      Database: {
        Type: "AWS::RDS::DBInstance",
        DeletionPolicy: "Snapshot",
        UpdateReplacePolicy: "Snapshot",
        Properties: {
          Engine: "postgres",
          EngineVersion: ref("DbEngineVersion"),
          DBInstanceClass: ref("DbInstanceClass"),
          AllocatedStorage: ref("DbAllocatedStorage"),
          StorageType: "gp3",
          DBName: ref("DbName"),
          MasterUsername: ref("DbMasterUsername"),
          ManageMasterUserPassword: true,
          MasterUserSecret: { KmsKeyId: ref("EnterpriseKey") },
          DBSubnetGroupName: ref("DatabaseSubnetGroup"),
          VPCSecurityGroups: [ref("DatabaseSecurityGroup")],
          StorageEncrypted: true,
          KmsKeyId: ref("EnterpriseKey"),
          MultiAZ: true,
          PubliclyAccessible: false,
          BackupRetentionPeriod: ref("DbBackupRetentionDays"),
          DeletionProtection: true,
          CopyTagsToSnapshot: true,
          AutoMinorVersionUpgrade: true,
          EnableIAMDatabaseAuthentication: true,
        },
      },
      AppSecret: {
        Type: "AWS::SecretsManager::Secret",
        Properties: {
          Name: sub("#{AWS::StackName}/noma/enterprise/app"),
          Description: "Noma enterprise application signing material",
          KmsKeyId: ref("EnterpriseKey"),
          GenerateSecretString: {
            SecretStringTemplate: "{}",
            GenerateStringKey: "sessionSigningKey",
            PasswordLength: 64,
            ExcludePunctuation: true,
          },
        },
      },
      BedrockInvokePolicy: {
        Type: "AWS::IAM::ManagedPolicy",
        Condition: "HasBedrockProfile",
        Properties: {
          Description: "Invoke only the configured EU Bedrock inference profile",
          PolicyDocument: {
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "InvokeInferenceProfile",
                Effect: "Allow",
                Action: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
                Resource: sub(profileArn),
              },
              {
                Sid: "InvokeModelsBehindProfile",
                Effect: "Allow",
                Action: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
                Resource: sub("arn:#{AWS::Partition}:bedrock:eu-*::foundation-model/*"),
                Condition: { StringEquals: { "bedrock:InferenceProfileArn": sub(profileArn) } },
              },
            ],
          },
        },
      },
    },
    Outputs: {
      Region: { Value: ref("AWS::Region") },
      KmsKeyArn: { Value: { "Fn::GetAtt": ["EnterpriseKey", "Arn"] } },
      AssetsBucketName: { Value: ref("AssetsBucket") },
      DatabaseEndpoint: { Value: { "Fn::GetAtt": ["Database", "Endpoint.Address"] } },
      DatabaseMasterSecretArn: { Value: { "Fn::GetAtt": ["Database", "MasterUserSecret.SecretArn"] } },
      AppSecretArn: { Value: ref("AppSecret") },
      BedrockInvokePolicyArn: { Condition: "HasBedrockProfile", Value: ref("BedrockInvokePolicy") },
    },
  };
}

/**
 * Properties CloudFormation requires (or this stack treats as mandatory) per
 * resource type. The self-check fails on any resource type missing here, so
 * adding a new resource forces a decision about its required properties.
 */
export const AWS_REQUIRED_PROPERTIES: Readonly<Record<string, readonly string[]>> = {
  "AWS::KMS::Key": ["KeyPolicy", "EnableKeyRotation"],
  "AWS::KMS::Alias": ["AliasName", "TargetKeyId"],
  "AWS::S3::Bucket": ["BucketEncryption", "PublicAccessBlockConfiguration"],
  "AWS::S3::BucketPolicy": ["Bucket", "PolicyDocument"],
  "AWS::RDS::DBSubnetGroup": ["DBSubnetGroupDescription", "SubnetIds"],
  "AWS::EC2::SecurityGroup": ["GroupDescription", "VpcId"],
  "AWS::RDS::DBInstance": [
    "Engine",
    "EngineVersion",
    "DBInstanceClass",
    "AllocatedStorage",
    "MasterUsername",
    "DBSubnetGroupName",
    "VPCSecurityGroups",
    "StorageEncrypted",
    "KmsKeyId",
  ],
  "AWS::SecretsManager::Secret": ["KmsKeyId"],
  "AWS::IAM::ManagedPolicy": ["PolicyDocument"],
};

const PSEUDO_PARAMETERS = new Set([
  "AWS::AccountId",
  "AWS::NotificationARNs",
  "AWS::NoValue",
  "AWS::Partition",
  "AWS::Region",
  "AWS::StackId",
  "AWS::StackName",
  "AWS::URLSuffix",
]);

type ResourceMap = Record<string, { Type?: string; Condition?: string; Properties?: Record<string, unknown> }>;

function collectReferences(value: unknown, refs: Set<string>, getAtts: Set<string>, subs: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectReferences(item, refs, getAtts, subs);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, inner] of Object.entries(value)) {
    if (key === "Ref" && typeof inner === "string") refs.add(inner);
    else if (key === "Fn::GetAtt" && Array.isArray(inner) && typeof inner[0] === "string") getAtts.add(inner[0]);
    else if (key === "Fn::Sub" && typeof inner === "string") {
      for (const match of inner.matchAll(/\$\{([^}!][^}]*)\}/g)) {
        const name = match[1] ?? "";
        subs.add(name.split(".")[0] ?? name);
      }
    }
    collectReferences(inner, refs, getAtts, subs);
  }
}

function isPresent(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/** Static self-check of the reference template. Returns human-readable findings; empty means pass. */
export function assertAwsEuStack(template: Record<string, unknown>): string[] {
  const findings: string[] = [];
  const resources = (template.Resources ?? {}) as ResourceMap;
  const parameters = (template.Parameters ?? {}) as Record<string, { Type?: string; Default?: unknown }>;
  const conditions = (template.Conditions ?? {}) as Record<string, unknown>;

  for (const [name, resource] of Object.entries(resources)) {
    const required = resource.Type ? AWS_REQUIRED_PROPERTIES[resource.Type] : undefined;
    if (!required) {
      findings.push(`${name}: resource type ${resource.Type ?? "(missing)"} has no required-property contract`);
      continue;
    }
    for (const property of required) {
      if (!isPresent(resource.Properties?.[property])) findings.push(`${name}: missing required property ${property}`);
    }
    if (resource.Condition && !(resource.Condition in conditions)) {
      findings.push(`${name}: unknown condition ${resource.Condition}`);
    }
  }

  const refs = new Set<string>();
  const getAtts = new Set<string>();
  const subs = new Set<string>();
  collectReferences({ Resources: template.Resources, Outputs: template.Outputs, Conditions: template.Conditions, Rules: template.Rules }, refs, getAtts, subs);
  for (const name of [...refs, ...subs]) {
    if (!(name in resources) && !(name in parameters) && !PSEUDO_PARAMETERS.has(name)) findings.push(`unresolved reference ${name}`);
  }
  for (const name of getAtts) {
    if (!(name in resources)) findings.push(`Fn::GetAtt targets unknown resource ${name}`);
  }

  const key = resources.EnterpriseKey;
  if (!key || key.Type !== "AWS::KMS::Key") findings.push("missing KMS CMK");
  if (key?.Properties?.EnableKeyRotation !== true) findings.push("KMS key rotation is disabled");

  const bucket = resources.AssetsBucket?.Properties as
    | {
        PublicAccessBlockConfiguration?: Record<string, boolean>;
        BucketEncryption?: { ServerSideEncryptionConfiguration?: Array<{ ServerSideEncryptionByDefault?: { SSEAlgorithm?: string } }> };
      }
    | undefined;
  const block = bucket?.PublicAccessBlockConfiguration;
  if (!block?.BlockPublicAcls || !block.BlockPublicPolicy || !block.IgnorePublicAcls || !block.RestrictPublicBuckets) {
    findings.push("S3 is not fully blocked from public access");
  }
  const sse = bucket?.BucketEncryption?.ServerSideEncryptionConfiguration?.[0]?.ServerSideEncryptionByDefault?.SSEAlgorithm;
  if (sse !== "aws:kms") findings.push("S3 is not encrypted with SSE-KMS");

  const db = resources.Database?.Properties as
    | {
        StorageEncrypted?: boolean;
        PubliclyAccessible?: boolean;
        MultiAZ?: boolean;
        KmsKeyId?: unknown;
        ManageMasterUserPassword?: boolean;
        MasterUserPassword?: unknown;
        AllocatedStorage?: unknown;
      }
    | undefined;
  if (!db) findings.push("missing RDS database");
  if (!db?.StorageEncrypted) findings.push("RDS storage is not encrypted");
  if (db?.PubliclyAccessible !== false) findings.push("RDS is publicly accessible");
  if (!db?.MultiAZ) findings.push("RDS is not Multi-AZ");
  if (!db?.KmsKeyId) findings.push("RDS is not using the customer KMS key");
  const password = db?.MasterUserPassword;
  const dynamicSecret = typeof password === "string" && password.startsWith("{{resolve:secretsmanager:");
  if (db?.ManageMasterUserPassword !== true && !dynamicSecret) {
    findings.push("RDS master password is neither RDS-managed nor a Secrets Manager dynamic reference");
  }
  if (db?.ManageMasterUserPassword === true && password !== undefined) {
    findings.push("RDS sets both ManageMasterUserPassword and MasterUserPassword");
  }
  if (typeof password === "string" && !dynamicSecret) findings.push("RDS master password is a plaintext literal");
  const storage = db?.AllocatedStorage;
  if (typeof storage === "number" && storage < 20) findings.push("RDS AllocatedStorage is below the 20 GiB PostgreSQL minimum");

  if (!resources.AppSecret || resources.AppSecret.Type !== "AWS::SecretsManager::Secret") {
    findings.push("missing Secrets Manager secret");
  }
  const rule = JSON.stringify((template.Rules as Record<string, unknown> | undefined) ?? {});
  if (!rule.includes('"AWS::Region"') || AWS_EU_ALLOWED_REGIONS.some((region) => !rule.includes(`"${region}"`))) {
    findings.push("stack does not assert the EU region allowlist");
  }
  const bedrockDefault = parameters.BedrockInferenceProfileId?.Default;
  if (typeof bedrockDefault === "string" && bedrockDefault !== "") {
    findings.push("Bedrock inference profile is hard-coded; it must be supplied as a parameter");
  }
  if (JSON.stringify(template).match(/inference-profile\/(?!\$\{)/)) {
    findings.push("template embeds a literal Bedrock inference profile ARN");
  }
  return findings;
}
