import assert from "node:assert/strict";
import test from "node:test";
import { type CloudDocumentResponse, createCloudUser, createSpace, json, savePage, startCloudServer } from "./cloud-wiki-harness.js";

interface AssignmentResponse {
  id: string;
  agentId: string;
  agentName: string;
  documentId: string;
  documentTitle?: string;
  documentHash?: string;
  source: "comment" | "task";
  commentId?: string;
  taskId?: string;
  request: string;
  requestedBy: string;
  status: "open" | "in_progress" | "done" | "declined";
  note?: string;
  proposalIds: string[];
  replyCommentIds: string[];
  completedAt?: string;
  thread?: Array<{ id: string; body: string; author: string; agentId?: string }>;
}

interface CommentResponse {
  id: string;
  body: string;
  parentId?: string;
  blockId?: string;
  createdBy: string;
  agent?: { id: string; name: string };
  mentions: Array<{ id: string; name: string; agent?: true }>;
}

async function mcp<T>(base: string, token: string, name: string, args: Record<string, unknown>, expectedStatus?: number): Promise<T> {
  const response = await json<{ result: { structuredContent: T } }>(`${base}/api/gateway/mcp`, {
    method: "POST",
    token,
    body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    ...(expectedStatus ? { expectedStatus } : {}),
  });
  return response.result?.structuredContent;
}

test("@-mentioning an agent in a comment opens an assignment it can answer in-thread and link proposals to", async () => {
  const harness = await startCloudServer("noma-agent-assign-");
  const { base } = harness;
  try {
    const ada = await createCloudUser(base, "Ada Lovelace");
    const bob = await createCloudUser(base, "Bob Builder");
    const eve = await createCloudUser(base, "Eve Outsider");
    const { site, pages } = await createSpace(base, ada.token, "Research", [`# Market memo\n\n::claim{id="tam" confidence=0.6}\nThe market is $4B.\n::\n`]);
    const page = pages[0]!;
    await json(`${base}/api/sites/${site.id}/collaborators`, { method: "POST", token: ada.token, body: { userId: bob.id, role: "editor" } });

    const agent = await json<{ id: string }>(`${base}/api/agents`, {
      method: "POST",
      token: bob.token,
      body: { name: "Research Bot", capabilities: ["read_doc", "list_ids", "patch_block", "comment"] },
    });
    const idle = await json<{ id: string }>(`${base}/api/agents`, { method: "POST", token: bob.token, body: { name: "Ungranted Bot", capabilities: ["comment"] } });

    let assignable = await json<{ agents: Array<{ id: string; name: string; canReply: boolean }> }>(`${base}/api/documents/${page.id}/agents`, { token: ada.token });
    assert.deepEqual(assignable.agents, [], "agents without a grant are not assignable");
    await json(`${base}/api/agents/${agent.id}/access`, { method: "POST", token: bob.token, body: { resourceType: "site", resourceId: site.id, role: "editor" } });
    assignable = await json(`${base}/api/documents/${page.id}/agents`, { token: ada.token });
    assert.deepEqual(assignable.agents.map((item) => [item.id, item.name, item.canReply]), [[agent.id, "Research Bot", true]]);
    await json(`${base}/api/documents/${page.id}/agents`, { token: eve.token, expectedStatus: 403 });
    const picker = await json<{ users: Array<{ id: string; name: string; agent?: true }> }>(`${base}/api/users?q=research&document=${page.id}`, { token: ada.token });
    assert.deepEqual(picker.users.filter((item) => item.agent).map((item) => item.id), [agent.id], "the mention picker offers assignable agents");
    const named = await json<{ users: Array<{ id: string; name: string; agent?: true }> }>(`${base}/api/users?ids=${agent.id},${idle.id}&document=${page.id}`, { token: ada.token });
    assert.deepEqual(named.users, [{ id: agent.id, name: "Research Bot", agent: true }]);
    assert.equal((await json<{ users: unknown[] }>(`${base}/api/users?q=research`, { token: ada.token })).users.length, 0, "agents only show for a page");

    const comment = await json<CommentResponse>(`${base}/api/documents/${page.id}/comments`, {
      method: "POST",
      token: ada.token,
      body: { body: `@{${agent.id}} please check the TAM against the latest filings. @{${idle.id}} too`, blockId: "tam" },
    });
    assert.deepEqual(comment.mentions.map((mention) => [mention.name, mention.agent]), [["Research Bot", true]], "only assignable agents resolve");

    const inbox = await json<{ assignments: AssignmentResponse[] }>(`${base}/api/agents/${agent.id}/assignments?status=active`, { token: bob.token });
    assert.equal(inbox.assignments.length, 1);
    const assignment = inbox.assignments[0]!;
    assert.equal(assignment.source, "comment");
    assert.equal(assignment.commentId, comment.id);
    assert.equal(assignment.status, "open");
    assert.equal(assignment.requestedBy, ada.id);
    assert.equal(assignment.documentTitle, "Market memo");
    assert.equal(assignment.documentHash, page.hash);
    assert.deepEqual(assignment.thread?.map((item) => item.id), [comment.id]);
    assert.equal((await json<{ assignments: AssignmentResponse[] }>(`${base}/api/agents/${idle.id}/assignments`, { token: bob.token })).assignments.length, 0);
    await json(`${base}/api/agents/${agent.id}/assignments`, { token: ada.token, expectedStatus: 403 });

    const bobNotes = await json<{ notifications: Array<{ type: string; title: string }> }>(`${base}/api/notifications`, { token: bob.token });
    assert.ok(bobNotes.notifications.some((note) => note.type === "task_assigned" && note.title.includes("Research Bot")), "the agent's owner hears about the request");

    const again = await json<CommentResponse>(`${base}/api/documents/${page.id}/comments/${comment.id}`, { method: "PATCH", token: ada.token, body: { body: `@{${agent.id}} please check the TAM (edited)` } });
    assert.ok(again.id);
    assert.equal((await json<{ assignments: AssignmentResponse[] }>(`${base}/api/agents/${agent.id}/assignments`, { token: bob.token })).assignments.length, 1, "editing keeps one assignment");

    const replied = await mcp<{ comment: CommentResponse; assignment: AssignmentResponse }>(base, bob.token, "reply", {
      agentId: agent.id,
      assignmentId: assignment.id,
      body: `Checking now. @{${agent.id}} self-mentions do not loop.`,
    });
    assert.equal(replied.comment.parentId, comment.id);
    assert.equal(replied.comment.agentId, agent.id);
    assert.equal(replied.assignment.status, "in_progress");
    const comments = await json<{ comments: CommentResponse[] }>(`${base}/api/documents/${page.id}/comments`, { token: ada.token });
    const agentComment = comments.comments.find((item) => item.id === replied.comment.id)!;
    assert.deepEqual(agentComment.agent, { id: agent.id, name: "Research Bot" });
    assert.equal(agentComment.createdBy, bob.id);
    assert.equal((await json<{ assignments: AssignmentResponse[] }>(`${base}/api/agents/${agent.id}/assignments?status=all`, { token: bob.token })).assignments.length, 1, "agent replies never open assignments");
    const adaNotes = await json<{ notifications: Array<{ type: string; body: string }> }>(`${base}/api/notifications`, { token: ada.token });
    assert.ok(adaNotes.notifications.some((note) => note.type === "comment" && note.body.includes("Checking now")), "the requester is told about the reply");

    const proposal = await mcp<{ proposed: boolean; proposal: { id: string }; assignment: AssignmentResponse }>(base, bob.token, "proposal", {
      agentId: agent.id,
      documentId: page.id,
      assignmentId: assignment.id,
      summary: "Lower TAM confidence",
      ops: [{ op: "update_attribute", id: "tam", key: "confidence", value: 0.4 }],
    });
    assert.equal(proposal.proposed, true);
    assert.deepEqual(proposal.assignment.proposalIds, [proposal.proposal.id]);

    await mcp(base, bob.token, "update_assignment", { agentId: agent.id, assignmentId: assignment.id, status: "finished" }, 400);
    const done = await mcp<{ assignment: AssignmentResponse }>(base, bob.token, "update_assignment", {
      agentId: agent.id,
      assignmentId: assignment.id,
      status: "done",
      note: "Proposed confidence 0.4; filings show $3.1B.",
    });
    assert.equal(done.assignment.status, "done");
    assert.ok(done.assignment.completedAt);
    const closedNotes = await json<{ notifications: Array<{ title: string; body: string }> }>(`${base}/api/notifications`, { token: ada.token });
    assert.ok(closedNotes.notifications.some((note) => note.title === "Research Bot finished your request" && note.body.includes("$3.1B")));

    const pageAssignments = await json<{ assignments: AssignmentResponse[] }>(`${base}/api/documents/${page.id}/agent-assignments`, { token: ada.token });
    assert.deepEqual(pageAssignments.assignments.map((item) => [item.agentName, item.status]), [["Research Bot", "done"]]);
    assert.equal((await json<{ assignments: AssignmentResponse[] }>(`${base}/api/agents/${agent.id}/assignments?status=active`, { token: bob.token })).assignments.length, 0);

    const tools = await json<{ result: { tools: Array<{ name: string }> } }>(`${base}/api/gateway/mcp`, { method: "POST", token: bob.token, body: { jsonrpc: "2.0", id: 2, method: "tools/list" } });
    for (const name of ["assignments", "reply", "update_assignment"]) assert.ok(tools.result.tools.some((tool) => tool.name === name), `${name} is an MCP tool`);
  } finally {
    await harness.close();
  }
});

test("page tasks assigned to an agent open assignments, and checking the task off closes them", async () => {
  const harness = await startCloudServer("noma-agent-tasks-");
  const { base } = harness;
  try {
    const ada = await createCloudUser(base, "Ada Lovelace");
    const { site, pages } = await createSpace(base, ada.token, "Ops", ["# Runbook\n\nSteps.\n"]);
    const agent = await json<{ id: string }>(`${base}/api/agents`, { method: "POST", token: ada.token, body: { name: "Ops Bot", capabilities: ["read_doc", "comment"] } });
    await json(`${base}/api/agents/${agent.id}/access`, { method: "POST", token: ada.token, body: { resourceType: "site", resourceId: site.id, role: "viewer" } });

    let page: CloudDocumentResponse = await savePage(base, ada.token, pages[0]!, `# Runbook\n\n- [ ] Refresh the restart steps @{${agent.id}} due:2026-07-01\n`);
    const taskId = /\{#(task-[a-z0-9]{8})\}/.exec(page.source)?.[1];
    assert.ok(taskId);
    let assignments = (await json<{ assignments: AssignmentResponse[] }>(`${base}/api/agents/${agent.id}/assignments`, { token: ada.token })).assignments;
    assert.equal(assignments.length, 1);
    assert.equal(assignments[0]!.source, "task");
    assert.equal(assignments[0]!.taskId, taskId);
    assert.equal(assignments[0]!.request, "Refresh the restart steps");

    const reply = await json<{ comment: CommentResponse; assignment: AssignmentResponse }>(`${base}/api/agents/${agent.id}/assignments/${assignments[0]!.id}/reply`, {
      method: "POST",
      token: ada.token,
      body: { body: "Drafting updated steps." },
    });
    assert.equal(reply.comment.blockId, taskId, "task replies anchor to the task's block");
    assert.equal(reply.comment.parentId, undefined);

    page = await savePage(base, ada.token, page, page.source.replace("[ ]", "[x]"));
    assignments = (await json<{ assignments: AssignmentResponse[] }>(`${base}/api/agents/${agent.id}/assignments`, { token: ada.token })).assignments;
    assert.equal(assignments[0]!.status, "done");
    assert.match(assignments[0]!.note ?? "", /checked off/);

    await json(`${base}/api/agents/${agent.id}/access`, { method: "POST", token: ada.token, body: { resourceType: "document", resourceId: page.id, role: "viewer" } });
    const silent = await json<{ id: string }>(`${base}/api/agents`, { method: "POST", token: ada.token, body: { name: "Silent Bot", capabilities: ["read_doc"] } });
    await json(`${base}/api/agents/${silent.id}/access`, { method: "POST", token: ada.token, body: { resourceType: "document", resourceId: page.id, role: "viewer" } });
    await json(`${base}/api/documents/${page.id}/comments`, { method: "POST", token: ada.token, body: { body: `@{${silent.id}} look` } });
    const silentAssignment = (await json<{ assignments: AssignmentResponse[] }>(`${base}/api/agents/${silent.id}/assignments`, { token: ada.token })).assignments[0]!;
    await json(`${base}/api/agents/${silent.id}/assignments/${silentAssignment.id}/reply`, { method: "POST", token: ada.token, body: { body: "hi" }, expectedStatus: 403 });
    await json(`${base}/api/agents/${silent.id}/assignments/${silentAssignment.id}/status`, { method: "POST", token: ada.token, body: { proposalId: "missing-proposal" }, expectedStatus: 400 });
    const declined = await json<{ assignment: AssignmentResponse }>(`${base}/api/agents/${silent.id}/assignments/${silentAssignment.id}/status`, { method: "POST", token: ada.token, body: { status: "declined", note: "No comment capability" } });
    assert.equal(declined.assignment.status, "declined");
  } finally {
    await harness.close();
  }
});

test("agent.assigned is a space webhook event", async () => {
  const harness = await startCloudServer("noma-agent-hook-");
  const { base } = harness;
  try {
    const ada = await createCloudUser(base, "Ada Lovelace");
    const { site } = await createSpace(base, ada.token, "Hooks", ["# Page\n\nBody.\n"]);
    const listed = await json<{ events: string[] }>(`${base}/api/sites/${site.id}/webhooks`, { token: ada.token });
    assert.ok(listed.events.includes("agent.assigned"));
  } finally {
    await harness.close();
  }
});
