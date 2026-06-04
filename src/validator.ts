import yaml from "js-yaml";
import type { Diagnostic, DirectiveNode, DocumentNode, Node } from "./ast.js";
import { walk } from "./ast.js";
import { computedDomainVars, controlDefaultNumber, formulaText, numericAttr as computedNumericAttr } from "./computed.js";
import { extractFormulaIdentifiers, parseFormula } from "./formula.js";
import { splitDelimitedRow } from "./inline.js";

export interface ValidateOptions {
  /**
   * Disable claim-without-evidence warnings entirely (default: enabled).
   * Per-block opt-out: add the `noverify` flag attribute to the claim.
   */
  requireEvidenceForClaims?: boolean;
  /**
   * Reference time for `stale-citation` checks. Defaults to `new Date()`.
   * Tests pass a fixed clock for determinism.
   */
  now?: Date;
  /** Citations older than this many days are flagged stale. Default: 365. */
  staleCitationDays?: number;
  /**
   * Rule codes to drop from the result. Diagnostics whose `code` matches an
   * entry are filtered out and do not affect exit status. Mirrors the per-block
   * `noverify` flag at file level. Used by `noma check --ignore-rule X`.
   */
  ignoreRules?: string[];
}

const DEFAULT_STALE_DAYS = 365;

/**
 * Directive allow-lists per declared `profile`. A document that opts in to a
 * profile guarantees to downstream tools that it only uses these directive
 * names. The validator warns on out-of-profile directives so authors notice
 * before their consumers do.
 */
const PROFILES: Record<string, ReadonlySet<string>> = {
  minimal: new Set([
    "summary",
    "abstract",
    "callout",
    "note",
    "warning",
    "tip",
    "header",
    "footer",
    "page_setup",
    "doc_protection",
    "toc",
    "figure",
    "citation",
    "footnote",
    "endnote",
    "bibliography",
    "math",
    "code",
    "table",
    "pagebreak",
  ]),
  technical: new Set([
    "summary",
    "abstract",
    "callout",
    "note",
    "warning",
    "tip",
    "hero",
    "grid",
    "card",
    "columns",
    "tabs",
    "accordion",
    "sidebar",
    "button",
    "api",
    "endpoint",
    "parameter",
    "example",
    "changelog",
    "instruction",
    "header",
    "footer",
    "page_setup",
    "doc_protection",
    "toc",
    "pagebreak",
    "figure",
    "plot",
    "plotly",
    "diagram",
    "dataset",
    "query",
    "code",
    "code_cell",
    "output",
    "control",
    "computed_metric",
    "computed_plot",
    "computed_table",
    "export_button",
    "agent_task",
    "todo",
    "citation",
    "footnote",
    "endnote",
    "bibliography",
    "math",
    "table",
    "html",
    "svg",
    "script",
  ]),
  research: new Set([
    "summary",
    "abstract",
    "callout",
    "note",
    "warning",
    "tip",
    "header",
    "footer",
    "page_setup",
    "doc_protection",
    "toc",
    "claim",
    "evidence",
    "counterevidence",
    "assumption",
    "risk",
    "hypothesis",
    "result",
    "limitation",
    "open_question",
    "decision",
    "adr",
    "dataset",
    "query",
    "plot",
    "plotly",
    "diagram",
    "metric",
    "control",
    "computed_metric",
    "computed_plot",
    "computed_table",
    "code",
    "figure",
    "agent_task",
    "todo",
    "instruction",
    "review",
    "comment",
    "change_request",
    "provenance",
    "confidence",
    "citation",
    "footnote",
    "endnote",
    "bibliography",
    "state_change",
    "math",
    "table",
    "pagebreak",
  ]),
  memory: new Set(["memory", "memory_index"]),
};

const MEMORY_TYPES = new Set(["user", "feedback", "project", "reference"]);
const ISO_DATE_RE =
  /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;

export const KNOWN_PROFILES = Object.keys(PROFILES);

export function validate(doc: DocumentNode, options: ValidateOptions = {}): Diagnostic[] {
  const requireEvidence = options.requireEvidenceForClaims !== false;
  const metaStale = readPositiveNumber(doc.meta.stale_citation_days);
  const staleDays =
    options.staleCitationDays ?? metaStale ?? DEFAULT_STALE_DAYS;
  const now = options.now ?? new Date();

  const diagnostics: Diagnostic[] = [];
  const ids = new Map<string, Node>();
  const aliasIds = new Set<string>();
  const claims: DirectiveNode[] = [];
  const evidenceTargets = new Set<string>();
  const referenced = new Set<string>();
  const datasetIds = new Map<string, DirectiveNode>();
  const datasetColumns = new Map<string, Set<string>>();
  const controls = new Map<string, DirectiveNode>();
  const computed = new Map<string, DirectiveNode>();
  const computedNodes: DirectiveNode[] = [];

  const aliasToNode = new Map<string, Node>();
  const declaredProfiles = readDeclaredProfiles(doc.meta);
  const profileSet: Set<string> | undefined = (() => {
    if (declaredProfiles.length === 0) return undefined;
    const union = new Set<string>();
    let any = false;
    for (const name of declaredProfiles) {
      const set = PROFILES[name];
      if (!set) {
        diagnostics.push({
          severity: "warning",
          code: "unknown-profile",
          message: `Document declares unknown profile "${name}". Known: ${KNOWN_PROFILES.join(", ")}.`,
        });
        continue;
      }
      any = true;
      for (const directive of set) union.add(directive);
    }
    return any ? union : undefined;
  })();
  const profileLabel = declaredProfiles.join("+");

  const wikilinkRe = /\[\[([a-zA-Z_][\w\-./:]*)\]\]/g;
  const wikilinkRefs = new Set<string>();
  const collectWikilinks = (text: string): void => {
    const stripped = text.replace(/`[^`]*`/g, "");
    for (const m of stripped.matchAll(wikilinkRe)) {
      referenced.add(m[1]!);
      wikilinkRefs.add(m[1]!);
    }
  };

  for (const node of walk(doc)) {
    if (node.type === "paragraph" || node.type === "quote") collectWikilinks(node.content);
    else if (node.type === "list_item") collectWikilinks(node.content);
    else if (node.type === "section") collectWikilinks(node.title);
    else if (node.type === "directive" && node.body) collectWikilinks(node.body);
    else if (node.type === "table") {
      for (const cell of node.header) collectWikilinks(cell);
      for (const row of node.rows) for (const cell of row) collectWikilinks(cell);
    }
    if (node.id) {
      if (ids.has(node.id)) {
        diagnostics.push({
          severity: "error",
          code: "duplicate-id",
          message: `Duplicate block ID "${node.id}".`,
          pos: node.pos,
          nodeId: node.id,
        });
      } else {
        ids.set(node.id, node);
      }
    }
    if (node.aliases) {
      for (const a of node.aliases) {
        aliasIds.add(a);
        if (!aliasToNode.has(a)) aliasToNode.set(a, node);
      }
    }

    if (node.type !== "directive") continue;

    if (profileSet && !suppressed(node) && !profileSet.has(node.name)) {
      diagnostics.push({
        severity: "warning",
        code: "out-of-profile-directive",
        message: `Directive "${node.name}" is not part of the declared "${profileLabel}" profile.`,
        pos: node.pos,
        nodeId: node.id,
      });
    }

    if (node.name === "dataset") {
      if (node.id) {
        datasetIds.set(node.id, node);
        datasetColumns.set(node.id, readDatasetColumns(node));
      }
      if (
        !suppressed(node) &&
        typeof node.attrs.src === "string" &&
        (!(node.body && node.body.trim()) || node.attrs.format === "error")
      ) {
        diagnostics.push({
          severity: "warning",
          code: "dataset-src-missing",
          message: `Dataset "${node.id ?? "?"}" src="${node.attrs.src}" failed to load (file missing or unreadable).`,
          pos: node.pos,
          nodeId: node.id,
        });
      }
    }

    if (node.name === "control") {
      if (node.id) controls.set(node.id, node);
      if (!suppressed(node)) {
        validateControl(node, diagnostics);
        validateControlLock(node, diagnostics);
      }
    }

    if (node.name === "computed_metric" || node.name === "computed_plot" || node.name === "computed_table") {
      if (node.id) computed.set(node.id, node);
      computedNodes.push(node);
    }

    if (node.name === "claim" && node.id) claims.push(node);

    if (node.name === "claim" && !suppressed(node) && "confidence" in node.attrs) {
      const c = node.attrs.confidence;
      let num: number | null = null;
      if (typeof c === "number" && Number.isFinite(c)) num = c;
      else if (typeof c === "string" && c.trim() !== "") {
        const n = Number(c);
        if (Number.isFinite(n)) num = n;
      }
      if (num === null || num < 0 || num > 1) {
        diagnostics.push({
          severity: "warning",
          code: "claim-invalid-confidence",
          message: `Claim "${node.id ?? "?"}" confidence="${c}" must be a number in [0, 1].`,
          pos: node.pos,
          nodeId: node.id,
        });
      }
    }

    if (node.name === "state_change" && !suppressed(node)) {
      const block = node.attrs.block;
      if (typeof block === "string") {
        referenced.add(block);
      } else {
        diagnostics.push({
          severity: "warning",
          code: "state-change-missing-block",
          message: `state_change has no \`block=\` attribute pointing at the changed block.`,
          pos: node.pos,
          nodeId: node.id,
        });
      }
      const hasFrom = "from" in node.attrs;
      const hasTo = "to" in node.attrs;
      if (!hasFrom || !hasTo) {
        diagnostics.push({
          severity: "warning",
          code: "state-change-missing-from-to",
          message: `state_change "${node.id ?? "?"}" needs both \`from=\` and \`to=\` attributes.`,
          pos: node.pos,
          nodeId: node.id,
        });
      }
    }

    if (node.name === "comment" && !suppressed(node)) {
      const target = readFirstStringAttr(node, ["target", "for", "parent", "block", "ref"]);
      if (target) referenced.add(target);
      const replyTo = readFirstStringAttr(node, ["reply_to", "replyTo", "reply"]);
      if (replyTo) referenced.add(replyTo);
    }

    if (node.name === "change_request" && !suppressed(node)) {
      const target = readFirstStringAttr(node, ["target", "for", "parent", "block"]);
      if (target) referenced.add(target);
      const action = readFirstStringAttr(node, ["action", "type"])?.toLowerCase();
      if (action) {
        if (action !== "insert" && action !== "delete" && action !== "replace") {
          diagnostics.push({
            severity: "warning",
            code: "change-request-invalid-action",
            message: `change_request "${node.id ?? "?"}" action="${action}" must be insert, delete, or replace.`,
            pos: node.pos,
            nodeId: node.id,
          });
        } else if (!hasChangeRequestRevisionText(node, action)) {
          diagnostics.push({
            severity: "warning",
            code: "change-request-missing-revision-text",
            message: `change_request "${node.id ?? "?"}" action="${action}" is missing the text needed for a tracked revision.`,
            pos: node.pos,
            nodeId: node.id,
          });
        }
      }
    }

    if ((node.name === "footnote" || node.name === "endnote") && !suppressed(node)) {
      const target = readFirstStringAttr(node, ["target", "for", "parent", "block", "ref"]);
      if (target) referenced.add(target);
    }

    if (node.name === "evidence" || node.name === "counterevidence") {
      const target = node.attrs.for;
      if (typeof target === "string") {
        referenced.add(target);
        evidenceTargets.add(target);
      } else {
        diagnostics.push({
          severity: "warning",
          code: "evidence-missing-for",
          message: `${node.name} block has no \`for=\` attribute.`,
          pos: node.pos,
          nodeId: node.id,
        });
      }
    }

    if (node.name === "diagram" && !suppressed(node)) {
      const kind = String(node.attrs.kind ?? "");
      if (!kind) {
        diagnostics.push({
          severity: "warning",
          code: "diagram-missing-kind",
          message: `Diagram "${node.id ?? "?"}" has no \`kind=\` (mermaid|graphviz|drawio).`,
          pos: node.pos,
          nodeId: node.id,
        });
      }
      if (!(node.body && node.body.trim())) {
        diagnostics.push({
          severity: "warning",
          code: "diagram-missing-source",
          message: `Diagram "${node.id ?? "?"}" has no source body.`,
          pos: node.pos,
          nodeId: node.id,
        });
      }
    }

    if (node.name === "plotly" && !suppressed(node)) {
      const body = (node.body ?? "").trim();
      if (!body) {
        diagnostics.push({
          severity: "warning",
          code: "plotly-missing-spec",
          message: `Plotly "${node.id ?? "?"}" has no JSON spec body.`,
          pos: node.pos,
          nodeId: node.id,
        });
      } else {
        try {
          JSON.parse(body);
        } catch (e) {
          diagnostics.push({
            severity: "error",
            code: "plotly-invalid-json",
            message: `Plotly "${node.id ?? "?"}" body is not valid JSON: ${(e as Error).message}`,
            pos: node.pos,
            nodeId: node.id,
          });
        }
      }
    }

    if (node.name === "figure" && !suppressed(node) && !node.attrs.alt && !node.attrs.caption) {
      diagnostics.push({
        severity: "warning",
        code: "figure-missing-alt",
        message: `Figure block has no alt or caption text.`,
        pos: node.pos,
        nodeId: node.id,
      });
    }

    if (node.name === "plot") {
      const hasData = "data" in node.attrs || "dataset" in node.attrs;
      if (typeof node.attrs.dataset === "string") {
        const ref = node.attrs.dataset;
        if (!datasetIds.has(ref)) {
          diagnostics.push({
            severity: "error",
            code: "plot-unknown-dataset",
            message: `Plot "${node.id ?? "?"}" references unknown dataset "${ref}".`,
            pos: node.pos,
            nodeId: node.id,
          });
        } else if (typeof node.attrs.column === "string") {
          const cols = datasetColumns.get(ref) ?? new Set<string>();
          if (cols.size > 0 && !cols.has(node.attrs.column)) {
            diagnostics.push({
              severity: "error",
              code: "plot-unknown-column",
              message: `Plot "${node.id ?? "?"}" references unknown column "${node.attrs.column}" in dataset "${ref}".`,
              pos: node.pos,
              nodeId: node.id,
            });
          }
        }
      }
      if (!hasData) {
        diagnostics.push({
          severity: "error",
          code: "plot-missing-data",
          message: `Plot has no data or dataset attribute.`,
          pos: node.pos,
          nodeId: node.id,
        });
      }
      if (!suppressed(node)) {
        const data = typeof node.attrs.data === "string" ? node.attrs.data : "";
        const labels = typeof node.attrs.xlabels === "string" ? node.attrs.xlabels : "";
        const delim = (s: string): "comma" | "space" | null => {
          const hasComma = /,/.test(s);
          const hasSpace = /\s/.test(s.trim());
          if (hasComma && !hasSpace) return "comma";
          if (hasSpace && !hasComma) return "space";
          return null;
        };
        const a = delim(data);
        const b = delim(labels);
        if (a && b && a !== b) {
          diagnostics.push({
            severity: "warning",
            code: "plot-mixed-delimiters",
            message: `Plot "${node.id ?? "?"}" mixes ${a}-separated data with ${b}-separated xlabels. Use commas for both (preferred).`,
            pos: node.pos,
            nodeId: node.id,
          });
        }
      }
    }

    if (node.name === "risk" && !suppressed(node) && !node.attrs.owner) {
      diagnostics.push({
        severity: "warning",
        code: "risk-without-owner",
        message: `Risk "${node.id ?? "?"}" has no \`owner=\` attribute.`,
        pos: node.pos,
        nodeId: node.id,
      });
    }

    if (
      (node.name === "decision" || node.name === "adr") &&
      !suppressed(node) &&
      !node.attrs.status
    ) {
      diagnostics.push({
        severity: "warning",
        code: "decision-without-status",
        message: `${node.name} "${node.id ?? "?"}" has no \`status=\` attribute.`,
        pos: node.pos,
        nodeId: node.id,
      });
    }

    if (
      (node.name === "agent_task" || node.name === "todo") &&
      !suppressed(node) &&
      !node.attrs.scope &&
      !(node.body && node.body.trim().length > 0) &&
      node.children.length === 0
    ) {
      diagnostics.push({
        severity: "warning",
        code: "agent-task-without-scope",
        message: `Agent task "${node.id ?? "?"}" has no scope or body.`,
        pos: node.pos,
        nodeId: node.id,
      });
    }

    if (
      (node.name === "html" || node.name === "svg" || node.name === "script") &&
      !suppressed(node) &&
      node.attrs.trusted !== true
    ) {
      diagnostics.push({
        severity: "warning",
        code: "escape-hatch-untrusted",
        message: `${node.name} escape-hatch block has no \`trusted\` attribute. Add \`trusted\` to silence this warning, or \`noverify\` to suppress all checks on this block.`,
        pos: node.pos,
        nodeId: node.id,
      });
    }

    if (node.name === "memory" && !suppressed(node)) {
      const t = node.attrs.type;
      if (typeof t !== "string" || !t) {
        diagnostics.push({
          severity: "error",
          code: "memory-missing-type",
          message: `Memory "${node.id ?? "?"}" has no \`type=\` attribute.`,
          pos: node.pos,
          nodeId: node.id,
        });
      } else if (!MEMORY_TYPES.has(t)) {
        diagnostics.push({
          severity: "error",
          code: "memory-invalid-type",
          message: `Memory "${node.id ?? "?"}" has type="${t}". Must be one of: ${[...MEMORY_TYPES].join(", ")}.`,
          pos: node.pos,
          nodeId: node.id,
        });
      }
      if ("confidence" in node.attrs) {
        const c = node.attrs.confidence;
        let num: number | null = null;
        if (typeof c === "number" && Number.isFinite(c)) {
          num = c;
        } else if (typeof c === "string" && c.trim() !== "") {
          const n = Number(c);
          if (Number.isFinite(n)) num = n;
        }
        if (num === null || num < 0 || num > 1) {
          diagnostics.push({
            severity: "error",
            code: "memory-invalid-confidence",
            message: `Memory "${node.id ?? "?"}" confidence="${c}" must be a number in [0, 1].`,
            pos: node.pos,
            nodeId: node.id,
          });
        }
      }
      if ("last_seen" in node.attrs) {
        const ls = node.attrs.last_seen;
        const s = typeof ls === "string" ? ls : "";
        if (!s || !ISO_DATE_RE.test(s) || !isValidIsoDate(s)) {
          diagnostics.push({
            severity: "error",
            code: "memory-invalid-last-seen",
            message: `Memory "${node.id ?? "?"}" last_seen="${ls}" must be ISO date (YYYY-MM-DD or full ISO 8601).`,
            pos: node.pos,
            nodeId: node.id,
          });
        }
      }
      if (!node.id) {
        diagnostics.push({
          severity: "error",
          code: "memory-missing-id",
          message: `Memory block has no \`id=\` attribute.`,
          pos: node.pos,
        });
      }
    }

    if (node.name === "citation" && !suppressed(node)) {
      if (!node.attrs.url && !node.attrs.source && !node.attrs.doi) {
        diagnostics.push({
          severity: "warning",
          code: "citation-missing-source",
          message: `Citation "${node.id ?? "?"}" has no \`url=\`, \`source=\`, or \`doi=\` attribute.`,
          pos: node.pos,
          nodeId: node.id,
        });
      }
      if (node.attrs.accessed) {
        const perBlock = readPositiveNumber(node.attrs.stale_after_days);
        const window = perBlock ?? staleDays;
        const stale = isStale(String(node.attrs.accessed), now, window);
        if (stale) {
          diagnostics.push({
            severity: "warning",
            code: "stale-citation",
            message: `Citation "${node.id ?? "?"}" was last accessed ${node.attrs.accessed} (>${window} days ago).`,
            pos: node.pos,
            nodeId: node.id,
          });
        }
      }
    }
  }

  for (const target of referenced) {
    if (!ids.has(target) && !aliasIds.has(target)) {
      diagnostics.push({
        severity: "error",
        code: "broken-reference",
        message: `Reference to unknown block ID "${target}".`,
      });
    }
  }

  if (declaredProfiles.includes("memory")) {
    for (const target of wikilinkRefs) {
      const node = ids.get(target) ?? aliasToNode.get(target);
      if (!node) continue;
      const isMemory =
        node.type === "directive" && (node as DirectiveNode).name === "memory";
      if (!isMemory) {
        diagnostics.push({
          severity: "warning",
          code: "memory-wikilink-non-memory-target",
          message: `Wikilink [[${target}]] points at a non-::memory block. Memory profile expects wikilinks to resolve to ::memory directives.`,
        });
      }
    }
  }

  if (requireEvidence) {
    for (const claim of claims) {
      if (suppressed(claim)) continue;
      if (claim.id && !evidenceTargets.has(claim.id)) {
        diagnostics.push({
          severity: "warning",
          code: "claim-without-evidence",
          message: `Claim "${claim.id}" has no evidence backing it.`,
          pos: claim.pos,
          nodeId: claim.id,
        });
      }
    }
  }

  validateComputedNodes(computedNodes, controls, computed, diagnostics);

  const ignore = options.ignoreRules;
  if (ignore && ignore.length > 0) {
    const known = collectRuleCodes();
    for (const rule of ignore) {
      if (!known.has(rule)) {
        diagnostics.push({
          severity: "info",
          code: "unknown-ignore-rule",
          message: `--ignore-rule "${rule}" matches no known validator rule (ignored).`,
        });
      }
    }
    const set = new Set(ignore);
    return diagnostics.filter((d) => !set.has(d.code));
  }

  return diagnostics;
}

function readDeclaredProfiles(meta: Record<string, unknown>): string[] {
  if (Array.isArray(meta.profiles)) {
    const out: string[] = [];
    for (const p of meta.profiles) {
      if (typeof p === "string" && p.trim()) out.push(p.trim());
    }
    if (out.length > 0) return out;
  }
  if (typeof meta.profile === "string" && meta.profile.trim()) {
    return [meta.profile.trim()];
  }
  return [];
}

const KNOWN_RULES = [
  "duplicate-id",
  "out-of-profile-directive",
  "unknown-profile",
  "broken-reference",
  "evidence-missing-for",
  "figure-missing-alt",
  "plot-unknown-dataset",
  "plot-unknown-column",
  "plot-missing-data",
  "plot-mixed-delimiters",
  "risk-without-owner",
  "decision-without-status",
  "agent-task-without-scope",
  "escape-hatch-untrusted",
  "stale-citation",
  "claim-without-evidence",
  "state-change-missing-block",
  "state-change-missing-from-to",
  "change-request-invalid-action",
  "change-request-missing-revision-text",
  "diagram-missing-kind",
  "diagram-missing-source",
  "plotly-missing-spec",
  "plotly-invalid-json",
  "dataset-src-missing",
  "memory-missing-type",
  "memory-invalid-type",
  "memory-invalid-confidence",
  "memory-invalid-last-seen",
  "memory-missing-id",
  "memory-wikilink-non-memory-target",
  "claim-invalid-confidence",
  "citation-missing-source",
  "control-missing-default",
  "control-out-of-range-default",
  "control-invalid-lock",
  "computed-missing-formula",
  "computed-unknown-dependency",
  "formula-parse-error",
  "computed-chain-too-deep",
];

function collectRuleCodes(): Set<string> {
  return new Set(KNOWN_RULES);
}

function suppressed(node: DirectiveNode): boolean {
  return node.attrs.noverify === true;
}

function readFirstStringAttr(node: DirectiveNode, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = node.attrs[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function hasChangeRequestRevisionText(node: DirectiveNode, action: "insert" | "delete" | "replace"): boolean {
  const from = readFirstStringAttr(node, ["from"]);
  const to = readFirstStringAttr(node, ["to"]);
  const text = readFirstStringAttr(node, ["text"]);
  const body = Boolean((node.body ?? "").trim() || node.children.length > 0);
  if (action === "replace") return Boolean(from && to);
  if (action === "insert") return Boolean(to || text || body);
  return Boolean(from || text || body);
}

function validateControl(node: DirectiveNode, diagnostics: Diagnostic[]): void {
  if (!controlNeedsNumericDefault(node)) return;
  const def = controlDefaultNumber(node);
  if (def === undefined) {
    diagnostics.push({
      severity: "warning",
      code: "control-missing-default",
      message: `Numeric control "${node.id ?? "?"}" has no numeric \`default=\` value for static rendering and LLM context.`,
      pos: node.pos,
      nodeId: node.id,
    });
    return;
  }
  const min = computedNumericAttr(node.attrs, "min");
  const max = computedNumericAttr(node.attrs, "max");
  if ((min !== undefined && def < min) || (max !== undefined && def > max)) {
    diagnostics.push({
      severity: "warning",
      code: "control-out-of-range-default",
      message: `Numeric control "${node.id ?? "?"}" default=${def} is outside its declared range.`,
      pos: node.pos,
      nodeId: node.id,
    });
  }
}

function validateControlLock(node: DirectiveNode, diagnostics: Diagnostic[]): void {
  const value = node.attrs.lock ?? node.attrs.content_control_lock ?? node.attrs.sdt_lock;
  if (value === undefined || typeof value === "boolean") return;
  const normalized = String(value).trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (CONTROL_LOCK_VALUES.has(normalized)) return;
  diagnostics.push({
    severity: "warning",
    code: "control-invalid-lock",
    message: `Control "${node.id ?? "?"}" lock="${value}" must be control, content, all, unlocked, or none.`,
    pos: node.pos,
    nodeId: node.id,
  });
}

const CONTROL_LOCK_VALUES = new Set([
  "control",
  "field",
  "container",
  "sdt",
  "sdtlocked",
  "content",
  "value",
  "contentlocked",
  "all",
  "both",
  "full",
  "sdtcontentlocked",
  "controlandcontent",
  "fieldandcontent",
  "unlocked",
  "none",
  "off",
  "false",
  "0",
  "no",
  "",
]);

function controlNeedsNumericDefault(node: DirectiveNode): boolean {
  const type = typeof node.attrs.type === "string" ? node.attrs.type.trim().toLowerCase() : undefined;
  if (!type) return true;
  return type === "slider" || type === "range" || type === "number" || type === "checkbox" || type === "toggle";
}

function validateComputedNodes(
  nodes: DirectiveNode[],
  controls: Map<string, DirectiveNode>,
  computed: Map<string, DirectiveNode>,
  diagnostics: Diagnostic[],
): void {
  const depMap = new Map<string, string[]>();
  for (const node of nodes) {
    if (suppressed(node)) continue;
    const formula = formulaText(node);
    if (!formula) {
      diagnostics.push({
        severity: "warning",
        code: "computed-missing-formula",
        message: `${node.name} "${node.id ?? "?"}" has no \`formula=\` attribute or \`formula:\` body line.`,
        pos: node.pos,
        nodeId: node.id,
      });
      continue;
    }
    const parsed = parseFormula(formula);
    if (!parsed.ok) {
      diagnostics.push({
        severity: "error",
        code: "formula-parse-error",
        message: `${node.name} "${node.id ?? "?"}" formula could not be parsed: ${parsed.error.message}`,
        pos: node.pos,
        nodeId: node.id,
      });
      continue;
    }
    const domainVars = computedDomainVars(node);
    const deps = extractFormulaIdentifiers(parsed.ast);
    depMap.set(node.id ?? `@${node.pos?.line ?? depMap.size}`, deps);
    for (const dep of deps) {
      if (domainVars.has(dep) || controls.has(dep) || computed.has(dep)) continue;
      diagnostics.push({
        severity: "error",
        code: "computed-unknown-dependency",
        message: `${node.name} "${node.id ?? "?"}" formula references unknown control or computed block "${dep}".`,
        pos: node.pos,
        nodeId: node.id,
      });
    }
  }

  const depthMemo = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (id: string): number => {
    if (controls.has(id)) return 0;
    const memo = depthMemo.get(id);
    if (memo !== undefined) return memo;
    if (visiting.has(id)) return Infinity;
    const node = computed.get(id);
    if (!node) return 0;
    visiting.add(id);
    const deps = depMap.get(id) ?? [];
    let depth = 1;
    for (const dep of deps) {
      if (computed.has(dep)) depth = Math.max(depth, depthOf(dep) + 1);
    }
    visiting.delete(id);
    depthMemo.set(id, depth);
    return depth;
  };

  for (const node of nodes) {
    if (suppressed(node) || !node.id) continue;
    const depth = depthOf(node.id);
    if (depth > 2) {
      diagnostics.push({
        severity: "warning",
        code: "computed-chain-too-deep",
        message: `${node.name} "${node.id}" has computed dependency depth ${depth === Infinity ? "cycle" : depth}; keep computed chains at depth <= 2.`,
        pos: node.pos,
        nodeId: node.id,
      });
    }
  }
}

function readDatasetColumns(node: DirectiveNode): Set<string> {
  const cols = new Set<string>();
  if (typeof node.attrs.columns === "string") {
    for (const c of node.attrs.columns.split(/[,\s]+/).filter(Boolean)) cols.add(c);
  }
  const body = node.body ?? "";
  const format = String(node.attrs.format ?? "").toLowerCase();
  if (!body.trim()) return cols;

  if (format === "csv" || format === "tsv") {
    const delim = format === "tsv" ? "\t" : ",";
    const firstLine = body.replace(/\r\n?/g, "\n").split("\n").find((l) => l.length > 0);
    if (firstLine) {
      for (const c of splitDelimitedRow(firstLine, delim).filter(Boolean)) {
        cols.add(c);
      }
    }
    return cols;
  }
  if (format === "json") {
    try {
      const parsed = JSON.parse(body);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const head = parsed[0];
        if (head && typeof head === "object" && !Array.isArray(head)) {
          for (const k of Object.keys(head as Record<string, unknown>)) cols.add(k);
        }
      } else if (parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).columns)) {
        for (const c of (parsed as { columns: unknown[] }).columns) {
          if (typeof c === "string") cols.add(c);
        }
      }
    } catch {
      // fall through
    }
    return cols;
  }

  // Default: YAML (existing behavior).
  let parsed: unknown;
  try {
    parsed = yaml.load(body);
  } catch {
    parsed = null;
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const schema = (parsed as Record<string, unknown>).schema;
    if (schema && typeof schema === "object" && !Array.isArray(schema)) {
      for (const k of Object.keys(schema as Record<string, unknown>)) cols.add(k);
    }
  }
  return cols;
}

function readPositiveNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

function isValidIsoDate(s: string): boolean {
  const t = Date.parse(s);
  if (Number.isNaN(t)) return false;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return true;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === mo - 1 &&
    dt.getUTCDate() === d
  );
}

function isStale(accessed: string, now: Date, days: number): boolean {
  const t = Date.parse(accessed);
  if (Number.isNaN(t)) return false;
  const ageMs = now.getTime() - t;
  return ageMs > days * 24 * 60 * 60 * 1000;
}

export function formatDiagnostics(diagnostics: Diagnostic[], filename?: string): string {
  if (diagnostics.length === 0) return "✓ No issues found.";
  const lines: string[] = [];
  for (const d of diagnostics) {
    const where = d.pos ? `${filename ?? "input"}:${d.pos.line}:${d.pos.column}` : (filename ?? "");
    lines.push(`${d.severity.toUpperCase()} [${d.code}] ${where}: ${d.message}`);
  }
  return lines.join("\n");
}
