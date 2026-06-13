import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { patchSource, type PatchOp } from "../src/patch.js";

interface Fixture {
  name: string;
  input: string;
  ops: PatchOp[];
}

const ROOT = "examples/conformance/patch";

const fixtures: Fixture[] = [
  {
    name: "replace_body",
    input: `::claim{id="c1" confidence=0.5}
Old body.
::
`,
    ops: [{ op: "replace_body", id: "c1", content: "New body." }],
  },
  {
    name: "update_heading",
    input: `## Old Title {id="sec"}

Body under the section.
`,
    ops: [{ op: "update_heading", id: "sec", title: "New Title" }],
  },
  {
    name: "remove_attribute",
    input: `::claim{id="c1" confidence=0.5 status="draft"}
body
::
`,
    ops: [{ op: "remove_attribute", id: "c1", key: "status" }],
  },
  {
    name: "move_block",
    input: `::claim{id="m"}
movable.
::

::section{id="b"}
:::claim{id="keep"}
stays.
:::
::
`,
    ops: [{ op: "move_block", id: "m", parent: "b", position: 0 }],
  },
  {
    name: "add_comment",
    input: `::claim{id="c1"}
A claim under review.
::
`,
    ops: [
      {
        op: "add_comment",
        id: "cm1",
        target: "c1",
        content: "Please verify this number.",
        author: "ferax564",
      },
    ],
  },
  {
    name: "resolve_comment",
    input: `::claim{id="c1"}
A claim under review.
::

::comment{id="cm1" target="c1" author="ferax564"}
Please verify this number.
::
`,
    ops: [{ op: "resolve_comment", id: "cm1", resolved_by: "reviewer" }],
  },
  {
    name: "add_footnote",
    input: `::claim{id="c1"}
A claim needing a note.
::
`,
    ops: [
      { op: "add_footnote", id: "fn1", target: "c1", content: "Source: internal model." },
    ],
  },
  {
    name: "add_endnote",
    input: `::claim{id="c1"}
A claim needing an endnote.
::
`,
    ops: [
      { op: "add_endnote", id: "en1", target: "c1", content: "See appendix B." },
    ],
  },
  {
    name: "add_change_request",
    input: `::claim{id="c1"}
The market is worth ten billion.
::
`,
    ops: [
      {
        op: "add_change_request",
        id: "cr1",
        target: "c1",
        action: "replace",
        from: "ten billion",
        to: "twelve billion",
        author: "reviewer",
      },
    ],
  },
  {
    name: "update_table_cell",
    input: `::table{id="t1" header align="l,l"}
Vertical | Growth
Legal | 3.4
Healthcare | 2.9
::
`,
    ops: [{ op: "update_table_cell", id: "t1", row: 0, column: 1, value: "3.8" }],
  },
  {
    name: "update_table_header_cell",
    input: `::table{id="t1" header align="l,l"}
Vertical | Growth
Legal | 3.4
::
`,
    ops: [{ op: "update_table_header_cell", id: "t1", column: 1, value: "YoY Growth" }],
  },
  {
    name: "insert_table_row",
    input: `::table{id="t1" header align="l,l"}
Vertical | Growth
Legal | 3.4
::
`,
    ops: [{ op: "insert_table_row", id: "t1", row: 1, cells: ["Healthcare", "2.9"] }],
  },
  {
    name: "delete_table_row",
    input: `::table{id="t1" header align="l,l"}
Vertical | Growth
Legal | 3.4
Healthcare | 2.9
::
`,
    ops: [{ op: "delete_table_row", id: "t1", row: 0 }],
  },
  {
    name: "insert_table_column",
    input: `::table{id="t1" header align="l,l"}
Vertical | Growth
Legal | 3.4
::
`,
    ops: [
      { op: "insert_table_column", id: "t1", column: 2, header: "Companies", cells: ["14"] },
    ],
  },
  {
    name: "delete_table_column",
    input: `::table{id="t1" header align="l,l,l"}
Vertical | Growth | Companies
Legal | 3.4 | 14
::
`,
    ops: [{ op: "delete_table_column", id: "t1", column: 2 }],
  },
  {
    name: "update_dataset_cell",
    input: `::dataset{id="d1"}
schema:
  vertical: string
  growth: number
rows:
  - [legal, 3.4]
  - [healthcare, 2.9]
::
`,
    ops: [{ op: "update_dataset_cell", id: "d1", row: 0, column: 1, value: "3.8" }],
  },
  {
    name: "insert_dataset_row",
    input: `::dataset{id="d1"}
schema:
  vertical: string
  growth: number
rows:
  - [legal, 3.4]
::
`,
    ops: [{ op: "insert_dataset_row", id: "d1", row: 1, cells: ["healthcare", "2.9"] }],
  },
  {
    name: "delete_dataset_row",
    input: `::dataset{id="d1"}
schema:
  vertical: string
  growth: number
rows:
  - [legal, 3.4]
  - [healthcare, 2.9]
::
`,
    ops: [{ op: "delete_dataset_row", id: "d1", row: 1 }],
  },
  {
    name: "insert_dataset_column",
    input: `::dataset{id="d1"}
schema:
  vertical: string
  growth: number
rows:
  - [legal, 3.4]
::
`,
    ops: [
      { op: "insert_dataset_column", id: "d1", column: 2, header: "companies", cells: ["14"] },
    ],
  },
  {
    name: "delete_dataset_column",
    input: `::dataset{id="d1"}
schema:
  vertical: string
  growth: number
  companies: number
rows:
  - [legal, 3.4, 14]
::
`,
    ops: [{ op: "delete_dataset_column", id: "d1", column: 2 }],
  },
];

for (const fx of fixtures) {
  const dir = join(ROOT, fx.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "input.noma"), fx.input);
  const patchJson = fx.ops.length === 1 ? fx.ops[0] : fx.ops;
  writeFileSync(join(dir, "patch.json"), JSON.stringify(patchJson, null, 2) + "\n");
  let cur = fx.input;
  for (const op of fx.ops) cur = patchSource(cur, op);
  writeFileSync(join(dir, "expected.post.noma"), cur);
  console.log(`\n========== ${fx.name} ==========`);
  console.log(cur);
}
console.log(`\nGenerated ${fixtures.length} fixtures.`);
