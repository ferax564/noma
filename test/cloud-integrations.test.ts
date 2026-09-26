import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { adfToMarkdown, parseJiraExport } from "../src/jira-import.js";
import { markdownToSlackText, slackEmoji, slackTextToMarkdown } from "../src/slack-import.js";
import { createZip } from "../src/zip.js";
import { createCloudUser, createSpace, json, request, startCloudServer } from "./cloud-wiki-harness.js";

interface MessageResponse {
  id: string;
  body: string;
  kind: string;
  threadId?: string;
  author?: { id: string; name: string };
  authorId?: string;
  reactions?: Array<{ emoji: string; memberIds: string[] }>;
}

test("Slack mrkdwn, Noma Markdown, and Jira ADF convert both ways", () => {
  const md = slackTextToMarkdown("hi <@U1> see <#C2|general> and <https://x.test|the doc> — *bold* _it_ ~gone~ &lt;3 <!here>", (id) => `@user-${id}`, (_id, name) => `#${name}`);
  assert.equal(md, "hi @user-U1 see #general and [the doc](https://x.test) — **bold** *it* ~~gone~~ <3 @here");
  assert.equal(markdownToSlackText("**ship** it [now](https://x.test) <b> ~~no~~"), "*ship* it <https://x.test|now> &lt;b&gt; ~no~");
  assert.deepEqual([slackEmoji("+1"), slackEmoji("thumbsup::skin-tone-2"), slackEmoji("partyparrot")], ["👍", "👍", ":partyparrot:"]);
  const adf = {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Steps" }] },
      { type: "paragraph", content: [{ type: "text", text: "Open " }, { type: "text", text: "checkout", marks: [{ type: "strong" }] }, { type: "text", text: " page", marks: [{ type: "link", attrs: { href: "https://x.test" } }] }] },
      { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] }, { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "two" }] }] }] },
      { type: "codeBlock", attrs: { language: "js" }, content: [{ type: "text", text: "pay()" }] },
    ],
  };
  assert.equal(adfToMarkdown(adf), "## Steps\n\nOpen **checkout**[ page](https://x.test)\n\n- one\n- two\n\n```js\npay()\n```");
  const [issue] = parseJiraExport({
    issues: [
      {
        key: "SHOP-7",
        fields: {
          summary: "Pay fails",
          issuetype: { name: "Bug" },
          status: { name: "Code Review", statusCategory: { key: "indeterminate" } },
          priority: { name: "Blocker" },
          labels: ["payments"],
          assignee: { displayName: "Bob", emailAddress: "Bob@Example.com" },
          issuelinks: [{ type: { name: "Blocks" }, outwardIssue: { key: "SHOP-8" } }],
        },
      },
    ],
  });
  assert.deepEqual([issue!.type, issue!.status, issue!.priority, issue!.assignee?.email, issue!.links], ["bug", "in_review", "highest", "bob@example.com", [{ type: "blocks", key: "SHOP-8" }]]);
});

function slackExportZip(): Buffer {
  const day = (messages: unknown[]) => JSON.stringify(messages);
  return createZip([
    { path: "export/users.json", data: JSON.stringify([{ id: "UBOB", name: "bob", profile: { real_name: "Bob Builder", email: "bob@example.com" } }, { id: "UZED", name: "zed", profile: { real_name: "Zed Outsider", email: "zed@elsewhere.test" } }]) },
    { path: "export/channels.json", data: JSON.stringify([{ id: "CGEN", name: "general", topic: { value: "Company-wide" }, members: ["UBOB", "UZED"] }]) },
    { path: "export/groups.json", data: JSON.stringify([{ id: "GLEADS", name: "leads", members: ["UBOB"] }]) },
    { path: "export/dms.json", data: JSON.stringify([{ id: "D1", members: ["UBOB", "UZED"] }]) },
    {
      path: "export/general/2026-01-05.json",
      data: day([
        { type: "message", subtype: "channel_join", user: "UZED", text: "<@UZED> has joined", ts: "1767600000.000100" },
        { type: "message", user: "UBOB", text: "Launch *Friday*? cc <@UZED>", ts: "1767600100.000200", reactions: [{ name: "+1", users: ["UBOB", "UZED"] }] },
        { type: "message", user: "UZED", text: "Yes, see <https://x.test/plan|the plan>", ts: "1767600200.000300", thread_ts: "1767600100.000200" },
        { type: "message", user: "UBOB", text: "screenshot", ts: "1767600300.000400", files: [{ name: "shot.png", permalink: "https://slack.test/shot" }] },
      ]),
    },
    { path: "export/leads/2026-01-06.json", data: day([{ type: "message", user: "UBOB", text: "Budget talk", ts: "1767690000.000100" }]) },
  ]);
}

test("a Slack export becomes channels, threads, and reactions, matched to members by email; re-imports add nothing", async () => {
  const harness = await startCloudServer("noma-slack-import-");
  const { base } = harness;
  try {
    const ada = await createCloudUser(base, "Ada Admin");
    const bob = await createCloudUser(base, "Bob Builder");
    const vic = await createCloudUser(base, "Vic Viewer");
    await json(`${base}/api/users/me`, { method: "PATCH", token: bob.token, body: { email: "Bob@Example.com" } });
    const { site } = await createSpace(base, ada.token, "Delivery", []);
    await json(`${base}/api/sites/${site.id}/collaborators`, { method: "POST", token: ada.token, body: { userId: bob.id, role: "editor" } });
    await json(`${base}/api/sites/${site.id}/collaborators`, { method: "POST", token: ada.token, body: { userId: vic.id, role: "viewer" } });
    const upload = (token: string) =>
      fetch(`${base}/api/import/slack?siteId=${site.id}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/zip" }, body: slackExportZip() }).then(async (response) => ({ status: response.status, body: (await response.json()) as Record<string, unknown> }));

    assert.equal((await upload(vic.token)).status, 403);
    const bad = await fetch(`${base}/api/import/slack?siteId=${site.id}`, { method: "POST", headers: { authorization: `Bearer ${ada.token}`, "content-type": "application/zip" }, body: createZip([{ path: "x.txt", data: "hi" }]) });
    assert.equal(bad.status, 400);

    const first = await upload(ada.token);
    assert.equal(first.status, 200);
    const report = first.body as { channels: Array<{ id: string; name: string; messages: number }>; messages: number; threads: number; reactions: number; skipped: Record<string, number>; matchedPeople: number; unmatchedPeople: string[] };
    assert.deepEqual(report.channels.map((channel) => [channel.name, channel.messages]), [["general", 3], ["leads", 1]]);
    assert.deepEqual([report.messages, report.threads, report.reactions, report.matchedPeople], [4, 1, 1, 1]);
    assert.deepEqual(report.unmatchedPeople, ["Zed Outsider"]);
    assert.deepEqual([report.skipped.files, report.skipped.directMessages], [1, 1]);

    const general = report.channels[0]!.id;
    const messages = (await json<{ messages: MessageResponse[] }>(`${base}/api/channels/${general}/messages`, { token: bob.token })).messages;
    assert.equal(messages.length, 2, "the reply sits in its thread");
    const root = messages[0]!;
    assert.equal(root.body, `Launch **Friday**? cc @Zed Outsider`);
    assert.equal(root.author?.id ?? root.authorId, bob.id, "matched people author their own messages");
    assert.deepEqual(root.reactions?.map((reaction) => [reaction.emoji, reaction.memberIds]), [["👍", [bob.id]]]);
    assert.match(messages[1]!.body, /📎 \[shot\.png\]\(https:\/\/slack\.test\/shot\)/);
    const thread = (await json<{ replies: MessageResponse[] }>(`${base}/api/channels/${general}/messages/${root.id}`, { token: bob.token })).replies;
    assert.equal(thread[0]!.body, "**Zed Outsider**: Yes, see [the plan](https://x.test/plan)");

    const leads = report.channels[1]!.id;
    const detail = await json<{ visibility: string; members: Array<{ id: string }> }>(`${base}/api/channels/${leads}`, { token: bob.token });
    assert.equal(detail.visibility, "private");
    assert.ok(detail.members.some((member) => member.id === bob.id));
    await json(`${base}/api/channels/${leads}`, { token: vic.token, expectedStatus: 404 });

    const again = await upload(ada.token);
    assert.deepEqual([(again.body as { messages: number }).messages, (again.body as { skipped: { alreadyImported: number } }).skipped.alreadyImported], [0, 4]);
    assert.equal((await json<{ messages: MessageResponse[] }>(`${base}/api/channels/${general}/messages`, { token: bob.token })).messages.length, 2);
  } finally {
    await harness.close();
  }
});

test("Jira issues import with types, statuses, people, subtasks, links, and comments — once", async () => {
  const harness = await startCloudServer("noma-jira-import-");
  const { base } = harness;
  try {
    const ada = await createCloudUser(base, "Ada Admin");
    const bob = await createCloudUser(base, "Bob Builder");
    await json(`${base}/api/users/me`, { method: "PATCH", token: bob.token, body: { email: "bob@example.com" } });
    const { site } = await createSpace(base, ada.token, "Delivery", []);
    await json(`${base}/api/sites/${site.id}/collaborators`, { method: "POST", token: ada.token, body: { userId: bob.id, role: "viewer" } });
    const project = await json<{ id: string }>(`${base}/api/projects`, { method: "POST", token: ada.token, body: { siteId: site.id, key: "SHOP", name: "Shop" } });
    const search = {
      issues: [
        { key: "OLD-2", fields: { summary: "Checkout flow", issuetype: { name: "Story" }, status: { name: "In Progress", statusCategory: { key: "indeterminate" } }, priority: { name: "High" }, parent: { key: "OLD-1" }, assignee: { displayName: "Bob Builder", emailAddress: "bob@example.com" }, comment: { comments: [{ author: { displayName: "Bob Builder", emailAddress: "bob@example.com" }, body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Started" }] }] }, created: "2026-01-02T10:00:00.000+0000" }, { author: { displayName: "Pat Former" }, body: "Legacy note", created: "2026-01-03T10:00:00.000+0000" }] } } },
        { key: "OLD-1", fields: { summary: "Payments epic", issuetype: { name: "Epic" }, status: { name: "To Do", statusCategory: { key: "new" } }, labels: ["Q1 Goals"] } },
        { key: "OLD-3", fields: { summary: "Card declined", issuetype: { name: "Bug" }, status: { name: "Done", statusCategory: { key: "done" } }, priority: { name: "Lowest" }, issuelinks: [{ type: { name: "Blocks" }, outwardIssue: { key: "OLD-2" } }], description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Steps to reproduce" }] }] } } },
      ],
    };
    await json(`${base}/api/import/jira`, { method: "POST", token: bob.token, body: { projectId: project.id, search }, expectedStatus: 403 });
    await json(`${base}/api/import/jira`, { method: "POST", token: ada.token, body: { projectId: project.id, search: { issues: [] } }, expectedStatus: 400 });
    const report = await json<{ created: number; comments: number; links: number; subtasks: number; unmatchedPeople: string[]; keys: Record<string, string> }>(`${base}/api/import/jira`, { method: "POST", token: ada.token, body: { projectId: project.id, search } });
    assert.deepEqual([report.created, report.comments, report.links, report.subtasks], [3, 2, 1, 1]);
    assert.deepEqual(report.unmatchedPeople, ["Pat Former"]);
    const story = await json<{ id: string; type: string; status: string; priority: string; assigneeId: string; parentId: string; comments: Array<{ body: string; createdBy: string }>; description: string }>(`${base}/api/projects/${project.id}/issues/${report.keys["OLD-2"]}`, { token: ada.token });
    const epic = await json<{ id: string; type: string; labels: string[] }>(`${base}/api/projects/${project.id}/issues/${report.keys["OLD-1"]}`, { token: ada.token });
    assert.deepEqual([story.type, story.status, story.priority, story.assigneeId, story.parentId], ["story", "in_progress", "high", bob.id, epic.id]);
    assert.deepEqual(epic.labels, ["jira", "q1-goals"]);
    assert.deepEqual(story.comments.map((comment) => [comment.body, comment.createdBy === bob.id]), [["Started", true], ["**Pat Former** (Jira): Legacy note", false]]);
    assert.match(story.description, /Imported from Jira OLD-2/);
    const bug = await json<{ status: string; links: Array<{ targetIssueKey: string; type: string }>; description: string }>(`${base}/api/projects/${project.id}/issues/${report.keys["OLD-3"]}`, { token: ada.token });
    assert.deepEqual([bug.status, bug.links.map((link) => [link.targetIssueKey, link.type])], ["done", [[report.keys["OLD-2"], "blocks"]]]);
    assert.match(bug.description, /^Steps to reproduce/);

    const again = await json<{ created: number; alreadyImported: number }>(`${base}/api/import/jira`, { method: "POST", token: ada.token, body: { projectId: project.id, search } });
    assert.deepEqual([again.created, again.alreadyImported], [0, 3]);
  } finally {
    await harness.close();
  }
});

test("the Slack bridge carries messages both ways, keeps threads, and never echoes", async () => {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  let tsCounter = 0;
  const slackFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const method = String(input).split("/").pop()!;
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ method, body });
    if (method === "users.info") return new Response(JSON.stringify({ ok: true, user: { id: body.user, profile: body.user === "UBOB" ? { real_name: "Bob Builder", email: "bob@example.com" } : { real_name: "Sam Slack" } } }));
    tsCounter += 1;
    return new Response(JSON.stringify({ ok: true, ts: `1767700000.00000${tsCounter}` }));
  }) as typeof fetch;
  const signingSecret = "slack-signing";
  const harness = await startCloudServer("noma-slack-bridge-", { slack: { botToken: "xoxb-test", signingSecret, fetch: slackFetch } });
  const { base } = harness;
  const event = (payload: unknown, secret = signingSecret) => {
    const body = JSON.stringify(payload);
    const timestamp = String(Math.floor(harness.clock.now().getTime() / 1000));
    return fetch(`${base}/api/hooks/slack`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-slack-request-timestamp": timestamp, "x-slack-signature": `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}` },
      body,
    }).then(async (response) => ({ status: response.status, body: (await response.json()) as Record<string, unknown> }));
  };
  const drained = async () => {
    for (let attempt = 0; attempt < 200 && calls.filter((call) => call.method === "chat.postMessage").length < wanted; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
  };
  let wanted = 0;
  try {
    const ada = await createCloudUser(base, "Ada Admin");
    const bob = await createCloudUser(base, "Bob Builder");
    await json(`${base}/api/users/me`, { method: "PATCH", token: bob.token, body: { email: "bob@example.com" } });
    const { site } = await createSpace(base, ada.token, "Delivery", []);
    await json(`${base}/api/sites/${site.id}/collaborators`, { method: "POST", token: ada.token, body: { userId: bob.id, role: "editor" } });
    const vic = await createCloudUser(base, "Vic Viewer");
    await json(`${base}/api/sites/${site.id}/collaborators`, { method: "POST", token: ada.token, body: { userId: vic.id, role: "viewer" } });
    const channel = await json<{ id: string }>(`${base}/api/channels`, { method: "POST", token: ada.token, body: { siteId: site.id, name: "ops" } });
    await json(`${base}/api/channels/${channel.id}/bridge`, { method: "PUT", token: vic.token, body: { slackChannelId: "C0OPS1234" }, expectedStatus: 403 });
    await json(`${base}/api/channels/${channel.id}/bridge`, { method: "PUT", token: ada.token, body: { slackChannelId: "#ops" }, expectedStatus: 400 });
    const linked = await json<{ bridge: { slackChannelId: string } }>(`${base}/api/channels/${channel.id}/bridge`, { method: "PUT", token: ada.token, body: { slackChannelId: "C0OPS1234" } });
    assert.equal(linked.bridge.slackChannelId, "C0OPS1234");

    const root = await json<MessageResponse>(`${base}/api/channels/${channel.id}/messages`, { method: "POST", token: bob.token, body: { body: "**Deploy** at 5, see [runbook](https://x.test/rb)" } });
    wanted = 1;
    await drained();
    const out = calls.filter((call) => call.method === "chat.postMessage");
    assert.deepEqual(out[0]?.body, { channel: "C0OPS1234", text: "*Deploy* at 5, see <https://x.test/rb|runbook>", username: "Bob Builder · Noma", unfurl_links: false });
    await json(`${base}/api/channels/${channel.id}/messages`, { method: "POST", token: ada.token, body: { body: "ack", threadId: root.id } });
    wanted = 2;
    await drained();
    assert.equal(calls.filter((call) => call.method === "chat.postMessage")[1]?.body.thread_ts, "1767700000.000001", "Noma thread replies land in the Slack thread");

    assert.equal((await event({ type: "url_verification", challenge: "abc" })).body.challenge, "abc");
    assert.equal((await event({ type: "event_callback", event: {} }, "wrong")).status, 401);
    const inbound = await event({ type: "event_callback", event: { type: "message", channel: "C0OPS1234", user: "USAM", text: "From Slack: <@UBOB> ok?", ts: "1767700100.000100", thread_ts: "1767700000.000001" } });
    assert.equal(inbound.body.handled, true);
    const replies = (await json<{ replies: MessageResponse[] }>(`${base}/api/channels/${channel.id}/messages/${root.id}`, { token: ada.token })).replies;
    assert.equal(replies.at(-1)?.body, "**Sam Slack** (Slack): From Slack: @UBOB ok?", "Slack replies join the Noma thread");
    const fromBob = await event({ type: "event_callback", event: { type: "message", channel: "C0OPS1234", user: "UBOB", text: "hello from slack", ts: "1767700200.000100" } });
    const bobMessage = (await json<{ messages: MessageResponse[] }>(`${base}/api/channels/${channel.id}/messages`, { token: ada.token })).messages.find((message) => message.id === fromBob.body.messageId)!;
    assert.equal(bobMessage.body, "hello from slack");
    assert.equal(bobMessage.author?.id ?? bobMessage.authorId, bob.id, "Slack people matched by email post as themselves");
    assert.equal((await event({ type: "event_callback", event: { type: "message", channel: "C0OPS1234", user: "UBOB", text: "hello from slack", ts: "1767700200.000100" } })).body.handled, false, "retries are ignored");
    assert.equal((await event({ type: "event_callback", event: { type: "message", channel: "C0OPS1234", bot_id: "B1", text: "echo", ts: "1767700300.000100" } })).body.handled, false, "bot posts (our own echoes) are ignored");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(calls.filter((call) => call.method === "chat.postMessage").length, 2, "messages that came from Slack are not sent back");

    await json(`${base}/api/channels/${channel.id}/bridge`, { method: "DELETE", token: ada.token });
    assert.equal((await event({ type: "event_callback", event: { type: "message", channel: "C0OPS1234", user: "USAM", text: "late", ts: "1767700400.000100" } })).body.handled, false);
  } finally {
    await harness.close();
  }
});

test("the bridge needs the Slack app configured", async () => {
  const harness = await startCloudServer("noma-slack-off-", { slack: null });
  try {
    const ada = await createCloudUser(harness.base, "Ada Admin");
    const { site } = await createSpace(harness.base, ada.token, "Delivery", []);
    const channel = await json<{ id: string }>(`${harness.base}/api/channels`, { method: "POST", token: ada.token, body: { siteId: site.id, name: "ops" } });
    assert.equal((await json<{ code: string }>(`${harness.base}/api/channels/${channel.id}/bridge`, { method: "PUT", token: ada.token, body: { slackChannelId: "C0OPS1234" }, expectedStatus: 409 })).code, "slack_not_configured");
    assert.equal((await request(`${harness.base}/api/hooks/slack`, { method: "POST", body: {} })).status, 404);
  } finally {
    await harness.close();
  }
});
