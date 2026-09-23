import assert from "node:assert/strict";
import test from "node:test";
import { assignTaskIds } from "../src/cloud/tasks.js";
import { type CloudDocumentResponse, createCloudUser, json, request, savePage, startCloudServer } from "./cloud-wiki-harness.js";

interface TaskResponse {
  documentId: string;
  taskId: string;
  text: string;
  title: string;
  status: "open" | "done";
  assigneeId?: string;
  assigneeName?: string;
  dueDate?: string;
  overdue: boolean;
  blockHash?: string;
  completedBy?: string;
  changed?: boolean;
}

test("assignTaskIds adds stable markers only to unidentified checkbox items outside code fences", () => {
  const source = "# T\n\n- [ ] one\n- {#task-keep0001} [x] two\n- plain\n\n```\n- [ ] code\n```\n";
  const assigned = assignTaskIds(source);
  const lines = assigned.split("\n");
  assert.match(lines[2]!, /^- \{#task-[a-z0-9]{8}\} \[ \] one$/);
  assert.equal(lines[3], "- {#task-keep0001} [x] two");
  assert.equal(lines[4], "- plain");
  assert.equal(lines[7], "- [ ] code");
  assert.equal(assignTaskIds(assigned), assigned, "assignment is idempotent");
});

test("inline tasks are indexed on save, notify assignees, list as My tasks, and complete through a hash-checked block patch", async () => {
  const harness = await startCloudServer("noma-tasks-");
  const { base } = harness;
  try {
    const ada = await createCloudUser(base, "Ada Lovelace");
    const bob = await createCloudUser(base, "Bob Builder");
    const carl = await createCloudUser(base, "Carl Sagan");
    const eve = await createCloudUser(base, "Eve Outsider");
    const space = await json<{ id: string }>(`${base}/api/sites`, { method: "POST", token: ada.token, body: { title: "Launch", documentIds: [] } });
    await json(`${base}/api/sites/${space.id}/collaborators`, { method: "POST", token: ada.token, body: { userId: bob.id, role: "editor" } });
    await json(`${base}/api/sites/${space.id}/collaborators`, { method: "POST", token: ada.token, body: { userId: carl.id, role: "viewer" } });

    let page = await json<CloudDocumentResponse>(`${base}/api/sites/${space.id}/documents`, {
      method: "POST",
      token: ada.token,
      body: { source: `# Launch Plan\n\n- [ ] Draft the plan @{${bob.id}} due:2026-06-01\n- [x] Book the room\n- [ ] Send invites @{${eve.id}}\n\n\`\`\`\n- [ ] not a task\n\`\`\`\n` },
    });
    const ids = [...page.source.matchAll(/\{#(task-[a-z0-9]{8})\}/g)].map((match) => match[1]!);
    assert.equal(ids.length, 3, "every checkbox item outside code gets a stable ID");
    assert.match(page.source, /```\n- \[ \] not a task\n```/);
    const [draftId, bookId, invitesId] = ids as [string, string, string];

    const notifications = async (token: string) =>
      (await json<{ notifications: Array<{ type: string; body: string }> }>(`${base}/api/notifications`, { token })).notifications.filter((item) => item.type === "task_assigned");
    assert.equal((await notifications(bob.token)).length, 1);
    assert.match((await notifications(bob.token))[0]!.body, /Draft the plan \(due 2026-06-01\)/);
    assert.equal((await notifications(eve.token)).length, 0, "assignees without access are not notified");

    const myTasks = async (token: string, params = "") => (await json<{ tasks: TaskResponse[] }>(`${base}/api/tasks${params}`, { token })).tasks;
    const bobTasks = await myTasks(bob.token);
    assert.deepEqual(bobTasks.map((task) => [task.taskId, task.title, task.dueDate, task.overdue, task.assigneeName]), [[draftId, "Draft the plan", "2026-06-01", true, "Bob Builder"]]);
    assert.ok(bobTasks[0]?.blockHash);
    assert.deepEqual((await myTasks(ada.token, "?assignee=any&status=all")).map((task) => [task.taskId, task.status]).sort(), [[bookId, "done"], [draftId, "open"], [invitesId, "open"]].sort());
    assert.deepEqual(await myTasks(eve.token, "?assignee=any&status=all"), [], "tasks on pages you cannot see stay hidden");
    await json(`${base}/api/tasks?status=maybe`, { token: bob.token, expectedStatus: 400 });

    page = await savePage(base, ada.token, page, page.source.replace(`@{${bob.id}} due`, `@{${carl.id}} due`).replace("```\n- [ ] not", "- [ ] Order snacks\n\n```\n- [ ] not"));
    assert.equal([...page.source.matchAll(/\{#task-/g)].length, 4, "a new task saved through PUT gets an ID");
    assert.ok(page.source.includes(`{#${draftId}}`), "existing task IDs never change");
    assert.equal((await notifications(carl.token)).length, 1, "reassignment notifies the new assignee");
    assert.equal((await notifications(bob.token)).length, 1);
    assert.deepEqual(await myTasks(bob.token), []);

    const carlTask = (await myTasks(carl.token))[0]!;
    await json(`${base}/api/documents/${page.id}/tasks/${carlTask.taskId}`, { method: "POST", token: carl.token, body: { done: true, baseHash: "0".repeat(64) }, expectedStatus: 409 });
    await json(`${base}/api/documents/${page.id}/tasks/${invitesId}`, { method: "POST", token: carl.token, body: { done: true }, expectedStatus: 403 });
    await json(`${base}/api/documents/${page.id}/tasks/${carlTask.taskId}`, { method: "POST", token: eve.token, body: { done: true }, expectedStatus: 403 });
    await json(`${base}/api/documents/${page.id}/tasks/${carlTask.taskId}`, { method: "POST", token: carl.token, body: { done: "yes" }, expectedStatus: 400 });
    const completed = await json<TaskResponse & { documentHash: string }>(`${base}/api/sites/${space.id}/documents/${page.id}/tasks/${carlTask.taskId}`, {
      method: "POST",
      token: carl.token,
      body: { done: true, baseHash: carlTask.blockHash },
    });
    assert.equal(completed.status, "done");
    assert.equal(completed.completedBy, carl.id);
    assert.equal(completed.changed, true);
    const reloaded = await json<CloudDocumentResponse>(`${base}/api/documents/${page.id}`, { token: ada.token });
    assert.equal(reloaded.hash, completed.documentHash);
    assert.ok(reloaded.source.includes(`- {#${draftId}} [x] Draft the plan @{${carl.id}} due:2026-06-01`), "only the checkbox changed, the ID stayed");
    assert.equal(reloaded.source.replace("[x] Draft", "[ ] Draft"), page.source, "no other line changed");
    assert.deepEqual(await myTasks(carl.token), []);
    assert.deepEqual((await myTasks(carl.token, "?status=done")).map((task) => task.taskId), [draftId]);
    const again = await json<TaskResponse>(`${base}/api/documents/${page.id}/tasks/${draftId}`, { method: "POST", token: carl.token, body: { done: true } });
    assert.equal(again.changed, false);
    const reopened = await json<TaskResponse>(`${base}/api/documents/${page.id}/tasks/${draftId}`, { method: "POST", token: bob.token, body: { done: false } });
    assert.equal(reopened.status, "open");
    const activity = await json<{ events: Array<{ action: string }> }>(`${base}/api/activity?document=${page.id}`, { token: ada.token });
    assert.ok(activity.events.some((event) => event.action === "task.completed"));

    const documentTasks = await json<{ tasks: TaskResponse[] }>(`${base}/api/documents/${page.id}/tasks`, { token: carl.token });
    assert.equal(documentTasks.tasks.length, 4);
    await json(`${base}/api/documents/${page.id}/tasks/task-missing1`, { token: carl.token, expectedStatus: 404 });

    await json(`${base}/api/trash/document/${page.id}`, { method: "POST", token: ada.token });
    assert.deepEqual(await myTasks(ada.token, "?assignee=any&status=all"), []);
    const trashedWrite = await request(`${base}/api/documents/${page.id}/tasks/${draftId}`, { method: "POST", token: ada.token, body: { done: true } });
    assert.equal(trashedWrite.status, 410);
  } finally {
    await harness.close();
  }
});
