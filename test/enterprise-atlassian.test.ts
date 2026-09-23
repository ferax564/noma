import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { EnterpriseError } from "../src/enterprise-contracts.js";
import {
  atlassianFetch,
  listConfluencePages,
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
    if (url.endsWith("/wiki/rest/api/content/123?expand=body.storage,version")) {
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
    if (url.includes("/wiki/")) throw new Error(`data center must not use the /wiki prefix: ${url}`);
    if (url.startsWith("https://jira.example.com/rest/api/content/99?")) {
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
  const probe = await atlassianFetch(auth, "wiki/rest/api/content/missing", {}, http);
  assert.equal(probe.status, 404);
});

interface FakeRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: Record<string, unknown>;
  authorization: string;
}

async function fakeAtlassian(
  handler: (req: FakeRequest) => { status?: number; body: unknown; headers?: Record<string, string> },
) {
  const seen: FakeRequest[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://fake.local");
      const raw = Buffer.concat(chunks).toString("utf8");
      const request: FakeRequest = {
        method: req.method ?? "GET",
        path: url.pathname,
        query: url.searchParams,
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
        authorization: req.headers.authorization ?? "",
      };
      seen.push(request);
      const reply = handler(request);
      res.writeHead(reply.status ?? 200, { "content-type": "application/json", ...(reply.headers ?? {}) });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as AddressInfo).port;
  return {
    seen,
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

test("Confluence Data Center paginates via _links.next under its context path without /wiki", async () => {
  const fake = await fakeAtlassian((req) => {
    const start = Number(req.query.get("start"));
    const limit = Number(req.query.get("limit"));
    const all = Array.from({ length: 5 }, (_, i) => ({ id: String(100 + i), title: `Page ${i}`, type: "page" }));
    const results = all.slice(start, start + limit);
    const more = start + limit < all.length;
    return {
      body: {
        results,
        start,
        limit,
        size: results.length,
        _links: more
          ? { next: `http://attacker.example/confluence/rest/api/content?spaceKey=ENG&start=${start + limit}&limit=${limit}` }
          : {},
      },
    };
  });
  try {
    const auth: AtlassianAuth = {
      baseUrl: `${fake.origin}/confluence`,
      edition: "datacenter",
      personalAccessToken: "pat",
      trustedPrivateHosts: ["127.0.0.1"],
    };
    const listed = await listConfluencePages(auth, "ENG", undefined, { pageSize: 2 });
    assert.deepEqual(listed.items.map((item) => item.id), ["100", "101", "102", "103", "104"]);
    assert.equal(listed.pages, 3);
    assert.equal(listed.truncated, false);
    assert.deepEqual(fake.seen.map((req) => req.path), Array(3).fill("/confluence/rest/api/content"));
    assert.deepEqual(fake.seen.map((req) => req.query.get("start")), ["0", "2", "4"]);
    assert.ok(fake.seen.every((req) => req.authorization === "Bearer pat"));

    fake.seen.length = 0;
    const capped = await listConfluencePages(auth, "ENG", undefined, { pageSize: 2, maxPages: 2 });
    assert.equal(capped.items.length, 4);
    assert.equal(capped.truncated, true);
    assert.equal(fake.seen.length, 2);
  } finally {
    await fake.close();
  }
});

test("Confluence Cloud reads through /wiki/rest/api", async () => {
  const fake = await fakeAtlassian((req) => {
    if (req.path === "/wiki/rest/api/content/7") {
      return { body: { title: "Cloud page", body: { storage: { value: "<p>From cloud</p>" } } } };
    }
    return { status: 404, body: {} };
  });
  try {
    const auth: AtlassianAuth = {
      baseUrl: fake.origin,
      edition: "cloud",
      email: "a@example.com",
      apiToken: "tok",
      trustedPrivateHosts: ["127.0.0.1"],
    };
    const page = await fetchConfluencePage(auth, "7");
    assert.match(page.source, /From cloud/);
    assert.equal(fake.seen[0]?.query.get("expand"), "body.storage,version");
    assert.match(fake.seen[0]?.authorization ?? "", /^Basic /);
  } finally {
    await fake.close();
  }
});

test("Jira Cloud search follows nextPageToken and honours maxPages", async () => {
  const tokens = ["", "t2", "t3"];
  const fake = await fakeAtlassian((req) => {
    assert.equal(req.method, "POST");
    assert.equal(req.path, "/rest/api/3/search/jql");
    const index = tokens.indexOf(String(req.body.nextPageToken ?? ""));
    const nextPageToken = tokens[index + 1];
    return { body: { issues: [{ key: `ENG-${index + 1}` }], ...(nextPageToken ? { nextPageToken } : { isLast: true }) } };
  });
  try {
    const auth: AtlassianAuth = {
      baseUrl: fake.origin,
      edition: "cloud",
      email: "a@example.com",
      apiToken: "tok",
      trustedPrivateHosts: ["127.0.0.1"],
    };
    const all = await searchJira(auth, "project = ENG", undefined, { pageSize: 1 });
    assert.deepEqual(all.issues.map((issue) => (issue as { key: string }).key), ["ENG-1", "ENG-2", "ENG-3"]);
    assert.equal(all.truncated, false);
    assert.equal(fake.seen[0]?.body.maxResults, 1);
    assert.equal(fake.seen[1]?.body.nextPageToken, "t2");
    fake.seen.length = 0;
    const capped = await searchJira(auth, "project = ENG", undefined, { pageSize: 1, maxPages: 2 });
    assert.equal(capped.issues.length, 2);
    assert.equal(capped.truncated, true);
    assert.equal(fake.seen.length, 2);
  } finally {
    await fake.close();
  }
});

test("Jira Data Center search pages with startAt/maxResults/total and retries 429", async () => {
  let throttled = false;
  const fake = await fakeAtlassian((req) => {
    assert.equal(req.path, "/jira/rest/api/2/search");
    if (!throttled) {
      throttled = true;
      return { status: 429, body: { message: "slow down" }, headers: { "retry-after": "0" } };
    }
    const startAt = Number(req.body.startAt);
    const maxResults = Number(req.body.maxResults);
    const total = 5;
    const issues = Array.from({ length: Math.max(0, Math.min(maxResults, total - startAt)) }, (_, i) => ({ key: `DC-${startAt + i}` }));
    return { body: { startAt, maxResults, total, issues } };
  });
  try {
    const auth: AtlassianAuth = {
      baseUrl: `${fake.origin}/jira/`,
      edition: "datacenter",
      personalAccessToken: "pat",
      trustedPrivateHosts: ["127.0.0.1"],
    };
    const result = await searchJira(auth, "project = DC", undefined, { pageSize: 2 });
    assert.deepEqual(result.issues.map((issue) => (issue as { key: string }).key), ["DC-0", "DC-1", "DC-2", "DC-3", "DC-4"]);
    assert.equal(result.pages, 3);
    assert.deepEqual(fake.seen.map((req) => req.body.startAt), [0, 0, 2, 4]);
  } finally {
    await fake.close();
  }
});

test("SSRF guard still blocks private hosts unless explicitly trusted, and pins requests to the site", async () => {
  const fake = await fakeAtlassian(() => ({ body: {} }));
  try {
    const auth: AtlassianAuth = { baseUrl: fake.origin, edition: "datacenter", personalAccessToken: "pat" };
    await assert.rejects(fetchJiraIssue(auth, "ENG-1"), (err: unknown) => err instanceof EnterpriseError && err.code === "policy");
    await assert.rejects(
      atlassianFetch({ ...auth, trustedPrivateHosts: ["127.0.0.1"] }, "https://elsewhere.example.com/rest/api/2/issue/X"),
      (err: unknown) => err instanceof EnterpriseError && err.code === "policy",
    );
    assert.equal(fake.seen.length, 0);
  } finally {
    await fake.close();
  }
});
