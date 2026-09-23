/**
 * Page templates and blueprints: built-in templates plus workspace- and
 * space-scoped templates stored in `page_templates`, with declared
 * `{{variable}}` placeholders filled (and escaped) at page creation.
 */
import type { CloudPageTemplateRecord, CloudTemplateVariable, CloudUserRecord } from "../cloud-db.js";
import {
  builtInTemplateValues,
  cloudPageTemplates,
  instantiateTemplateSource,
  MAX_TEMPLATE_VALUE_LENGTH,
  RESERVED_TEMPLATE_VARIABLES,
  TEMPLATE_VARIABLE_NAME_RE,
  templatePlaceholders,
} from "../cloud-templates.js";
import type { CloudServerConfig } from "./context.js";
import { HttpError } from "./http.js";
import { optionalRecord, optionalString } from "./input.js";

export const MAX_TEMPLATE_SOURCE_BYTES = 200_000;
export const MAX_TEMPLATE_VARIABLES = 30;

/** A template ready to instantiate into a new page. */
export interface CreateTemplate {
  id: string;
  title: string;
  variables: CloudTemplateVariable[];
  instantiate(title: string, spaceTitle: string, rawValues: unknown, author: CloudUserRecord): string;
}

/**
 * Look up `templateId` for page creation. Built-ins are available everywhere,
 * workspace templates to every signed-in user, and space templates only when
 * creating a page inside that space.
 */
export function resolveCreateTemplate(config: CloudServerConfig, templateId: unknown, siteId: string | undefined): CreateTemplate | undefined {
  if (templateId === undefined || templateId === null || templateId === "") return undefined;
  if (typeof templateId !== "string") throw new HttpError(400, "templateId must be a string");
  const today = config.now().toISOString().slice(0, 10);
  const builtIn = cloudPageTemplates.find((candidate) => candidate.id === templateId);
  if (builtIn) {
    return {
      id: builtIn.id,
      title: builtIn.title,
      variables: [],
      instantiate: (title, spaceTitle, _raw, author) =>
        instantiateTemplateSource(builtIn.source, builtInTemplateValues(title, spaceTitle, { date: today, author: author.name })),
    };
  }
  const stored = /^[A-Za-z0-9_-]{8,80}$/.test(templateId) ? config.store.readPageTemplate(templateId) : undefined;
  if (!stored || (stored.scope === "site" && stored.siteId !== siteId)) throw new HttpError(400, "Unknown page template");
  if (stored.siteId && config.store.isTrashed("site", stored.siteId)) throw new HttpError(400, "Unknown page template");
  return {
    id: stored.id,
    title: stored.name,
    variables: stored.variables,
    instantiate: (title, spaceTitle, raw, author) => {
      const values = templateValues(stored.variables, raw);
      return instantiateTemplateSource(stored.source, builtInTemplateValues(title, spaceTitle, { ...values, date: today, author: author.name }));
    },
  };
}

/** Declared variable values from request input: defaults applied, required ones enforced. */
export function templateValues(variables: CloudTemplateVariable[], raw: unknown): Record<string, string> {
  const input = optionalRecord(raw, "variables") ?? {};
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const variable of variables) {
    const supplied = input[variable.name];
    if (supplied !== undefined && typeof supplied !== "string" && typeof supplied !== "number" && typeof supplied !== "boolean") {
      throw new HttpError(400, `variables.${variable.name} must be a string`);
    }
    const value = supplied === undefined ? variable.default ?? "" : String(supplied);
    if (value.length > MAX_TEMPLATE_VALUE_LENGTH) throw new HttpError(400, `variables.${variable.name} is longer than ${MAX_TEMPLATE_VALUE_LENGTH} characters`);
    if (variable.required && !value.trim()) missing.push(variable.name);
    values[variable.name] = value;
  }
  if (missing.length > 0) throw new HttpError(400, `Missing required template variables: ${missing.join(", ")}`, { code: "template_variables_required", missing });
  return values;
}

export function templateVariablesInput(value: unknown): CloudTemplateVariable[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new HttpError(400, "variables must be an array");
  if (value.length > MAX_TEMPLATE_VARIABLES) throw new HttpError(400, `A template can declare at most ${MAX_TEMPLATE_VARIABLES} variables`);
  const seen = new Set<string>();
  return value.map((item, index) => {
    const record = optionalRecord(item, `variables[${index}]`) ?? {};
    const name = optionalString(record.name);
    if (!name || !TEMPLATE_VARIABLE_NAME_RE.test(name)) {
      throw new HttpError(400, `variables[${index}].name must start with a lowercase letter and use a-z, 0-9, or _ (max 40)`);
    }
    if (RESERVED_TEMPLATE_VARIABLES.includes(name)) throw new HttpError(400, `variables[${index}].name "${name}" is reserved`);
    if (seen.has(name)) throw new HttpError(400, `variables[${index}].name "${name}" is declared twice`);
    seen.add(name);
    if (record.default !== undefined && typeof record.default !== "string") throw new HttpError(400, `variables[${index}].default must be a string`);
    if (record.required !== undefined && typeof record.required !== "boolean") throw new HttpError(400, `variables[${index}].required must be a boolean`);
    const defaultValue = typeof record.default === "string" ? record.default.slice(0, MAX_TEMPLATE_VALUE_LENGTH) : undefined;
    return {
      name,
      label: (optionalString(record.label) ?? name).slice(0, 80),
      ...(defaultValue !== undefined ? { default: defaultValue } : {}),
      required: record.required === true,
    };
  });
}

/** Rejects sources that are too large or use placeholders that are neither declared nor reserved. */
export function assertTemplateSource(source: string, variables: CloudTemplateVariable[]): void {
  if (!source.trim()) throw new HttpError(400, "Template source cannot be empty");
  if (Buffer.byteLength(source, "utf8") > MAX_TEMPLATE_SOURCE_BYTES) throw new HttpError(400, "Template source is too large");
  const declared = new Set([...RESERVED_TEMPLATE_VARIABLES, ...variables.map((variable) => variable.name)]);
  const unknown = templatePlaceholders(source).filter((name) => !declared.has(name));
  if (unknown.length > 0) {
    throw new HttpError(400, `Template uses undeclared variables: ${unknown.join(", ")}`, { code: "template_unknown_variables", unknown });
  }
}

/** Turn a page's first H1 into the `{{title}}` placeholder so new pages get their own title and ID. */
export function templateSourceFromPage(source: string): string {
  const normalized = source.replace(/\r\n?/g, "\n");
  return normalized.replace(/^#\s+.*$/m, '# {{title}} {id="{{title_id}}"}');
}

/** Response shape shared by built-in and stored templates. */
export function templateResponse(template: CloudPageTemplateRecord, editable: boolean): Record<string, unknown> {
  return {
    id: template.id,
    title: template.name,
    name: template.name,
    description: template.description,
    category: template.category,
    scope: template.scope,
    ...(template.siteId ? { siteId: template.siteId } : {}),
    source: template.source,
    variables: template.variables,
    createdBy: template.createdBy,
    updatedBy: template.updatedBy,
    createdAt: template.createdAt,
    updatedAt: template.updatedAt,
    editable,
  };
}

export function builtInTemplateResponses(): Array<Record<string, unknown>> {
  return cloudPageTemplates.map((template) => ({ ...template, name: template.title, scope: "built-in", variables: [], editable: false }));
}
