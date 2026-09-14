import assert from "node:assert/strict";
import test from "node:test";
import { EnterpriseError } from "../src/enterprise-contracts.js";
import {
  applyHostedPaperDomTransaction,
  createUpstreamPaperDocument,
  paperDomFidelityReport,
  paperDomHtmlExport,
  paperDomOutline,
} from "../src/enterprise-paperdom-host.js";
import { mountPaperDomHost } from "../src/enterprise-paperdom-react.js";
import { PAPERDOM_UPSTREAM_COMMIT, PAPERDOM_UPSTREAM_LICENSE, PAPERDOM_UPSTREAM_REPO } from "../src/paperdom-pin.js";

test("hosted PaperDOM strips client actors and rejects stale revisions", () => {
  let doc = createUpstreamPaperDocument("visual-1", "Board");
  doc = applyHostedPaperDomTransaction(
    doc,
    {
      expectedRevision: 0,
      actor: { id: "", name: "spoof", type: "human" },
      operations: [
        {
          op: "createElement",
          element: {
            id: "title",
            type: "text",
            name: "Title",
            frame: { x: 40, y: 40, w: 400, h: 48, rotation: 0 },
            z: 1,
            content: { text: "Hosted title" },
          },
        },
      ],
    },
    "server-alice",
  );
  assert.equal(doc.revision, 1);
  assert.equal(paperDomOutline(doc)[0]?.label, "Hosted title");
  assert.throws(
    () =>
      applyHostedPaperDomTransaction(
        doc,
        {
          expectedRevision: 0,
          operations: [{ op: "replaceText", elementId: "title", text: "stale" }],
        },
        "server-alice",
      ),
    (err: unknown) => err instanceof EnterpriseError && err.code === "stale_revision",
  );
  const html = paperDomHtmlExport(doc);
  const target = { innerHTML: "" };
  mountPaperDomHost(target, doc);
  assert.match(html, /Hosted title/);
  assert.equal(target.innerHTML, html);
  const report = paperDomFidelityReport(doc, "pptx");
  assert.equal(report.completeOfficeFidelity, false);
  assert.equal(report.source.commit, PAPERDOM_UPSTREAM_COMMIT);
  assert.equal(report.source.repo, PAPERDOM_UPSTREAM_REPO);
  assert.equal(PAPERDOM_UPSTREAM_LICENSE, "MIT");
  assert.match(PAPERDOM_UPSTREAM_COMMIT, /^[a-f0-9]{40}$/);
});
