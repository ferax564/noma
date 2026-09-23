import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prosemirrorJSONToYDoc, yXmlFragmentToProseMirrorRootNode } from "y-prosemirror";
import WebSocket from "ws";
import * as Y from "yjs";
import { createNomaCloudServer, type NomaCloudServerOptions } from "../src/cloud-server.js";
import { canonicalEditorDoc, editorBlockKey, type EditorNode, nomaToEditorDoc } from "../src/editor-model.js";
import { EDITOR_YJS_FRAGMENT, editorFragment, editorNodeToYElement, yDocFromNoma, yFragmentToEditorDoc } from "../src/editor-yjs.js";
import { visualSchema } from "../web/cloud/visual-schema.js";

interface CloudUserResponse {
  id: string;
  name: string;
  token: string;
}

interface CloudDocument {
  id: string;
  title: string;
  source: string;
  hash: string;
}

interface JsonRequestOptions {
  method?: string;
  token?: string;
  share?: string;
  body?: unknown;
  expectedStatus?: number;
}

interface Harness {
  base: string;
  close: () => Promise<void>;
}

async function startCloudServer(prefix: string, collab: NomaCloudServerOptions["collab"] = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const publicDir = join(root, "public");
  await mkdir(publicDir, { recursive: true });
  await writeFile(join(publicDir, "index.html"), "<h1>Noma</h1>", "utf8");
  const server = createNomaCloudServer({
    dataDir: join(root, "data", "documents"),
    usersDir: join(root, "data", "users"),
    sitesDir: join(root, "data", "sites"),
    dbPath: join(root, "data", "noma-cloud.sqlite"),
    publicDir,
    maxBodyBytes: 100_000,
    rateLimitMaxRequests: 10_000,
    collab: { checkpointIntervalMs: 60_000, permissionCheckMs: 60_000, ...collab },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function createCloudUser(base: string, name: string): Promise<CloudUserResponse> {
  return json<CloudUserResponse>(`${base}/api/users`, { method: "POST", body: { name } });
}

async function json<T = { error?: string }>(url: string, options: JsonRequestOptions = {}): Promise<T> {
  const headers = new Headers({ accept: "application/json" });
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  if (options.share) headers.set("x-noma-share-token", options.share);
  if (options.body) headers.set("content-type", "application/json");
  const response = await fetch(url, { method: options.method ?? "GET", headers, body: options.body ? JSON.stringify(options.body) : undefined });
  if (options.expectedStatus !== undefined) {
    assert.equal(response.status, options.expectedStatus, await response.text());
    return {} as T;
  }
  if (!response.ok) assert.fail(`${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}

type ServerFrame = { type: string } & Record<string, unknown>;

class CollabTestClient {
  readonly doc = new Y.Doc();
  readonly frames: ServerFrame[] = [];
  closeCode: number | undefined;
  private waiters: Array<() => void> = [];
  private nextId = 1;
  private ready = false;

  private constructor(readonly ws: WebSocket) {
    ws.on("message", (raw: Buffer) => {
      const frame = JSON.parse(raw.toString("utf8")) as ServerFrame;
      if ((frame.type === "init" || frame.type === "update") && typeof frame.update === "string") {
        Y.applyUpdate(this.doc, new Uint8Array(Buffer.from(frame.update, "base64")), "remote");
        if (frame.type === "init") this.ready = true;
      }
      this.frames.push(frame);
      this.notify();
    });
    ws.on("close", (code: number) => {
      this.closeCode = code;
      this.notify();
    });
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === "remote" || !this.ready) return;
      this.ws.send(JSON.stringify({ type: "update", id: this.nextId++, update: Buffer.from(update).toString("base64") }));
    });
  }

  static async connect(base: string, documentId: string, auth: { token?: string; share?: string; headerToken?: string }): Promise<CollabTestClient> {
    const headers: Record<string, string> = { origin: base };
    if (auth.headerToken) headers.authorization = `Bearer ${auth.headerToken}`;
    const ws = new WebSocket(`${base.replace("http", "ws")}/api/collab/documents/${documentId}`, { headers });
    const client = new CollabTestClient(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    ws.send(JSON.stringify({ type: "hello", clientId: client.doc.clientID, token: auth.token, share: auth.share }));
    await client.waitFor(() => client.ready || client.closeCode !== undefined);
    return client;
  }

  private notify(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter();
  }

  async waitFor(predicate: () => boolean, label = "condition", timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 25);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  frame(type: string): ServerFrame | undefined {
    return this.frames.filter((frame) => frame.type === type).at(-1);
  }

  keys(): string[] {
    return yFragmentToEditorDoc(editorFragment(this.doc)).content.map(editorBlockKey);
  }

  text(): string {
    return JSON.stringify(yFragmentToEditorDoc(editorFragment(this.doc)));
  }

  appendParagraph(text: string): void {
    const fragment = editorFragment(this.doc);
    fragment.insert(fragment.length, [editorNodeToYElement({ type: "paragraph", content: [{ type: "text", text }] })]);
  }

  close(): Promise<void> {
    if (this.closeCode !== undefined) return Promise.resolve();
    return new Promise((resolve) => {
      this.ws.once("close", () => resolve());
      this.ws.close();
    });
  }
}

async function until(predicate: () => boolean | Promise<boolean>, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const SOURCE = "# Live Page\n\nFirst paragraph.\n\n## Agent Section {id=\"agent-section\"}\n\nAgent target paragraph.\n";

async function setup(prefix: string, collab: NomaCloudServerOptions["collab"] = {}): Promise<{ harness: Harness; owner: CloudUserResponse; editor: CloudUserResponse; viewer: CloudUserResponse; doc: CloudDocument }> {
  const harness = await startCloudServer(prefix, collab);
  const owner = await createCloudUser(harness.base, "Owner Olga");
  const editor = await createCloudUser(harness.base, "Editor Emil");
  const viewer = await createCloudUser(harness.base, "Viewer Vera");
  const doc = await json<CloudDocument>(`${harness.base}/api/documents`, { method: "POST", token: owner.token, body: { title: "Live Page", source: SOURCE } });
  for (const [user, role] of [[editor, "editor"], [viewer, "viewer"]] as const) {
    await json(`${harness.base}/api/documents/${doc.id}/collaborators`, { method: "POST", token: owner.token, body: { userId: user.id, role } });
  }
  return { harness, owner, editor, viewer, doc };
}

test("y-prosemirror and the server codec agree on the Yjs encoding of every example", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const files = readdirSync("examples").filter((name) => name.endsWith(".noma"));
  for (const name of files) {
    const source = readFileSync(join("examples", name), "utf8");
    const editorDoc = nomaToEditorDoc(source);
    const fromPm = prosemirrorJSONToYDoc(visualSchema, editorDoc, EDITOR_YJS_FRAGMENT);
    assert.deepEqual(yFragmentToEditorDoc(fromPm.getXmlFragment(EDITOR_YJS_FRAGMENT)), editorDoc, `${name}: server cannot read y-prosemirror output`);
    const fromServer = yDocFromNoma(source);
    const pmNode = yXmlFragmentToProseMirrorRootNode(fromServer.getXmlFragment(EDITOR_YJS_FRAGMENT), visualSchema);
    assert.deepEqual(canonicalEditorDoc(pmNode.toJSON() as EditorNode), editorDoc, `${name}: y-prosemirror cannot read server output`);
  }
});

test("two editors converge, updates are persisted before ack, and presence lists both", async (t) => {
  const { harness, owner, editor, doc } = await setup("noma-collab-converge-");
  t.after(() => harness.close());
  const alice = await CollabTestClient.connect(harness.base, doc.id, { token: owner.token });
  const bob = await CollabTestClient.connect(harness.base, doc.id, { headerToken: editor.token });
  t.after(async () => {
    await alice.close();
    await bob.close();
  });
  assert.equal(alice.frame("init")?.role, "owner");
  assert.equal(bob.frame("init")?.readOnly, false);
  await alice.waitFor(() => ((alice.frame("presence")?.presence as unknown[]) ?? []).length === 2, "presence of two");
  const names = ((alice.frame("presence")?.presence as Array<{ name: string }>) ?? []).map((entry) => entry.name).sort();
  assert.deepEqual(names, ["Editor Emil", "Owner Olga"]);

  alice.appendParagraph("Alice was here.");
  await alice.waitFor(() => alice.frames.some((frame) => frame.type === "ack"), "ack");
  const status = await json<{ pendingUpdates: number; clients: unknown[]; live: boolean }>(`${harness.base}/api/collab/documents/${doc.id}`, { token: owner.token });
  assert.ok(status.pendingUpdates >= 1, "update persisted before it was acknowledged");
  assert.equal(status.live, true);
  assert.equal(status.clients.length, 2);

  bob.appendParagraph("Bob too.");
  await until(() => alice.text().includes("Bob too.") && bob.text().includes("Alice was here."), "convergence");
  assert.deepEqual(alice.keys(), bob.keys());
  const stored = await json<CloudDocument>(`${harness.base}/api/documents/${doc.id}`, { token: owner.token });
  assert.equal(stored.source, SOURCE, "no revision is written before the checkpoint");
});

test("checkpoint coalesces activity into one revision and the last disconnect flushes", async (t) => {
  const { harness, owner, doc } = await setup("noma-collab-checkpoint-", { checkpointIntervalMs: 400 });
  t.after(() => harness.close());
  const alice = await CollabTestClient.connect(harness.base, doc.id, { token: owner.token });
  const before = await json<{ revisions: unknown[] }>(`${harness.base}/api/documents/${doc.id}/revisions`, { token: owner.token });
  for (let i = 1; i <= 5; i++) alice.appendParagraph(`Burst ${i}.`);
  await alice.waitFor(() => alice.frames.filter((frame) => frame.type === "ack").length === 5, "five acks");
  await alice.waitFor(() => alice.frames.some((frame) => frame.type === "saved"), "checkpoint saved", 5_000);
  const saved = alice.frame("saved")!;
  const stored = await json<CloudDocument>(`${harness.base}/api/documents/${doc.id}`, { token: owner.token });
  assert.equal(saved.hash, stored.hash);
  assert.equal(stored.source, `${SOURCE}\nBurst 1.\n\nBurst 2.\n\nBurst 3.\n\nBurst 4.\n\nBurst 5.\n`);
  const after = await json<{ revisions: Array<{ createdBy: string }> }>(`${harness.base}/api/documents/${doc.id}/revisions`, { token: owner.token });
  assert.equal(after.revisions.length, before.revisions.length + 1, "one coalesced revision");
  assert.equal(after.revisions[0]?.createdBy, owner.id);

  alice.appendParagraph("Parting words.");
  await alice.waitFor(() => alice.frames.filter((frame) => frame.type === "ack").length === 6, "sixth ack");
  await alice.close();
  await until(async () => (await json<CloudDocument>(`${harness.base}/api/documents/${doc.id}`, { token: owner.token })).source.includes("Parting words."), "flush on last disconnect");
  const reopened = await CollabTestClient.connect(harness.base, doc.id, { token: owner.token });
  t.after(() => reopened.close());
  assert.match(reopened.text(), /Parting words\./);
  assert.equal((await json<{ pendingUpdates: number }>(`${harness.base}/api/collab/documents/${doc.id}`, { token: owner.token })).pendingUpdates, 0, "room compacted after checkpoint");
});

test("viewers are read-only and anonymous sockets are refused", async (t) => {
  const { harness, owner, viewer, doc } = await setup("noma-collab-viewer-");
  t.after(() => harness.close());
  const alice = await CollabTestClient.connect(harness.base, doc.id, { token: owner.token });
  const vera = await CollabTestClient.connect(harness.base, doc.id, { token: viewer.token });
  t.after(async () => {
    await alice.close();
    await vera.close();
  });
  assert.equal(vera.frame("init")?.readOnly, true);
  vera.appendParagraph("Viewer vandalism.");
  await vera.waitFor(() => vera.frame("error")?.code === "read_only", "read_only error");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.doesNotMatch(alice.text(), /Viewer vandalism/);
  const status = await json<{ pendingUpdates: number }>(`${harness.base}/api/collab/documents/${doc.id}`, { token: owner.token });
  assert.equal(status.pendingUpdates, 0);

  const anonymous = await CollabTestClient.connect(harness.base, doc.id, {});
  assert.equal(anonymous.closeCode, 4401);
  const share = await json<{ token: string }>(`${harness.base}/api/documents/${doc.id}/shares`, { method: "POST", token: owner.token, body: { role: "viewer" } });
  const guest = await CollabTestClient.connect(harness.base, doc.id, { share: share.token });
  t.after(() => guest.close());
  assert.equal(guest.frame("init")?.readOnly, true);
  assert.equal((guest.frame("init")?.self as { name: string }).name, "Share-link guest");

  const crossSite = new WebSocket(`${harness.base.replace("http", "ws")}/api/collab/documents/${doc.id}`, { headers: { origin: "https://evil.example" } });
  const status403 = await new Promise<number>((resolve) => {
    crossSite.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    crossSite.once("open", () => resolve(101));
    crossSite.once("error", () => resolve(-1));
  });
  assert.equal(status403, 403);
});

test("revoked collaborators and trashed pages are disconnected", async (t) => {
  const { harness, owner, editor, doc } = await setup("noma-collab-revoke-", { permissionCheckMs: 100 });
  t.after(() => harness.close());
  const bob = await CollabTestClient.connect(harness.base, doc.id, { token: editor.token });
  await json(`${harness.base}/api/documents/${doc.id}/collaborators/${editor.id}`, { method: "DELETE", token: owner.token });
  await bob.waitFor(() => bob.closeCode !== undefined, "revocation close");
  assert.equal(bob.closeCode, 4403);
  assert.ok(bob.frames.some((frame) => frame.type === "revoked"));
  const refused = await CollabTestClient.connect(harness.base, doc.id, { token: editor.token });
  assert.equal(refused.closeCode, 4403);

  const alice = await CollabTestClient.connect(harness.base, doc.id, { token: owner.token });
  await json(`${harness.base}/api/trash/document/${doc.id}`, { method: "POST", token: owner.token });
  await alice.waitFor(() => alice.closeCode !== undefined, "trash close");
  assert.equal(alice.closeCode, 4403);
});

test("agent patches and API writes merge into the live document without clobbering live edits", async (t) => {
  const { harness, owner, editor, doc } = await setup("noma-collab-agent-");
  t.after(() => harness.close());
  const alice = await CollabTestClient.connect(harness.base, doc.id, { token: owner.token });
  const bob = await CollabTestClient.connect(harness.base, doc.id, { token: editor.token });
  t.after(async () => {
    await alice.close();
    await bob.close();
  });
  const fragment = editorFragment(alice.doc);
  const first = fragment.get(1) as Y.XmlElement;
  const text = first.get(0) as Y.XmlText;
  text.insert(text.length, " Edited live by Alice.");
  await alice.waitFor(() => alice.frames.some((frame) => frame.type === "ack"), "ack");

  const current = await json<CloudDocument>(`${harness.base}/api/documents/${doc.id}`, { token: owner.token });
  await json(`${harness.base}/api/realtime/documents/${doc.id}/operations`, {
    method: "POST",
    token: owner.token,
    body: {
      expectedHash: current.hash,
      ops: [{ op: "add_block", parent: "agent-section", content: "::callout{tone=\"info\"}\nAgent inserted this note.\n::" }],
    },
  });
  await until(() => alice.text().includes("Agent inserted this note.") && bob.text().includes("Agent inserted this note."), "agent patch reflected live");
  assert.match(alice.text(), /Edited live by Alice\./, "live edit survived the external write");
  assert.ok(bob.frames.some((frame) => frame.type === "saved"));

  const latest = await json<CloudDocument>(`${harness.base}/api/documents/${doc.id}`, { token: owner.token });
  await json(`${harness.base}/api/documents/${doc.id}`, {
    method: "PUT",
    token: owner.token,
    body: { expectedHash: latest.hash, source: latest.source.replace("Agent target paragraph.", "Agent target paragraph, rewritten by API.") },
  });
  await until(() => bob.text().includes("rewritten by API"), "API PUT reflected live");
  assert.match(bob.text(), /Edited live by Alice\./);

  await alice.close();
  await bob.close();
  await until(async () => (await json<CloudDocument>(`${harness.base}/api/documents/${doc.id}`, { token: owner.token })).source.includes("Edited live by Alice."), "final checkpoint");
  const final = await json<CloudDocument>(`${harness.base}/api/documents/${doc.id}`, { token: owner.token });
  assert.match(final.source, /First paragraph\. Edited live by Alice\./);
  assert.match(final.source, /::callout\{tone="info"\}\nAgent inserted this note\.\n::/);
  assert.match(final.source, /rewritten by API/);
  assert.match(final.source, /## Agent Section \{id="agent-section"\}/);
});

test("collab status route enforces document access", async (t) => {
  const { harness, doc } = await setup("noma-collab-status-");
  t.after(() => harness.close());
  const stranger = await createCloudUser(harness.base, "Stranger");
  await json(`${harness.base}/api/collab/documents/${doc.id}`, { token: stranger.token, expectedStatus: 403 });
  await json(`${harness.base}/api/collab/documents/${doc.id}`, { expectedStatus: 401 });
});
