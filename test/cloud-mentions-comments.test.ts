import assert from "node:assert/strict";
import test from "node:test";
import { extractMentions } from "../src/cloud/mentions.js";
import { type CloudDocumentResponse, createCloudUser, createSpace, json, savePage, startCloudServer } from "./cloud-wiki-harness.js";

interface NotificationList {
  notifications: Array<{ type: string; title: string; resourceId?: string }>;
}

interface DirectoryResponse {
  users: Array<{ id: string; name: string; tokenPreview?: string }>;
}

test("mention extraction ignores fenced code and deduplicates", () => {
  assert.deepEqual(extractMentions("Hi @{abcdefgh1} and @{abcdefgh1} and @{zyxwvuts2}\n```\n@{codeuser99}\n```\n"), ["abcdefgh1", "zyxwvuts2"]);
  assert.deepEqual(extractMentions("@{short} email@{notauser}"), ["notauser"]);
});

test("user directory only lists people who share a space and source mentions notify newly added, permitted users", async () => {
  const harness = await startCloudServer("noma-mentions-");
  const { base } = harness;
  try {
    const ada = await createCloudUser(base, "Ada Lovelace");
    const bob = await createCloudUser(base, "Bob Builder");
    const carl = await createCloudUser(base, "Carl Sagan");
    const eve = await createCloudUser(base, "Eve Outsider");

    const eng = await createSpace(base, ada.token, "Engineering", ["# Plan\n\nKickoff notes.\n"]);
    await json(`${base}/api/sites/${eng.site.id}/collaborators`, { method: "POST", token: ada.token, body: { userId: bob.id, role: "editor" } });
    const lab = await createSpace(base, bob.token, "Lab", ["# Lab\n\nBench.\n"]);
    await json(`${base}/api/sites/${lab.site.id}/collaborators`, { method: "POST", token: bob.token, body: { userId: carl.id, role: "viewer" } });
    const privatePage = await json<CloudDocumentResponse>(`${base}/api/documents`, { method: "POST", token: ada.token, body: { source: "# Private\n\nOnly Ada.\n" } });

    const directory = (token: string, params: string) => json<DirectoryResponse>(`${base}/api/users?${params}`, { token });
    assert.deepEqual((await directory(ada.token, "q=b")).users.map((user) => user.name), ["Bob Builder"]);
    assert.deepEqual((await directory(ada.token, "q=@bo")).users.map((user) => user.name), ["Bob Builder"]);
    assert.deepEqual((await directory(ada.token, "q=eve")).users, []);
    assert.deepEqual((await directory(ada.token, "q=carl")).users, [], "Carl only shares a space with Bob");
    assert.deepEqual((await directory(bob.token, "q=")).users.map((user) => user.name), ["Ada Lovelace", "Bob Builder", "Carl Sagan"]);
    assert.deepEqual((await directory(eve.token, "q=")).users.map((user) => user.name), ["Eve Outsider"]);
    assert.equal((await directory(ada.token, "q=bob")).users[0]?.tokenPreview, undefined);
    assert.deepEqual((await directory(ada.token, `ids=${bob.id},${eve.id},${carl.id}`)).users.map((user) => user.id), [bob.id]);
    assert.deepEqual((await directory(ada.token, `q=bob&document=${privatePage.id}`)).users, [], "Bob cannot open the private page");
    await json(`${base}/api/users?q=ada&document=${privatePage.id}`, { token: bob.token, expectedStatus: 403 });
    await json(`${base}/api/users?q=a&limit=500`, { token: ada.token, expectedStatus: 400 });
    await json(`${base}/api/users?ids=bad`, { token: ada.token, expectedStatus: 400 });

    const bobMentions = async () => (await json<NotificationList>(`${base}/api/notifications`, { token: bob.token })).notifications.filter((item) => item.type === "mention");
    const eveMentions = async () => (await json<NotificationList>(`${base}/api/notifications`, { token: eve.token })).notifications.filter((item) => item.type === "mention");

    let plan = eng.pages[0]!;
    plan = await savePage(base, ada.token, plan, `# Plan\n\nKickoff notes for @{${bob.id}}.\n`);
    assert.equal((await bobMentions()).length, 1);
    assert.equal((await bobMentions())[0]?.resourceId, plan.id);
    plan = await savePage(base, ada.token, plan, `# Plan\n\nKickoff notes for @{${bob.id}} again.\n`);
    assert.equal((await bobMentions()).length, 1, "an existing mention does not notify twice");
    plan = await savePage(base, ada.token, plan, `# Plan\n\nKickoff notes for @{${bob.id}} and @{${eve.id}}.\n\n\`\`\`\n@{${carl.id}}\n\`\`\`\n`);
    assert.equal((await eveMentions()).length, 0, "users without access are never notified");
    await json(`${base}/api/sites/${eng.site.id}/collaborators`, { method: "POST", token: ada.token, body: { userId: eve.id, role: "viewer" } });
    plan = await savePage(base, ada.token, plan, `# Plan\n\nKickoff for @{${bob.id}} and @{${eve.id}}.\n`);
    assert.equal((await eveMentions()).length, 0, "only newly added mentions notify");
    plan = await savePage(base, bob.token, plan, `# Plan\n\nKickoff for @{${bob.id}}.\n`);
    plan = await savePage(base, bob.token, plan, `# Plan\n\nKickoff for @{${bob.id}} and @{${eve.id}}.\n`);
    assert.equal((await eveMentions()).length, 1, "re-adding a removed mention notifies");
    assert.equal((await bobMentions()).length, 1, "self-mentions do not notify");

    const created = await json<CloudDocumentResponse>(`${base}/api/sites/${eng.site.id}/documents`, {
      method: "POST",
      token: ada.token,
      body: { source: `# Handoff\n\nOwner: @{${bob.id}}\n` },
    });
    assert.equal((await bobMentions()).length, 2);
    assert.ok(created.id);

    const comment = await json<{ id: string; mentions: Array<{ id: string; name: string }> }>(`${base}/api/documents/${plan.id}/comments`, {
      method: "POST",
      token: ada.token,
      body: { body: `Thanks @{${bob.id}} and @{${carl.id}}` },
    });
    assert.deepEqual(comment.mentions, [{ id: bob.id, name: "Bob Builder" }]);
    const listed = await json<{ comments: Array<{ mentions: Array<{ name: string }> }> }>(`${base}/api/documents/${plan.id}/comments`, { token: ada.token });
    assert.deepEqual(listed.comments[0]?.mentions.map((mention) => mention.name), ["Bob Builder"]);
  } finally {
    await harness.close();
  }
});
