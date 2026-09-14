import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  atlassianFetch,
  fetchConfluencePage,
  fetchJiraIssue,
  searchJira,
  type AtlassianAuth,
  type AtlassianHttp,
} from "../src/enterprise-atlassian.js";
import { createTestOidc, EnterpriseWorkspace } from "../src/enterprise-workspace.js";
import { resetIdentitySequence } from "../src/stable-identity.js";

const xml = readFileSync("examples/enterprise/confluence-page.xml", "utf8");
const jira = JSON.parse(readFileSync("examples/enterprise/jira-issue.json", "utf8")) as Record<string, unknown>;

function mockHttp(handler: (url: string, init?: RequestInit) => { status: number; body: unknown; retryAfter?: string }): AtlassianHttp {
  return {
    async fetch(url: string, init?: RequestInit) {
      const result = handler(url, init);
      const headers = new Headers({ "content-type": "application/json" });
      if (result.retryAfter !== undefined) headers.set("retry-after", result.retryAfter);
      return new Response(JSON.stringify(result.body), { status: result.status, headers });
    },
  };
}

test("Cloud and Data Center Atlassian HTTP adapters map storage and issues", async () => {
  resetIdentitySequence(0);
  const oidc = createTestOidc({ alice: { sub: "alice", email: "alice@example.com", name: "Alice" } });
  const ws = new EnterpriseWorkspace({ oidc });
  const tenantId = ws.provisionTenant("Acme").tenantId;
  ws.scimUpsert(tenantId, { externalId: "alice", userName: "Alice", active: true });
  const alice = ws.loginOidc(tenantId, "alice").actor;
  ws.bootstrapGrant(tenantId, alice.principalId, "tenant", tenantId, "owner");
  const spaceId = ws.createSpace(alice, "Docs");
  const projectId = ws.createProject(alice, { key: "ENG", name: "Engineering", spaceId });

  const cloudAuth: AtlassianAuth = {
    baseUrl: "https://acme.atlassian.net/",
    edition: "cloud",
    email: "alice@example.com",
    apiToken: "token",
  };
  const cloudHttp = mockHttp((url) => {
    if (url.includes("wiki/api/v2/pages/123")) {
      return { status: 200, body: { title: "Soak results", body: { storage: { value: xml } } } };
    }
    if (url.includes("rest/api/3/issue/ENG-42")) {
      return { status: 200, body: jira };
    }
    throw new Error(`unexpected cloud URL ${url}`);
  });
  const page = await ws.importLiveConfluencePage(alice, spaceId, cloudAuth, "123", cloudHttp);
  assert.match(ws.readDocument(alice, page.documentId).source, /Soak results/);
  const issue = await ws.importLiveJiraIssue(alice, projectId, cloudAuth, "ENG-42", cloudHttp);
  assert.match(issue.key, /^ENG-/);

  const dcAuth: AtlassianAuth = {
    baseUrl: "https://jira.example.com/",
    edition: "datacenter",
    personalAccessToken: "pat-123",
  };
  let dcAuthHeader = "";
  const dcHttp = mockHttp((url, init) => {
    dcAuthHeader = new Headers(init?.headers).get("authorization") ?? "";
    if (url.includes("rest/api/content/99")) {
      return { status: 200, body: { title: "DC page", body: { storage: { value: "<p>From DC</p>" } } } };
    }
    if (url.includes("rest/api/2/issue/ENG-1")) {
      return { status: 200, body: jira };
    }
    throw new Error(`unexpected dc URL ${url}`);
  });
  const dcPage = await fetchConfluencePage(dcAuth, "99", dcHttp);
  assert.match(dcPage.source, /From DC/);
  const dcIssue = await fetchJiraIssue(dcAuth, "ENG-1", dcHttp);
  assert.equal(dcIssue.key, "ENG-42");
  assert.match(dcAuthHeader, /^Bearer pat-123$/);
  ws.close();
});

test("Atlassian HTTP retries 429 Retry-After and searches Jira", async () => {
  const auth: AtlassianAuth = {
    baseUrl: "https://acme.atlassian.net/",
    edition: "cloud",
    email: "alice@example.com",
    apiToken: "token",
  };
  let calls = 0;
  const http = mockHttp((url) => {
    calls += 1;
    if (url.includes("search/jql") && calls === 1) {
      return { status: 429, body: { message: "slow down" }, retryAfter: "0" };
    }
    if (url.includes("search/jql")) {
      return { status: 200, body: { issues: [{ key: "ENG-1" }] } };
    }
    return { status: 404, body: {} };
  });
  const result = await searchJira(auth, "project = ENG", http);
  assert.equal(calls, 2);
  assert.equal(result.issues?.[0] && (result.issues[0] as { key: string }).key, "ENG-1");
  const probe = await atlassianFetch(auth, "wiki/api/v2/pages/missing", {}, http);
  assert.equal(probe.status, 404);
});
