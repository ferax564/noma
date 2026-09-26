import assert from "node:assert/strict";
import test from "node:test";
import { chatThreadToNoma, channelNameInput } from "../src/cloud/chat.js";
import { parse } from "../src/parser.js";
import { validate } from "../src/validator.js";
import { walk } from "../src/ast.js";
import { createCloudUser, createSpace, json, request, startCloudServer } from "./cloud-wiki-harness.js";

interface ChannelResponse {
  id: string;
  siteId: string;
  projectId?: string;
  name: string;
  topic?: string;
  visibility: "public" | "private";
  lastSeq: number;
  archivedAt?: string;
  joined: boolean;
  unread?: number;
  mentions?: number;
  lastReadSeq?: number;
  access?: { role: string; canManage: boolean; canPost: boolean };
  members?: Array<{ id: string; name: string; type: "user" | "agent"; role: string }>;
  agents?: Array<{ id: string; name: string }>;
  project?: { id: string; key: string };
}

interface MessageResponse {
  id: string;
  seq: number;
  threadId?: string;
  kind: "message" | "system";
  authorId: string;
  authorName: string;
  agent?: { id: string; name: string };
  body: string;
  replyCount: number;
  editedAt?: string;
  deletedAt?: string;
  reactions: Array<{ emoji: string; memberIds: string[] }>;
  mentions: Array<{ id: string; name: string; agent?: true }>;
  refs: Array<{ key: string; summary: string; status: string }>;
  links: { issues: Array<{ key: string }>; documents: Array<{ id: string; title: string }> };
}

async function mcp<T>(base: string, token: string, name: string, args: Record<string, unknown>): Promise<T> {
  const response = await json<{ result: { structuredContent: T } }>(`${base}/api/gateway/mcp`, {
    method: "POST",
    token,
    body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
  });
  return response.result.structuredContent;
}

test("channel names are normalised Slack-style", () => {
  assert.equal(channelNameInput("#Release Planning"), "release-planning");
  assert.equal(channelNameInput("  q3 -- launch!! "), "q3-launch");
  assert.throws(() => channelNameInput("!!!"), /letters or digits/);
});

test("thread transcripts are valid .noma with one stable block per message, even for hostile bodies", () => {
  const source = chatThreadToNoma({
    title: "Ship the {beta}?",
    channel: "launch",
    space: "Delivery",
    capturedAt: "2026-09-26T10:00:00.000Z",
    capturedBy: "Ada",
    messages: [
      { id: "m1aaaaaaaa", author: 'Ada "the Countess"', at: "2026-09-26T09:00:00.000Z", body: "Should we ship **today**?\n- risk: docs" },
      { id: "m2bbbbbbbb", author: "Bot owner", agent: "Release Bot", at: "2026-09-26T09:01:00.000Z", body: "::\n# not a heading\n````\nfence\n````" },
      { id: "m3cccccccc", author: "Bob", at: "2026-09-26T09:02:00.000Z", body: "```\nunclosed" },
    ],
  });
  const doc = parse(source, { filename: "thread.noma" });
  const errors = validate(doc).filter((diagnostic) => diagnostic.severity === "error");
  assert.deepEqual(errors, []);
  const ids = [...walk(doc)].map((node) => node.id).filter(Boolean);
  assert.ok(ids.includes("thread-m1aaaaaaaa"));
  assert.deepEqual(ids.filter((id) => id!.startsWith("msg-")), ["msg-m1aaaaaaaa", "msg-m2bbbbbbbb", "msg-m3cccccccc"]);
  assert.match(source, /agent="Release Bot"/);
  assert.match(source, /`{5}text\n::\n# not a heading/);
});

test("channels: space access, private membership, threads, reactions, unread, mentions, and search", async () => {
  const harness = await startCloudServer("noma-chat-");
  const { base } = harness;
  try {
    const ada = await createCloudUser(base, "Ada Lovelace");
    const bob = await createCloudUser(base, "Bob Builder");
    const eve = await createCloudUser(base, "Eve Outsider");
    const { site } = await createSpace(base, ada.token, "Delivery", []);
    await json(`${base}/api/sites/${site.id}/collaborators`, { method: "POST", token: ada.token, body: { userId: bob.id, role: "viewer" } });

    await json(`${base}/api/channels`, { method: "POST", token: bob.token, body: { siteId: site.id, name: "nope" }, expectedStatus: 403 });
    const general = await json<ChannelResponse>(`${base}/api/channels`, { method: "POST", token: ada.token, body: { siteId: site.id, name: "General Chat", topic: "Anything about delivery" } });
    assert.equal(general.name, "general-chat");
    assert.equal(general.visibility, "public");
    assert.equal(general.access?.canManage, true);
    await json(`${base}/api/channels`, { method: "POST", token: ada.token, body: { siteId: site.id, name: "general chat" }, expectedStatus: 409 });

    const bobList = await json<{ channels: ChannelResponse[] }>(`${base}/api/channels?siteId=${site.id}`, { token: bob.token });
    assert.deepEqual(bobList.channels.map((channel) => [channel.name, channel.joined]), [["general-chat", false]]);
    assert.deepEqual((await json<{ channels: ChannelResponse[] }>(`${base}/api/channels`, { token: eve.token })).channels, []);
    await json(`${base}/api/channels/${general.id}`, { token: eve.token, expectedStatus: 404 });
    await json(`${base}/api/channels/${general.id}/messages`, { method: "POST", token: eve.token, body: { body: "hi" }, expectedStatus: 404 });

    const root = await json<MessageResponse>(`${base}/api/channels/${general.id}/messages`, {
      method: "POST",
      token: ada.token,
      body: { body: `Kick-off: @{${bob.id}} can you own the release notes? @{${eve.id}} is not in this space.` },
    });
    assert.equal(root.seq, 1);
    assert.deepEqual(root.mentions.map((mention) => mention.name), ["Bob Builder"], "only people who can read the channel are mentioned");
    const bobNotes = await json<{ notifications: Array<{ type: string; title: string; resourceId?: string }> }>(`${base}/api/notifications`, { token: bob.token });
    assert.ok(bobNotes.notifications.some((note) => note.type === "mention" && note.title === "Ada Lovelace mentioned you in #general-chat" && note.resourceId === site.id));
    assert.equal((await json<{ notifications: unknown[] }>(`${base}/api/notifications`, { token: eve.token })).notifications.length, 0);

    const reply = await json<MessageResponse>(`${base}/api/channels/${general.id}/messages`, { method: "POST", token: bob.token, body: { body: "On it.", threadId: root.id } });
    assert.equal(reply.threadId, root.id);
    const nested = await json<MessageResponse>(`${base}/api/channels/${general.id}/messages`, { method: "POST", token: ada.token, body: { body: "Thanks!", threadId: reply.id } });
    assert.equal(nested.threadId, root.id, "replying to a reply stays in the root thread");

    const timeline = await json<{ messages: MessageResponse[]; lastSeq: number }>(`${base}/api/channels/${general.id}/messages`, { token: bob.token });
    assert.deepEqual(timeline.messages.map((message) => [message.id, message.replyCount]), [[root.id, 2]]);
    assert.equal(timeline.lastSeq, 3);
    const thread = await json<{ root: MessageResponse; replies: MessageResponse[] }>(`${base}/api/channels/${general.id}/messages/${reply.id}`, { token: bob.token });
    assert.equal(thread.root.id, root.id);
    assert.deepEqual(thread.replies.map((message) => message.body), ["On it.", "Thanks!"]);
    const poll = await json<{ messages: MessageResponse[] }>(`${base}/api/channels/${general.id}/messages?after=1&all=1`, { token: bob.token });
    assert.deepEqual(poll.messages.map((message) => message.seq), [2, 3]);

    let list = await json<{ channels: ChannelResponse[] }>(`${base}/api/channels?siteId=${site.id}`, { token: bob.token });
    assert.equal(list.channels[0]!.joined, true, "posting joins a public channel");
    assert.equal(list.channels[0]!.unread, 0, "replies in threads do not count as unread top-level messages");
    await json(`${base}/api/channels/${general.id}/messages`, { method: "POST", token: ada.token, body: { body: `Status check @{${bob.id}}` } });
    list = await json(`${base}/api/channels?siteId=${site.id}`, { token: bob.token });
    assert.deepEqual([list.channels[0]!.unread, list.channels[0]!.mentions], [1, 1]);
    await json(`${base}/api/channels/${general.id}/read`, { method: "POST", token: bob.token, body: {} });
    list = await json(`${base}/api/channels?siteId=${site.id}`, { token: bob.token });
    assert.deepEqual([list.channels[0]!.unread, list.channels[0]!.mentions], [0, 0]);

    const reacted = await json<MessageResponse>(`${base}/api/channels/${general.id}/messages/${root.id}/reactions`, { method: "POST", token: bob.token, body: { emoji: "👍" } });
    assert.deepEqual(reacted.reactions, [{ emoji: "👍", memberIds: [bob.id] }]);
    const unreacted = await json<MessageResponse>(`${base}/api/channels/${general.id}/messages/${root.id}/reactions/${encodeURIComponent("👍")}`, { method: "DELETE", token: bob.token });
    assert.deepEqual(unreacted.reactions, []);

    await json(`${base}/api/channels/${general.id}/messages/${root.id}`, { method: "PATCH", token: bob.token, body: { body: "hijack" }, expectedStatus: 403 });
    const edited = await json<MessageResponse>(`${base}/api/channels/${general.id}/messages/${reply.id}`, { method: "PATCH", token: bob.token, body: { body: "On it — draft by Friday." } });
    assert.ok(edited.editedAt);
    await json(`${base}/api/channels/${general.id}/messages/${root.id}`, { method: "DELETE", token: bob.token, expectedStatus: 403 });
    const removed = await json<MessageResponse>(`${base}/api/channels/${general.id}/messages/${nested.id}`, { method: "DELETE", token: ada.token });
    assert.ok(removed.deletedAt);
    assert.equal(removed.body, "");

    const found = await json<{ results: Array<{ channel: { name: string }; message: { id: string } }> }>(`${base}/api/chat/search?q=friday`, { token: bob.token });
    assert.deepEqual(found.results.map((result) => [result.channel.name, result.message.id]), [["general-chat", reply.id]]);
    assert.equal((await json<{ results: unknown[] }>(`${base}/api/chat/search?q=friday`, { token: eve.token })).results.length, 0);

    const secret = await json<ChannelResponse>(`${base}/api/channels`, { method: "POST", token: ada.token, body: { siteId: site.id, name: "leadership", visibility: "private" } });
    assert.deepEqual((await json<{ channels: ChannelResponse[] }>(`${base}/api/channels?siteId=${site.id}`, { token: bob.token })).channels.map((channel) => channel.name), ["general-chat"]);
    await json(`${base}/api/channels/${secret.id}`, { token: bob.token, expectedStatus: 404 });
    await json(`${base}/api/channels/${secret.id}/join`, { method: "POST", token: bob.token, expectedStatus: 404 });
    const hidden = await json<MessageResponse>(`${base}/api/channels/${secret.id}/messages`, { method: "POST", token: ada.token, body: { body: `Budget talk @{${bob.id}}` } });
    assert.deepEqual(hidden.mentions, [], "non-members are not mentioned in private channels");
    assert.equal((await json<{ results: unknown[] }>(`${base}/api/chat/search?q=budget`, { token: bob.token })).results.length, 0);
    await json(`${base}/api/channels/${secret.id}/members`, { method: "POST", token: ada.token, body: { memberId: eve.id }, expectedStatus: 400 });
    await json(`${base}/api/channels/${secret.id}/members`, { method: "POST", token: ada.token, body: { memberId: bob.id } });
    const joined = await json<ChannelResponse>(`${base}/api/channels/${secret.id}`, { token: bob.token });
    assert.equal(joined.access?.canPost, true);
    assert.equal(joined.access?.canManage, false);
    await json(`${base}/api/channels/${secret.id}`, { method: "PATCH", token: bob.token, body: { topic: "x" }, expectedStatus: 403 });

    const archived = await json<ChannelResponse>(`${base}/api/channels/${general.id}`, { method: "PATCH", token: ada.token, body: { archived: true } });
    assert.ok(archived.archivedAt);
    await json(`${base}/api/channels/${general.id}/messages`, { method: "POST", token: ada.token, body: { body: "late" }, expectedStatus: 409 });
    assert.equal((await json<{ channels: ChannelResponse[] }>(`${base}/api/channels?siteId=${site.id}`, { token: ada.token })).channels.some((channel) => channel.id === general.id), false);
    assert.equal((await json<{ channels: ChannelResponse[] }>(`${base}/api/channels?siteId=${site.id}&archived=1`, { token: ada.token })).channels.some((channel) => channel.id === general.id), true);
  } finally {
    await harness.close();
  }
});

test("project channels turn messages into issues and threads into .noma pages", async () => {
  const harness = await startCloudServer("noma-chat-work-");
  const { base } = harness;
  try {
    const ada = await createCloudUser(base, "Ada Lovelace");
    const bob = await createCloudUser(base, "Bob Builder");
    const { site } = await createSpace(base, ada.token, "Delivery", []);
    const other = await createSpace(base, ada.token, "Elsewhere", []);
    await json(`${base}/api/sites/${site.id}/collaborators`, { method: "POST", token: ada.token, body: { userId: bob.id, role: "viewer" } });
    const project = await json<{ id: string; key: string }>(`${base}/api/projects`, { method: "POST", token: ada.token, body: { siteId: site.id, key: "SHIP", name: "Ship it" } });
    const foreign = await json<{ id: string }>(`${base}/api/projects`, { method: "POST", token: ada.token, body: { siteId: other.site.id, key: "ELSE", name: "Else" } });
    await json(`${base}/api/channels`, { method: "POST", token: ada.token, body: { siteId: site.id, name: "bad", projectId: foreign.id }, expectedStatus: 400 });
    const channel = await json<ChannelResponse>(`${base}/api/channels`, { method: "POST", token: ada.token, body: { siteId: site.id, name: "ship", projectId: project.id, topic: "Release train" } });
    assert.equal(channel.project?.key, "SHIP");
    assert.deepEqual((await json<{ channels: ChannelResponse[] }>(`${base}/api/channels?projectId=${project.id}`, { token: bob.token })).channels.map((item) => item.id), [channel.id]);

    const root = await json<MessageResponse>(`${base}/api/channels/${channel.id}/messages`, { method: "POST", token: bob.token, body: { body: "Login fails on Safari after the redirect\nSteps: open /login in Safari 18" } });
    await json(`${base}/api/channels/${channel.id}/messages/${root.id}/issue`, { method: "POST", token: bob.token, body: {}, expectedStatus: 403 });
    const created = await json<{ issue: { key: string; summary: string; labels: string[]; description: string }; message: MessageResponse }>(`${base}/api/channels/${channel.id}/messages/${root.id}/issue`, {
      method: "POST",
      token: ada.token,
      body: { type: "bug", priority: "high" },
    });
    assert.equal(created.issue.key, "SHIP-1");
    assert.equal(created.issue.summary, "Login fails on Safari after the redirect");
    assert.deepEqual(created.issue.labels, ["chat"]);
    assert.match(created.issue.description, /From #ship/);
    assert.deepEqual(created.message.links.issues.map((issue) => issue.key), ["SHIP-1"]);

    const followUp = await json<MessageResponse>(`${base}/api/channels/${channel.id}/messages`, { method: "POST", token: bob.token, body: { body: "SHIP-1 is also on Firefox; ELSE-1 is unrelated", threadId: root.id } });
    assert.deepEqual(followUp.refs.map((ref) => [ref.key, ref.status]), [["SHIP-1", "backlog"]], "issue keys unfurl only for projects in this space");

    const thread = await json<{ replies: MessageResponse[] }>(`${base}/api/channels/${channel.id}/messages/${root.id}`, { token: bob.token });
    assert.ok(thread.replies.some((message) => message.kind === "system" && message.body.startsWith("created SHIP-1")));

    await json(`${base}/api/channels/${channel.id}/messages/${root.id}/page`, { method: "POST", token: bob.token, body: {}, expectedStatus: 403 });
    const captured = await json<{ document: { id: string; title: string; source: string }; message: MessageResponse }>(`${base}/api/channels/${channel.id}/messages/${followUp.id}/page`, {
      method: "POST",
      token: ada.token,
      body: { title: "Safari login incident" },
    });
    assert.equal(captured.document.title, "Safari login incident");
    assert.match(captured.document.source, new RegExp(`:::message\\{id="msg-${root.id}" author="Bob Builder"`));
    assert.match(captured.document.source, new RegExp(`msg-${followUp.id}`));
    assert.doesNotMatch(captured.document.source, /created SHIP-1/, "system notes are not part of the transcript");
    assert.deepEqual(captured.message.links.documents.map((document) => document.id), [captured.document.id]);
    const spaceAfter = await json<{ documentIds: string[] }>(`${base}/api/sites/${site.id}`, { token: ada.token });
    assert.ok(spaceAfter.documentIds.includes(captured.document.id), "the captured page lives in the channel's space");
  } finally {
    await harness.close();
  }
});

test("agents answer chat mentions through the gateway, and agent posts never mention other agents", async () => {
  const harness = await startCloudServer("noma-chat-agents-");
  const { base } = harness;
  try {
    const ada = await createCloudUser(base, "Ada Lovelace");
    const bob = await createCloudUser(base, "Bob Builder");
    const { site } = await createSpace(base, ada.token, "Delivery", []);
    await json(`${base}/api/sites/${site.id}/collaborators`, { method: "POST", token: ada.token, body: { userId: bob.id, role: "editor" } });
    const agent = await json<{ id: string }>(`${base}/api/agents`, { method: "POST", token: bob.token, body: { name: "Test Runner", capabilities: ["chat"] } });
    const helper = await json<{ id: string }>(`${base}/api/agents`, { method: "POST", token: bob.token, body: { name: "Helper", capabilities: ["chat"] } });
    const mute = await json<{ id: string }>(`${base}/api/agents`, { method: "POST", token: bob.token, body: { name: "Mute Bot", capabilities: ["comment"] } });
    for (const id of [agent.id, helper.id, mute.id]) {
      await json(`${base}/api/agents/${id}/access`, { method: "POST", token: bob.token, body: { resourceType: "site", resourceId: site.id, role: "viewer" } });
    }
    const channel = await json<ChannelResponse>(`${base}/api/channels`, { method: "POST", token: ada.token, body: { siteId: site.id, name: "ci" } });
    assert.deepEqual(channel.agents?.map((item) => item.name), ["Helper", "Test Runner"], "only agents with the chat capability are listed");

    const ask = await json<MessageResponse>(`${base}/api/channels/${channel.id}/messages`, {
      method: "POST",
      token: ada.token,
      body: { body: `@{${agent.id}} please run the smoke suite. @{${mute.id}} cannot chat.` },
    });
    assert.deepEqual(ask.mentions.map((mention) => [mention.name, mention.agent]), [["Test Runner", true]]);
    const bobNotes = await json<{ notifications: Array<{ type: string; title: string }> }>(`${base}/api/notifications`, { token: bob.token });
    assert.ok(bobNotes.notifications.some((note) => note.type === "task_assigned" && note.title === "Test Runner was asked in #ci"));

    await json(`${base}/api/agents/${agent.id}/chat`, { token: ada.token, expectedStatus: 403 });
    let inbox = await json<{ mentions: Array<{ channel: { id: string }; message: { id: string }; threadId: string }> }>(`${base}/api/agents/${agent.id}/chat`, { token: bob.token });
    assert.deepEqual(inbox.mentions.map((mention) => [mention.channel.id, mention.message.id, mention.threadId]), [[channel.id, ask.id, ask.id]]);
    const viaGateway = await mcp<{ mentions: unknown[] }>(base, bob.token, "chat_inbox", { agentId: agent.id });
    assert.equal(viaGateway.mentions.length, 1);

    const history = await mcp<{ messages: Array<{ id: string }> }>(base, bob.token, "chat_history", { agentId: agent.id, channelId: channel.id });
    assert.deepEqual(history.messages.map((message) => message.id), [ask.id]);
    const posted = await mcp<{ message: MessageResponse }>(base, bob.token, "chat_post", {
      agentId: agent.id,
      channelId: channel.id,
      threadId: ask.id,
      body: `Smoke suite green (42 passed). @{${helper.id}} FYI`,
    });
    assert.equal(posted.message.agent?.name, "Test Runner");
    assert.equal(posted.message.threadId, ask.id);
    inbox = await json(`${base}/api/agents/${agent.id}/chat`, { token: bob.token });
    assert.equal(inbox.mentions.length, 0, "answering in the thread clears the pending mention");
    assert.equal((await json<{ mentions: unknown[] }>(`${base}/api/agents/${agent.id}/chat?status=all`, { token: bob.token })).mentions.length, 1);
    assert.equal((await json<{ mentions: unknown[] }>(`${base}/api/agents/${helper.id}/chat`, { token: bob.token })).mentions.length, 0, "agent posts do not open agent mentions");

    const adaList = await json<{ channels: ChannelResponse[] }>(`${base}/api/channels?siteId=${site.id}`, { token: ada.token });
    assert.equal(adaList.channels[0]!.unread, 0, "thread replies are not top-level unread");
    await json(`${base}/api/channels/${channel.id}/messages`, { method: "POST", token: bob.token, body: { body: "Direct post", agentId: agent.id } });
    const bobList = await json<{ channels: ChannelResponse[] }>(`${base}/api/channels?siteId=${site.id}`, { token: bob.token });
    assert.equal(bobList.channels.length, 1);
    await json(`${base}/api/channels/${channel.id}/messages`, { method: "POST", token: ada.token, body: { body: "not mine", agentId: agent.id }, expectedStatus: 403 });
    await json(`${base}/api/channels/${channel.id}/messages`, { method: "POST", token: bob.token, body: { body: "no chat", agentId: mute.id }, expectedStatus: 403 });

    const secret = await json<ChannelResponse>(`${base}/api/channels`, { method: "POST", token: ada.token, body: { siteId: site.id, name: "private-ops", visibility: "private" } });
    await mcp<unknown>(base, bob.token, "chat_history", { agentId: agent.id, channelId: secret.id }).then(
      () => assert.fail("agents cannot read private channels they are not in"),
      (error: Error) => assert.match(error.message, /404/),
    );
    await json(`${base}/api/channels/${secret.id}/members`, { method: "POST", token: ada.token, body: { memberId: agent.id } });
    const inPrivate = await mcp<{ message: MessageResponse }>(base, bob.token, "chat_post", { agentId: agent.id, channelId: secret.id, body: "Joined." });
    assert.equal(inPrivate.message.agent?.id, agent.id);
  } finally {
    await harness.close();
  }
});

test("the channel stream pushes a notice for every write and ends when the server closes", async () => {
  const harness = await startCloudServer("noma-chat-stream-");
  const { base } = harness;
  let closed = false;
  try {
    const ada = await createCloudUser(base, "Ada Lovelace");
    const { site } = await createSpace(base, ada.token, "Delivery", []);
    const channel = await json<ChannelResponse>(`${base}/api/channels`, { method: "POST", token: ada.token, body: { siteId: site.id, name: "live" } });
    const outsider = await createCloudUser(base, "Eve Outsider");
    assert.equal((await request(`${base}/api/channels/${channel.id}/stream`, { token: outsider.token })).status, 404);

    const response = await fetch(`${base}/api/channels/${channel.id}/stream`, { headers: { authorization: `Bearer ${ada.token}` } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const readUntil = async (pattern: RegExp): Promise<string> => {
      while (!pattern.test(buffer)) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
      }
      return buffer;
    };
    await readUntil(/event: ready/);
    const message = await json<MessageResponse>(`${base}/api/channels/${channel.id}/messages`, { method: "POST", token: ada.token, body: { body: "hello stream" } });
    const text = await readUntil(/event: chat\ndata: .*\n\n/);
    const data = JSON.parse(/event: chat\ndata: (.*)\n/.exec(text)![1]!) as { type: string; seq: number; messageId: string };
    assert.deepEqual([data.type, data.seq, data.messageId], ["message", 1, message.id]);
    assert.doesNotMatch(text, /hello stream/, "stream notices carry no message content");

    await harness.close();
    closed = true;
    const end = await reader.read().catch(() => ({ done: true }));
    assert.equal(end.done, true);
  } finally {
    if (!closed) await harness.close();
  }
});
