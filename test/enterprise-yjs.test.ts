import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import puppeteer, { type Browser, type Page } from "puppeteer";
import WebSocket from "ws";
import * as Y from "yjs";
import { EnterpriseError } from "../src/enterprise-contracts.js";
import {
  compactYjsUpdates,
  enterpriseCollabHtml,
  listenEnterpriseCollab,
  loadYjsDocument,
  persistYjsUpdate,
  YJS_BEARER_PREFIX,
  YJS_SUBPROTOCOL,
  yjsFragmentText,
  yjsPersistedCount,
  type EnterpriseYjsOptions,
} from "../src/enterprise-yjs.js";
import { createTestOidc, EnterpriseWorkspace } from "../src/enterprise-workspace.js";
import { resetIdentitySequence } from "../src/stable-identity.js";

const run = promisify(execFile);

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

function harness(dbPath?: string) {
  resetIdentitySequence(0);
  const oidc = createTestOidc({
    alice: { sub: "alice", email: "alice@example.com", name: "Alice" },
    bob: { sub: "bob", email: "bob@example.com", name: "Bob" },
    victor: { sub: "victor", email: "victor@example.com", name: "Victor" },
  });
  const ws = new EnterpriseWorkspace({ oidc, dbPath });
  const tenantId = ws.provisionTenant("Acme").tenantId;
  ws.scimUpsert(tenantId, { externalId: "alice", userName: "Alice", active: true });
  ws.scimUpsert(tenantId, { externalId: "bob", userName: "Bob", active: true });
  ws.scimUpsert(tenantId, { externalId: "victor", userName: "Victor", active: true });
  const session = ws.loginOidc(tenantId, "alice");
  const bob = ws.loginOidc(tenantId, "bob");
  const victor = ws.loginOidc(tenantId, "victor");
  ws.bootstrapGrant(tenantId, session.actor.principalId, "tenant", tenantId, "owner");
  const spaceId = ws.createSpace(session.actor, "Docs");
  ws.bootstrapGrant(tenantId, bob.actor.principalId, "space", spaceId, "editor");
  ws.bootstrapGrant(tenantId, victor.actor.principalId, "space", spaceId, "viewer");
  const documentId = ws.createDocument(session.actor, { spaceId, title: "Live", source: `{#p}\nHello.\n` });
  return { ws, session, bob, victor, documentId };
}

function textUpdate(text: string, base?: Y.Doc): Uint8Array {
  const doc = new Y.Doc();
  if (base) Y.applyUpdate(doc, Y.encodeStateAsUpdate(base));
  const before = Y.encodeStateVector(doc);
  const field = doc.getText("plain");
  field.insert(field.length, text);
  return Y.encodeStateAsUpdate(doc, before);
}

interface Client {
  socket: WebSocket;
  messages: Array<Record<string, unknown>>;
  next: (type: string, predicate?: (m: Record<string, unknown>) => boolean) => Promise<Record<string, unknown>>;
}

function connect(
  port: number,
  documentId: string,
  auth: { protocols?: string[]; headers?: Record<string, string>; query?: string },
): Promise<Client> {
  const url = `ws://127.0.0.1:${port}/yjs?documentId=${encodeURIComponent(documentId)}${auth.query ?? ""}`;
  const socket = new WebSocket(url, auth.protocols ?? [], { headers: auth.headers });
  const messages: Array<Record<string, unknown>> = [];
  const waiters: Array<() => void> = [];
  socket.on("message", (raw) => {
    messages.push(JSON.parse(String(raw)) as Record<string, unknown>);
    for (const wake of waiters.splice(0)) wake();
  });
  const next: Client["next"] = (type, predicate = () => true) =>
    new Promise((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`timed out waiting for ${type}`)), 5_000);
      const check = () => {
        const index = messages.findIndex((m) => m.type === type && predicate(m));
        if (index >= 0) {
          clearTimeout(timer);
          done(messages.splice(index, 1)[0]!);
        } else waiters.push(check);
      };
      check();
    });
  return new Promise((done, fail) => {
    socket.once("open", () => done({ socket, messages, next }));
    socket.once("unexpected-response", (_req, res) => fail(new Error(`HTTP ${res.statusCode}`)));
    socket.once("error", fail);
  });
}

const bearer = (token: string) => ({ protocols: [YJS_SUBPROTOCOL, `${YJS_BEARER_PREFIX}${token}`] });

async function relay(options: EnterpriseYjsOptions = {}) {
  const h = harness();
  const server = await listenEnterpriseCollab({ workspace: h.ws, editorHtml: "<!doctype html>", yjs: options });
  return {
    ...h,
    server,
    async dispose() {
      await server.close();
      h.ws.close();
    },
  };
}

test("Yjs persist-before-ack keeps an unacknowledged update on disk", () => {
  const { ws, session, documentId } = harness();
  assert.throws(
    () =>
      persistYjsUpdate(ws, session.actor, documentId, textUpdate("acked-from-disk"), {
        hooks: {
          afterPersist: () => {
            throw new EnterpriseError("invalid", "simulated lost ack");
          },
        },
      }),
    (err: unknown) => err instanceof EnterpriseError && err.code === "invalid",
  );
  assert.equal(yjsPersistedCount(ws, documentId), 1);
  const reloaded = loadYjsDocument(ws, documentId);
  assert.match(reloaded.getText("plain").toString(), /acked-from-disk/);
  assert.throws(
    () => persistYjsUpdate(ws, session.actor, documentId, new Uint8Array([255, 255, 255])),
    (err: unknown) => err instanceof EnterpriseError && err.code === "invalid",
  );
  assert.equal(yjsPersistedCount(ws, documentId), 1, "malformed updates never reach disk");
  ws.close();
});

test("compaction folds persisted updates into one snapshot without losing state", () => {
  const { ws, session, documentId } = harness();
  const mirror = new Y.Doc();
  for (let i = 0; i < 6; i++) {
    const update = textUpdate(`w${i} `, mirror);
    Y.applyUpdate(mirror, update);
    persistYjsUpdate(ws, session.actor, documentId, update);
  }
  assert.equal(yjsPersistedCount(ws, documentId), 6);
  assert.equal(compactYjsUpdates(ws, documentId, 10), null, "below threshold is a no-op");
  const result = compactYjsUpdates(ws, documentId);
  assert.equal(result?.compacted, 6);
  assert.equal(result?.seq, 6);
  assert.equal(yjsPersistedCount(ws, documentId), 1);
  assert.equal(loadYjsDocument(ws, documentId).getText("plain").toString(), mirror.getText("plain").toString());
  const after = persistYjsUpdate(ws, session.actor, documentId, textUpdate("tail", mirror));
  assert.equal(after.seq, 7, "sequence keeps increasing after compaction");
  assert.match(loadYjsDocument(ws, documentId).getText("plain").toString(), /w5 tail$/);
  ws.close();
});

test("sequence allocation is atomic across processes sharing one database", { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "noma-yjs-"));
  const dbPath = join(dir, "enterprise.db");
  try {
    const { ws, session, documentId } = harness(dbPath);
    ws.close();
    const moduleUrl = pathToFileURL(resolve("src/enterprise-yjs.ts")).href;
    const workspaceUrl = pathToFileURL(resolve("src/enterprise-workspace.ts")).href;
    const script = `
      const Y = await import("yjs");
      const { persistYjsUpdate } = await import(${JSON.stringify(moduleUrl)});
      const { EnterpriseWorkspace } = await import(${JSON.stringify(workspaceUrl)});
      const ws = new EnterpriseWorkspace({ dbPath: ${JSON.stringify(dbPath)} });
      const actor = ws.authenticate(${JSON.stringify(session.token)});
      for (let i = 0; i < 40; i++) {
        const doc = new Y.Doc();
        doc.getText("plain").insert(0, process.argv.at(-1) + i);
        persistYjsUpdate(ws, actor, ${JSON.stringify(documentId)}, Y.encodeStateAsUpdate(doc));
      }
      ws.close();
    `;
    const spawn = (tag: string) =>
      run(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, tag], { cwd: process.cwd() });
    await Promise.all([spawn("a"), spawn("b"), spawn("c")]);
    const check = new EnterpriseWorkspace({ dbPath });
    const rows = check.store.db
      .prepare("SELECT seq FROM crdt_updates WHERE document_id = ? AND client_id = 'yjs' ORDER BY seq")
      .all(documentId) as Array<{ seq: number }>;
    assert.equal(rows.length, 120);
    assert.deepEqual(
      rows.map((row) => row.seq),
      Array.from({ length: 120 }, (_, i) => i + 1),
    );
    check.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("relay authenticates via subprotocol or Authorization header, never the query string by default", async () => {
  const r = await relay();
  try {
    await assert.rejects(connect(r.server.port, r.documentId, { query: `&token=${r.session.token}` }), /HTTP 401/);
    await assert.rejects(connect(r.server.port, r.documentId, bearer("not-a-session")), /HTTP 401/);
    const outsider = r.ws.loginOidc(r.session.actor.tenantId, "alice");
    r.ws.revokeSession(outsider.actor.sessionId);
    await assert.rejects(connect(r.server.port, r.documentId, bearer(outsider.token)), /HTTP 401/);

    const viaProtocol = await connect(r.server.port, r.documentId, bearer(r.session.token));
    assert.equal(viaProtocol.socket.protocol, YJS_SUBPROTOCOL, "the token is never echoed back as the selected protocol");
    const init = await viaProtocol.next("init");
    assert.equal(init.canEdit, true);
    const viaHeader = await connect(r.server.port, r.documentId, { headers: { authorization: `Bearer ${r.bob.token}` } });
    await viaHeader.next("init");
    viaProtocol.socket.close();
    viaHeader.socket.close();
  } finally {
    await r.dispose();
  }
  const legacy = await relay({ allowQueryToken: true });
  try {
    const client = await connect(legacy.server.port, legacy.documentId, { query: `&token=${legacy.session.token}` });
    await client.next("init");
    client.socket.close();
  } finally {
    await legacy.dispose();
  }
});

test("relay persists before ack, relays to peers, enforces editor role, and compacts", async () => {
  const r = await relay({ compactAfter: 3 });
  try {
    const alice = await connect(r.server.port, r.documentId, bearer(r.session.token));
    const bob = await connect(r.server.port, r.documentId, bearer(r.bob.token));
    const viewer = await connect(r.server.port, r.documentId, bearer(r.victor.token));
    await alice.next("init");
    await bob.next("init");
    assert.equal((await viewer.next("init")).canEdit, false);

    const mirror = new Y.Doc();
    for (let i = 0; i < 4; i++) {
      const update = textUpdate(`u${i} `, mirror);
      Y.applyUpdate(mirror, update);
      alice.socket.send(JSON.stringify({ type: "update", update: Buffer.from(update).toString("base64") }));
      const ack = await alice.next("ack");
      assert.equal(typeof ack.seq, "number");
      await bob.next("update");
    }
    assert.ok(yjsPersistedCount(r.ws, r.documentId) < 4, "compaction ran once the threshold was reached");
    assert.equal(loadYjsDocument(r.ws, r.documentId).getText("plain").toString(), "u0 u1 u2 u3 ");

    viewer.socket.send(JSON.stringify({ type: "update", update: Buffer.from(textUpdate("nope")).toString("base64") }));
    assert.match(String((await viewer.next("error")).message), /editor/);
    assert.doesNotMatch(loadYjsDocument(r.ws, r.documentId).getText("plain").toString(), /nope/);
    for (const client of [alice, bob, viewer]) client.socket.close();
  } finally {
    await r.dispose();
  }
});

test("presence is relayed with server-asserted identity and cleared on disconnect", async () => {
  const r = await relay();
  try {
    const alice = await connect(r.server.port, r.documentId, bearer(r.session.token));
    await alice.next("init");
    alice.socket.send(JSON.stringify({ type: "presence", state: { cursor: 3, principalId: "spoofed" } }));
    await new Promise((done) => setTimeout(done, 50));
    const bob = await connect(r.server.port, r.documentId, bearer(r.bob.token));
    const init = await bob.next("init");
    const listed = init.presence as Array<{ name: string; principalId: string; state: { cursor: number } }>;
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.name, "Alice");
    assert.equal(listed[0]?.principalId, r.session.actor.principalId);
    assert.equal(listed[0]?.state.cursor, 3);

    bob.socket.send(JSON.stringify({ type: "presence", state: { cursor: 9 } }));
    const seen = await alice.next("presence");
    assert.equal(seen.name, "Bob");
    bob.socket.send(JSON.stringify({ type: "presence", state: { blob: "x".repeat(5_000) } }));
    assert.match(String((await bob.next("error")).message), /too large/);

    alice.socket.close();
    const left = await bob.next("presence", (m) => m.state === null);
    assert.equal(left.name, "Alice");
    assert.equal(r.server.relay.presence(r.documentId).length, 1);
    bob.socket.close();
  } finally {
    await r.dispose();
  }
});

test("idle rooms are evicted and reloaded from disk on the next connection", async () => {
  const r = await relay({ roomIdleMs: 50 });
  try {
    const alice = await connect(r.server.port, r.documentId, bearer(r.session.token));
    await alice.next("init");
    alice.socket.send(JSON.stringify({ type: "update", update: Buffer.from(textUpdate("kept")).toString("base64") }));
    await alice.next("ack");
    assert.deepEqual(r.server.relay.roomIds(), [r.documentId]);
    alice.socket.close();
    await new Promise((done) => setTimeout(done, 250));
    assert.deepEqual(r.server.relay.roomIds(), []);

    const again = await connect(r.server.port, r.documentId, bearer(r.session.token));
    const init = await again.next("init");
    const doc = new Y.Doc();
    Y.applyUpdate(doc, new Uint8Array(Buffer.from(String(init.update), "base64")));
    assert.equal(doc.getText("plain").toString(), "kept");
    again.socket.close();
  } finally {
    await r.dispose();
  }
});

test("hosted Tiptap/Yjs replicates across two browsers and survives reconnect", { timeout: 120_000 }, async (t) => {
  const { ws, session, documentId } = harness();
  const script = await bundleCollab();
  const server = await listenEnterpriseCollab({ workspace: ws, editorHtml: enterpriseCollabHtml(script) });
  const origin = `${server.url}/collab?documentId=${encodeURIComponent(documentId)}#token=${encodeURIComponent(session.token)}`;
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
  await pageA.waitForFunction(
    () => (window as unknown as { nomaCollab: { peers: () => string[] } }).nomaCollab.peers().includes("Alice"),
    { timeout: 15_000 },
  );

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
