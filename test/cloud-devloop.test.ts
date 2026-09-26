import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { issuesMentioned, runAppName } from "../src/cloud/devloop.js";
import { EzkeelRunProvider, FakeRunProvider } from "../src/cloud/run-provider.js";
import type { CloudProject } from "../src/cloud-db.js";
import { createCloudUser, createSpace, json, request, startCloudServer } from "./cloud-wiki-harness.js";

interface RepoResponse {
  linked: boolean;
  repo?: string;
  webhookSecret?: string;
  hookPath: string;
  runEnvironment: string | null;
  runsEnabled?: boolean;
  usage?: { minutesUsed: number; activeRuns: number };
}

interface RunResponse {
  id: string;
  kind: "deploy" | "test";
  ref: string;
  status: string;
  appName: string;
  url?: string;
  issueKey?: string;
  threadId?: string;
  channelId?: string;
  minutes: number;
  agentId?: string;
}

interface IssueResponse {
  id: string;
  key: string;
  status: string;
  type: string;
  labels: string[];
  summary: string;
  links?: Array<{ targetIssueKey: string; type: string }>;
  comments?: Array<{ body: string }>;
}

interface MessageResponse {
  id: string;
  body: string;
  kind: string;
  threadId?: string;
}

function hook(base: string, projectId: string, secret: string, event: string, payload: unknown, delivery = `d-${Math.random()}`): Promise<{ status: number; body: Record<string, unknown> }> {
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  return fetch(`${base}/api/hooks/github/${projectId}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-github-event": event, "x-github-delivery": delivery, "x-hub-signature-256": signature },
    body,
  }).then(async (response) => ({ status: response.status, body: (await response.json()) as Record<string, unknown> }));
}

function pullPayload(action: string, extra: Record<string, unknown> = {}) {
  return {
    action,
    number: 7,
    repository: { full_name: "acme/shop" },
    pull_request: {
      number: 7,
      title: "SHIP-1: checkout flow",
      body: "Implements the checkout.",
      html_url: "https://github.com/acme/shop/pull/7",
      head: { ref: "feature/checkout", sha: "abc123" },
      user: { login: "octocat" },
      merged: false,
      ...extra,
    },
  };
}

async function setup(prefix: string, provider?: FakeRunProvider) {
  const harness = await startCloudServer(prefix, { runProvider: provider ?? null, queueIntervalMs: 0 });
  const { base } = harness;
  const ada = await createCloudUser(base, "Ada Lovelace");
  const bob = await createCloudUser(base, "Bob Builder");
  const vic = await createCloudUser(base, "Vic Viewer");
  const { site } = await createSpace(base, ada.token, "Delivery", []);
  await json(`${base}/api/sites/${site.id}/collaborators`, { method: "POST", token: ada.token, body: { userId: bob.id, role: "editor" } });
  await json(`${base}/api/sites/${site.id}/collaborators`, { method: "POST", token: ada.token, body: { userId: vic.id, role: "viewer" } });
  const project = await json<{ id: string; key: string }>(`${base}/api/projects`, { method: "POST", token: ada.token, body: { siteId: site.id, key: "SHIP", name: "Shop" } });
  const channel = await json<{ id: string }>(`${base}/api/channels`, { method: "POST", token: ada.token, body: { siteId: site.id, name: "shop", projectId: project.id } });
  const root = await json<MessageResponse>(`${base}/api/channels/${channel.id}/messages`, { method: "POST", token: bob.token, body: { body: "Checkout needs a flow" } });
  const { issue } = await json<{ issue: IssueResponse }>(`${base}/api/channels/${channel.id}/messages/${root.id}/issue`, { method: "POST", token: bob.token, body: {} });
  return { harness, base, ada, bob, vic, site, project, channel, root, issue };
}

async function thread(base: string, token: string, channelId: string, rootId: string): Promise<MessageResponse[]> {
  return (await json<{ replies: MessageResponse[] }>(`${base}/api/channels/${channelId}/messages/${rootId}`, { token })).replies;
}

test("run app names are RFC 1123 and issue keys are found in text", () => {
  const project = { id: "p", key: "SHIP", siteId: "s" } as CloudProject;
  assert.equal(runAppName(project, "deploy", "feature/SHIP-1_login", "r1"), "ship-feature-ship-1-login");
  assert.equal(runAppName(project, "test", "main", "ABCDEF1234567"), "ship-test-abcdef1234");
  const long = runAppName(project, "deploy", `feature/${"x".repeat(120)}`, "r");
  assert.ok(long.length <= 63 && /^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(long));
  assert.notEqual(long, runAppName(project, "deploy", `feature/${"x".repeat(119)}y`, "r"), "truncated names stay distinct");
  const issues = new Map([["SHIP-1", { id: "i1", key: "SHIP-1", projectId: "p" }], ["SHIP-12", { id: "i12", key: "SHIP-12", projectId: "p" }]]);
  const config = { store: { readIssue: (key: string) => issues.get(key) } } as unknown as Parameters<typeof issuesMentioned>[0];
  assert.deepEqual(issuesMentioned(config, project, "fix ship-1 and SHIP-12, not XSHIP-1 or SHIP-123").map((issue) => issue.key), ["SHIP-1", "SHIP-12"]);
});

test("repository linking: owners link and see the secret, editors cannot, hooks bypass the access gate", async () => {
  const { harness, base, ada, bob, vic, project } = await setup("noma-devloop-link-");
  try {
    const empty = await json<RepoResponse>(`${base}/api/projects/${project.id}/repo`, { token: vic.token });
    assert.equal(empty.linked, false);
    assert.equal(empty.runEnvironment, null);
    await json(`${base}/api/projects/${project.id}/repo`, { method: "PUT", token: bob.token, body: { repo: "acme/shop" }, expectedStatus: 403 });
    await json(`${base}/api/projects/${project.id}/repo`, { method: "PUT", token: ada.token, body: { repo: "not a repo" }, expectedStatus: 400 });
    const linked = await json<RepoResponse>(`${base}/api/projects/${project.id}/repo`, { method: "PUT", token: ada.token, body: { repo: "acme/shop", runsEnabled: true }, expectedStatus: 201 });
    assert.equal(linked.hookPath, `/api/hooks/github/${project.id}`);
    assert.match(linked.webhookSecret ?? "", /^[0-9a-f]{48}$/);
    const asViewer = await json<RepoResponse>(`${base}/api/projects/${project.id}/repo`, { token: vic.token });
    assert.equal(asViewer.repo, "acme/shop");
    assert.equal(asViewer.webhookSecret, undefined, "only owners see the webhook secret");
    const kept = await json<RepoResponse>(`${base}/api/projects/${project.id}/repo`, { method: "PUT", token: ada.token, body: { autoPreview: true } });
    assert.equal(kept.webhookSecret, linked.webhookSecret, "updating settings keeps the secret");
    const rotated = await json<RepoResponse>(`${base}/api/projects/${project.id}/repo`, { method: "PUT", token: ada.token, body: { rotateSecret: true } });
    assert.notEqual(rotated.webhookSecret, linked.webhookSecret);

    const noEnv = await json<{ code: string }>(`${base}/api/projects/${project.id}/runs`, { method: "POST", token: bob.token, body: { kind: "deploy" }, expectedStatus: 503 });
    assert.equal(noEnv.code, "run_environment_unavailable");

    assert.equal((await hook(base, project.id, "wrong", "ping", { zen: "hi" })).status, 401);
    assert.equal((await hook(base, "missing", rotated.webhookSecret!, "ping", {})).status, 404);
    assert.equal((await hook(base, project.id, rotated.webhookSecret!, "ping", { zen: "hi" })).status, 202);
    const audit = await json<{ events: Array<{ action: string }> }>(`${base}/api/enterprise/audit`, { token: ada.token });
    assert.ok(audit.events.some((event) => event.action === "repo.linked"));
    assert.equal((await hook(base, project.id, rotated.webhookSecret!, "pull_request", { action: "opened", number: "x" })).status, 400);
    assert.equal((await hook(base, project.id, rotated.webhookSecret!, "pull_request", { action: "opened", number: "x" }, "retry-me")).status, 400);
    assert.equal((await hook(base, project.id, rotated.webhookSecret!, "pull_request", { action: "opened", number: "x" }, "retry-me")).status, 400, "a failed delivery is not remembered, so GitHub's retry runs again");
  } finally {
    await harness.close();
  }

  const gated = await startCloudServer("noma-devloop-gate-", { accessToken: "gate-secret" });
  try {
    const blocked = await request(`${gated.base}/api/projects`, {});
    assert.notEqual(blocked.status, 200);
    const reached = await fetch(`${gated.base}/api/hooks/github/nope`, { method: "POST", headers: { "x-hub-signature-256": "sha256=00" }, body: "{}" });
    assert.equal(reached.status, 404, "the hook is served before the access gate — its HMAC is the credential");
  } finally {
    await gated.close();
  }
});

test("pull requests and CI move issues and land in the issue's chat thread", async () => {
  const provider = new FakeRunProvider();
  const { harness, base, ada, bob, project, channel, root, issue } = await setup("noma-devloop-github-", provider);
  try {
    const repo = await json<RepoResponse>(`${base}/api/projects/${project.id}/repo`, { method: "PUT", token: ada.token, body: { repo: "acme/shop", runsEnabled: true, autoPreview: true }, expectedStatus: 201 });
    const secret = repo.webhookSecret!;

    const opened = await hook(base, project.id, secret, "pull_request", pullPayload("opened"), "delivery-1");
    assert.equal(opened.status, 202);
    assert.deepEqual(opened.body.issues, ["SHIP-1"]);
    assert.equal((opened.body.runs as string[]).length, 1, "auto-preview deploys the pull request's branch");
    assert.equal((await hook(base, project.id, secret, "pull_request", pullPayload("opened"), "delivery-1")).body.duplicate, true, "redeliveries are ignored");
    assert.equal(provider.started[0]?.ref, "feature/checkout");
    assert.equal(provider.started[0]?.repoUrl, "https://github.com/acme/shop.git");

    let current = await json<IssueResponse>(`${base}/api/projects/${project.id}/issues/${issue.id}`, { token: bob.token });
    assert.equal(current.status, "in_review");
    assert.ok(current.comments?.some((comment) => comment.body.includes("#7 SHIP-1: checkout flow")));
    let replies = await thread(base, bob.token, channel.id, root.id);
    assert.ok(replies.some((reply) => reply.kind === "system" && reply.body.includes("opened by octocat")), "the PR lands in the issue's thread");
    assert.ok(replies.some((reply) => reply.body.includes("Deploying `feature/checkout`")));

    const pulls = await json<{ pulls: Array<{ number: number; issues: Array<{ key: string }>; state: string }> }>(`${base}/api/projects/${project.id}/pulls`, { token: bob.token });
    assert.deepEqual(pulls.pulls.map((pull) => [pull.number, pull.state, pull.issues.map((item) => item.key)]), [[7, "open", ["SHIP-1"]]]);

    const ciFailed = await hook(base, project.id, secret, "workflow_run", {
      action: "completed",
      repository: { full_name: "acme/shop" },
      workflow_run: { name: "CI", conclusion: "failure", head_sha: "abc123", head_branch: "feature/checkout", html_url: "https://github.com/acme/shop/actions/runs/1" },
    });
    assert.deepEqual(ciFailed.body.issues, ["SHIP-1"]);
    const suite = await hook(base, project.id, secret, "check_suite", { action: "completed", repository: { full_name: "acme/shop" }, check_suite: { app: { slug: "github-actions" }, conclusion: "failure", head_sha: "abc123" } });
    assert.equal(suite.body.handled, false, "Actions check suites duplicate workflow_run and are skipped");
    replies = await thread(base, bob.token, channel.id, root.id);
    assert.ok(replies.some((reply) => reply.body.includes("❌ CI failed on [#7]")));
    const [pull] = (await json<{ pulls: Array<{ ciStatus: string; ciUrl: string }> }>(`${base}/api/projects/${project.id}/pulls`, { token: bob.token })).pulls;
    assert.equal(pull?.ciStatus, "failure");

    await hook(base, project.id, secret, "workflow_run", { action: "completed", repository: { full_name: "acme/shop" }, workflow_run: { name: "CI", conclusion: "success", head_sha: "abc123", head_branch: "feature/checkout" } });
    assert.equal((await hook(base, project.id, secret, "pull_request", { ...pullPayload("opened"), repository: { full_name: "evil/fork" } })).body.handled, false);

    const merged = await hook(base, project.id, secret, "pull_request", pullPayload("closed", { merged: true }));
    assert.deepEqual(merged.body.issues, ["SHIP-1"]);
    current = await json<IssueResponse>(`${base}/api/projects/${project.id}/issues/${issue.id}`, { token: bob.token });
    assert.equal(current.status, "done", "merging the pull request finishes the issue");
    replies = await thread(base, bob.token, channel.id, root.id);
    assert.ok(replies.some((reply) => reply.body.includes("✅ CI passed")));
    assert.ok(replies.some((reply) => reply.body.includes("merged — SHIP-1 is done")));
    assert.deepEqual(provider.tornDown, ["ship-feature-checkout"], "closing the pull request tears its preview down");
    const history = await json<{ events: Array<{ action: string }> }>(`${base}/api/projects/${project.id}/issues/${issue.id}/history`, { token: bob.token });
    assert.ok(["pr.linked", "ci.failed", "ci.passed", "pr.merged"].every((action) => history.events.some((event) => event.action === action)));
  } finally {
    await harness.close();
  }
});

test("/deploy and /test run on the run environment, report back, and file bugs for failing tests", async () => {
  const provider = new FakeRunProvider();
  const { harness, base, ada, bob, vic, project, channel, root, issue } = await setup("noma-devloop-runs-", provider);
  try {
    await json(`${base}/api/projects/${project.id}/repo`, { method: "PUT", token: ada.token, body: { repo: "acme/shop", runsEnabled: true, maxConcurrent: 2 }, expectedStatus: 201 });
    await json(`${base}/api/projects/${project.id}/issues/${issue.id}`, { method: "PATCH", token: bob.token, body: { status: "todo" } });
    await json(`${base}/api/projects/${project.id}/issues/${issue.id}`, { method: "PATCH", token: bob.token, body: { status: "in_progress" } });

    await json(`${base}/api/channels/${channel.id}/messages`, { method: "POST", token: bob.token, body: { body: "/deploy feature/SHIP-1-checkout", threadId: root.id } });
    let runs = (await json<{ runs: RunResponse[] }>(`${base}/api/projects/${project.id}/runs`, { token: vic.token })).runs;
    assert.equal(runs.length, 1);
    const deploy = runs[0]!;
    assert.deepEqual([deploy.kind, deploy.status, deploy.issueKey, deploy.threadId, deploy.appName], ["deploy", "running", "SHIP-1", root.id, "ship-feature-ship-1-checkout"]);

    harness.clock.advance(3 * 60_000);
    provider.finish(deploy.appName, { status: "success" });
    const done = await json<RunResponse>(`${base}/api/projects/${project.id}/runs/${deploy.id}`, { token: bob.token });
    assert.equal(done.status, "success");
    assert.equal(done.minutes, 3);
    assert.equal(done.url, "https://ship-feature-ship-1-checkout.apps.test");
    let replies = await thread(base, bob.token, channel.id, root.id);
    assert.ok(replies.some((reply) => reply.body === `✅ Preview of \`feature/SHIP-1-checkout\` is live: ${done.url}`));
    assert.equal((await json<IssueResponse>(`${base}/api/projects/${project.id}/issues/${issue.id}`, { token: bob.token })).status, "in_review", "a live preview moves in-progress work to review");

    const test = await json<RunResponse>(`${base}/api/projects/${project.id}/runs`, { method: "POST", token: bob.token, body: { kind: "test", ref: "main", issueId: issue.id, channelId: channel.id, threadId: root.id }, expectedStatus: 201 });
    assert.equal(test.status, "running");
    provider.finish(test.appName, { status: "failed", error: "clone_build failed", log: "npm test\n1 failing: checkout total" });
    const failed = await json<RunResponse>(`${base}/api/projects/${project.id}/runs/${test.id}`, { token: bob.token });
    assert.equal(failed.status, "failed");
    assert.ok(provider.tornDown.includes(test.appName), "test builds are torn down");
    const issues = (await json<{ issues: IssueResponse[] }>(`${base}/api/projects/${project.id}/issues`, { token: bob.token })).issues;
    const bug = issues.find((item) => item.type === "bug")!;
    assert.equal(bug.summary, "Tests failing on main");
    assert.deepEqual(bug.labels, ["ci"]);
    const bugDetail = await json<IssueResponse>(`${base}/api/projects/${project.id}/issues/${bug.id}`, { token: bob.token });
    assert.deepEqual(bugDetail.links?.map((link) => [link.targetIssueKey, link.type]), [["SHIP-1", "relates"]]);
    replies = await thread(base, bob.token, channel.id, root.id);
    assert.ok(replies.some((reply) => reply.body.startsWith(`❌ Tests failed on \`main\` — filed ${bug.key}`) && reply.body.includes("1 failing: checkout total")));

    await json(`${base}/api/projects/${project.id}/runs`, { method: "POST", token: vic.token, body: { kind: "deploy" }, expectedStatus: 403 });
    await json(`${base}/api/projects/${project.id}/runs`, { method: "POST", token: bob.token, body: { kind: "deploy", ref: "--upload-pack=x" }, expectedStatus: 400 });
    const again = await json<MessageResponse>(`${base}/api/channels/${channel.id}/messages`, { method: "POST", token: vic.token, body: { body: "/test main" } });
    replies = await thread(base, bob.token, channel.id, again.id);
    assert.match(replies[0]?.body ?? "", /^⚠️ \/test main was not started: editor access is required/);

    await json(`${base}/api/projects/${project.id}/runs`, { method: "POST", token: bob.token, body: { kind: "deploy", ref: "one" } });
    await json(`${base}/api/projects/${project.id}/runs`, { method: "POST", token: bob.token, body: { kind: "deploy", ref: "two" } });
    const busy = await json<{ code: string }>(`${base}/api/projects/${project.id}/runs`, { method: "POST", token: bob.token, body: { kind: "deploy", ref: "three" }, expectedStatus: 429 });
    assert.equal(busy.code, "run_concurrency_limit");
    runs = (await json<{ runs: RunResponse[] }>(`${base}/api/projects/${project.id}/runs`, { token: bob.token })).runs;
    const one = runs.find((run) => run.ref === "one")!;
    const stopped = await json<RunResponse>(`${base}/api/projects/${project.id}/runs/${one.id}`, { method: "DELETE", token: bob.token });
    assert.equal(stopped.status, "canceled");

    await json(`${base}/api/projects/${project.id}/repo`, { method: "PUT", token: ada.token, body: { monthlyMinutes: 3 } });
    const broke = await json<{ code: string }>(`${base}/api/projects/${project.id}/runs`, { method: "POST", token: bob.token, body: { kind: "test" }, expectedStatus: 429 });
    assert.equal(broke.code, "run_budget_exhausted");

    provider.failStart = "ezkeel refused the app: 403 tier limit";
    await json(`${base}/api/projects/${project.id}/repo`, { method: "PUT", token: ada.token, body: { monthlyMinutes: 600, maxConcurrent: 5 } });
    const refused = await json<RunResponse & { error: string }>(`${base}/api/projects/${project.id}/runs`, { method: "POST", token: bob.token, body: { kind: "deploy", ref: "four" }, expectedStatus: 201 });
    assert.equal(refused.status, "failed");
    assert.match(refused.error, /tier limit/);

    const audit = await json<{ events: Array<{ action: string }> }>(`${base}/api/enterprise/audit`, { token: ada.token });
    assert.ok(["run.requested", "run.finished", "run.stopped"].every((action) => audit.events.some((event) => event.action === action)));
  } finally {
    await harness.close();
  }
});

test("agents start runs through the gateway only with the run capability and a space grant", async () => {
  const provider = new FakeRunProvider();
  const { harness, base, ada, bob, project, site } = await setup("noma-devloop-agents-", provider);
  try {
    await json(`${base}/api/projects/${project.id}/repo`, { method: "PUT", token: ada.token, body: { repo: "acme/shop", runsEnabled: true }, expectedStatus: 201 });
    const runner = await json<{ id: string }>(`${base}/api/agents`, { method: "POST", token: bob.token, body: { name: "Release Bot", capabilities: ["chat", "run"] } });
    const chatty = await json<{ id: string }>(`${base}/api/agents`, { method: "POST", token: bob.token, body: { name: "Chatty", capabilities: ["chat"] } });
    const call = (agentId: string) =>
      request<{ result?: { structuredContent: { run: RunResponse } }; error?: string }>(`${base}/api/gateway/mcp`, {
        method: "POST",
        token: bob.token,
        body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "run_request", arguments: { agentId, projectId: project.id, kind: "test", ref: "main", issueKey: "SHIP-1" } } },
      });
    assert.equal((await call(runner.id)).status, 403, "no space grant yet");
    for (const id of [runner.id, chatty.id]) await json(`${base}/api/agents/${id}/access`, { method: "POST", token: bob.token, body: { resourceType: "site", resourceId: site.id, role: "viewer" } });
    assert.equal((await call(chatty.id)).status, 403, "chat alone does not allow runs");
    const started = await call(runner.id);
    assert.equal(started.status, 200);
    const run = started.body.result!.structuredContent.run;
    assert.deepEqual([run.kind, run.agentId, run.issueKey], ["test", runner.id, "SHIP-1"]);
    const tools = await json<{ result: { tools: Array<{ name: string }> } }>(`${base}/api/gateway/mcp`, { method: "POST", token: bob.token, body: { jsonrpc: "2.0", id: 2, method: "tools/list" } });
    assert.ok(tools.result.tools.some((tool) => tool.name === "run_request"));
  } finally {
    await harness.close();
  }
});

test("the ezkeel provider speaks ezkeel's headless API", async () => {
  const calls: Array<{ method: string; url: string; body?: string; auth?: string }> = [];
  const replies: Record<string, { status: number; body: unknown }> = {
    "POST /api/apps": { status: 409, body: { error: "app name already taken" } },
    "POST /api/apps/ship-main/deploy": { status: 202, body: { deploy_id: "d-1", status: "running" } },
    "GET /api/deploys/d-1": { status: 200, body: { deploy: { status: "failed", error: "build failed" }, steps: [{ step_name: "clone_build", status: "failed", output: "line1\nline2", error: "exit 1" }] } },
    "DELETE /api/apps/ship-main?purge=1": { status: 404, body: { error: "app not found" } },
  };
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const key = `${init?.method ?? "GET"} ${url.pathname}${url.search}`;
    calls.push({ method: init?.method ?? "GET", url: key, ...(typeof init?.body === "string" ? { body: init.body } : {}), auth: (init?.headers as Record<string, string>).authorization });
    const reply = replies[key] ?? { status: 500, body: { error: `unexpected ${key}` } };
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  }) as typeof fetch;
  const provider = new EzkeelRunProvider({ url: "https://ezkeel.test/", token: "ezk_x", appsDomain: "apps.ezkeel.test", fetch: fakeFetch });
  const started = await provider.start({ appName: "ship-main", repoUrl: "https://github.com/acme/shop.git", ref: "main", kind: "deploy" });
  assert.deepEqual(started, { providerRef: "d-1", url: "https://ship-main.apps.ezkeel.test" });
  assert.equal(calls[1]?.body, JSON.stringify({ ref: "main" }), "the ref rides the deploy body");
  assert.equal(calls[0]?.auth, "Bearer ezk_x");
  const status = await provider.status("ship-main", "d-1");
  assert.deepEqual(status, { status: "failed", providerRef: "d-1", error: "build failed", log: "line1\nline2\nexit 1" });
  await provider.teardown("ship-main");
  await assert.rejects(provider.start({ appName: "nope", repoUrl: "x", ref: "main", kind: "test" }), /refused the deploy: 500/);
});
