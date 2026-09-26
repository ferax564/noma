/**
 * Data-loss prevention: detectors for secrets and card numbers in chat messages, issue comments and
 * descriptions, and page source. `warn` records a finding and lets the write through; `block` refuses
 * it with `422 dlp_blocked`. Responses and findings name the detector, never the matched text.
 */
import type { DlpDetector, DlpFinding } from "../cloud-compliance.js";
import { type CloudServerConfig, randomId } from "./context.js";
import { HttpError } from "./http.js";

const PATTERNS: Record<Exclude<DlpDetector, "credit_card">, RegExp> = {
  aws_access_key: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  github_token: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/g,
  slack_token: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  private_key: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g,
  api_key: /\bsk-(?:ant-|proj-|live_|test_)?[A-Za-z0-9_-]{24,}\b/g,
};

const CARD_CANDIDATE = /\b(?:\d[ -]?){13,19}\b/g;

/** How many times each enabled detector matches `text`. */
export function scanText(text: string, detectors: readonly DlpDetector[]): Map<DlpDetector, number> {
  return new Map([...matchText(text, detectors)].map(([detector, values]) => [detector, values.length]));
}

/** The values each enabled detector matches in `text` (card numbers without separators). */
function matchText(text: string, detectors: readonly DlpDetector[]): Map<DlpDetector, string[]> {
  const found = new Map<DlpDetector, string[]>();
  for (const detector of detectors) {
    const values = detector === "credit_card" ? cardNumbers(text) : text.match(PATTERNS[detector]) ?? [];
    if (values.length > 0) found.set(detector, values);
  }
  return found;
}

/**
 * Applies the workspace DLP policy to new text. With `previous`, only values that were not already there
 * count, so an edit near an old, already-flagged value is not blocked again — but swapping it for a
 * different secret is.
 */
export function enforceDlp(
  config: CloudServerConfig,
  input: { text: string; previous?: string; actorId: string; resourceType: DlpFinding["resourceType"]; resourceId: string; siteId?: string },
): DlpDetector[] {
  const policy = config.compliance.dlpPolicy();
  if (policy.mode === "off" || policy.detectors.length === 0) return [];
  const now = matchText(input.text, policy.detectors);
  const before = input.previous === undefined ? new Map<DlpDetector, string[]>() : matchText(input.previous, policy.detectors);
  const detectors = [...now].filter(([detector, values]) => introducesNew(values, before.get(detector) ?? [])).map(([detector]) => detector);
  if (detectors.length === 0) return [];
  const outcome = policy.mode === "block" ? "blocked" : "flagged";
  const createdAt = config.now().toISOString();
  config.compliance.recordFinding({ id: randomId(), detectors, outcome, resourceType: input.resourceType, resourceId: input.resourceId, ...(input.siteId ? { siteId: input.siteId } : {}), actorId: input.actorId, createdAt });
  config.platform.recordAudit(input.actorId, outcome === "blocked" ? "dlp.blocked" : "dlp.flagged", input.siteId ? "site" : "workspace", input.siteId ?? "workspace", { detectors, resourceType: input.resourceType, resourceId: input.resourceId }, createdAt);
  if (outcome === "blocked") {
    throw new HttpError(422, `This looks like it contains ${detectors.map(describe).join(" and ")}; workspace policy blocks sharing it here`, { code: "dlp_blocked", detectors });
  }
  return detectors;
}

function describe(detector: DlpDetector): string {
  switch (detector) {
    case "aws_access_key":
      return "an AWS access key";
    case "github_token":
      return "a GitHub token";
    case "slack_token":
      return "a Slack token";
    case "private_key":
      return "a private key";
    case "api_key":
      return "an API key";
    case "credit_card":
      return "a card number";
  }
}

/** True when `values` holds some value more often than `previous` does. */
function introducesNew(values: string[], previous: string[]): boolean {
  const remaining = new Map<string, number>();
  for (const value of previous) remaining.set(value, (remaining.get(value) ?? 0) + 1);
  for (const value of values) {
    const left = remaining.get(value) ?? 0;
    if (left === 0) return true;
    remaining.set(value, left - 1);
  }
  return false;
}

function cardNumbers(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(CARD_CANDIDATE)) {
    const digits = match[0].replace(/[ -]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && !/^(\d)\1+$/.test(digits) && luhn(digits)) found.push(digits);
  }
  return found;
}

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index--) {
    let digit = digits.charCodeAt(index) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}
