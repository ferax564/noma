export const AWS_EU_REGION = "eu-central-1";
export const AWS_EU_ALLOWED_REGIONS = ["eu-central-1", "eu-west-1", "eu-south-1"] as const;

export interface AwsEuReference {
  region: string;
  kmsKeyAlias: string;
  rdsEncrypted: boolean;
  s3PublicAccessBlocked: boolean;
  secretsManager: boolean;
  bedrockAllowedProfiles: string[];
  processes: Array<"app" | "realtime" | "worker">;
}

export function awsEuReferenceStack(): AwsEuReference {
  return {
    region: AWS_EU_REGION,
    kmsKeyAlias: "alias/noma-enterprise-eu",
    rdsEncrypted: true,
    s3PublicAccessBlocked: true,
    secretsManager: true,
    bedrockAllowedProfiles: ["eu.anthropic.claude-sonnet-4"],
    processes: ["app", "realtime", "worker"],
  };
}

export function awsEuCloudFormation(): Record<string, unknown> {
  const stack = awsEuReferenceStack();
  const accountRootArn = "arn:aws:iam::${" + "AWS::AccountId}:root";
  return {
    AWSTemplateFormatVersion: "2010-09-09",
    Description: "Noma enterprise AWS/EU reference: KMS, encrypted RDS, private S3, Secrets Manager",
    Parameters: {
      Region: { Type: "String", Default: stack.region, AllowedValues: [...AWS_EU_ALLOWED_REGIONS] },
    },
    Resources: {
      EnterpriseKey: {
        Type: "AWS::KMS::Key",
        Properties: {
          Description: "Noma enterprise CMK",
          EnableKeyRotation: true,
          KeyPolicy: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: { "Fn::Sub": accountRootArn } }, Action: "kms:*", Resource: "*" }] },
        },
      },
      EnterpriseKeyAlias: {
        Type: "AWS::KMS::Alias",
        Properties: { AliasName: stack.kmsKeyAlias, TargetKeyId: { Ref: "EnterpriseKey" } },
      },
      AssetsBucket: {
        Type: "AWS::S3::Bucket",
        Properties: {
          BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: "aws:kms", KMSMasterKeyID: { Ref: "EnterpriseKey" } } }] },
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: true,
            BlockPublicPolicy: true,
            IgnorePublicAcls: true,
            RestrictPublicBuckets: true,
          },
        },
      },
      Database: {
        Type: "AWS::RDS::DBInstance",
        Properties: {
          Engine: "postgres",
          StorageEncrypted: true,
          KmsKeyId: { Ref: "EnterpriseKey" },
          MultiAZ: true,
          PubliclyAccessible: false,
        },
      },
      AppSecret: {
        Type: "AWS::SecretsManager::Secret",
        Properties: { Name: "noma/enterprise/app", KmsKeyId: { Ref: "EnterpriseKey" } },
      },
    },
    Outputs: {
      Region: { Value: { Ref: "Region" } },
    },
  };
}

export function assertAwsEuStack(template: Record<string, unknown>): string[] {
  const findings: string[] = [];
  const resources = (template.Resources ?? {}) as Record<string, { Type?: string; Properties?: Record<string, unknown> }>;
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
  const db = resources.Database?.Properties as {
    StorageEncrypted?: boolean;
    PubliclyAccessible?: boolean;
    MultiAZ?: boolean;
    KmsKeyId?: unknown;
  } | undefined;
  if (!db?.StorageEncrypted) findings.push("RDS storage is not encrypted");
  if (db?.PubliclyAccessible) findings.push("RDS is publicly accessible");
  if (!db?.MultiAZ) findings.push("RDS is not Multi-AZ");
  if (!db?.KmsKeyId) findings.push("RDS is not using the customer KMS key");
  if (!resources.AppSecret || resources.AppSecret.Type !== "AWS::SecretsManager::Secret") {
    findings.push("missing Secrets Manager secret");
  }
  const region = (template.Parameters as { Region?: { Default?: string } } | undefined)?.Region?.Default;
  if (region && !AWS_EU_ALLOWED_REGIONS.includes(region as (typeof AWS_EU_ALLOWED_REGIONS)[number])) {
    findings.push("stack default region is outside the EU allowlist");
  }
  return findings;
}
