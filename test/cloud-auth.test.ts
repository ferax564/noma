import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openNomaCloudDatabase, type CloudDocumentRecord } from "../src/cloud-db.js";
import { createNomaCloudServer, type NomaCloudServerOptions } from "../src/cloud-server.js";

interface CloudUserResponse {
  id: string;
  name: string;
  token: string;
  tokenPreview?: string;
}

interface CloudDocumentResponse {
  id: string;
  title: string;
  source: string;
  hash: string;
}

interface TokenResponse {
  id: string;
  name: string;
  token?: string;
  tokenPreview: string;
  scopes: string[];
  expiresAt?: string;
  lastUsedAt?: string;
  revokedAt?: string;
  active: boolean;
}

interface SessionListResponse {
  sessions: Array<{ id: string; current: boolean; scopes: string[]; source: string; userAgent?: string; ip?: string; expiresAt: string }>;
}

interface JsonRequestOptions {
  method?: string;
  token?: string;
  cookie?: string;
  csrf?: string;
  headers?: Record<string, string>;
  body?: unknown;
  expectedStatus?: number;
}

interface CloudTestHarness {
  base: string;
  root: string;
  clock: { now: Date };
  close(): Promise<void>;
}

interface BrowserCookies {
  session: string;
  csrf: string;
  cookie: string;
  raw: string[];
}

test("browser sessions use HttpOnly cookies, require CSRF for mutations, and can be listed and revoked", async () => {
  const harness = await startCloudServer("noma-cloud-auth-sessions-");
  try {
    const registered = await fetch(`${harness.base}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "auth-test-browser" },
      body: JSON.stringify({ name: "Cookie Alice" }),
    });
    assert.equal(registered.status, 201);
    const registeredPayload = (await registered.json()) as { user: CloudUserResponse; csrfToken: string };
    const alice = registeredPayload.user;
    const browser = browserCookies(registered.headers.getSetCookie());
    assert.equal(registeredPayload.csrfToken, browser.csrf);
    const sessionCookie = browser.raw.find((cookie) => cookie.startsWith("noma_session="));
    const csrfCookie = browser.raw.find((cookie) => cookie.startsWith("noma_csrf="));
    assert.match(sessionCookie ?? "", /; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000$/);
    assert.doesNotMatch(csrfCookie ?? "", /HttpOnly/);
    assert.doesNotMatch(sessionCookie ?? "", /Secure/);

    const me = await json<CloudUserResponse>(`${harness.base}/api/users/me`, { cookie: browser.cookie });
    assert.equal(me.id, alice.id);
    assert.equal(typeof me.tokenPreview, "string");

    const noCsrf = await json<{ code: string }>(`${harness.base}/api/documents`, {
      method: "POST",
      cookie: browser.cookie,
      body: { source: "# Forged\n\nCross-site write." },
      expectedStatus: 403,
    });
    assert.equal(noCsrf.code, "csrf_required");
    const wrongCsrf = await json<{ code: string }>(`${harness.base}/api/documents`, {
      method: "POST",
      cookie: browser.cookie,
      csrf: "not-the-token",
      body: { source: "# Forged\n\nCross-site write." },
      expectedStatus: 403,
    });
    assert.equal(wrongCsrf.code, "csrf_required");
    const created = await json<CloudDocumentResponse>(`${harness.base}/api/documents`, {
      method: "POST",
      cookie: browser.cookie,
      csrf: browser.csrf,
      body: { source: "# Cookie Page\n\nWritten with a session." },
    });
    assert.equal(created.title, "Cookie Page");

    await json(`${harness.base}/api/documents`, { method: "POST", token: alice.token, body: { source: "# Bearer Page\n\nNo CSRF needed." } });

    const current = await json<{ authenticated: boolean; method: string; csrfToken: string; sessionId: string }>(`${harness.base}/api/auth/session`, { cookie: browser.cookie });
    assert.equal(current.authenticated, true);
    assert.equal(current.method, "session");
    assert.equal(current.csrfToken, browser.csrf);
    const anonymous = await json<{ authenticated: boolean }>(`${harness.base}/api/auth/session`);
    assert.equal(anonymous.authenticated, false);

    const refreshed = await fetch(`${harness.base}/api/auth/session`, { headers: { cookie: `noma_session=${browser.session}` } });
    const refreshedPayload = (await refreshed.json()) as { csrfToken: string };
    assert.notEqual(refreshedPayload.csrfToken, browser.csrf);
    assert.match(refreshed.headers.getSetCookie().join("\n"), /noma_csrf=/);
    browser.csrf = refreshedPayload.csrfToken;
    browser.cookie = `noma_session=${browser.session}; noma_csrf=${browser.csrf}`;

    const login = await fetch(`${harness.base}/api/auth/session`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-proto": "https" },
      body: JSON.stringify({ userToken: alice.token }),
    });
    assert.equal(login.status, 200);
    const laptop = browserCookies(login.headers.getSetCookie());
    assert.ok(laptop.raw.every((cookie) => cookie.endsWith("; Secure")));
    const loginPayload = (await login.json()) as { user: Record<string, unknown> };
    assert.equal(loginPayload.user.token, undefined);

    const sessions = await json<SessionListResponse>(`${harness.base}/api/auth/sessions`, { cookie: browser.cookie });
    assert.equal(sessions.sessions.length, 2);
    const currentSession = sessions.sessions.find((session) => session.current);
    const otherSession = sessions.sessions.find((session) => !session.current);
    assert.ok(currentSession && otherSession);
    assert.equal(currentSession.userAgent, "auth-test-browser");
    assert.equal(currentSession.source, "register");
    assert.deepEqual(currentSession.scopes, ["read", "write", "admin"]);
    assert.equal(typeof currentSession.ip, "string");

    const bob = await createCloudUser(harness.base, "Bob");
    await json(`${harness.base}/api/auth/sessions/${otherSession.id}`, { method: "DELETE", token: bob.token, expectedStatus: 404 });
    await json(`${harness.base}/api/auth/sessions/${otherSession.id}`, { method: "DELETE", cookie: browser.cookie, expectedStatus: 403 });
    await json(`${harness.base}/api/auth/sessions/${otherSession.id}`, { method: "DELETE", cookie: browser.cookie, csrf: browser.csrf });
    await json(`${harness.base}/api/users/me`, { cookie: laptop.cookie, expectedStatus: 401 });
    await json(`${harness.base}/api/users/me`, { cookie: browser.cookie });

    await json(`${harness.base}/api/auth/logout`, { method: "POST", cookie: browser.cookie, body: {}, expectedStatus: 403 });
    const logout = await fetch(`${harness.base}/api/auth/logout`, {
      method: "POST",
      headers: { cookie: browser.cookie, "x-noma-csrf": browser.csrf },
    });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.getSetCookie().join("\n"), /noma_session=; Path=\/; HttpOnly; SameSite=Lax; Max-Age=0/);
    await json(`${harness.base}/api/users/me`, { cookie: browser.cookie, expectedStatus: 401 });
    await json(`${harness.base}/api/users/me`, { token: alice.token });
  } finally {
    await harness.close();
  }
});

test("personal access tokens are scoped, expiring, revocable, and never stored in clear", async () => {
  const harness = await startCloudServer("noma-cloud-auth-pat-");
  try {
    const alice = await createCloudUser(harness.base, "Alice Admin");
    const readOnly = await json<TokenResponse>(`${harness.base}/api/tokens`, {
      method: "POST",
      token: alice.token,
      body: { name: "Reporting bot", scopes: ["read"] },
    });
    assert.match(readOnly.token ?? "", /^noma_pat_[A-Za-z0-9_-]{40,}$/);
    assert.deepEqual(readOnly.scopes, ["read"]);
    assert.equal(readOnly.active, true);
    assert.equal(readOnly.expiresAt, undefined);

    await json(`${harness.base}/api/users/me`, { token: readOnly.token });
    const denied = await json<{ code: string; requiredScope: string }>(`${harness.base}/api/documents`, {
      method: "POST",
      token: readOnly.token,
      body: { source: "# Nope\n\nRead-only token." },
      expectedStatus: 403,
    });
    assert.equal(denied.code, "insufficient_scope");
    assert.equal(denied.requiredScope, "write");
    await json(`${harness.base}/api/db/query`, { method: "POST", token: readOnly.token, body: { resource: "documents" } });
    await json(`${harness.base}/api/tokens`, { method: "POST", token: readOnly.token, body: { name: "Escalate", scopes: ["write"] }, expectedStatus: 403 });
    await json(`${harness.base}/api/users/me/rotate-token`, { method: "POST", token: readOnly.token, body: {}, expectedStatus: 403 });

    const listed = await json<{ tokens: TokenResponse[]; limit: number; offset: number }>(`${harness.base}/api/tokens`, { token: alice.token });
    assert.equal(listed.tokens.length, 1);
    assert.equal(listed.tokens[0]?.token, undefined);
    assert.equal(listed.tokens[0]?.tokenPreview.startsWith("noma_"), true);
    assert.equal(listed.tokens[0]?.lastUsedAt, harness.clock.now.toISOString());
    assert.equal(JSON.stringify(listed).includes(readOnly.token ?? "missing"), false);

    const writer = await json<TokenResponse>(`${harness.base}/api/tokens`, {
      method: "POST",
      token: alice.token,
      body: { name: "Docs agent", scopes: ["write"], expiresInDays: 1 },
    });
    assert.deepEqual(writer.scopes, ["read", "write"]);
    await json(`${harness.base}/api/documents`, { method: "POST", token: writer.token, body: { source: "# Agent Page\n\nWritten by a PAT." } });
    const enterpriseDenied = await json<{ code: string }>(`${harness.base}/api/enterprise`, { token: writer.token, expectedStatus: 403 });
    assert.equal(enterpriseDenied.code, "insufficient_scope");
    const admin = await json<TokenResponse>(`${harness.base}/api/tokens`, { method: "POST", token: alice.token, body: { name: "Admin", scopes: ["admin", "write"] } });
    await json(`${harness.base}/api/enterprise`, { token: admin.token });

    await json(`${harness.base}/api/tokens`, { method: "POST", token: alice.token, body: { name: "Bad", scopes: ["root"] }, expectedStatus: 400 });
    await json(`${harness.base}/api/tokens`, { method: "POST", token: alice.token, body: { name: "Bad", scopes: [] }, expectedStatus: 400 });
    await json(`${harness.base}/api/tokens`, { method: "POST", token: alice.token, body: { name: "Bad", scopes: ["read"], expiresInDays: 0 }, expectedStatus: 400 });

    const patLogin = await fetch(`${harness.base}/api/auth/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userToken: readOnly.token }),
    });
    assert.equal(patLogin.status, 200);
    const patBrowser = browserCookies(patLogin.headers.getSetCookie());
    const patSessionDenied = await json<{ code: string }>(`${harness.base}/api/documents`, {
      method: "POST",
      cookie: patBrowser.cookie,
      csrf: patBrowser.csrf,
      body: { source: "# Nope\n\nSession inherits read scope." },
      expectedStatus: 403,
    });
    assert.equal(patSessionDenied.code, "insufficient_scope");

    const bob = await createCloudUser(harness.base, "Bob");
    await json(`${harness.base}/api/tokens/${readOnly.id}`, { method: "DELETE", token: bob.token, expectedStatus: 404 });
    await json(`${harness.base}/api/tokens/${readOnly.id}`, { method: "DELETE", token: alice.token });
    const revoked = await json<{ code: string }>(`${harness.base}/api/users/me`, { token: readOnly.token, expectedStatus: 401 });
    assert.equal(revoked.code, "token_revoked");
    await json(`${harness.base}/api/users/me`, { cookie: patBrowser.cookie, expectedStatus: 401 });
    const afterRevoke = await json<{ tokens: TokenResponse[] }>(`${harness.base}/api/tokens`, { token: alice.token });
    assert.equal(afterRevoke.tokens.find((token) => token.id === readOnly.id)?.active, false);

    harness.clock.now = new Date(harness.clock.now.getTime() + 2 * 86_400_000);
    const expired = await json<{ code: string }>(`${harness.base}/api/users/me`, { token: writer.token, expectedStatus: 401 });
    assert.equal(expired.code, "token_expired");

    const rotated = await json<CloudUserResponse & { revokedSessions: number }>(`${harness.base}/api/users/me/rotate-token`, { method: "POST", token: alice.token, body: {} });
    assert.notEqual(rotated.token, alice.token);
    await json(`${harness.base}/api/users/me`, { token: alice.token, expectedStatus: 401 });
    await json(`${harness.base}/api/users/me`, { token: rotated.token });
    await json(`${harness.base}/api/enterprise`, { token: admin.token });
  } finally {
    await harness.close();
  }
});

test("production enterprise admin fails closed without an admin allowlist; development bootstraps the first user", async () => {
  const production = await startCloudServer("noma-cloud-auth-admin-", { production: true, allowOpenAccess: true, allowOpenRegistration: true });
  try {
    const first = await createCloudUser(production.base, "First User");
    const closed = await json<{ code: string; error: string }>(`${production.base}/api/enterprise`, { token: first.token, expectedStatus: 403 });
    assert.equal(closed.code, "admin_not_configured");
    assert.match(closed.error, /NOMA_CLOUD_ADMIN_USER_IDS/);
    await json(`${production.base}/api/enterprise/retention`, { method: "POST", token: first.token, body: {}, expectedStatus: 403 });
    await json(`${production.base}/api/status`, { token: first.token });
  } finally {
    await production.close();
  }

  const development = await startCloudServer("noma-cloud-auth-admin-dev-");
  try {
    const first = await createCloudUser(development.base, "Bootstrap Admin");
    const second = await createCloudUser(development.base, "Second User");
    await json(`${development.base}/api/enterprise`, { token: first.token });
    await json(`${development.base}/api/enterprise`, { token: second.token, expectedStatus: 403 });
  } finally {
    await development.close();
  }
});

test("production admin allowlist grants enterprise access to the configured user", async () => {
  const harness = await startCloudServer("noma-cloud-auth-admin-allow-", { production: true, allowOpenAccess: true, allowOpenRegistration: true });
  let admin: CloudUserResponse | undefined;
  try {
    admin = await createCloudUser(harness.base, "Configured Admin");
  } finally {
    await harness.close({ keepData: true });
  }
  const restarted = await startCloudServer("unused-", { production: true, allowOpenAccess: true, allowOpenRegistration: true, adminUserIds: [admin.id], root: harness.root });
  try {
    await json(`${restarted.base}/api/enterprise`, { token: admin.token });
  } finally {
    await restarted.close();
  }
});

test("access gate tokens on app paths are rate limited with the auth limiter", async () => {
  const harness = await startCloudServer("noma-cloud-auth-gate-", { accessToken: "gate-secret", authRateLimitMaxRequests: 3 });
  try {
    await writeFile(join(harness.root, "public", "cloud.html"), "<h1>Cloud</h1>", "utf8");
    for (let attempt = 0; attempt < 3; attempt++) {
      const guess = await fetch(`${harness.base}/cloud.html?access=guess-${attempt}`, { redirect: "manual" });
      assert.equal(guess.status, 302);
      assert.match(guess.headers.get("location") ?? "", /^\/login\.html/);
      assert.equal(guess.headers.get("x-ratelimit-limit"), "3");
    }
    const limited = await fetch(`${harness.base}/cloud.html?access=gate-secret`, { redirect: "manual" });
    assert.equal(limited.status, 429);
    const payload = (await limited.json()) as { code: string };
    assert.equal(payload.code, "rate_limit_exceeded");
    assert.ok(Number(limited.headers.get("retry-after")) >= 1);
    const plain = await fetch(`${harness.base}/index.html`);
    assert.equal(plain.status, 200);
    assert.equal(plain.headers.get("x-ratelimit-limit"), null);
  } finally {
    await harness.close();
  }
});

test("token previews are visible only to their owner", async () => {
  const harness = await startCloudServer("noma-cloud-auth-preview-");
  try {
    const alice = await createCloudUser(harness.base, "Alice");
    const bob = await createCloudUser(harness.base, "Bob");
    const users = await json<{ users: Array<{ id: string; tokenPreview?: string; tokenHash?: string }> }>(`${harness.base}/api/users`, { token: alice.token });
    assert.equal(typeof users.users.find((user) => user.id === alice.id)?.tokenPreview, "string");
    assert.equal(users.users.find((user) => user.id === bob.id)?.tokenPreview, undefined);
    assert.ok(users.users.every((user) => user.tokenHash === undefined));
    const rows = await json<{ rows: Array<{ id: string; tokenPreview?: string }> }>(`${harness.base}/api/db/query`, { method: "POST", token: bob.token, body: { resource: "users" } });
    assert.equal(rows.rows.find((row) => row.id === alice.id)?.tokenPreview, undefined);
    assert.equal(typeof rows.rows.find((row) => row.id === bob.id)?.tokenPreview, "string");
    const status = await json<{ user: { tokenPreview?: string } }>(`${harness.base}/api/status`, { token: bob.token });
    assert.equal(typeof status.user.tokenPreview, "string");
  } finally {
    await harness.close();
  }
});

test("backup import validates the whole bundle, writes atomically, and does not reveal inaccessible IDs", async () => {
  const harness = await startCloudServer("noma-cloud-auth-backup-");
  try {
    const alice = await createCloudUser(harness.base, "Alice");
    const bob = await createCloudUser(harness.base, "Bob");
    const bobsSecret = await json<CloudDocumentResponse>(`${harness.base}/api/documents`, { method: "POST", token: bob.token, body: { source: "# Bob Secret\n\nPrivate." } });
    const shared = await json<CloudDocumentResponse>(`${harness.base}/api/documents`, { method: "POST", token: bob.token, body: { source: "# Shared Read\n\nViewer only." } });
    await json(`${harness.base}/api/documents/${shared.id}/collaborators`, { method: "POST", token: bob.token, body: { userId: alice.id, role: "viewer" } });
    const own = await json<CloudDocumentResponse>(`${harness.base}/api/documents`, { method: "POST", token: alice.token, body: { source: "# Alice Page\n\nVersion one." } });
    const exportedAt = new Date(harness.clock.now.getTime() + 60_000).toISOString();

    const hidden = backupBundle(exportedAt, [
      { documentId: "freshdoc001", title: "Fresh", source: "# Fresh\n\nNew page." },
      { documentId: bobsSecret.id, title: "Hijack", source: "# Hijack\n\nOverwrite attempt." },
    ]);
    const dryRun = await json<{ applied: boolean; plan: { create: Array<{ documentId: string }>; update: unknown[] } }>(`${harness.base}/api/backup/import`, { method: "POST", token: alice.token, body: { bundle: hidden } });
    assert.equal(dryRun.applied, false);
    assert.deepEqual(dryRun.plan.create.map((file) => file.documentId).sort(), ["freshdoc001", bobsSecret.id].sort());
    const hiddenError = await json<{ code: string; error: string }>(`${harness.base}/api/backup/import`, { method: "POST", token: alice.token, body: { bundle: hidden, apply: true }, expectedStatus: 409 });
    assert.equal(hiddenError.code, "backup_ids_unavailable");
    assert.equal(hiddenError.error.includes(bobsSecret.id), false);
    await json(`${harness.base}/api/documents/freshdoc001`, { token: alice.token, expectedStatus: 404 });

    const viewerOnly = backupBundle(exportedAt, [
      { documentId: "freshdoc002", title: "Fresh Two", source: "# Fresh Two\n\nNew page." },
      { documentId: shared.id, title: "Shared Read", source: "# Shared Read\n\nEdited without edit rights." },
    ]);
    const viewerError = await json<{ code: string; error: string }>(`${harness.base}/api/backup/import`, { method: "POST", token: alice.token, body: { bundle: viewerOnly, apply: true }, expectedStatus: 409 });
    assert.deepEqual(viewerError, hiddenError);
    await json(`${harness.base}/api/documents/freshdoc002`, { token: alice.token, expectedStatus: 404 });

    const valid = backupBundle(exportedAt, [
      { documentId: "freshdoc003", title: "Fresh Three", source: "# Fresh Three\n\nImported." },
      { documentId: own.id, title: "Alice Page", source: "# Alice Page\n\nVersion two from backup." },
    ]);
    const applied = await json<{ applied: boolean; created: string[]; updated: string[] }>(`${harness.base}/api/backup/import`, { method: "POST", token: alice.token, body: { bundle: valid, apply: true } });
    assert.deepEqual(applied, { ...applied, applied: true, created: ["freshdoc003"], updated: [own.id] });
    const imported = await json<CloudDocumentResponse>(`${harness.base}/api/documents/freshdoc003`, { token: alice.token });
    assert.equal(imported.title, "Fresh Three");
    const updated = await json<CloudDocumentResponse>(`${harness.base}/api/documents/${own.id}`, { token: alice.token });
    assert.match(updated.source, /Version two from backup/);

    const tooMany = backupBundle(exportedAt, Array.from({ length: 1_001 }, (_, index) => ({ documentId: `bulkdoc${String(index).padStart(4, "0")}`, title: "Bulk", source: "# Bulk\n" })));
    const tooLarge = await fetch(`${harness.base}/api/backup/import`, {
      method: "POST",
      headers: { authorization: `Bearer ${alice.token}`, "content-type": "application/json" },
      body: JSON.stringify({ bundle: tooMany }),
    });
    assert.equal(tooLarge.status, 413);
  } finally {
    await harness.close();
  }
});

test("store transactions roll back every write when one fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "noma-cloud-auth-tx-"));
  const store = openNomaCloudDatabase({
    dbPath: join(root, "noma-cloud.sqlite"),
    dataDir: join(root, "documents"),
    usersDir: join(root, "users"),
    sitesDir: join(root, "sites"),
  });
  try {
    const record = (id: string): CloudDocumentRecord => ({
      version: 2,
      id,
      title: id,
      source: `# ${id}\n`,
      hash: sha256Hex(`# ${id}\n`),
      createdAt: "2026-06-06T12:00:00.000Z",
      updatedAt: "2026-06-06T12:00:00.000Z",
      createdBy: "tester01",
      updatedBy: "tester01",
      permissions: {},
      shareLinks: [],
    });
    assert.throws(() =>
      store.runInTransaction(() => {
        store.writeDocument(record("txdoc0001"));
        store.writeDocument(record("txdoc0002"));
        throw new Error("simulated failure");
      }),
    );
    assert.equal(store.readDocument("txdoc0001"), undefined);
    assert.equal(store.readDocument("txdoc0002"), undefined);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy JSON records move out of the data directory after a successful import", async () => {
  const root = await mkdtemp(join(tmpdir(), "noma-cloud-auth-legacy-"));
  const dataRoot = join(root, "data");
  const dataDir = join(dataRoot, "documents");
  const usersDir = join(dataRoot, "users");
  const sitesDir = join(dataRoot, "sites");
  await mkdir(dataDir, { recursive: true });
  await mkdir(usersDir, { recursive: true });
  await mkdir(sitesDir, { recursive: true });
  const token = "nu_legacy_move_token";
  const now = "2026-06-01T00:00:00.000Z";
  const source = "# Legacy Move\n\nImported then moved.";
  await writeFile(join(usersDir, "legacyusr9.json"), JSON.stringify({ version: 1, id: "legacyusr9", name: "Legacy", tokenHash: sha256Hex(token), tokenPreview: "nu_le...token", createdAt: now, updatedAt: now }), "utf8");
  await writeFile(
    join(dataDir, "legacydoc9.json"),
    JSON.stringify({ version: 2, id: "legacydoc9", title: "Legacy Move", source, hash: sha256Hex(source), createdAt: now, updatedAt: now, createdBy: "legacyusr9", updatedBy: "legacyusr9", permissions: { legacyusr9: { role: "owner", addedAt: now } }, shareLinks: [] }),
    "utf8",
  );
  await writeFile(join(dataDir, "notes.noma"), "# Not legacy JSON\n", "utf8");

  const options = { dbPath: join(dataRoot, "noma-cloud.sqlite"), dataDir, usersDir, sitesDir };
  const store = openNomaCloudDatabase(options);
  try {
    assert.equal(store.readDocument("legacydoc9")?.title, "Legacy Move");
    assert.equal(store.findUserByToken(sha256Hex(token))?.id, "legacyusr9");
  } finally {
    store.close();
  }
  assert.deepEqual(await readdir(dataDir), ["notes.noma"]);
  await assert.rejects(stat(usersDir));
  await assert.rejects(stat(sitesDir));
  const moved = (await readdir(dataRoot)).filter((name) => name.startsWith("legacy-imported-"));
  assert.equal(moved.length, 1);
  assert.deepEqual(await readdir(join(dataRoot, moved[0] ?? "", "documents")), ["legacydoc9.json"]);
  assert.deepEqual(await readdir(join(dataRoot, moved[0] ?? "", "users")), ["legacyusr9.json"]);

  const reopened = openNomaCloudDatabase(options);
  try {
    assert.equal(reopened.readDocument("legacydoc9")?.title, "Legacy Move");
  } finally {
    reopened.close();
  }
  assert.equal((await readdir(dataRoot)).filter((name) => name.startsWith("legacy-imported-")).length, 1);
  await rm(root, { recursive: true, force: true });
});

test("offline drafts and analytics have per-user quotas, and listings paginate", async () => {
  const harness = await startCloudServer("noma-cloud-auth-quota-", { maxBodyBytes: 3_000_000, rateLimitMaxRequests: 5_000 });
  try {
    const alice = await createCloudUser(harness.base, "Alice");
    const page = await json<CloudDocumentResponse>(`${harness.base}/api/documents`, { method: "POST", token: alice.token, body: { source: "# Draft Target\n\nBase." } });
    const draftBody = { documentId: page.id, baseHash: page.hash, baseSource: page.source, source: `${page.source}\nEdited offline.` };

    const huge = "x".repeat(600_000);
    const tooLarge = await json<{ code: string }>(`${harness.base}/api/offline/drafts`, { method: "POST", token: alice.token, body: { ...draftBody, baseSource: huge, source: huge }, expectedStatus: 413 });
    assert.equal(tooLarge.code, "offline_draft_too_large");

    for (let index = 0; index < 200; index++) {
      await json(`${harness.base}/api/offline/drafts`, { method: "POST", token: alice.token, body: draftBody });
    }
    const quota = await json<{ code: string }>(`${harness.base}/api/offline/drafts`, { method: "POST", token: alice.token, body: draftBody, expectedStatus: 429 });
    assert.equal(quota.code, "offline_draft_quota_exceeded");
    const firstPage = await json<{ drafts: unknown[]; limit: number; offset: number }>(`${harness.base}/api/offline/drafts?limit=5&offset=10`, { token: alice.token });
    assert.equal(firstPage.drafts.length, 5);
    assert.equal(firstPage.offset, 10);
    const all = await json<{ drafts: unknown[] }>(`${harness.base}/api/offline/drafts`, { token: alice.token });
    assert.equal(all.drafts.length, 200);
    await json(`${harness.base}/api/offline/drafts?limit=abc`, { token: alice.token, expectedStatus: 400 });
    await json(`${harness.base}/api/offline/drafts?limit=5000`, { token: alice.token, expectedStatus: 400 });

    for (let index = 0; index < 120; index++) {
      await json(`${harness.base}/api/analytics`, { method: "POST", token: alice.token, body: { type: "no_result", query: `q${index}` } });
    }
    const limited = await json<{ code: string }>(`${harness.base}/api/analytics`, { method: "POST", token: alice.token, body: { type: "no_result" }, expectedStatus: 429 });
    assert.equal(limited.code, "analytics_rate_limited");

    harness.clock.now = new Date(harness.clock.now.getTime() + 91 * 86_400_000);
    await json(`${harness.base}/api/analytics`, { method: "POST", token: alice.token, body: { type: "task_completed" } });
    const summary = await json<{ total: number }>(`${harness.base}/api/analytics`, { token: alice.token });
    assert.equal(summary.total, 1);

    const agents = await json<{ agents: unknown[]; limit: number }>(`${harness.base}/api/agents?limit=10`, { token: alice.token });
    assert.equal(agents.limit, 10);
  } finally {
    await harness.close();
  }
});

async function startCloudServer(
  prefix: string,
  options: Partial<NomaCloudServerOptions> & { root?: string } = {},
): Promise<CloudTestHarness & { close(options?: { keepData?: boolean }): Promise<void> }> {
  const { root: existingRoot, ...serverOptions } = options;
  const root = existingRoot ?? (await mkdtemp(join(tmpdir(), prefix)));
  const publicDir = join(root, "public");
  await mkdir(publicDir, { recursive: true });
  await writeFile(join(publicDir, "index.html"), "<h1>Noma</h1>", "utf8");
  const clock = { now: new Date("2026-06-06T12:00:00.000Z") };
  const server = createNomaCloudServer({
    dataDir: join(root, "data", "documents"),
    usersDir: join(root, "data", "users"),
    sitesDir: join(root, "data", "sites"),
    dbPath: join(root, "data", "noma-cloud.sqlite"),
    publicDir,
    maxBodyBytes: 1_000_000,
    now: () => clock.now,
    ...serverOptions,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    base: `http://127.0.0.1:${address.port}`,
    root,
    clock,
    close: async (closeOptions = {}) => {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      if (!closeOptions.keepData) await rm(root, { recursive: true, force: true });
    },
  };
}

async function createCloudUser(base: string, name: string): Promise<CloudUserResponse> {
  return json<CloudUserResponse>(`${base}/api/users`, { method: "POST", body: { name } });
}

async function json<T = { error?: string }>(url: string, options: JsonRequestOptions = {}): Promise<T> {
  const headers = new Headers({ accept: "application/json" });
  for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value);
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  if (options.cookie) headers.set("cookie", options.cookie);
  if (options.csrf) headers.set("x-noma-csrf", options.csrf);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  if (options.expectedStatus !== undefined) {
    assert.equal(response.status, options.expectedStatus, text);
    return (text ? JSON.parse(text) : {}) as T;
  }
  if (!response.ok) assert.fail(`${response.status} ${text}`);
  return JSON.parse(text) as T;
}

function browserCookies(setCookies: string[]): BrowserCookies {
  const value = (name: string): string => {
    const cookie = setCookies.find((item) => item.startsWith(`${name}=`));
    assert.ok(cookie, `missing ${name} cookie`);
    return cookie.slice(name.length + 1).split(";")[0] ?? "";
  };
  const session = value("noma_session");
  const csrf = value("noma_csrf");
  return { session, csrf, cookie: `noma_session=${session}; noma_csrf=${csrf}`, raw: setCookies };
}

function backupBundle(exportedAt: string, entries: Array<{ documentId: string; title: string; source: string }>): Record<string, unknown> {
  const files = [...entries]
    .sort((left, right) => left.documentId.localeCompare(right.documentId))
    .map((entry) => ({
      path: `documents/${entry.documentId}.noma`,
      documentId: entry.documentId,
      title: entry.title,
      hash: sha256Hex(entry.source),
      source: entry.source,
      updatedAt: exportedAt,
    }));
  const manifest = { format: "noma-cloud-backup-v1", exportedAt, files: files.map(({ source: _source, ...file }) => file) };
  const digest = sha256Hex(`${JSON.stringify(manifest)}\n${files.map((file) => `${file.path}\n${file.source}`).join("\n")}`);
  return { manifest, files, digest };
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
