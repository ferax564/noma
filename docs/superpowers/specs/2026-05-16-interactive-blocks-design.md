# Interactive Artifact Blocks — Design

**Date:** 2026-05-16
**Target release:** v0.12.0 (interactive blocks debut) → v0.13.0 (validator + theming polish)
**Status:** draft, awaiting brainstorm + sign-off
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

## Decisions To Brainstorm (open questions)

| # | Question | Default proposal | Why it matters |
|---|----------|------------------|----------------|
| 1 | Runtime model: vanilla JS recompile-on-input, signal-graph, or third-party micro-framework? | **Vanilla JS, single shared `<script>` block injected once per page when any computed block is present** | Adds ~3KB inline JS; zero deps; no CDN; works under `--strict` if we mark `<script>` as Noma-generated (not user `::script`) |
| 2 | Formula DSL: hand-written tiny parser, or existing math library (mathjs, expr-eval)? | **Hand-written shunting-yard parser**, ~150 LOC, supports `+ - * / ^ %`, parens, ident lookup, fn calls from a fixed allow-list | mathjs adds ~150KB; expr-eval adds ~30KB; both can `eval`-equivalent. Hand-written stays auditable, no deps, fits Noma's "learnable in an afternoon" rule. |
| 3 | Where does formula evaluation happen? | **Browser at runtime** (HTML target) **AND** at render-time for PDF/LLM (using default values) | Browser keeps interactivity. Render-time evaluation for PDF means a printed thesis still shows a coherent number for the default. |
| 4 | Dependency tracking: explicit `depends_on="a,b"` attr, or scan formula for identifiers? | **Scan formula for identifiers**, validator warns when scan disagrees with explicit `depends_on=` if both present | Less typing; mirrors how spreadsheets work. Explicit attr stays available as override for documentation. |
| 5 | Control state at page load: defaults from attrs, or URL hash? | **Defaults from `default=` attr; URL hash sync deferred to v0.13** | Keep v0.12 surface tight. URL sync is a "share this configuration" feature, not core to the artifact. |
| 6 | Validator coverage scope | **5 rules: computed-missing-formula, computed-unknown-dependency, formula-parse-error, control-missing-default, control-out-of-range-default** | Mirrors existing validator density per block family. |
| 7 | LLM rendering | **Emit formula as `formula: <expr>` and default value as `default: <n>` in the LLM output**, do not include runtime | LLM consumers reason about the expression and the steady-state value, never the live one. |
| 8 | `--strict` posture | **Render as inert placeholder with a "disabled" badge**; do NOT throw, do NOT strip | Strict mode is about blocking unsafe HTML/SVG/script *from authors*. Noma-generated runtime is safe by construction. The badge signals to readers why the slider doesn't move. |
| 9 | Theme support | **Controls inherit theme form styles; computed_plot uses the same SVG palette as `::plot`** | No new theme surface to maintain. |
| 10 | Test surface | **Parser, formula evaluator, dep extraction, validator rules, HTML output shape (snapshot), strict-mode rendering** — no browser tests for v0.12 | Add Playwright/jsdom in v0.13 once the surface stabilizes. |

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
- A `<noma-controls>` data island per page with `{ controls: [{ id, type, default, ... }], computed: [{ id, formula, deps, ... }] }`.
- Inline `<script>` block (~3KB minified, single shared block per page, only when `computed_*` present) that:
  - Wires `input` events on each control to recompute every dependent block.
  - Re-renders `computed_plot` SVG inline (reuse the existing plot SVG generator, ported to a browser-compatible standalone function).
  - Updates `computed_metric` text content.
- Static fallback: every `computed_*` block renders with the **default-value result** baked in. JS upgrade is purely progressive.

**Phase 4 — Validator (1 day).** Five rules listed above. Add to `KNOWN_RULES` for `--ignore-rule`. Add tests.

**Phase 5 — LLM renderer (0.5 day).** Emit formula + default-value result; never emit the runtime JS. Add tests.

**Phase 6 — `--strict` mode (0.5 day).** When `--strict` is set, render the static fallback but replace the inline `<script>` with a `<noscript>`-style caption. Add tests confirming no `<script>` tag survives strict mode.

**Phase 7 — Demo + docs (1 day).** Add a `examples/interactive-projection.noma` exercising the example above. Update `docs/spec.noma` block-type tables (bump spec version to v0.12.0). Update `PLAN.md` §24.23.

**Total estimate:** ~8 days of focused work.

## Risks

| Risk | Mitigation |
|------|-----------|
| Inline `<script>` violates anyone's CSP | Document required CSP (`script-src 'self' 'sha256-...'`); offer `--external-script <path>` flag in v0.13 to write the runtime as a separate file. |
| Formula DSL grows into a generic eval | Lock the function allow-list in the spec; rejecting any identifier outside controls + allowed fns is a *parse error*, not a runtime check. |
| Computed plots in PDFs look broken (no interactivity) | PDFs render the default-value plot, which is a valid plot. Caption can note "live version on web." |
| Authors write `formula="x + y"` where `y` isn't a control | `computed-unknown-dependency` validator rule catches at lint time. |
| Float precision (0.1 + 0.2 = 0.30000000000000004) shows in metric display | `format=` attribute defaults to 2-decimal precision; raw float available via `format="raw"` for debug. |

## Open question for sign-off

**Should v0.12 ship `::computed_table` too, or hold for v0.13?**

The §23.9 example only shows `::computed_plot` and a slider. `::computed_table` (a table where one column is a formula over the row's other columns + control inputs) is the obvious "next" piece — but its design surface is bigger (sort order, per-row formulas vs columnar, derived column header naming). Recommendation: hold for v0.13 once `computed_plot` has shipped and surfaced real usage patterns.

---

**Next step:** brainstorming pass on questions 1, 2, 8 above (runtime model, parser approach, strict-mode posture). After that, write the implementation plan (`docs/superpowers/plans/2026-05-XX-interactive-blocks.md`).
