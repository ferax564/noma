import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { walk } from "../src/ast.js";
import { parse } from "../src/parser.js";
import { validate } from "../src/validator.js";
import { readZip } from "../src/zip.js";
import { createCloudUser, createSpace, json, request, startCloudServer } from "./cloud-wiki-harness.js";

interface ChannelResponse {
  id: string;
  kind: "channel" | "dm";
  name: string;
  title?: string;
  unread?: number;
  members?: Array<{ id: string }>;
}

interface FileResponse {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  image: boolean;
  url: string;
}

interface MessageResponse {
  id: string;
  seq: number;
  body: string;
  threadId?: string;
  deletedAt?: string;
  links: { files: FileResponse[] };
}

const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");

async function upload(base: string, token: string, channelId: string, data: Buffer, filename: string, type = "application/octet-stream"): Promise<{ status: number; body: FileResponse & { error?: string } }> {
  const response = await fetch(`${base}/api/channels/${channelId}/files`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": type, "x-filename": filename },
    body: data,
  });
  return { status: response.status, body: (await response.json()) as FileResponse & { error?: string } };
}

test("direct and group messages: members only, one conversation per member set, notifications", async () => {
  const harness = await startCloudServer("noma-chat-dm-");
  const { base } = harness;
  try {
    const ada = await createCloudUser(base, "Ada Lovelace");
    const bob = await createCloudUser(base, "Bob Builder");
    const cy = await createCloudUser(base, "Cyrus Chen");
    const eve = await createCloudUser(base, "Eve Outsider");
    const { site } = await createSpace(base, ada.token, "Delivery", []);
    for (const user of [bob, cy]) await json(`${base}/api/sites/${site.id}/collaborators`, { method: "POST", token: ada.token, body: { userId: user.id, role: "viewer" } });

    await json(`${base}/api/chat/dms`, { method: "POST", token: ada.token, body: { memberIds: [eve.id] }, expectedStatus: 400 });
    await json(`${base}/api/chat/dms`, { method: "POST", token: ada.token, body: { memberIds: [ada.id] }, expectedStatus: 400 });
    const dm = await json<ChannelResponse>(`${base}/api/chat/dms`, { method: "POST", token: ada.token, body: { memberIds: [bob.id] } });
    assert.equal(dm.kind, "dm");
    assert.equal(dm.title, "Bob Builder");
    const again = await json<ChannelResponse>(`${base}/api/chat/dms`, { method: "POST", token: bob.token, body: { memberIds: [ada.id] } });
    assert.equal(again.id, dm.id, "the same pair reuses one conversation");
    assert.equal(again.title, "Ada Lovelace");

    await json(`${base}/api/channels/${dm.id}`, { token: cy.token, expectedStatus: 404 });
    await json(`${base}/api/channels/${dm.id}/messages`, { method: "POST", token: cy.token, body: { body: "hi" }, expectedStatus: 404 });
    await json(`${base}/api/channels/${dm.id}/messages`, { method: "POST", token: ada.token, body: { body: "Lunch at 12?" } });
    await json(`${base}/api/channels/${dm.id}/messages`, { method: "POST", token: ada.token, body: { body: "Or 1pm" } });
    const bobNotes = await json<{ notifications: Array<{ title: string }> }>(`${base}/api/notifications`, { token: bob.token });
    assert.equal(bobNotes.notifications.filter((note) => note.title === "Ada Lovelace sent you a message").length, 1, "one notification per unread stretch");
    const bobDms = await json<{ dms: ChannelResponse[] }>(`${base}/api/chat/dms`, { token: bob.token });
    assert.deepEqual(bobDms.dms.map((item) => [item.id, item.title, item.unread]), [[dm.id, "Ada Lovelace", 2]]);
    assert.equal((await json<{ channels: ChannelResponse[] }>(`${base}/api/channels?siteId=${site.id}`, { token: ada.token })).channels.length, 0, "DMs are not space channels");

    const root = await json<MessageResponse>(`${base}/api/channels/${dm.id}/messages`, { method: "POST", token: bob.token, body: { body: "Let's track this" } });
    await json(`${base}/api/channels/${dm.id}/messages/${root.id}/page`, { method: "POST", token: bob.token, body: {}, expectedStatus: 409 });
    await json(`${base}/api/channels/${dm.id}/messages/${root.id}/issue`, { method: "POST", token: bob.token, body: {}, expectedStatus: 409 });
    await json(`${base}/api/channels/${dm.id}`, { method: "PATCH", token: ada.token, body: { topic: "x" }, expectedStatus: 409 });

    const group = await json<ChannelResponse>(`${base}/api/chat/dms`, { method: "POST", token: ada.token, body: { memberIds: [bob.id, cy.id] } });
    assert.notEqual(group.id, dm.id);
    assert.equal(group.title, "Bob Builder, Cyrus Chen");
    await json(`${base}/api/channels/${dm.id}/members`, { method: "POST", token: ada.token, body: { memberId: eve.id }, expectedStatus: 400 });
    await json(`${base}/api/channels/${dm.id}/members`, { method: "POST", token: ada.token, body: { memberId: bob.id } });
    const same = await json<ChannelResponse>(`${base}/api/chat/dms`, { method: "POST", token: ada.token, body: { memberIds: [bob.id] } });
    assert.equal(same.id, dm.id, "re-adding an existing member keeps the pair's conversation");
    await json(`${base}/api/channels/${dm.id}/members`, { method: "POST", token: ada.token, body: { memberId: cy.id } });
    const fresh = await json<ChannelResponse>(`${base}/api/chat/dms`, { method: "POST", token: ada.token, body: { memberIds: [bob.id] } });
    assert.notEqual(fresh.id, dm.id, "a DM that grew into a group no longer stands in for the pair");
    await json(`${base}/api/channels/${fresh.id}/members/${ada.id}`, { method: "DELETE", token: ada.token });
    const rejoined = await json<ChannelResponse>(`${base}/api/chat/dms`, { method: "POST", token: ada.token, body: { memberIds: [bob.id] } });
    assert.notEqual(rejoined.id, fresh.id, "leaving through the members route retires the pair's conversation");

    const found = await json<{ dms: Array<{ id: string }>; messages: Array<{ channelId: string }> }>(`${base}/api/find?q=lunch`, { token: bob.token });
    assert.deepEqual(found.messages.map((message) => message.channelId), [dm.id]);
    assert.equal((await json<{ messages: unknown[] }>(`${base}/api/find?q=lunch`, { token: eve.token })).messages.length, 0);
  } finally {
    await harness.close();
  }
});

test("chat files: upload, share, download by members only, type and quota checks", async () => {
  const harness = await startCloudServer("noma-chat-files-", { attachmentQuotaBytes: 4_000 });
  const { base } = harness;
  try {
    const ada = await createCloudUser(base, "Ada Lovelace");
    const bob = await createCloudUser(base, "Bob Builder");
    const eve = await createCloudUser(base, "Eve Outsider");
    const { site } = await createSpace(base, ada.token, "Delivery", []);
    await json(`${base}/api/sites/${site.id}/collaborators`, { method: "POST", token: ada.token, body: { userId: bob.id, role: "viewer" } });
    const channel = await json<ChannelResponse>(`${base}/api/channels`, { method: "POST", token: ada.token, body: { siteId: site.id, name: "design" } });

    const png = await upload(base, ada.token, channel.id, PNG, "mock.png", "image/png");
    assert.equal(png.status, 201);
    assert.equal(png.body.contentType, "image/png");
    assert.equal(png.body.image, true);
    const exe = await upload(base, ada.token, channel.id, Buffer.from("MZ\x90\x00binary"), "tool.exe");
    assert.equal(exe.status, 415);
    assert.equal((await upload(base, eve.token, channel.id, PNG, "x.png")).status, 404);

    const unshared = await request(`${base}/api/channels/${channel.id}/files/${png.body.id}`, { token: bob.token });
    assert.equal(unshared.status, 404, "unshared uploads stay private to the uploader");
    await json(`${base}/api/channels/${channel.id}/messages`, { method: "POST", token: bob.token, body: { body: "stealing", fileIds: [png.body.id] }, expectedStatus: 400 });
    const message = await json<MessageResponse>(`${base}/api/channels/${channel.id}/messages`, { method: "POST", token: ada.token, body: { body: "", fileIds: [png.body.id] } });
    assert.equal(message.body, "mock.png", "a files-only message is labelled by its files");
    assert.deepEqual(message.links.files.map((file) => [file.id, file.url]), [[png.body.id, `/api/channels/${channel.id}/files/${png.body.id}`]]);
    await json(`${base}/api/channels/${channel.id}/messages`, { method: "POST", token: ada.token, body: { body: "again", fileIds: [png.body.id] }, expectedStatus: 400 });

    const download = await fetch(`${base}/api/channels/${channel.id}/files/${png.body.id}`, { headers: { authorization: `Bearer ${bob.token}` } });
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("content-type"), "image/png");
    assert.match(download.headers.get("content-security-policy") ?? "", /sandbox/);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), PNG);
    assert.equal((await request(`${base}/api/channels/${channel.id}/files/${png.body.id}`, { token: eve.token })).status, 404);

    const draft = await upload(base, ada.token, channel.id, Buffer.alloc(2_000, 66), "draft.txt", "text/plain");
    assert.equal(draft.status, 201);
    assert.equal((await upload(base, ada.token, channel.id, Buffer.alloc(2_000, 67), "second.txt", "text/plain")).status, 413);
    await json(`${base}/api/channels/${channel.id}/files/${draft.body.id}`, { method: "DELETE", token: bob.token, expectedStatus: 404 });
    await json(`${base}/api/channels/${channel.id}/files/${png.body.id}`, { method: "DELETE", token: ada.token, expectedStatus: 409 });
    await json(`${base}/api/channels/${channel.id}/files/${draft.body.id}`, { method: "DELETE", token: ada.token });
    assert.equal((await upload(base, ada.token, channel.id, Buffer.alloc(2_000, 67), "second.txt", "text/plain")).status, 201, "removing a pending upload frees its quota");

    const big = await upload(base, ada.token, channel.id, Buffer.alloc(3_990, 65), "notes.txt", "text/plain");
    assert.equal(big.status, 413, "chat files count against the space's storage quota");
    assert.equal((big.body as unknown as { code: string }).code, "attachment_quota_exceeded");
  } finally {
    await harness.close();
  }
});

test("edit history, channel exports, eDiscovery, and audit", async () => {
  const harness = await startCloudServer("noma-chat-ediscovery-");
  const { base } = harness;
  try {
    const admin = await createCloudUser(base, "Ada Admin");
    const bob = await createCloudUser(base, "Bob Builder");
    const { site } = await createSpace(base, admin.token, "Delivery", []);
    await json(`${base}/api/sites/${site.id}/collaborators`, { method: "POST", token: admin.token, body: { userId: bob.id, role: "viewer" } });
    const channel = await json<ChannelResponse>(`${base}/api/channels`, { method: "POST", token: admin.token, body: { siteId: site.id, name: "general" } });
    const original = await json<MessageResponse>(`${base}/api/channels/${channel.id}/messages`, { method: "POST", token: bob.token, body: { body: "The budget is 10k" } });
    await json(`${base}/api/channels/${channel.id}/messages/${original.id}`, { method: "PATCH", token: bob.token, body: { body: "The budget is 12k" } });
    const reply = await json<MessageResponse>(`${base}/api/channels/${channel.id}/messages`, { method: "POST", token: bob.token, body: { body: "## heading-like\n::not a fence", threadId: original.id } });
    await json(`${base}/api/channels/${channel.id}/messages/${reply.id}`, { method: "DELETE", token: admin.token });
    const secret = await json<ChannelResponse>(`${base}/api/channels`, { method: "POST", token: admin.token, body: { siteId: site.id, name: "hr", visibility: "private" } });
    await json(`${base}/api/channels/${secret.id}/messages`, { method: "POST", token: admin.token, body: { body: "private matter" } });
    const dm = await json<ChannelResponse>(`${base}/api/chat/dms`, { method: "POST", token: bob.token, body: { memberIds: [admin.id] } });
    await json(`${base}/api/channels/${dm.id}/messages`, { method: "POST", token: bob.token, body: { body: "quick question" } });

    await json(`${base}/api/channels/${channel.id}/export`, { token: bob.token, expectedStatus: 403 });
    const bundle = await json<{ format: string; digest: string; messages: Array<{ id: string; body: string; deletedAt?: string; revisions: Array<{ body: string; action: string; revisedBy: string }> }> }>(`${base}/api/channels/${channel.id}/export`, { token: admin.token });
    assert.equal(bundle.format, "noma-chat-export-v1");
    assert.match(bundle.digest, /^[0-9a-f]{64}$/);
    const edited = bundle.messages.find((message) => message.id === original.id)!;
    assert.equal(edited.body, "The budget is 12k");
    assert.deepEqual(edited.revisions.map((revision) => [revision.action, revision.body]), [["edit", "The budget is 10k"]]);
    const removed = bundle.messages.find((message) => message.id === reply.id)!;
    assert.ok(removed.deletedAt);
    assert.equal(removed.body, "");
    assert.deepEqual(removed.revisions.map((revision) => [revision.action, revision.body, revision.revisedBy]), [["delete", "## heading-like\n::not a fence", admin.id]]);

    const transcript = await request<string>(`${base}/api/channels/${channel.id}/export?format=noma`, { token: admin.token });
    const doc = parse(transcript.body, { filename: "general.noma" });
    assert.deepEqual(validate(doc).filter((diagnostic) => diagnostic.severity === "error"), []);
    assert.ok([...walk(doc)].some((node) => node.id === `msg-${original.id}`));

    await json(`${base}/api/enterprise/chat-export`, { token: bob.token, expectedStatus: 403 });
    const discovery = await json<{ channels: Array<{ channel: { id: string; kind: string }; digest: string; messages: Array<{ body: string }> }> }>(`${base}/api/enterprise/chat-export?userId=${bob.id}`, { token: admin.token });
    const byChannel = new Map(discovery.channels.map((item) => [item.channel.id, item]));
    assert.ok(byChannel.has(dm.id), "admins can export DMs");
    assert.ok(byChannel.has(secret.id), "and private channels");
    assert.deepEqual(byChannel.get(secret.id)!.messages, [], "a userId filter keeps only that person's messages");
    assert.deepEqual(byChannel.get(dm.id)!.messages.map((message) => message.body), ["quick question"]);
    for (const item of discovery.channels) {
      assert.equal(item.digest, createHash("sha256").update(JSON.stringify(item.messages)).digest("hex"), "the digest covers exactly the filtered messages");
    }

    const audit = await json<{ events: Array<{ action: string }> }>(`${base}/api/enterprise/audit`, { token: admin.token });
    assert.ok(audit.events.some((event) => event.action === "chat.channel_exported"));
    assert.ok(audit.events.some((event) => event.action === "chat.ediscovery_exported"));
    const activity = await json<{ events: Array<{ action: string }> }>(`${base}/api/activity?site=${site.id}`, { token: admin.token });
    assert.ok(activity.events.some((event) => event.action === "chat.message_moderated"));
  } finally {
    await harness.close();
  }
});

test("chat retention removes old messages and files unless a legal hold protects them", async () => {
  const harness = await startCloudServer("noma-chat-retention-");
  const { base, clock } = harness;
  try {
    const admin = await createCloudUser(base, "Ada Admin");
    const { site: open } = await createSpace(base, admin.token, "Open", []);
    const { site: held } = await createSpace(base, admin.token, "Held", []);
    const openChannel = await json<ChannelResponse>(`${base}/api/channels`, { method: "POST", token: admin.token, body: { siteId: open.id, name: "general" } });
    const heldChannel = await json<ChannelResponse>(`${base}/api/channels`, { method: "POST", token: admin.token, body: { siteId: held.id, name: "general" } });
    const file = await upload(base, admin.token, openChannel.id, PNG, "old.png", "image/png");
    const old = await json<MessageResponse>(`${base}/api/channels/${openChannel.id}/messages`, { method: "POST", token: admin.token, body: { body: "old news", fileIds: [file.body.id] } });
    const oldRoot = await json<MessageResponse>(`${base}/api/channels/${openChannel.id}/messages`, { method: "POST", token: admin.token, body: { body: "old root" } });
    await json(`${base}/api/channels/${heldChannel.id}/messages`, { method: "POST", token: admin.token, body: { body: "held forever" } });

    clock.advance(40 * 86_400_000);
    await json(`${base}/api/channels/${openChannel.id}/messages`, { method: "POST", token: admin.token, body: { body: "recent reply", threadId: oldRoot.id } });
    await json(`${base}/api/channels/${openChannel.id}/messages`, { method: "POST", token: admin.token, body: { body: "recent" } });

    await json(`${base}/api/enterprise`, { method: "PUT", token: admin.token, body: { connectorAllowlist: ["github"], modelAllowlist: ["local-deterministic"], chatRetentionDays: 30, legalHoldEnabled: true } });
    await json(`${base}/api/enterprise/legal-holds`, { method: "POST", token: admin.token, body: { resourceType: "site", resourceId: held.id, reason: "litigation" } });
    const result = await json<{ chat: { deletedMessages: number; blankedRoots: number; protectedMessages: number; deletedFiles: number; blobsRemoved: number } }>(`${base}/api/enterprise/retention`, { method: "POST", token: admin.token });
    assert.equal(result.chat.deletedMessages, 1, "the old message goes");
    assert.equal(result.chat.blankedRoots, 1, "the old root with a recent reply is blanked, not removed");
    assert.equal(result.chat.protectedMessages, 1, "the held space keeps its messages");
    assert.equal(result.chat.deletedFiles, 1);
    assert.equal(result.chat.blobsRemoved, 1);

    const timeline = await json<{ messages: MessageResponse[] }>(`${base}/api/channels/${openChannel.id}/messages`, { token: admin.token });
    assert.deepEqual(timeline.messages.map((message) => [message.body, Boolean(message.deletedAt)]), [["", true], ["recent", false]]);
    assert.equal(timeline.messages.some((message) => message.id === old.id), false);
    assert.equal((await request(`${base}/api/channels/${openChannel.id}/files/${file.body.id}`, { token: admin.token })).status, 404);
    const heldTimeline = await json<{ messages: MessageResponse[] }>(`${base}/api/channels/${heldChannel.id}/messages`, { token: admin.token });
    assert.deepEqual(heldTimeline.messages.map((message) => message.body), ["held forever"]);
  } finally {
    await harness.close();
  }
});

test("space exports carry public channel transcripts; the finder spans the product", async () => {
  const harness = await startCloudServer("noma-chat-export-find-");
  const { base } = harness;
  try {
    const ada = await createCloudUser(base, "Ada Lovelace");
    const eve = await createCloudUser(base, "Eve Outsider");
    const { site } = await createSpace(base, ada.token, "Delivery", ["# Release plan\n\nThe release train leaves Friday.\n"]);
    const project = await json<{ id: string }>(`${base}/api/projects`, { method: "POST", token: ada.token, body: { siteId: site.id, key: "SHIP", name: "Ship it" } });
    await json(`${base}/api/projects/${project.id}/issues`, { method: "POST", token: ada.token, body: { summary: "Release train checklist" } });
    const general = await json<ChannelResponse>(`${base}/api/channels`, { method: "POST", token: ada.token, body: { siteId: site.id, name: "release-train", topic: "::note Shipping" } });
    const secret = await json<ChannelResponse>(`${base}/api/channels`, { method: "POST", token: ada.token, body: { siteId: site.id, name: "secret", visibility: "private" } });
    await json(`${base}/api/channels/${general.id}/messages`, { method: "POST", token: ada.token, body: { body: "Release train boards at 9" } });
    await json(`${base}/api/channels/${secret.id}/messages`, { method: "POST", token: ada.token, body: { body: "Release train salary talk" } });

    const zip = await fetch(`${base}/api/sites/${site.id}/export?to=noma-zip`, { headers: { authorization: `Bearer ${ada.token}` } });
    const entries = new Map(readZip(new Uint8Array(await zip.arrayBuffer())).map((entry) => [entry.path, entry.data.toString("utf8")]));
    assert.ok(entries.has("chat/release-train.noma"));
    assert.equal(entries.has("chat/secret.noma"), false, "private channels stay out of space exports");
    assert.match(entries.get("chat/release-train.noma")!, /Release train boards at 9/);
    const transcript = parse(entries.get("chat/release-train.noma")!, { filename: "release-train.noma" });
    assert.deepEqual(validate(transcript).filter((diagnostic) => diagnostic.severity === "error"), []);
    assert.equal([...walk(transcript)].filter((node) => node.type === "directive" && node.name === "chat_channel").length, 1, "a block-like topic cannot swallow the channel block");
    const manifest = JSON.parse(entries.get("manifest.json")!) as { chat: Array<{ name: string; messages: number }> };
    assert.deepEqual(manifest.chat.map((channel) => [channel.name, channel.messages]), [["release-train", 1]]);

    const found = await json<{ spaces: unknown[]; pages: Array<{ title: string }>; issues: Array<{ key: string }>; channels: Array<{ name: string }>; messages: Array<{ excerpt: string }> }>(`${base}/api/find?q=release train`, { token: ada.token });
    assert.deepEqual(found.pages.map((page) => page.title), ["Release plan"]);
    assert.deepEqual(found.issues.map((issue) => issue.key), ["SHIP-1"]);
    assert.deepEqual(found.messages.map((message) => message.excerpt).sort(), ["Release train boards at 9", "Release train salary talk"]);
    const channels = await json<{ channels: Array<{ name: string }> }>(`${base}/api/find?q=release`, { token: ada.token });
    assert.deepEqual(channels.channels.map((channel) => channel.name), ["release-train"]);
    const outsider = await json<{ pages: unknown[]; issues: unknown[]; messages: unknown[]; channels: unknown[] }>(`${base}/api/find?q=release train`, { token: eve.token });
    assert.deepEqual([outsider.pages.length, outsider.issues.length, outsider.messages.length, outsider.channels.length], [0, 0, 0, 0]);
    await json(`${base}/api/find?q=r`, { token: ada.token, expectedStatus: 400 });
  } finally {
    await harness.close();
  }
});
