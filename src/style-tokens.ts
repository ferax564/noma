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

export interface ParsedStyleTokens {
  tokens: StyleToken[];
  unknown: string[];
}

/** Split a `class=` attribute value into known tokens and unknown words (order kept, duplicates dropped). */
export function parseStyleTokens(value: unknown): ParsedStyleTokens {
  const tokens: StyleToken[] = [];
  const unknown: string[] = [];
  if (typeof value !== "string") return { tokens, unknown };
  const seen = new Set<string>();
  for (const word of value.split(/[\s,]+/)) {
    if (!word || seen.has(word)) continue;
    seen.add(word);
    if (STYLE_TOKENS.has(word)) tokens.push(word as StyleToken);
    else unknown.push(word);
  }
  return { tokens, unknown };
}

/** HTML class names for a block's known tokens; unknown words are dropped, never emitted. */
export function styleTokenClassNames(attrs: Record<string, unknown>): string[] {
  return parseStyleTokens(attrs.class).tokens.map((token) => `${STYLE_TOKEN_CLASS_PREFIX}${token}`);
}
