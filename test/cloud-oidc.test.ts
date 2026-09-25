import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { openNomaCloudDatabase } from "../src/cloud-db.js";
import { createNomaCloudServer, type NomaCloudServerOptions } from "../src/cloud-server.js";
import { resolveOidcSettings } from "../src/cloud/oidc.js";
import { safeReturnTo } from "../src/cloud/routes-oidc.js";

const clientId = "noma-cloud";
const clientSecret = "s3cret value/+";

interface SigningKey {
  kid: string;
  alg: string;
  privateKey: KeyObject;
  publicJwk: Record<string, unknown>;
}

interface IssuedCode {
  nonce: string;
  challenge: string;
  redirectUri: string;
}

interface FakeIdp {
  issuer: string;
  keys: SigningKey[];
  published: SigningKey[];
  codes: Map<string, IssuedCode>;
  claims: Record<string, unknown>;
  tokenOverrides: { alg?: string; kid?: string; tamper?: boolean; claims?: Record<string, unknown>; noneAlg?: boolean };
  signWith: SigningKey;
  jwksFetches: number;
  tokenAuth: string[];
  close(): Promise<void>;
}

function rsaKey(kid: string, alg = "RS256"): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { kid, alg, privateKey, publicJwk: { ...publicKey.export({ format: "jwk" }), kid, alg, use: "sig" } };
}

function ecKey(kid: string): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { kid, alg: "ES256", privateKey, publicJwk: { ...publicKey.export({ format: "jwk" }), kid, alg: "ES256", use: "sig" } };
}

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function signJwt(key: SigningKey, header: Record<string, unknown>, payload: Record<string, unknown>): string {
  const input = `${b64(header)}.${b64(payload)}`;
  const alg = String(header.alg);
  const hash = "sha256";
  const signature =
    alg === "ES256"
      ? sign(hash, Buffer.from(input), { key: key.privateKey, dsaEncoding: "ieee-p1363" })
      : alg === "PS256"
        ? sign(hash, Buffer.from(input), { key: key.privateKey, padding: 6, saltLength: 32 })
        : sign(hash, Buffer.from(input), key.privateKey);
  return `${input}.${signature.toString("base64url")}`;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString("utf8");
}

async function startFakeIdp(clock: { now: Date }): Promise<FakeIdp> {
  const rsa = rsaKey("rsa-1");
  const ec = ecKey("ec-1");
  const idp: Partial<FakeIdp> & { server?: Server } = {
    keys: [rsa, ec],
    published: [rsa, ec],
    codes: new Map(),
    claims: {},
    tokenOverrides: {},
    signWith: rsa,
    jwksFetches: 0,
    tokenAuth: [],
  };
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", idp.issuer);
      const json = (status: number, body: unknown): void => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (url.pathname === "/.well-known/openid-configuration") {
        json(200, {
          issuer: idp.issuer,
          authorization_endpoint: `${idp.issuer}/authorize`,
          token_endpoint: `${idp.issuer}/token`,
          jwks_uri: `${idp.issuer}/jwks`,
          token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
        });
        return;
      }
      if (url.pathname === "/jwks") {
        idp.jwksFetches = (idp.jwksFetches ?? 0) + 1;
        json(200, { keys: idp.published?.map((key) => key.publicJwk) });
        return;
      }
      if (url.pathname === "/token" && req.method === "POST") {
        const form = new URLSearchParams(await readBody(req));
        const basic = req.headers.authorization;
        if (basic) {
          const [id, secret] = Buffer.from(basic.replace(/^Basic /, ""), "base64").toString("utf8").split(":").map(decodeURIComponent);
          if (id !== clientId || secret !== clientSecret) return json(401, { error: "invalid_client" });
          idp.tokenAuth?.push("basic");
        } else {
          if (form.get("client_id") !== clientId || form.get("client_secret") !== clientSecret) return json(401, { error: "invalid_client" });
          idp.tokenAuth?.push("post");
        }
        const issued = idp.codes?.get(form.get("code") ?? "");
        if (!issued) return json(400, { error: "invalid_grant" });
        idp.codes?.delete(form.get("code") ?? "");
        const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
        if (challenge !== issued.challenge) return json(400, { error: "invalid_grant" });
        if (form.get("redirect_uri") !== issued.redirectUri) return json(400, { error: "invalid_grant" });
        const nowSeconds = Math.floor(clock.now.getTime() / 1000);
        const overrides = idp.tokenOverrides ?? {};
        const key = idp.signWith as SigningKey;
        const payload = { iss: idp.issuer, aud: clientId, iat: nowSeconds, exp: nowSeconds + 300, nonce: issued.nonce, ...idp.claims, ...overrides.claims };
        let idToken: string;
        if (overrides.noneAlg) {
          idToken = `${b64({ alg: "none", typ: "JWT" })}.${b64(payload)}.`;
        } else {
          idToken = signJwt(key, { alg: overrides.alg ?? key.alg, kid: overrides.kid ?? key.kid, typ: "JWT" }, payload);
          if (overrides.tamper) {
            const [h, , s] = idToken.split(".");
            idToken = `${h}.${b64({ ...payload, sub: "attacker" })}.${s}`;
          }
        }
        json(200, { access_token: "at", token_type: "Bearer", expires_in: 300, id_token: idToken });
        return;
      }
      json(404, { error: "not_found" });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  idp.issuer = `http://127.0.0.1:${address.port}`;
  idp.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return idp as FakeIdp;
}

interface Harness {
  base: string;
  idp: FakeIdp;
  clock: { now: Date };
  close(): Promise<void>;
}

async function startHarness(oidc: NomaCloudServerOptions["oidc"] = {}, extra: Partial<NomaCloudServerOptions> = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "noma-cloud-oidc-"));
  const publicDir = join(root, "public");
  await mkdir(publicDir, { recursive: true });
  await writeFile(join(publicDir, "cloud.html"), "<h1>Cloud</h1>", "utf8");
  const clock = { now: new Date("2026-09-25T12:00:00.000Z") };
  const idp = await startFakeIdp(clock);
  const server = createNomaCloudServer({
    dataDir: join(root, "data", "documents"),
    usersDir: join(root, "data", "users"),
    sitesDir: join(root, "data", "sites"),
    dbPath: join(root, "data", "noma-cloud.sqlite"),
    publicDir,
    now: () => clock.now,
    queueIntervalMs: 0,
    ai: { provider: null, maintenanceTickMs: 0 },
    authRateLimitMaxRequests: 1000,
    ...extra,
    oidc: oidc === null ? null : { issuer: idp.issuer, clientId, clientSecret, redirectUrl: "http://127.0.0.1/api/auth/oidc/callback", label: "Acme ID", ...oidc },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    base: `http://127.0.0.1:${address.port}`,
    idp,
    clock,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await idp.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

interface StartedLogin {
  flowCookie: string;
  state: string;
  nonce: string;
  challenge: string;
  authorize: URL;
}

async function startLogin(harness: Harness, returnTo?: string): Promise<StartedLogin> {
  const query = returnTo === undefined ? "" : `?returnTo=${encodeURIComponent(returnTo)}`;
  const response = await fetch(`${harness.base}/api/auth/oidc/start${query}`, { redirect: "manual" });
  assert.equal(response.status, 302, await response.text());
  const authorize = new URL(response.headers.get("location") ?? "");
  const setCookie = response.headers.getSetCookie().find((cookie) => cookie.startsWith("noma_oidc_flow="));
  assert.ok(setCookie);
  assert.match(setCookie, /; Path=\/api\/auth\/oidc; HttpOnly; SameSite=Lax; Max-Age=600$/);
  return {
    flowCookie: setCookie.split(";")[0] ?? "",
    state: authorize.searchParams.get("state") ?? "",
    nonce: authorize.searchParams.get("nonce") ?? "",
    challenge: authorize.searchParams.get("code_challenge") ?? "",
    authorize,
  };
}

async function callback(harness: Harness, login: StartedLogin, options: { state?: string; nonce?: string; cookie?: string } = {}): Promise<Response> {
  const code = `code-${Math.random().toString(36).slice(2)}`;
  harness.idp.codes.set(code, { nonce: options.nonce ?? login.nonce, challenge: login.challenge, redirectUri: "http://127.0.0.1/api/auth/oidc/callback" });
  return fetch(`${harness.base}/api/auth/oidc/callback?code=${code}&state=${encodeURIComponent(options.state ?? login.state)}`, {
    redirect: "manual",
    headers: { cookie: options.cookie ?? login.flowCookie },
  });
}

async function login(harness: Harness, claims: Record<string, unknown>, returnTo?: string): Promise<Response> {
  harness.idp.claims = claims;
  return callback(harness, await startLogin(harness, returnTo));
}

function sessionCookies(response: Response): { cookie: string; csrf: string } {
  const cookies = response.headers.getSetCookie();
  const value = (name: string): string => {
    const found = cookies.find((cookie) => cookie.startsWith(`${name}=`) && !cookie.startsWith(`${name}=;`));
    assert.ok(found, `missing ${name}`);
    return found.slice(name.length + 1).split(";")[0] ?? "";
  };
  const session = value("noma_session");
  const csrf = value("noma_csrf");
  return { cookie: `noma_session=${session}; noma_csrf=${csrf}`, csrf };
}

async function api<T>(harness: Harness, path: string, init: { method?: string; token?: string; cookie?: string; csrf?: string; body?: unknown } = {}, expected = 200): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.cookie) headers.cookie = init.cookie;
  if (init.csrf) headers["x-noma-csrf"] = init.csrf;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${harness.base}${path}`, { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  const text = await response.text();
  assert.equal(response.status, expected, text);
  return (text ? JSON.parse(text) : {}) as T;
}

const alice = { sub: "alice-sub", email: "alice@acme.test", email_verified: true, name: "Alice Acme" };

test("OIDC happy path: PKCE + state + nonce, cookie session with working CSRF, returnTo honored, binding reused", async () => {
  const harness = await startHarness({ autoProvision: true });
  try {
    const providers = await api<{ providers: Array<{ id: string; label: string; startUrl: string }>; tokenLogin: boolean }>(harness, "/api/auth/providers");
    assert.deepEqual(providers.providers, [{ id: "oidc", type: "oidc", label: "Acme ID", startUrl: "/api/auth/oidc/start" }]);
    assert.equal(providers.tokenLogin, true);

    harness.idp.claims = alice;
    const started = await startLogin(harness, "/cloud.html?site=abc#frag");
    assert.equal(started.authorize.origin + started.authorize.pathname, `${harness.idp.issuer}/authorize`);
    assert.equal(started.authorize.searchParams.get("response_type"), "code");
    assert.equal(started.authorize.searchParams.get("client_id"), clientId);
    assert.equal(started.authorize.searchParams.get("code_challenge_method"), "S256");
    assert.equal(started.authorize.searchParams.get("scope"), "openid email profile");
    assert.ok(started.state.length >= 43 && started.nonce.length >= 43);
    assert.ok(!started.flowCookie.includes(started.state), "flow cookie must be encrypted");

    const response = await callback(harness, started);
    assert.equal(response.status, 302, await response.text());
    assert.equal(response.headers.get("location"), "/cloud.html?site=abc#frag");
    assert.deepEqual(harness.idp.tokenAuth, ["basic"]);
    const cleared = response.headers.getSetCookie().find((cookie) => cookie.startsWith("noma_oidc_flow="));
    assert.match(cleared ?? "", /Max-Age=0/);
    const session = sessionCookies(response);

    const current = await api<{ authenticated: boolean; user: { id: string; name: string; email?: string } }>(harness, "/api/auth/session", { cookie: session.cookie });
    assert.equal(current.authenticated, true);
    assert.equal(current.user.name, "Alice Acme");
    assert.equal(current.user.email, "alice@acme.test");
    const sessions = await api<{ sessions: Array<{ source: string; current: boolean }> }>(harness, "/api/auth/sessions", { cookie: session.cookie });
    assert.equal(sessions.sessions.find((item) => item.current)?.source, "oidc");

    await api(harness, "/api/documents", { method: "POST", cookie: session.cookie, body: { source: "# Forged\n" } }, 403);
    const created = await api<{ title: string }>(harness, "/api/documents", { method: "POST", cookie: session.cookie, csrf: session.csrf, body: { source: "# OIDC Page\n\nHello." } }, 201);
    assert.equal(created.title, "OIDC Page");

    harness.idp.claims = { ...alice, email: "alice.renamed@acme.test", name: "Renamed" };
    const again = await callback(harness, await startLogin(harness));
    assert.equal(again.status, 302);
    assert.equal(again.headers.get("location"), "/cloud.html");
    const second = await api<{ user: { id: string } }>(harness, "/api/auth/session", { cookie: sessionCookies(again).cookie });
    assert.equal(second.user.id, current.user.id, "the (issuer, sub) binding is reused even when the email changes");
  } finally {
    await harness.close();
  }
});

test("OIDC callback rejects state mismatch, nonce mismatch, missing flow cookie and IdP errors", async () => {
  const harness = await startHarness({ autoProvision: true });
  try {
    harness.idp.claims = alice;
    const started = await startLogin(harness);
    const wrongState = await callback(harness, started, { state: "forged-state" });
    assert.equal(wrongState.status, 400);
    assert.match(await wrongState.text(), /state does not match/);
    assert.equal(wrongState.headers.getSetCookie().some((cookie) => cookie.startsWith("noma_session=")), false);

    const wrongNonce = await callback(harness, started, { nonce: "other-nonce" });
    assert.equal(wrongNonce.status, 401);
    assert.match(await wrongNonce.text(), /nonce/);

    const noCookie = await callback(harness, started, { cookie: "" });
    assert.equal(noCookie.status, 400);
    const tamperedCookie = await callback(harness, started, { cookie: `${started.flowCookie.slice(0, -4)}AAAA` });
    assert.equal(tamperedCookie.status, 400);

    const idpError = await fetch(`${harness.base}/api/auth/oidc/callback?error=access_denied&state=${started.state}`, { redirect: "manual", headers: { cookie: started.flowCookie } });
    assert.equal(idpError.status, 401);

    harness.clock.now = new Date(harness.clock.now.getTime() + 11 * 60_000);
    const expiredFlow = await callback(harness, started);
    assert.equal(expiredFlow.status, 400, "flow cookie expires after ten minutes");
  } finally {
    await harness.close();
  }
});

test("OIDC ID-token verification: bad signature, expiry, wrong aud/iss, alg none/HS256, EC and PS keys, azp", async () => {
  const harness = await startHarness({ autoProvision: true });
  try {
    const expectFailure = async (overrides: FakeIdp["tokenOverrides"], pattern: RegExp): Promise<void> => {
      harness.idp.tokenOverrides = overrides;
      const response = await login(harness, alice);
      const text = await response.text();
      assert.equal(response.status, 401, text);
      assert.match(text, pattern);
      harness.idp.tokenOverrides = {};
    };
    const nowSeconds = Math.floor(harness.clock.now.getTime() / 1000);
    await expectFailure({ tamper: true }, /signature is invalid/);
    await expectFailure({ claims: { exp: nowSeconds - 120 } }, /expired/);
    await expectFailure({ claims: { iat: nowSeconds + 600 } }, /future/);
    await expectFailure({ claims: { nbf: nowSeconds + 600 } }, /not yet valid/);
    await expectFailure({ claims: { aud: "someone-else" } }, /audience/);
    await expectFailure({ claims: { aud: [clientId, "other"] } }, /authorized party/);
    await expectFailure({ claims: { aud: [clientId, "other"], azp: "other" } }, /authorized party/);
    await expectFailure({ claims: { iss: "https://evil.example" } }, /issuer/);
    await expectFailure({ noneAlg: true }, /algorithm none is not accepted/);
    await expectFailure({ alg: "HS256" }, /algorithm HS256 is not accepted/);
    await expectFailure({ alg: "RS256", kid: "ec-1" }, /No signing key/);

    const withinSkew = await login(harness, { ...alice, exp: nowSeconds - 30 });
    assert.equal(withinSkew.status, 302, "small clock skew is tolerated");

    const multiAud = await login(harness, { ...alice, aud: [clientId, "other"], azp: clientId });
    assert.equal(multiAud.status, 302);

    harness.idp.signWith = harness.idp.keys[1] as SigningKey;
    const ec = await login(harness, alice);
    assert.equal(ec.status, 302, await ec.text());

    const ps = rsaKey("ps-1", "PS256");
    harness.idp.published = [...harness.idp.published, ps];
    harness.clock.now = new Date(harness.clock.now.getTime() + 5 * 60_000);
    harness.idp.signWith = ps;
    const psLogin = await login(harness, alice);
    assert.equal(psLogin.status, 302, await psLogin.text());
  } finally {
    await harness.close();
  }
});

test("OIDC unknown kid refreshes the JWKS once, throttled", async () => {
  const harness = await startHarness({ autoProvision: true });
  try {
    const first = await login(harness, alice);
    assert.equal(first.status, 302);
    assert.equal(harness.idp.jwksFetches, 1);

    const rotated = rsaKey("rsa-2");
    harness.idp.published = [rotated];
    harness.idp.signWith = rotated;
    const throttled = await login(harness, alice);
    assert.equal(throttled.status, 401, "refresh is throttled right after the last fetch");
    assert.equal(harness.idp.jwksFetches, 1);

    harness.clock.now = new Date(harness.clock.now.getTime() + 2 * 60_000);
    const refreshed = await login(harness, alice);
    assert.equal(refreshed.status, 302, await refreshed.text());
    assert.equal(harness.idp.jwksFetches, 2);

    const cached = await login(harness, alice);
    assert.equal(cached.status, 302);
    assert.equal(harness.idp.jwksFetches, 2, "known kid uses the cached JWKS");
  } finally {
    await harness.close();
  }
});

test("OIDC returnTo only allows same-origin paths", async () => {
  for (const hostile of ["https://evil.example/", "//evil.example/x", "/\\evil.example", "javascript:alert(1)", "/%0d%0aSet-Cookie:x", "/api/tokens", "cloud.html"]) {
    const safe = safeReturnTo(hostile);
    assert.ok(safe === "/cloud.html" || (safe.startsWith("/") && !safe.startsWith("//")), `${hostile} -> ${safe}`);
    assert.doesNotMatch(safe, /evil|javascript|\r|\n|^\/api\//);
  }
  assert.equal(safeReturnTo("/cloud.html?doc=1"), "/cloud.html?doc=1");

  const harness = await startHarness({ autoProvision: true });
  try {
    const response = await login(harness, alice, "https://evil.example/phish");
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/cloud.html");
    const protocolRelative = await login(harness, alice, "//evil.example");
    assert.equal(protocolRelative.headers.get("location"), "/cloud.html");
  } finally {
    await harness.close();
  }
});

test("OIDC account mapping: domain allowlist, required group, auto-provision off, email_verified, email linking", async () => {
  const harness = await startHarness({ autoProvision: false, linkByEmail: true, allowedDomains: ["acme.test"], requiredGroup: "wiki-users", groupsClaim: "roles" });
  try {
    const existing = await api<{ id: string; token: string }>(harness, "/api/users", { method: "POST", body: { name: "Bob" } }, 201);
    await api(harness, "/api/users/me", { method: "PATCH", token: existing.token, body: { email: "bob@acme.test" } });

    const wrongDomain = await login(harness, { sub: "x1", email: "eve@evil.test", email_verified: true, roles: ["wiki-users"] });
    assert.equal(wrongDomain.status, 403);
    assert.match(await wrongDomain.text(), /domain is not allowed/);

    const noGroup = await login(harness, { sub: "x2", email: "bob@acme.test", email_verified: true, roles: ["other"] });
    assert.equal(noGroup.status, 403);
    assert.match(await noGroup.text(), /group required/);

    const unverified = await login(harness, { sub: "bob-sub", email: "bob@acme.test", email_verified: false, roles: ["wiki-users"] });
    assert.equal(unverified.status, 403, "unverified email neither passes the domain allowlist nor links");

    const unknown = await login(harness, { sub: "carol-sub", email: "carol@acme.test", email_verified: true, roles: ["wiki-users"] });
    assert.equal(unknown.status, 403);
    assert.match(await unknown.text(), /No Noma account is linked/);

    const linked = await login(harness, { sub: "bob-sub", email: "BOB@acme.test", email_verified: true, roles: "wiki-users" });
    assert.equal(linked.status, 302, await linked.text());
    const me = await api<{ user: { id: string } }>(harness, "/api/auth/session", { cookie: sessionCookies(linked).cookie });
    assert.equal(me.user.id, existing.id);

    const noLinking = await startHarness({ autoProvision: false });
    try {
      const user = await api<{ token: string }>(noLinking, "/api/users", { method: "POST", body: { name: "Erin" } }, 201);
      await api(noLinking, "/api/users/me", { method: "PATCH", token: user.token, body: { email: "erin@acme.test" } });
      const refused = await login(noLinking, { sub: "erin-sub", email: "erin@acme.test", email_verified: true });
      assert.equal(refused.status, 403, "email linking is opt-in because profile emails are self-asserted");
    } finally {
      await noLinking.close();
    }

    const hijack = await login(harness, { sub: "other-bob", email: "bob@acme.test", email_verified: true, roles: ["wiki-users"] });
    assert.equal(hijack.status, 403, "a second subject cannot link to an account already bound at this issuer");
  } finally {
    await harness.close();
  }
});

test("OIDC unverified email is not linked; auto-provision creates a separate user without the email", async () => {
  const harness = await startHarness({ autoProvision: true, linkByEmail: true });
  try {
    const existing = await api<{ id: string; token: string }>(harness, "/api/users", { method: "POST", body: { name: "Dana" } }, 201);
    await api(harness, "/api/users/me", { method: "PATCH", token: existing.token, body: { email: "dana@acme.test" } });
    const response = await login(harness, { sub: "dana-sub", email: "dana@acme.test", email_verified: false, preferred_username: "dana" });
    assert.equal(response.status, 302);
    const me = await api<{ user: { id: string; name: string; email?: string } }>(harness, "/api/auth/session", { cookie: sessionCookies(response).cookie });
    assert.notEqual(me.user.id, existing.id);
    assert.equal(me.user.name, "dana");
    assert.equal(me.user.email, undefined);
  } finally {
    await harness.close();
  }
});

test("OIDC satisfies an enforced SSO policy, with the access gate, SCIM and issuer checks; client_secret_post works", async () => {
  const harness = await startHarness({ autoProvision: true, tokenEndpointAuthMethod: "client_secret_post" }, { accessToken: "gate-token" });
  try {
    await api(harness, "/api/users", { method: "POST", body: { name: "Anonymous" } }, 401);
    const gated = (path: string, init: RequestInit = {}): Promise<Response> =>
      fetch(`${harness.base}${path}`, { ...init, headers: { "x-noma-cloud-access-token": "gate-token", "content-type": "application/json", ...(init.headers as Record<string, string>) } });
    const adminUser = (await (await gated("/api/users", { method: "POST", body: JSON.stringify({ name: "Admin" }) })).json()) as { id: string; token: string };
    const policyBody = (issuer: string, scim: boolean): string =>
      JSON.stringify({
        sso: { enabled: true, provider: "oidc", issuer, enforced: true },
        scim: { enabled: scim },
        retentionDays: 365,
        dataResidency: "local",
        connectorAllowlist: ["github"],
        modelAllowlist: ["any-model"],
      });
    const put = await gated("/api/enterprise", { method: "PUT", headers: { authorization: `Bearer ${adminUser.token}` }, body: policyBody(`${harness.idp.issuer}/`, false) });
    assert.equal(put.status, 200, await put.text());

    const tokenLogin = await gated("/api/auth/session", { method: "POST", body: JSON.stringify({ userToken: adminUser.token }) });
    assert.equal(tokenLogin.status, 403);
    const providers = await api<{ tokenLogin: boolean; sso: { enforced: boolean } }>(harness, "/api/auth/providers");
    assert.equal(providers.tokenLogin, false);
    assert.equal(providers.sso.enforced, true);

    const response = await login(harness, alice, "/cloud.html");
    assert.equal(response.status, 302, await response.text());
    assert.deepEqual(harness.idp.tokenAuth, ["post"]);
    const session = sessionCookies(response);
    const shell = await fetch(`${harness.base}/cloud.html`, { redirect: "manual", headers: { cookie: session.cookie } });
    assert.equal(shell.status, 200, "an OIDC session passes the access gate without the gate token");
    const anonymousShell = await fetch(`${harness.base}/cloud.html`, { redirect: "manual" });
    assert.equal(anonymousShell.status, 302);

    const wrongIssuer = await gated("/api/enterprise", { method: "PUT", headers: { authorization: `Bearer ${adminUser.token}` }, body: policyBody("https://other-idp.example", false) });
    assert.equal(wrongIssuer.status, 200);
    const rejected = await login(harness, alice);
    assert.equal(rejected.status, 403);
    assert.match(await rejected.text(), /different identity provider/);

    const scimPolicy = await gated("/api/enterprise", { method: "PUT", headers: { authorization: `Bearer ${adminUser.token}` }, body: policyBody(harness.idp.issuer, true) });
    assert.equal(scimPolicy.status, 200);
    const newcomer = await login(harness, { sub: "newcomer", email: "new@acme.test", email_verified: true });
    assert.equal(newcomer.status, 403, "JIT provisioning is off while SSO+SCIM is enforced");
    const aliceUnprovisioned = await login(harness, alice);
    assert.equal(aliceUnprovisioned.status, 403, "an existing binding still needs an active SCIM identity under enforcement");

    const scim = await gated("/api/enterprise/scim", {
      method: "POST",
      headers: { authorization: `Bearer ${adminUser.token}` },
      body: JSON.stringify({ id: "scim-admin", externalId: "admin-sub", userId: adminUser.id, userName: "admin", active: true }),
    });
    assert.equal(scim.status, 201, await scim.text());
    const viaScim = await login(harness, { sub: "admin-sub", email: "admin@acme.test", email_verified: false });
    assert.equal(viaScim.status, 302, await viaScim.text());
    const me = await api<{ user: { id: string } }>(harness, "/api/auth/session", { cookie: sessionCookies(viaScim).cookie });
    assert.equal(me.user.id, adminUser.id, "an active SCIM identity whose externalId is the subject maps to its user");
  } finally {
    await harness.close();
  }
});

test("OIDC callback is rate limited by the auth limiter", async () => {
  const harness = await startHarness({ autoProvision: true }, { authRateLimitMaxRequests: 3 });
  try {
    harness.idp.claims = alice;
    const started = await startLogin(harness);
    assert.equal((await callback(harness, started, { state: "x" })).status, 400);
    assert.equal((await callback(harness, started, { state: "y" })).status, 400);
    const limited = await callback(harness, started);
    assert.equal(limited.status, 429);
  } finally {
    await harness.close();
  }
});

test("OIDC routes 404 when not configured; settings fail fast on partial configuration", async () => {
  const harness = await startHarness(null);
  try {
    await api(harness, "/api/auth/oidc/start", {}, 404);
    const providers = await api<{ providers: unknown[] }>(harness, "/api/auth/providers");
    assert.deepEqual(providers.providers, []);
  } finally {
    await harness.close();
  }
  assert.equal(resolveOidcSettings(undefined, {}), undefined);
  assert.throws(() => resolveOidcSettings(undefined, { NOMA_CLOUD_OIDC_ISSUER: "https://id.example" }), /missing NOMA_CLOUD_OIDC_CLIENT_ID, NOMA_CLOUD_OIDC_CLIENT_SECRET/);
  assert.throws(() => resolveOidcSettings(undefined, { NOMA_CLOUD_OIDC_LABEL: "Okta" }), /Incomplete OpenID Connect configuration/);
  assert.throws(
    () => resolveOidcSettings(undefined, { NOMA_CLOUD_OIDC_ISSUER: "http://id.example", NOMA_CLOUD_OIDC_CLIENT_ID: "c", NOMA_CLOUD_OIDC_CLIENT_SECRET: "s", NOMA_CLOUD_PUBLIC_URL: "https://wiki.example" }),
    /must use https/,
  );
  const settings = resolveOidcSettings(undefined, {
    NOMA_CLOUD_OIDC_ISSUER: "https://id.example/",
    NOMA_CLOUD_OIDC_CLIENT_ID: "c",
    NOMA_CLOUD_OIDC_CLIENT_SECRET: "s",
    NOMA_CLOUD_PUBLIC_URL: "https://wiki.example/",
    NOMA_CLOUD_OIDC_SCOPES: "email groups",
    NOMA_CLOUD_OIDC_ALLOWED_DOMAINS: "Acme.test, @corp.test",
    NOMA_CLOUD_OIDC_AUTO_PROVISION: "1",
    NOMA_CLOUD_OIDC_LABEL: "Okta",
  });
  assert.ok(settings);
  assert.equal(settings.issuer, "https://id.example");
  assert.equal(settings.redirectUrl, "https://wiki.example/api/auth/oidc/callback");
  assert.deepEqual(settings.scopes, ["openid", "email", "groups"]);
  assert.deepEqual(settings.allowedDomains, ["acme.test", "corp.test"]);
  assert.equal(settings.autoProvision, true);
  assert.equal(settings.linkByEmail, false);
  assert.equal(settings.label, "Okta");
});

test("databases created before OIDC gain the oidc session source without losing sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "noma-cloud-oidc-migrate-"));
  try {
    const options = { dbPath: join(root, "noma.sqlite"), dataDir: join(root, "d"), usersDir: join(root, "u"), sitesDir: join(root, "s") };
    openNomaCloudDatabase(options).close();
    const raw = new Database(options.dbPath);
    raw.exec(`DROP TABLE auth_sessions;
      CREATE TABLE auth_sessions (id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL UNIQUE, csrf_hash TEXT NOT NULL, user_id TEXT NOT NULL,
        scopes_json TEXT NOT NULL, source TEXT NOT NULL CHECK (source IN ('user_token', 'register', 'pat', 'sso')), pat_id TEXT,
        created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, expires_at TEXT NOT NULL, user_agent TEXT, ip TEXT, revoked_at TEXT);
      INSERT INTO auth_sessions VALUES ('old', 'h1', 'c1', 'u1', '["read"]', 'sso', NULL, '2026-01-01', '2026-01-01', '2099-01-01', NULL, NULL, NULL);`);
    raw.close();
    const store = openNomaCloudDatabase(options);
    try {
      store.createAuthSession({ id: "new", userId: "u1", scopes: ["read"], source: "oidc", createdAt: "2026-01-02", lastSeenAt: "2026-01-02", expiresAt: "2099-01-01" }, "h2", "c2");
      assert.deepEqual(store.listAuthSessions("u1", "2026-02-01", 10, 0).map((session) => session.source).sort(), ["oidc", "sso"]);
    } finally {
      store.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
