# Interactive Artifact Blocks — Design

**Date:** 2026-05-16
**Target release:** v0.12.0 (interactive blocks debut) → v0.13.0 (validator + theming polish)
**Status:** draft with Q1, Q2, Q8 locked (2026-05-16); Q3–7, Q9–10 still open
**PLAN reference:** §23.9 (Interactive Artifact Blocks), §23.10 (Copy/Export Buttons), §17 ("Do not build yet" — visual editor still excluded)

---

## Purpose

Per PLAN §23.9, Noma's artifact layer should support declarative interactive blocks so agents can produce **useful temporary tools** — projection calculators, parameter sweeps, decision aids — without Noma becoming a full app framework.

Today, `::control` and `::export_button` parse and render as static decorative blocks. There is no runtime wiring. A `::control{type="slider"}` produces an `<input type="range">` that has no effect on anything else on the page.

This spec defines the runtime model that turns existing static directives into a small, secure, declarative reactivity system — enough to ship the §23.9 example (slider + computed line plot) without growing dependencies, without compromising `--strict` mode, and without adding a build step for authors.

## Scope

**In scope:**
- Runtime activation of existing `::control` directive (type=slider, type=select, type=number, type=toggle).
- New `::computed_plot` directive — depends on one or more `::control` IDs, recomputes its SVG on input.
- New `::computed_metric` directive — derived scalar shown as a `::metric`-style number.
- Pure-formula expression language (no eval, no JS): `a + b * c`, `pow(x, 2)`, `min/max/clamp/round`, `if(cond, then, else)`. Numeric only at v0.12.
- Validator rules for control/computed pairs (e.g. `computed-missing-formula`, `computed-unknown-dependency`, `formula-parse-error`).
- LLM renderer: emit the formula and default values as plain text; do not include runtime JS.
- `--strict` interaction: interactive blocks render as inert placeholders (input + caption "interactive controls disabled in strict mode") instead of being stripped.
- Theme integration: controls inherit the active theme's form-control styling; `variant="..."` works.

**Out of scope (v0.12):**
- String-valued formulas, regex, lookup tables.
- Cross-document state (URL hash sync, localStorage persistence).
- Two-way binding to `::dataset` block bodies.
- `::computed_table` (recomputed rows). Defer to v0.13.
- WASM, sandboxed JS, or any user-supplied script. Escape hatches remain `::script` only.
- Form submission, network requests, or any side-effecting interaction.

## Decisions Locked (2026-05-16 brainstorm)

### Q1 — Runtime model: **vanilla JS, single shared inline `<script>`** (locked)

When any `::control` or `::computed_*` is present on a page, the HTML renderer emits one shared inline `<script>` block (~3 KB minified) that:

- Reads a `<noma-controls>` data island holding `{ controls: [...], computed: [{ id, formula, deps, target_type }] }`.
- Wires `input` events on each control to a `recompute(changed_id)` function.
- `recompute` walks a precomputed evaluation order (topological sort done at render-time, stored in the data island).
- Updates `computed_metric` via `textContent`; re-renders `computed_plot` SVG inline using a browser-compatible port of the existing plot SVG generator.

Zero deps. Zero CDN. No build step for authors. Topo sort precomputed at render-time keeps runtime cost O(dependents).

**Consequence for v0.12 scope:** chained derivations (computed depending on another computed) are allowed but limited to depth ≤ 2 — see Q6 update below for the new validator rule. Deeper chains land in v0.13 if real usage demands them.

### Q2 — Formula DSL: **hand-written shunting-yard, ~150 LOC** (locked)

Operators: `+ - * / ^ %`, unary `-`, parens.

Function allow-list (frozen for v0.12; additions require spec version bump):

```
min, max, clamp, round, floor, ceil, abs,
pow, sqrt, exp, log, log10,
sin, cos, tan, atan2,
if
```

Identifiers outside this list (or outside the page's `::control` IDs) are a **parse error**, not a runtime error. This keeps the evaluator constant-time-bounded and rejects any path to arbitrary identifier lookup.

Parser lives in `src/formula.ts`. Exposes `parse(expr: string): FormulaAst | FormulaError` and `evaluate(ast: FormulaAst, env: Record<string, number>): number | EvalError`. Same parser used at render-time and at runtime (ported via the same TS source compiled into the inline `<script>`).

### Q8 — `--strict` posture: **inert placeholder, zero JS emitted** (locked, A2 variant)

Under `noma render --strict`:

- `::control`, `::computed_metric`, `::computed_plot` blocks **still render** — never stripped, never throw.
- Default-value math runs **at render-time**. Plots show the baseline plot. Metrics show the baseline number.
- The `<input>` element is emitted with `disabled` attribute.
- A small badge appears next to the first interactive block on the page: `[ interactive controls disabled in strict mode ]`.
- **No `<script>` tag in the output.** No `<noma-controls>` data island either (it would be dead weight without the runtime).

This is the stricter variant of the design doc's original default: same UX (frozen baseline visible), but the artifact is CSP-clean (`script-src 'self'` works without modification).

Threat model: `--strict` blocks **author-supplied** escape hatches (`::html`, `::svg`, `::script`). The interactive runtime is **Noma-generated** and deterministic, so the distinction matters — but the CSP-clean output gives consumers a path to deploy strict artifacts to environments where any inline script is forbidden.

## Decisions To Brainstorm (still open)

| # | Question | Default proposal | Why it matters |
|---|----------|------------------|----------------|
| 3 | Where does formula evaluation happen? | **Browser at runtime** (HTML target) **AND** at render-time for PDF/LLM (using default values) | Browser keeps interactivity. Render-time evaluation for PDF means a printed thesis still shows a coherent number for the default. |
| 4 | Dependency tracking: explicit `depends_on="a,b"` attr, or scan formula for identifiers? | **Scan formula for identifiers**, validator warns when scan disagrees with explicit `depends_on=` if both present | Less typing; mirrors how spreadsheets work. Explicit attr stays available as override for documentation. |
| 5 | Control state at page load: defaults from attrs, or URL hash? | **Defaults from `default=` attr; `#noma:` URL hash sync shipped in v0.12.0** | Defaults keep static render targets coherent; URL state lets scenario pages be shared without a backend. |
| 6 | Validator coverage scope | **6 rules: computed-missing-formula, computed-unknown-dependency, formula-parse-error, control-missing-default, control-out-of-range-default, computed-chain-too-deep** (last added 2026-05-16 to enforce Q1's depth ≤ 2 ceiling) | Mirrors existing validator density per block family. |
| 7 | LLM rendering | **Emit formula as `formula: <expr>` and default value as `default: <n>` in the LLM output**, do not include runtime | LLM consumers reason about the expression and the steady-state value, never the live one. |
| 9 | Theme support | **Controls inherit theme form styles; computed_plot uses the same SVG palette as `::plot`** | No new theme surface to maintain. |
| 10 | Test surface | **Parser, formula evaluator, dep extraction, validator rules, HTML output shape (snapshot), strict-mode rendering (no `<script>` assertion)** — no browser tests for v0.12 | Add Playwright/jsdom in v0.13 once the surface stabilizes. |

## Proposed AST surface

No new node *variant* — both new directives flow through the existing `DirectiveNode`:

```typescript
// New directive names handled by renderer-html + validator + renderer-llm:
"computed_plot"     // attrs: depends_on?, formula, type ("line" | "bar"), domain?, range?
"computed_metric"   // attrs: depends_on?, formula, unit?, format? ("number" | "percent" | "currency")
// Existing, now activated:
"control"           // attrs: type, min?, max?, step?, default, options? (for select)
```

`computed_plot` and `computed_metric` use `formula=` (string), parsed once at render time and re-evaluated at runtime.

## Example

```noma
::control{id="growth-rate" type="slider" min=0 max=20 default=8 step=0.5}
label: Growth rate
unit: %
::

::control{id="base-revenue" type="number" default=120 min=0 max=10000}
label: Base revenue ($M)
::

::computed_metric{id="year-5-revenue" depends_on="growth-rate,base-revenue" formula="base-revenue * pow(1 + growth-rate / 100, 5)" format="currency" unit="$M"}
label: Projected Year 5 Revenue
::

::computed_plot{id="projection" depends_on="growth-rate,base-revenue" type="line" formula="base-revenue * pow(1 + growth-rate / 100, year)" domain="year:0..10"}
title: 10-Year Revenue Projection
xlabel: Year
ylabel: Revenue ($M)
::
```

## Implementation phases

**Phase 1 — Parser + AST + JSON renderer (1 day).** No new node variant; just confirm `computed_plot` / `computed_metric` parse cleanly through the existing directive path. Add parser tests.

**Phase 2 — Formula evaluator (2 days).** Hand-written shunting-yard parser. Function allow-list: `min, max, clamp, round, floor, ceil, abs, pow, sqrt, exp, log, log10, sin, cos, tan, atan2, if`. Identifier resolution from a `{ [id]: number }` map. Unit tests: 30+ cases including parse errors, division by zero, NaN propagation, missing identifier.

**Phase 3 — HTML renderer (2 days).** Emit:
- A `<noma-controls>` data island per page with `{ controls: [{ id, type, default, ... }], computed: [{ id, formula, deps, target_type, eval_order: N }] }`. The `eval_order` field is the precomputed topological position so the runtime never sorts at input time (O(dependents) on every input event, not O(graph)).
- Inline `<script>` block (~3 KB minified, single shared block per page, only when `computed_*` present) that:
  - Wires `input` events on each control to a `recompute(changed_id)` function.
  - `recompute` iterates affected `computed_*` blocks in `eval_order` and updates them.
  - Re-renders `computed_plot` SVG inline (reuse the existing plot SVG generator, ported to a browser-compatible standalone function).
  - Updates `computed_metric` text content via `textContent`.
- Static fallback: every `computed_*` block renders with the **default-value result** baked in (formula evaluated at render-time using each control's `default=`). JS upgrade is purely progressive — readers without JS see the baseline.

**Phase 4 — Validator (1 day).** Six rules: `computed-missing-formula`, `computed-unknown-dependency`, `formula-parse-error`, `control-missing-default`, `control-out-of-range-default`, `computed-chain-too-deep` (depth > 2). Add all six to `KNOWN_RULES` for `--ignore-rule`. Add tests.

**Phase 5 — LLM renderer (0.5 day).** Emit formula + default-value result; never emit the runtime JS. Add tests.

**Phase 6 — `--strict` mode (0.5 day).** When `--strict` is set:
- Render `::control` / `::computed_*` blocks normally, with default-value math baked in.
- Mark every `<input>` with the `disabled` attribute.
- Emit one badge `[ interactive controls disabled in strict mode ]` next to the first interactive block on the page (not per-block — avoid clutter).
- Omit the `<script>` tag AND the `<noma-controls>` data island entirely. The output is fully static and CSP-clean (`script-src 'self'` works without modification).
- Tests: snapshot a strict render of `examples/interactive-projection.noma` and assert no `<script>`, no `<noma-controls>`, every `<input>` has `disabled`, and the badge appears exactly once.

**Phase 7 — Demo + docs (1 day).** Add a `examples/interactive-projection.noma` exercising the example above. Update `docs/spec.noma` block-type tables (bump spec version to v0.12.0). Update `PLAN.md` §24.24.

**Total estimate:** ~8 days of focused work.

## Risks

| Risk | Mitigation |
|------|-----------|
| Inline `<script>` violates anyone's CSP | Use `--strict` (Q8 A2 decision) — strict mode omits the `<script>` entirely while keeping the static baseline visible. For non-strict consumers, document required CSP (`script-src 'self' 'unsafe-inline'` or compute the SHA hash); a `--external-script <path>` flag is tracked for v0.13. |
| Formula DSL grows into a generic eval | Function allow-list locked in the spec (Q2); any identifier outside controls + allowed fns is a *parse error*, not a runtime check. Adding a function = spec version bump. |
| Computed plots in PDFs look broken (no interactivity) | PDFs render the default-value plot (Q3 render-time eval), which is a valid plot. Caption can note "live version on web." |
| Authors write `formula="x + y"` where `y` isn't a control | `computed-unknown-dependency` validator rule catches at lint time. |
| Float precision (0.1 + 0.2 = 0.30000000000000004) shows in metric display | `format=` attribute defaults to 2-decimal precision; raw float available via `format="raw"` for debug. |
| Chained derivations (computed → computed) create unmaintainable graphs | Q1 caps chain depth at 2 for v0.12; new validator rule `computed-chain-too-deep` warns at lint time. Lift to depth-N in v0.13 only if real authors hit the ceiling. |

## Open question for sign-off

**Should v0.12 ship `::computed_table` too, or hold for v0.13?**

Answered in v0.12.0: ship the simple-domain version now. `::computed_table` uses the same `formula=` + `domain="x:0..5"` contract as `::computed_plot`, renders live HTML rows, exports native DOCX tables, and leaves richer per-row/columnar table formulas for a later release if real usage requires them.

---

**Next step:** Q1, Q2, Q8 locked 2026-05-16 (see "Decisions Locked" section above). Remaining open questions Q3–7, Q9–10 default to the proposals in the table — sign off or contest before writing the implementation plan at `docs/superpowers/plans/2026-05-XX-interactive-blocks.md`.
