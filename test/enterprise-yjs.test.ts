import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import puppeteer, { type Browser, type Page } from "puppeteer";
import * as Y from "yjs";
import { EnterpriseError } from "../src/enterprise-contracts.js";
import {
  enterpriseCollabHtml,
  listenEnterpriseCollab,
  loadYjsDocument,
  persistYjsUpdate,
  yjsFragmentText,
  yjsPersistedCount,
} from "../src/enterprise-yjs.js";
import { createTestOidc, EnterpriseWorkspace } from "../src/enterprise-workspace.js";
import { resetIdentitySequence } from "../src/stable-identity.js";

async function bundleCollab(): Promise<string> {
  const result = await build({
    entryPoints: ["web/enterprise-collab.ts"],
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
    logLevel: "silent",
  });
  const file = result.outputFiles[0];
  if (!file) throw new Error("esbuild produced no collab bundle");
  return file.text;
}

function harness() {
  resetIdentitySequence(0);
  const oidc = createTestOidc({
    alice: { sub: "alice", email: "alice@example.com", name: "Alice" },
  });
  const ws = new EnterpriseWorkspace({ oidc });
  const tenantId = ws.provisionTenant("Acme").tenantId;
  ws.scimUpsert(tenantId, { externalId: "alice", userName: "Alice", active: true });
  const session = ws.loginOidc(tenantId, "alice");
  ws.bootstrapGrant(tenantId, session.actor.principalId, "tenant", tenantId, "owner");
  const spaceId = ws.createSpace(session.actor, "Docs");
  const documentId = ws.createDocument(session.actor, { spaceId, title: "Live", source: `{#p}\nHello.\n` });
  return { ws, session, documentId };
}

test("Yjs persist-before-ack keeps an unacknowledged update on disk", () => {
  const { ws, session, documentId } = harness();
  const doc = new Y.Doc();
  doc.getText("plain").insert(0, "acked-from-disk");
  assert.throws(
    () => persistYjsUpdate(ws, session.actor, documentId, Y.encodeStateAsUpdate(doc), true),
    (err: unknown) => err instanceof EnterpriseError && err.code === "invalid",
  );
  assert.equal(yjsPersistedCount(ws, documentId), 1);
  const reloaded = loadYjsDocument(ws, documentId);
  assert.match(reloaded.getText("plain").toString(), /acked-from-disk/);
  ws.close();
});

test("hosted Tiptap/Yjs replicates across two browsers and survives reconnect", { timeout: 120_000 }, async (t) => {
  const { ws, session, documentId } = harness();
  const script = await bundleCollab();
  const server = await listenEnterpriseCollab({ workspace: ws, editorHtml: enterpriseCollabHtml(script) });
  const origin = `${server.url}/collab?token=${encodeURIComponent(session.token)}&documentId=${encodeURIComponent(documentId)}`;
  const browsers: Browser[] = [];
  t.after(async () => {
    await Promise.all(browsers.map((browser) => browser.close()));
    await server.close();
    ws.close();
  });

  const browserA = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  const browserB = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  browsers.push(browserA, browserB);
  const pageA = await browserA.newPage();
  const pageB = await browserB.newPage();

  const ready = async (page: Page) => {
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => (window as unknown as { nomaCollab?: { ready: () => boolean } }).nomaCollab?.ready(), {
      timeout: 20_000,
    });
  };
  await ready(pageA);
  await ready(pageB);

  await pageA.click("#editor .ProseMirror");
  await pageA.keyboard.type("alpha-sync");
  await pageA.waitForFunction(
    () => (window as unknown as { nomaCollab: { acks: () => number } }).nomaCollab.acks() >= 1,
    { timeout: 15_000 },
  );
  await pageB.waitForFunction(
    () => ((window as unknown as { nomaCollab: { getText: () => string } }).nomaCollab.getText() ?? "").includes("alpha-sync"),
    { timeout: 15_000 },
  );
  const persisted = loadYjsDocument(ws, documentId);
  assert.match(yjsFragmentText(persisted), /alpha-sync/);
  assert.ok(yjsPersistedCount(ws, documentId) >= 1);

  await pageA.reload({ waitUntil: "domcontentloaded" });
  await pageA.waitForFunction(
    () => {
      const collab = (window as unknown as { nomaCollab?: { ready: () => boolean; getText: () => string } }).nomaCollab;
      return Boolean(collab?.ready() && collab.getText().includes("alpha-sync"));
    },
    { timeout: 20_000 },
  );
  await pageA.click("#editor .ProseMirror");
  await pageA.keyboard.press("End");
  await pageA.keyboard.type(" beta-reconnect");
  await pageB.waitForFunction(
    () => ((window as unknown as { nomaCollab: { getText: () => string } }).nomaCollab.getText() ?? "").includes("beta-reconnect"),
    { timeout: 15_000 },
  );
});
