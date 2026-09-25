import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeAttachmentFilename } from "../src/cloud/attachments.js";
import { documentPageProperties } from "../src/macros.js";
import { NotionImportError, notionAttachmentFilename, notionOutputFiles, parseCsv, parseNotionBundle, parseNotionExport } from "../src/notion-import.js";
import { parse } from "../src/parser.js";
import { validate } from "../src/validator.js";
import { createZip } from "../src/zip.js";
import { DESIGN, HOME, notionFixture, TASK_A, TASK_B, TASKS } from "./notion-fixture.js";

test("Notion export converts the page tree, links, attachments, databases, and properties", () => {
  const result = parseNotionExport(notionFixture());
  const byId = new Map(result.pages.map((page) => [page.id, page]));
  assert.deepEqual(result.pages.map((page) => page.title), ["Home", "Design Doc", "Tasks", "Ship importer", "Write docs"]);
  assert.equal(byId.get(HOME)?.parentId, undefined);
  assert.equal(byId.get(DESIGN)?.parentId, HOME);
  assert.equal(byId.get(TASKS)?.parentId, HOME);
  assert.equal(byId.get(TASKS)?.kind, "database");
  assert.equal(byId.get(TASK_A)?.parentId, TASKS);
  assert.equal(byId.get(TASK_B)?.parentId, TASKS);

  const home = byId.get(HOME)!;
  assert.match(home.source, /^---\nsource: notion\nnotion:\n  id: 0123456789abcdef0123456789abcdef\n  url: https:\/\/www\.notion\.so\/0123456789abcdef0123456789abcdef\n---\n\n# Home \{id="home"\}\n/);
  assert.match(home.source, /Read the \[\[Design Doc\]\] first\./);
  assert.match(home.source, /Track work in \[\[Tasks\]\]\./);
  assert.match(home.source, /::callout\{tone="info"\}\n💡 Notion callouts become Noma callouts\.\n\n:::figure\{src="att:team-photo\.png" alt="Team photo"\}\n:::\n::/);
  assert.match(home.source, /Broken: Gone\./);
  assert.match(home.source, /\u200b::include\{page="Secrets"\} stays literal, and so does \[\u200b\[not a link\]\u200b\]\./);
  assert.deepEqual(home.attachments.map((attachment) => [attachment.filename, attachment.archivePath]), [["team-photo.png", `Export-6f1c/Home ${HOME}/team photo.png`]]);
  assert.deepEqual(home.loss, [{ kind: "html", count: 3 }, { kind: "broken-link", count: 1 }]);

  const design = byId.get(DESIGN)!;
  assert.match(design.source, /^Status: this line is prose, not a property, on a normal page\.$/m);
  assert.doesNotMatch(design.source, /page-properties/);
  assert.match(design.source, /^## Architecture \{id="architecture"\}$/m);
  assert.match(design.source, /::figure\{src="att:arch-v2-\.png" alt="Diagram"\}\n::/);
  assert.match(design.source, /Spec attached: \[spec\.pdf\]\(att:spec\.pdf\)\. Back to \[\[Home\]\]\./);
  assert.match(design.source, /and \[\[Ship importer\|the task\]\]\./);
  assert.match(design.source, /const link = "\[x\]\(Home\.md\)";/);
  assert.deepEqual(design.attachments.map((attachment) => attachment.filename), ["arch-v2-.png", "spec.pdf"]);

  const tasks = byId.get(TASKS)!;
  assert.match(tasks.source, /notion:\n  id: '2{32}'\n  url: https:\/\/www\.notion\.so\/2{32}\n  database: true/);
  assert.match(tasks.source, /\| Name \| Status \| Tags \| Notes \|\n\| --- \| --- \| --- \| --- \|\n\| \[\[Ship importer\]\] \| Done \| import, notion \| Line one line two \|\n\| \[\[Write docs\]\] \| In progress \| docs \| Has \\\| pipe, and "quotes" \|\n\| Archived \| Done \|  \|  \|/);
  assert.match(tasks.source, /::dataset\{id="tasks-data" format="csv"\}\nName,Status,Tags,Notes\nShip importer,Done,"import, notion",Line one line two\nWrite docs,In progress,docs,"Has \| pipe, and ""quotes"""\nArchived,Done,,\n::/);

  const shipped = byId.get(TASK_A)!;
  assert.match(shipped.source, /labels:\n  - import\n  - notion/);
  assert.match(shipped.source, /# Ship importer \{id="ship-importer"\}\n\n::page-properties\{id="ship-importer-properties"\}\nStatus: Done\nTags: import, notion\nBlocked by: \[\[Write docs\]\]\n::\n\nThe importer ships with the \[\[Design Doc\]\]\./);
  assert.deepEqual(shipped.labels, ["import", "notion"]);
  const shippedDoc = parse(shipped.source);
  assert.deepEqual(documentPageProperties(shippedDoc), [["Status", "Done"], ["Tags", "import, notion"], ["Blocked by", "[[Write docs]]"]]);
  assert.equal(byId.get(TASK_B)?.position, 1);
  assert.equal(shipped.position, 0);

  for (const page of result.pages) {
    const diagnostics = validate(parse(page.source, { filename: `${page.id}.noma` }));
    assert.deepEqual(diagnostics.filter((diagnostic) => diagnostic.severity === "error" && diagnostic.code !== "broken-reference"), [], `${page.title}: ${page.source}`);
  }
  assert.deepEqual(result.loss.find((entry) => entry.kind === "html"), { kind: "html", count: 3 });
  assert.equal(result.skipped.length, 0);
});

test("Notion export conversion is deterministic so re-imports compare by hash", () => {
  const first = parseNotionExport(notionFixture());
  const second = parseNotionExport(notionFixture());
  assert.deepEqual(first.pages.map((page) => page.source), second.pages.map((page) => page.source));
});

test("Notion export skips traversal entries, enforces bounds, and rejects non-exports", () => {
  const placeholder = createZip([
    { path: `Page ${HOME}.md`, data: "# Page\n\n[escape](../../etc/passwd) and ![x](../../secret.png)\n" },
    { path: "safe/@@/@@/outside.md", data: "# Outside\n" },
  ]);
  const withTraversal = Buffer.from(placeholder.toString("latin1").split("safe/@@/@@/").join("safe/../../"), "latin1");
  const result = parseNotionExport(withTraversal);
  assert.deepEqual(result.pages.map((page) => page.title), ["Page"]);
  assert.deepEqual(result.skipped, [{ path: "safe/../../outside.md", reason: "unsafe path" }]);
  assert.match(result.pages[0]!.source, /escape and x\n/);
  assert.deepEqual(result.pages[0]!.attachments, []);
  assert.deepEqual(result.loss, [{ kind: "missing-file", count: 2 }]);

  assert.throws(() => parseNotionExport(Buffer.from("not a zip")), NotionImportError);
  assert.throws(() => parseNotionExport(createZip([{ path: "readme.txt", data: "hi" }])), /no Notion pages/);
  assert.throws(() => parseNotionExport(notionFixture(), { maxPages: 3 }), /at most 3 pages/);
  assert.throws(() => parseNotionExport(notionFixture(), { maxEntries: 4 }), /more than 4 entries/);
  assert.throws(() => parseNotionExport(notionFixture(), { maxTotalBytes: 500 }), NotionImportError);

  const small = parseNotionExport(notionFixture(), { maxAttachmentBytes: 20 });
  const home = small.pages.find((page) => page.id === HOME)!;
  assert.deepEqual(home.attachments, []);
  assert.ok(small.loss.some((entry) => entry.kind === "attachment-too-large"));
});

test("inner export ZIPs are unpacked and attachment names stay Cloud-safe", () => {
  const outer = createZip([{ path: "Export-Part-1.zip", data: notionFixture() }]);
  assert.equal(parseNotionExport(outer).pages.length, 5);
  for (const raw of ["arch (v2).png", "Résumé 100% final?.pdf", "  ..hidden", "a#b[c]{d}.txt", `${"x".repeat(300)}.png`]) {
    const name = notionAttachmentFilename(raw);
    assert.equal(sanitizeAttachmentFilename(name), name, raw);
    assert.doesNotMatch(name, /[\s()%]/);
  }
});

test("CSV parser handles quotes, multi-line cells, and CRLF", () => {
  assert.deepEqual(parseCsv('a,b\r\n"x, y","multi\nline"\r\n,\r\n'), { columns: ["a", "b"], rows: [["x, y", "multi\nline"]] });
});

test("Notion JSON bundles convert markdown pages with ID links and properties", () => {
  const result = parseNotionBundle({
    format: "noma-notion-bundle",
    workspace: "Acme",
    pages: [
      { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", title: "Root", markdown: "# Root\n\nGo to [child](https://www.notion.so/Child-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb).\n" },
      {
        id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        parentId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        title: "Child",
        markdown: "Body with [root](aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa).",
        properties: { Owner: "Ada", Tags: ["x", "y"] },
        database: { columns: ["Name", "Score"], rows: [["one", 1]] },
      },
    ],
  });
  assert.equal(result.workspace, "Acme");
  const [root, child] = result.pages;
  assert.equal(root?.id, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(child?.parentId, root?.id);
  assert.match(root!.source, /Go to \[\[Child\|child\]\]\./);
  assert.match(child!.source, /::page-properties\{id="child-properties"\}\nOwner: Ada\nTags: x, y\n::/);
  assert.match(child!.source, /Body with \[\[Root\|root\]\]\./);
  assert.match(child!.source, /::dataset\{id="child-data" format="csv"\}\nName,Score\none,1\n::/);
  assert.deepEqual(child!.labels, ["x", "y"]);
  assert.throws(() => parseNotionBundle({ pages: [{ id: "x" }] }), /needs a Notion id and a title/);
  assert.throws(() => parseNotionBundle({ format: "other", pages: [] }), /noma-notion-bundle/);
});

test("notionOutputFiles lays pages out as a slug tree with local attachment paths and a report", () => {
  const files = notionOutputFiles(parseNotionExport(notionFixture()));
  assert.deepEqual(files.map((file) => file.path), [
    "home.files/team-photo.png",
    "home.noma",
    "home/design-doc.files/arch-v2-.png",
    "home/design-doc.files/spec.pdf",
    "home/design-doc.noma",
    "home/tasks.noma",
    "home/tasks/ship-importer.noma",
    "home/tasks/write-docs.noma",
    "notion-import-report.json",
  ]);
  const design = String(files.find((file) => file.path === "home/design-doc.noma")!.data);
  assert.match(design, /::figure\{src="design-doc\.files\/arch-v2-\.png" alt="Diagram"\}/);
  assert.match(design, /\[spec\.pdf\]\(design-doc\.files\/spec\.pdf\)/);
  const report = JSON.parse(String(files.at(-1)!.data)) as { pages: Array<{ file: string }>; loss: unknown[] };
  assert.equal(report.pages.length, 5);
  assert.ok(report.loss.length > 0);
});
