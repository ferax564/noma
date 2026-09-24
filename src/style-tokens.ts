/**
 * Style tokens — the closed "lego" vocabulary a block may carry in `class="..."`.
 *
 * Tokens compose like utility classes (`::card{class="tone-accent elevated span-2"}`),
 * but the set is fixed and themed: every renderer knows what each token means,
 * the validator rejects unknown ones, and no token can inject CSS, scripts, or
 * layout that breaks the reading order. HTML emits each token as `n-<token>`.
 */
export const STYLE_TOKEN_GROUPS = {
  tone: ["tone-neutral", "tone-accent", "tone-info", "tone-success", "tone-warning", "tone-danger"],
  surface: ["plain", "outline", "filled", "elevated", "muted", "inverse"],
  emphasis: ["lead", "subtle", "emphasis", "mono"],
  size: ["text-sm", "text-lg", "text-xl", "text-2xl"],
  align: ["align-start", "align-center", "align-end"],
  spacing: ["tight", "roomy"],
  span: ["span-2", "span-3", "span-full"],
  layout: ["stack", "row", "center-v"],
  media: ["print-only", "screen-only", "hide-in-slides", "slides-only"],
} as const;

export type StyleToken = (typeof STYLE_TOKEN_GROUPS)[keyof typeof STYLE_TOKEN_GROUPS][number];

export const STYLE_TOKENS: ReadonlySet<string> = new Set(Object.values(STYLE_TOKEN_GROUPS).flat());

/** Prefix applied to every token in HTML so themes cannot collide with page CSS. */
export const STYLE_TOKEN_CLASS_PREFIX = "n-";

/**
 * Named bundles of core tokens, e.g. `{ "brand-callout": "tone-accent filled roomy" }`.
 * Spaces (and a document's `style_tokens:` frontmatter) define them so teams get
 * their own vocabulary without new CSS: an alias only ever expands to core tokens.
 */
export type StyleTokenAliases = Readonly<Record<string, readonly StyleToken[]>>;

export const MAX_STYLE_TOKEN_ALIASES = 64;
const ALIAS_NAME_RE = /^[a-z][a-z0-9-]{1,39}$/;

export interface StyleTokenAliasResult {
  aliases: Record<string, StyleToken[]>;
  errors: string[];
}

/**
 * Validates alias definitions from host settings or frontmatter. Accepts a map of
 * alias → space/comma-separated tokens (or a token array). Invalid entries are
 * reported and skipped; valid ones are returned expanded to core tokens.
 */
export function normalizeStyleTokenAliases(input: unknown): StyleTokenAliasResult {
  const aliases: Record<string, StyleToken[]> = {};
  const errors: string[] = [];
  if (input === undefined || input === null) return { aliases, errors };
  if (typeof input !== "object" || Array.isArray(input)) return { aliases, errors: ["style tokens must be a map of alias name to core tokens"] };
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > MAX_STYLE_TOKEN_ALIASES) errors.push(`at most ${MAX_STYLE_TOKEN_ALIASES} style token aliases are allowed`);
  for (const [name, value] of entries.slice(0, MAX_STYLE_TOKEN_ALIASES)) {
    if (!ALIAS_NAME_RE.test(name)) {
      errors.push(`alias "${name}" must be 2-40 lowercase letters, digits, or dashes, starting with a letter`);
      continue;
    }
    if (STYLE_TOKENS.has(name)) {
      errors.push(`alias "${name}" shadows a core style token`);
      continue;
    }
    const words = Array.isArray(value) ? value.map(String) : typeof value === "string" ? value.split(/[\s,]+/).filter(Boolean) : undefined;
    if (!words || words.length === 0) {
      errors.push(`alias "${name}" must list one or more core tokens`);
      continue;
    }
    const unknown = words.filter((word) => !STYLE_TOKENS.has(word));
    if (unknown.length > 0) {
      errors.push(`alias "${name}" uses unknown core token${unknown.length === 1 ? "" : "s"} ${unknown.map((t) => `"${t}"`).join(", ")}`);
      continue;
    }
    aliases[name] = [...new Set(words)] as StyleToken[];
  }
  return { aliases, errors };
}

/**
 * Alias set for one render/validation: the document's `style_tokens:` frontmatter,
 * overridden by host (space) definitions so a space owner's vocabulary wins.
 */
export function resolveStyleTokenAliases(frontmatter: unknown, host: StyleTokenAliases | undefined): StyleTokenAliases {
  return { ...normalizeStyleTokenAliases(frontmatter).aliases, ...(host ?? {}) };
}

export interface ParsedStyleTokens {
  tokens: StyleToken[];
  unknown: string[];
}

/** Split a `class=` attribute value into core tokens (aliases expanded) and unknown words; order kept, duplicates dropped. */
export function parseStyleTokens(value: unknown, aliases: StyleTokenAliases = {}): ParsedStyleTokens {
  const tokens: StyleToken[] = [];
  const unknown: string[] = [];
  if (typeof value !== "string") return { tokens, unknown };
  const seen = new Set<string>();
  const add = (token: StyleToken): void => {
    if (seen.has(token)) return;
    seen.add(token);
    tokens.push(token);
  };
  for (const word of value.split(/[\s,]+/)) {
    if (!word) continue;
    if (STYLE_TOKENS.has(word)) add(word as StyleToken);
    else if (Object.hasOwn(aliases, word)) for (const token of aliases[word]!) add(token);
    else if (!unknown.includes(word)) unknown.push(word);
  }
  return { tokens, unknown };
}

/** HTML class names for a block's tokens (aliases expanded); unknown words are dropped, never emitted. */
export function styleTokenClassNames(attrs: Record<string, unknown>, aliases: StyleTokenAliases = {}): string[] {
  return parseStyleTokens(attrs.class, aliases).tokens.map((token) => `${STYLE_TOKEN_CLASS_PREFIX}${token}`);
}
