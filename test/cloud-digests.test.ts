import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TLSSocket } from "node:tls";
import { logTransport, parseSmtpUrl, SmtpError, sendSmtpMail } from "../src/cloud/mail.js";
import { type CloudDocumentResponse, createCloudUser, json, savePage, startCloudServer } from "./cloud-wiki-harness.js";

/** Self-signed test-only certificate for the fake SMTP server's STARTTLS (CN=localhost). */
const TEST_TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCtH6IWrPOzrjNh
6xO3ONakD2UZ7PvF1E/CGja2mV4BTajLRemgvzUl2rxUGKVH0I04Q90LEjvUSS3j
Xwa+7xv0Q+mtMcASZft3UyuyvUc/S1bc5R2A5m9FmS5yR44nurXZBOMVNtLDJZn1
AldHFPvcnyAMejr0uiZVI/TE4h4QVAVbFrq92+zP9i62HCHcFIzhYosk+TtAY2At
wOD1CWxpeVzoFlvnfs4J9A/vtkgvRniWwlc920KqTQk1kyrsMc7IysK6kl0S0luX
1RogULLO6hrQEAeRbP3BY0Hk5SJv9OBrI45KVCZho4sS4PC7qrMdDUBkLn9JsE8m
cD5p1WULAgMBAAECggEARFWqqLGu5hsaLAnat+UnEA4FlaStwqopq0+mjg/eg7ww
JsBbVfhzVZRP5w/tWXnv7CgZXY/ebs5N3yQ4qO//xDx0RclP69M2XaTGKGC++TRX
PozvRtxuSnYK18/3xCXWNqnPqqV/rsiuSwAYDDYzriNfRp2OnN/HVq8BJB+uxzmD
JefeFQGNJlmxLJooM3xFqfq8pvF9+DAnuaIBAez+N4wxX2Gtf8cbkJM0ZAhCfpfR
rooaU4pP6XBz7BnT53zfC/vZDQkFoH81zID/QoBtiC/q3+50UfYPFpzXyxjPHPi+
JanMXADK8NnedVVMLv5UJ1RH6RRrnP812AMHxI1b8QKBgQDyUtQGCAdWGd4+J/Yi
dgaKzaBdE6H2dbUwj6nQ9v8zYpOpTXowYjmXjufMd4ctY7OTuXUGG62eWqzsume1
6xA68Ll9ocG0eGe6bRhuzNqeZwIlrodHv/9T+RAxooegVbOT8RKA214we9TjKo6Y
y2oZDulLLx/EmvT5cUax9YqiMQKBgQC25Pr+QA8uv2hL7xVb78kR1Zs7bQNR7+JL
mynaniuhhUSML8Zpw2IB4/Hs1fL10IYUpQ3amGgp3OAU6jo6IjsyzaIJRUSitbY9
FF0amppsVmUu+xMC+sGRVQ3cOwQtk4eQyUvSJG0Ollj420GRvAFVeRRaplI/xwYV
GRw7BH+P+wKBgAEv2KwC5A5O6CDDz1fR3ixV34A1NWjgoLeRLJLCcvOMew6sO3n7
MS8F2yrMNxRI1btWgDU8c3hAF3K9Yv6oHRc80JvF7A33PQLTv/fi9vsppAANP8ph
LV367VJg6msloFCMMLwC1w5DvQIz1ij3bhibUxc0LuKmo6aJIICEpF4xAoGBALU+
wgUIEoOvJ3pomfAb9lR4LHd9lpaydL2cLKP7rx1H5iBOj//rocphzDN56mXzmYwH
7Wy9MCycOGxBmiZWGfhEk9lADb54+PoanhFpOLM4AtnF8pc3TG/rq+qdiYxo8SVo
dnzvoCuejtk+3wG/IEtFzAfxXvzZDIwH8FQEJy3VAoGAWQKL+hhcwR7Jzzjm4QsG
WfZAu5Srpa91UWT63S5WTyXa0KXmM8q8JLXRUIzne3A+4V4cL7Y2QARFwHP802L1
Zn6oA/dXBgmFpJ9rzVoqb5i6Vo3LR40DvVLYnhIJqbwwxueQE7ILuveMBNEyDvc6
L3ZT4/cBK/et8q0fPhzhr7U=
-----END PRIVATE KEY-----`;

const TEST_TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIDCzCCAfOgAwIBAgIUIK680uKRLUIMmp0c39yx35wZcIswDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MDkyMzA1MDg0MVoYDzIxMjYw
ODMwMDUwODQxWjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQCtH6IWrPOzrjNh6xO3ONakD2UZ7PvF1E/CGja2mV4B
TajLRemgvzUl2rxUGKVH0I04Q90LEjvUSS3jXwa+7xv0Q+mtMcASZft3UyuyvUc/
S1bc5R2A5m9FmS5yR44nurXZBOMVNtLDJZn1AldHFPvcnyAMejr0uiZVI/TE4h4Q
VAVbFrq92+zP9i62HCHcFIzhYosk+TtAY2AtwOD1CWxpeVzoFlvnfs4J9A/vtkgv
RniWwlc920KqTQk1kyrsMc7IysK6kl0S0luX1RogULLO6hrQEAeRbP3BY0Hk5SJv
9OBrI45KVCZho4sS4PC7qrMdDUBkLn9JsE8mcD5p1WULAgMBAAGjUzBRMB0GA1Ud
DgQWBBSxejhSTJYUsWMNDOj68DaH5T4mpTAfBgNVHSMEGDAWgBSxejhSTJYUsWMN
DOj68DaH5T4mpTAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQBi
nCKY+dfbrPOQjCr9De3dyZdOwS4za7eWHyDf/EACOVrmx16zNrCZO+buAGxUgo83
iJq1zkgU6xH+oiUgMBc0yNCQxgUccrddaMnjJ87kpiCefLwXEuSgwtwjObm/1Fpt
BtAQb85w1xNGWP8Vfv+OcKo6e4aCdPV4w744TTxMYAVQwiAX9A38jskzVmT6Gt+2
Y2DeYN3WXgechMC3Wit4ZzP8+P7u6EGQXRmQlXJv3W/IRzTwUjqaIWC84dU3PDxE
/URnNO8p35qcXrTnm+s5/BN1FYSlx/Oxw8AuciBukTrowjhQlPAD8Qs2qeV753/k
nzI1gOrz8c65xbNRKp3K
-----END CERTIFICATE-----`;

interface CapturedMail {
  from: string;
  to: string;
  data: string;
  subject: string;
  text: string;
  tls: boolean;
  auth?: string;
}

interface FakeSmtp {
  port: number;
  mails: CapturedMail[];
  /** Replies to force for upcoming RCPT commands, e.g. `451 try later`. */
  rcptFailures: string[];
  close: () => Promise<void>;
}

async function startFakeSmtp(options: { starttls?: boolean; auth?: "PLAIN" | "LOGIN" | "PLAIN LOGIN" } = {}): Promise<FakeSmtp> {
  const mails: CapturedMail[] = [];
  const rcptFailures: string[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((raw) => {
    sockets.add(raw);
    raw.on("close", () => sockets.delete(raw));
    let socket: Socket | TLSSocket = raw;
    let tls = false;
    let buffer = "";
    let inData = false;
    let dataLines: string[] = [];
    let from = "";
    let to = "";
    let auth: string | undefined;
    let loginStep = 0;
    let loginUser = "";
    const write = (line: string) => socket.write(`${line}\r\n`);
    const onLine = (line: string): void => {
      if (inData) {
        if (line === ".") {
          inData = false;
          const data = dataLines.join("\r\n");
          const [head = "", body = ""] = data.split("\r\n\r\n");
          const subject = /^Subject: (.*)$/m.exec(head)?.[1] ?? "";
          const decodedSubject = subject.replace(/=\?UTF-8\?B\?([^?]+)\?=/g, (_, value: string) => Buffer.from(value, "base64").toString("utf8"));
          mails.push({ from, to, data, subject: decodedSubject, text: Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8"), tls, ...(auth ? { auth } : {}) });
          dataLines = [];
          write("250 2.0.0 queued");
        } else {
          dataLines.push(line.startsWith("..") ? line.slice(1) : line);
        }
        return;
      }
      if (loginStep === 1) {
        loginUser = Buffer.from(line, "base64").toString("utf8");
        loginStep = 2;
        write("334 UGFzc3dvcmQ6");
        return;
      }
      if (loginStep === 2) {
        auth = `LOGIN ${loginUser}:${Buffer.from(line, "base64").toString("utf8")}`;
        loginStep = 0;
        write("235 2.7.0 ok");
        return;
      }
      const upper = line.toUpperCase();
      if (upper.startsWith("EHLO")) {
        const caps = ["250-fake.smtp", ...(options.starttls && !tls ? ["250-STARTTLS"] : []), ...(options.auth ? [`250-AUTH ${options.auth}`] : []), "250 8BITMIME"];
        for (const cap of caps) write(cap);
      } else if (upper === "STARTTLS") {
        write("220 2.0.0 ready");
        raw.removeAllListeners("data");
        const secured = new TLSSocket(raw, { isServer: true, key: TEST_TLS_KEY, cert: TEST_TLS_CERT });
        socket = secured;
        tls = true;
        buffer = "";
        secured.setEncoding("utf8");
        secured.on("data", onData);
      } else if (upper.startsWith("AUTH PLAIN ")) {
        const [, user = "", pass = ""] = Buffer.from(line.slice(11), "base64").toString("utf8").split("\u0000");
        auth = `PLAIN ${user}:${pass}`;
        write("235 2.7.0 ok");
      } else if (upper === "AUTH LOGIN") {
        loginStep = 1;
        write("334 VXNlcm5hbWU6");
      } else if (upper.startsWith("MAIL FROM:")) {
        from = /<([^>]*)>/.exec(line)?.[1] ?? "";
        write("250 2.1.0 ok");
      } else if (upper.startsWith("RCPT TO:")) {
        const failure = rcptFailures.shift();
        if (failure) {
          write(failure);
          return;
        }
        to = /<([^>]*)>/.exec(line)?.[1] ?? "";
        write("250 2.1.5 ok");
      } else if (upper === "DATA") {
        inData = true;
        write("354 go ahead");
      } else if (upper === "QUIT") {
        write("221 2.0.0 bye");
        socket.end();
      } else {
        write("502 5.5.2 unknown");
      }
    };
    const onData = (chunk: string): void => {
      buffer += chunk;
      let index = buffer.indexOf("\r\n");
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        onLine(line);
        index = buffer.indexOf("\r\n");
      }
    };
    raw.setEncoding("utf8");
    raw.on("data", onData);
    raw.on("error", () => undefined);
    write("220 fake.smtp ESMTP ready");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    port: address.port,
    mails,
    rcptFailures,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

async function waitFor(check: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) assert.fail(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("the SMTP client speaks AUTH LOGIN, STARTTLS with AUTH PLAIN, and refuses credentials without TLS", async () => {
  const plain = await startFakeSmtp({ auth: "LOGIN" });
  const starttls = await startFakeSmtp({ starttls: true, auth: "PLAIN LOGIN" });
  try {
    await sendSmtpMail(parseSmtpUrl(`smtp://mailer:s3cret@127.0.0.1:${plain.port}?insecure=1&starttls=never`), {
      from: "Noma <noma@example.com>",
      to: "ada@example.com",
      subject: "Grüße from Noma",
      text: "Line one\n.leading dot\nLine three",
    });
    assert.equal(plain.mails.length, 1);
    assert.deepEqual([plain.mails[0]!.from, plain.mails[0]!.to, plain.mails[0]!.auth, plain.mails[0]!.tls], ["noma@example.com", "ada@example.com", "LOGIN mailer:s3cret", false]);
    assert.equal(plain.mails[0]!.subject, "Grüße from Noma");
    assert.equal(plain.mails[0]!.text, "Line one\r\n.leading dot\r\nLine three");

    await sendSmtpMail(parseSmtpUrl(`smtp://mailer:s3cret@127.0.0.1:${starttls.port}?insecure=1`), { from: "noma@example.com", to: "bob@example.com", subject: "Hi", text: "Secure" });
    assert.deepEqual([starttls.mails[0]!.tls, starttls.mails[0]!.auth, starttls.mails[0]!.text], [true, "PLAIN mailer:s3cret", "Secure"]);

    await assert.rejects(
      sendSmtpMail(parseSmtpUrl(`smtp://mailer:s3cret@127.0.0.1:${plain.port}`), { from: "noma@example.com", to: "ada@example.com", subject: "x", text: "x" }),
      /without TLS/,
    );
    await assert.rejects(
      sendSmtpMail(parseSmtpUrl(`smtp://127.0.0.1:${plain.port}?starttls=required`), { from: "noma@example.com", to: "ada@example.com", subject: "x", text: "x" }),
      /does not offer STARTTLS/,
    );
    plain.rcptFailures.push("550 5.1.1 no such user");
    await assert.rejects(
      sendSmtpMail(parseSmtpUrl(`smtp://127.0.0.1:${plain.port}?starttls=never`), { from: "noma@example.com", to: "nobody@example.com", subject: "x", text: "x" }),
      (error: unknown) => error instanceof SmtpError && error.permanent,
    );
  } finally {
    await plain.close();
    await starttls.close();
  }
});

test("the log transport appends JSON lines", async () => {
  const root = await mkdtemp(join(tmpdir(), "noma-mail-log-"));
  try {
    const file = join(root, "mail.log");
    await logTransport(file).send({ from: "a@example.com", to: "b@example.com", subject: "Hello", text: "Body" });
    const entry = JSON.parse((await readFile(file, "utf8")).trim()) as { transport: string; to: string; subject: string };
    assert.deepEqual([entry.transport, entry.to, entry.subject], ["log", "b@example.com", "Hello"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("notification preferences route mentions to email, silence types, and schedule digests of unread notifications", async () => {
  const smtp = await startFakeSmtp();
  const previousUrl = process.env.NOMA_CLOUD_SMTP_URL;
  const previousFrom = process.env.NOMA_CLOUD_MAIL_FROM;
  process.env.NOMA_CLOUD_SMTP_URL = `smtp://127.0.0.1:${smtp.port}?starttls=never`;
  process.env.NOMA_CLOUD_MAIL_FROM = "Noma Cloud <noma@example.com>";
  const harness = await startCloudServer("noma-digests-", { queueIntervalMs: 30 });
  const { base, clock } = harness;
  try {
    const ada = await createCloudUser(base, "Ada Lovelace");
    const bob = await createCloudUser(base, "Bob Builder");

    await json(`${base}/api/users/me`, { method: "PUT", token: bob.token, body: { email: "not-an-email" }, expectedStatus: 400 });
    const me = await json<{ email: string; name: string }>(`${base}/api/users/me`, { method: "PUT", token: bob.token, body: { email: "bob@example.com" } });
    assert.equal(me.email, "bob@example.com");
    assert.equal((await json<{ email: string }>(`${base}/api/users/me`, { token: bob.token })).email, "bob@example.com");
    const directory = await json<{ users: Array<{ id: string; email?: string }> }>(`${base}/api/users`, { token: ada.token });
    assert.ok(directory.users.every((user) => user.email === undefined), "email addresses are never listed to other users");

    const defaults = await json<{ channels: Record<string, string>; digest: string; emailConfigured: boolean }>(`${base}/api/users/me/preferences`, { token: bob.token });
    assert.equal(defaults.channels.mention, "in_app");
    assert.equal(defaults.channels.task_assigned, "in_app");
    assert.equal(defaults.digest, "off");
    assert.equal(defaults.emailConfigured, true);
    await json(`${base}/api/users/me/preferences`, { method: "PUT", token: bob.token, body: { channels: { mention: "sms" } }, expectedStatus: 400 });
    await json(`${base}/api/users/me/preferences`, { method: "PUT", token: bob.token, body: { channels: { gossip: "email" } }, expectedStatus: 400 });
    await json(`${base}/api/users/me/preferences`, { method: "PUT", token: bob.token, body: { digest: "hourly" }, expectedStatus: 400 });
    const updated = await json<{ channels: Record<string, string> }>(`${base}/api/users/me/preferences`, { method: "PUT", token: bob.token, body: { channels: { mention: "email", comment: "off" } } });
    assert.deepEqual([updated.channels.mention, updated.channels.comment, updated.channels.page_updated], ["email", "off", "in_app"]);

    const space = await json<{ id: string }>(`${base}/api/sites`, { method: "POST", token: ada.token, body: { title: "Eng", documentIds: [] } });
    await json(`${base}/api/sites/${space.id}/collaborators`, { method: "POST", token: ada.token, body: { userId: bob.id, role: "editor" } });
    let page = await json<CloudDocumentResponse>(`${base}/api/sites/${space.id}/documents`, { method: "POST", token: bob.token, body: { source: "# Bob's Plan\n\nDraft.\n" } });
    await json(`${base}/api/documents/${page.id}/comments`, { method: "POST", token: ada.token, body: { body: `Looks good @{${bob.id}}` } });
    await waitFor(() => smtp.mails.length === 1, "mention email");
    assert.deepEqual([smtp.mails[0]!.from, smtp.mails[0]!.to, smtp.mails[0]!.subject], ["noma@example.com", "bob@example.com", "Mentioned in Bob's Plan"]);
    assert.match(smtp.mails[0]!.text, /Ada Lovelace: Looks good/);
    await json(`${base}/api/documents/${page.id}/comments`, { method: "POST", token: ada.token, body: { body: "Plain comment" } });
    const bobNotifications = await json<{ notifications: Array<{ type: string }> }>(`${base}/api/notifications`, { token: bob.token });
    assert.deepEqual(bobNotifications.notifications.map((item) => item.type), ["mention"], "comment notifications are off");

    await json(`${base}/api/users/me/preferences`, { method: "PUT", token: bob.token, body: { digest: "daily" } });
    page = await savePage(base, ada.token, page, "# Bob's Plan\n\nDraft, reviewed.\n");
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(smtp.mails.length, 1, "no digest before the period elapses");
    smtp.rcptFailures.push("451 4.3.0 try again later");
    clock.advance(25 * 60 * 60 * 1000);
    await waitFor(() => smtp.mails.length === 1 && smtp.rcptFailures.length === 0, "first digest attempt fails transiently");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(smtp.mails.length, 1, "the transient failure is retried later, not immediately");
    clock.advance(61_000);
    await waitFor(() => smtp.mails.length === 2, "digest email after retry");
    const digest = smtp.mails[1]!;
    assert.equal(digest.subject, "Your Noma daily digest: 2 updates");
    assert.match(digest.text, /Bob's Plan was updated/);
    assert.match(digest.text, /Mentioned in Bob's Plan/);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(smtp.mails.length, 2, "one digest per period");

    await json(`${base}/api/notifications/read-all`, { method: "POST", token: bob.token });
    clock.advance(25 * 60 * 60 * 1000);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(smtp.mails.length, 2, "nothing unread means no digest");
    const prefs = await json<{ lastDigestAt: string }>(`${base}/api/users/me/preferences`, { token: bob.token });
    assert.equal(prefs.lastDigestAt, clock.now().toISOString(), "the schedule still advances");

    await json(`${base}/api/users/me`, { method: "PUT", token: bob.token, body: { email: null } });
    await json(`${base}/api/documents/${page.id}/comments`, { method: "POST", token: ada.token, body: { body: `Again @{${bob.id}}` } });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(smtp.mails.length, 2, "no email address, no email");
    assert.equal((await json<{ notifications: Array<{ type: string }> }>(`${base}/api/notifications`, { token: bob.token })).notifications.filter((item) => item.type === "mention").length, 2);
  } finally {
    await harness.close();
    await smtp.close();
    if (previousUrl === undefined) delete process.env.NOMA_CLOUD_SMTP_URL;
    else process.env.NOMA_CLOUD_SMTP_URL = previousUrl;
    if (previousFrom === undefined) delete process.env.NOMA_CLOUD_MAIL_FROM;
    else process.env.NOMA_CLOUD_MAIL_FROM = previousFrom;
  }
});
