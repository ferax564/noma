import assert from "node:assert/strict";
import test from "node:test";
import { createCloudUser, createSpace, json, request, startCloudServer } from "./cloud-wiki-harness.js";

interface ChannelResponse {
  id: string;
  name: string;
  topic?: string;
  lastSeq: number;
  joined: boolean;
  unread?: number;
}

interface MessageResponse {
  id: string;
  seq: number;
  kind: "message" | "system";
  body: string;
  replyCount: number;
  deletedAt?: string;
  mentions: Array<{ id: string }>;
}

async function mcpStatus(base: string, token: string, name: string, args: Record<string, unknown>): Promise<number> {
  const response = await request(`${base}/api/gateway/mcp`, { method: "POST", token, body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } } });
  return response.status;
}

test("chat input validation, pagination, and search escaping", async () => {
  const harness = await startCloudServer("noma-chat-edge-");
  const { base } = harness;
  try {
    const ada = await createCloudUser(base, "Ada Lovelace");
    const { site } = await createSpace(base, ada.token, "Delivery", []);
    const other = await createSpace(base, ada.token, "Other", []);
    assert.equal((await request(`${base}/api/channels`)).status, 401, "chat needs a signed-in user");
    await json(`${base}/api/channels`, { method: "POST", token: ada.token, body: { siteId: site.id, name: "!!!" }, expectedStatus: 400 });
    await json(`${base}/api/channels`, { method: "POST", token: ada.token, body: { siteId: site.id, name: "x", visibility: "secret" }, expectedStatus: 400 });
    const channel = await json<ChannelResponse>(`${base}/api/channels`, { method: "POST", token: ada.token, body: { siteId: site.id, name: "general" } });
    const elsewhere = await json<ChannelResponse>(`${base}/api/channels`, { method: "POST", token: ada.token, body: { siteId: other.site.id, name: "general" } });
    assert.notEqual(elsewhere.id, channel.id, "names are unique per space, not globally");

    const messages = `${base}/api/channels/${channel.id}/messages`;
    await json(messages, { method: "POST", token: ada.token, body: { body: "   " }, expectedStatus: 400 });
    await json(messages, { method: "POST", token: ada.token, body: { body: "x".repeat(16_001) }, expectedStatus: 413 });
    const foreign = await json<MessageResponse>(`${base}/api/channels/${elsewhere.id}/messages`, { method: "POST", token: ada.token, body: { body: "other space" } });
    await json(messages, { method: "POST", token: ada.token, body: { body: "reply", threadId: foreign.id }, expectedStatus: 400 });

    for (let index = 1; index <= 7; index++) await json(messages, { method: "POST", token: ada.token, body: { body: `message ${index}` } });
    const latest = await json<{ messages: MessageResponse[]; lastSeq: number }>(`${messages}?limit=3`, { token: ada.token });
    assert.deepEqual(latest.messages.map((message) => message.seq), [5, 6, 7], "default page is the newest messages, oldest first");
    const older = await json<{ messages: MessageResponse[] }>(`${messages}?limit=3&before=5`, { token: ada.token });
    assert.deepEqual(older.messages.map((message) => message.seq), [2, 3, 4]);
    const newer = await json<{ messages: MessageResponse[] }>(`${messages}?limit=2&after=3`, { token: ada.token });
    assert.deepEqual(newer.messages.map((message) => message.seq), [4, 5]);
    await json(`${messages}?limit=0`, { token: ada.token, expectedStatus: 400 });

    await json(`${base}/api/channels/${channel.id}/read`, { method: "POST", token: ada.token, body: { seq: 99 }, expectedStatus: 400 });
    const read = await json<{ lastReadSeq: number }>(`${base}/api/channels/${channel.id}/read`, { method: "POST", token: ada.token, body: { seq: 3 } });
    assert.equal(read.lastReadSeq, 7, "the read marker never moves backwards");

    await json(messages, { method: "POST", token: ada.token, body: { body: "100% done_now" } });
    await json(messages, { method: "POST", token: ada.token, body: { body: "1000 donexnow" } });
    const percent = await json<{ results: Array<{ message: { body: string } }> }>(`${base}/api/chat/search?q=${encodeURIComponent("0% done_")}`, { token: ada.token });
    assert.deepEqual(percent.results.map((result) => result.message.body), ["100% done_now"], "% and _ are literal in search");
    await json(`${base}/api/chat/search?q=a`, { token: ada.token, expectedStatus: 400 });
    const scoped = await json<{ results: unknown[] }>(`${base}/api/chat/search?q=other&siteId=${site.id}`, { token: ada.token });
    assert.equal(scoped.results.length, 0, "siteId narrows search to one space");
  } finally {
    await harness.close();
  }
});

test("channel management: renames, topics, membership, leaving, deleted messages", async () => {
  const harness = await startCloudServer("noma-chat-manage-");
  const { base } = harness;
  try {
    const ada = await createCloudUser(base, "Ada Lovelace");
    const bob = await createCloudUser(base, "Bob Builder");
    const { site } = await createSpace(base, ada.token, "Delivery", []);
    await json(`${base}/api/sites/${site.id}/collaborators`, { method: "POST", token: ada.token, body: { userId: bob.id, role: "viewer" } });
    const general = await json<ChannelResponse>(`${base}/api/channels`, { method: "POST", token: ada.token, body: { siteId: site.id, name: "general" } });
    await json(`${base}/api/channels`, { method: "POST", token: ada.token, body: { siteId: site.id, name: "random" } });
    await json(`${base}/api/channels/${general.id}`, { method: "PATCH", token: ada.token, body: { name: "Random" }, expectedStatus: 409 });
    await json(`${base}/api/channels/${general.id}`, { method: "PATCH", token: bob.token, body: { topic: "mine" }, expectedStatus: 403 });
    const renamed = await json<ChannelResponse>(`${base}/api/channels/${general.id}`, { method: "PATCH", token: ada.token, body: { name: "announcements", topic: "Weekly updates" } });
    assert.deepEqual([renamed.name, renamed.topic], ["announcements", "Weekly updates"]);
    const timeline = await json<{ messages: MessageResponse[] }>(`${base}/api/channels/${general.id}/messages`, { token: ada.token });
    assert.deepEqual(timeline.messages.map((message) => [message.kind, message.body]), [["system", "renamed the channel to #announcements"]]);

    const post = await json<MessageResponse>(`${base}/api/channels/${general.id}/messages`, { method: "POST", token: bob.token, body: { body: "hello" } });
    await json(`${base}/api/channels/${general.id}/messages/${post.id}`, { method: "PATCH", token: bob.token, body: { body: `hello @{${ada.id}}` } });
    await json(`${base}/api/channels/${general.id}/messages/${post.id}`, { method: "PATCH", token: bob.token, body: { body: `hello again @{${ada.id}}` } });
    const adaNotes = await json<{ notifications: Array<{ type: string }> }>(`${base}/api/notifications`, { token: ada.token });
    assert.equal(adaNotes.notifications.filter((note) => note.type === "mention").length, 1, "a mention added by an edit notifies once");

    await json(`${base}/api/channels/${general.id}/messages/${post.id}/reactions`, { method: "POST", token: bob.token, body: { emoji: "two words" }, expectedStatus: 400 });
    const gone = await json<MessageResponse>(`${base}/api/channels/${general.id}/messages/${post.id}`, { method: "DELETE", token: bob.token });
    assert.ok(gone.deletedAt);
    assert.deepEqual(gone.mentions, []);
    await json(`${base}/api/channels/${general.id}/messages/${post.id}`, { method: "PATCH", token: bob.token, body: { body: "undo" }, expectedStatus: 409 });
    await json(`${base}/api/channels/${general.id}/messages/${post.id}/reactions`, { method: "POST", token: bob.token, body: { emoji: "👍" }, expectedStatus: 409 });
    assert.equal((await json<{ results: unknown[] }>(`${base}/api/chat/search?q=hello`, { token: ada.token })).results.length, 0, "deleted messages drop out of search");

    await json(`${base}/api/channels/${general.id}/leave`, { method: "POST", token: bob.token });
    let list = await json<{ channels: ChannelResponse[] }>(`${base}/api/channels?siteId=${site.id}`, { token: bob.token });
    assert.equal(list.channels.find((channel) => channel.id === general.id)?.joined, false);
    await json(`${base}/api/channels/${general.id}/join`, { method: "POST", token: bob.token });
    list = await json(`${base}/api/channels?siteId=${site.id}`, { token: bob.token });
    assert.equal(list.channels.find((channel) => channel.id === general.id)?.unread, 0, "joining starts at the latest message");

    const ops = await json<ChannelResponse>(`${base}/api/channels`, { method: "POST", token: ada.token, body: { siteId: site.id, name: "ops", visibility: "private", memberIds: [bob.id] } });
    await json(`${base}/api/channels/${ops.id}`, { token: bob.token });
    await json(`${base}/api/channels/${ops.id}/members/${ada.id}`, { method: "DELETE", token: bob.token, expectedStatus: 403 });
    await json(`${base}/api/channels/${ops.id}/leave`, { method: "POST", token: bob.token });
    await json(`${base}/api/channels/${ops.id}`, { token: bob.token, expectedStatus: 404 });

    await json(`${base}/api/sites/${site.id}/collaborators/${bob.id}`, { method: "DELETE", token: ada.token });
    await json(`${base}/api/channels/${general.id}`, { token: bob.token, expectedStatus: 404 });
    assert.equal((await json<{ channels: unknown[] }>(`${base}/api/channels`, { token: bob.token })).channels.length, 0, "losing space access hides every channel");
  } finally {
    await harness.close();
  }
});

test("archived and trashed spaces freeze or hide their channels", async () => {
  const harness = await startCloudServer("noma-chat-archive-");
  const { base } = harness;
  try {
    const ada = await createCloudUser(base, "Ada Lovelace");
    const { site } = await createSpace(base, ada.token, "Delivery", []);
    const channel = await json<ChannelResponse>(`${base}/api/channels`, { method: "POST", token: ada.token, body: { siteId: site.id, name: "general" } });
    const post = await json<MessageResponse>(`${base}/api/channels/${channel.id}/messages`, { method: "POST", token: ada.token, body: { body: "before archive" } });
    await json(`${base}/api/sites/${site.id}/archive`, { method: "POST", token: ada.token });
    await json(`${base}/api/channels/${channel.id}/messages`, { method: "POST", token: ada.token, body: { body: "after" }, expectedStatus: 409 });
    await json(`${base}/api/channels/${channel.id}/messages/${post.id}`, { method: "DELETE", token: ada.token, expectedStatus: 409 });
    await json(`${base}/api/channels`, { method: "POST", token: ada.token, body: { siteId: site.id, name: "new" }, expectedStatus: 409 });
    const detail = await json<{ access: { canPost: boolean } }>(`${base}/api/channels/${channel.id}`, { token: ada.token });
    assert.equal(detail.access.canPost, false);
    assert.equal((await json<{ messages: unknown[] }>(`${base}/api/channels/${channel.id}/messages`, { token: ada.token })).messages.length, 1, "archived channels stay readable");
    await json(`${base}/api/sites/${site.id}/unarchive`, { method: "POST", token: ada.token });
    await json(`${base}/api/trash/site/${site.id}`, { method: "POST", token: ada.token });
    await json(`${base}/api/channels/${channel.id}`, { token: ada.token, expectedStatus: 404 });
    assert.equal((await json<{ channels: unknown[] }>(`${base}/api/channels`, { token: ada.token })).channels.length, 0);
  } finally {
    await harness.close();
  }
});

test("agents lose chat when their grant, capability, or status goes away", async () => {
  const harness = await startCloudServer("noma-chat-agent-revoke-");
  const { base } = harness;
  try {
    const ada = await createCloudUser(base, "Ada Lovelace");
    const { site } = await createSpace(base, ada.token, "Delivery", []);
    const agent = await json<{ id: string }>(`${base}/api/agents`, { method: "POST", token: ada.token, body: { name: "Runner", capabilities: ["chat"] } });
    const other = await createSpace(base, ada.token, "Other", []);
    await json(`${base}/api/agents/${agent.id}/access`, { method: "POST", token: ada.token, body: { resourceType: "site", resourceId: other.site.id, role: "viewer" } });
    const channel = await json<ChannelResponse>(`${base}/api/channels`, { method: "POST", token: ada.token, body: { siteId: site.id, name: "ci" } });
    const ask = await json<MessageResponse>(`${base}/api/channels/${channel.id}/messages`, { method: "POST", token: ada.token, body: { body: `@{${agent.id}} run it` } });
    assert.deepEqual(ask.mentions, [], "a grant on another space does not count");
    assert.equal(await mcpStatus(base, ada.token, "chat_post", { agentId: agent.id, channelId: channel.id, body: "hi" }), 404);
    await json(`${base}/api/agents/${agent.id}/access`, { method: "POST", token: ada.token, body: { resourceType: "site", resourceId: site.id, role: "viewer" } });
    const again = await json<MessageResponse>(`${base}/api/channels/${channel.id}/messages`, { method: "POST", token: ada.token, body: { body: `@{${agent.id}} run it now` } });
    assert.equal(again.mentions.length, 1);
    assert.equal((await json<{ mentions: unknown[] }>(`${base}/api/agents/${agent.id}/chat`, { token: ada.token })).mentions.length, 1);
    await json(`${base}/api/agents/${agent.id}/chat?status=bogus`, { token: ada.token, expectedStatus: 400 });
    const unmentioned = await json<MessageResponse>(`${base}/api/channels/${channel.id}/messages/${again.id}`, { method: "PATCH", token: ada.token, body: { body: "never mind, done by hand" } });
    assert.deepEqual(unmentioned.mentions, [], "editing a mention away removes it");
    assert.equal((await json<{ mentions: unknown[] }>(`${base}/api/agents/${agent.id}/chat?status=all`, { token: ada.token })).mentions.length, 0, "the agent no longer sees a request that was edited away");
    const stranger = await createCloudUser(base, "Mallory");
    assert.equal(await mcpStatus(base, stranger.token, "chat_inbox", { agentId: agent.id }), 403, "only the owner drives the agent");
  } finally {
    await harness.close();
  }
});

test("live streams are capped per user", async () => {
  const harness = await startCloudServer("noma-chat-stream-cap-");
  const { base } = harness;
  const controllers: AbortController[] = [];
  try {
    const ada = await createCloudUser(base, "Ada Lovelace");
    const { site } = await createSpace(base, ada.token, "Delivery", []);
    const channel = await json<ChannelResponse>(`${base}/api/channels`, { method: "POST", token: ada.token, body: { siteId: site.id, name: "live" } });
    const open = async (): Promise<number> => {
      const controller = new AbortController();
      controllers.push(controller);
      const response = await fetch(`${base}/api/channels/${channel.id}/stream`, { headers: { authorization: `Bearer ${ada.token}` }, signal: controller.signal });
      return response.status;
    };
    for (let index = 0; index < 20; index++) assert.equal(await open(), 200);
    assert.equal(await open(), 429);
    controllers.shift()!.abort();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await open(), 200, "closing a stream frees a slot");
  } finally {
    for (const controller of controllers) controller.abort();
    await harness.close();
  }
});

test("capturing a long thread keeps every reply", async () => {
  const harness = await startCloudServer("noma-chat-capture-");
  const { base } = harness;
  try {
    const ada = await createCloudUser(base, "Ada Lovelace");
    const { site } = await createSpace(base, ada.token, "Delivery", []);
    const channel = await json<ChannelResponse>(`${base}/api/channels`, { method: "POST", token: ada.token, body: { siteId: site.id, name: "long" } });
    const root = await json<MessageResponse>(`${base}/api/channels/${channel.id}/messages`, { method: "POST", token: ada.token, body: { body: "Long discussion" } });
    const replies: MessageResponse[] = [];
    for (let index = 1; index <= 205; index++) {
      replies.push(await json<MessageResponse>(`${base}/api/channels/${channel.id}/messages`, { method: "POST", token: ada.token, body: { body: `turn ${index}`, threadId: root.id } }));
    }
    const captured = await json<{ document: { source: string } }>(`${base}/api/channels/${channel.id}/messages/${root.id}/page`, { method: "POST", token: ada.token, body: {} });
    const turns = captured.document.source.match(/:::message\{/g) ?? [];
    assert.equal(turns.length, 206, "root plus all 205 replies");
    assert.match(captured.document.source, new RegExp(`msg-${replies[0]!.id}`), "the oldest reply is kept");
    assert.match(captured.document.source, new RegExp(`msg-${replies[204]!.id}`));
  } finally {
    await harness.close();
  }
});
