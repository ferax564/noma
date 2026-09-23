/**
 * Email for Noma Cloud: a dependency-free SMTP client (implicit TLS or STARTTLS, AUTH PLAIN/LOGIN),
 * a `log` transport for development, the persisted outbox with retries, per-notification emails,
 * and daily/weekly digests of unread notifications.
 *
 * Configuration: `NOMA_CLOUD_SMTP_URL=smtp://user:pass@host:587` (STARTTLS when offered; add
 * `?starttls=required`), `smtps://…:465` for implicit TLS, `?insecure=1` to skip certificate checks
 * or allow AUTH without TLS (development only). Without an SMTP URL, or with
 * `NOMA_CLOUD_MAIL_TRANSPORT=log`, messages are appended to `NOMA_CLOUD_MAIL_LOG` (or stdout).
 * `NOMA_CLOUD_MAIL_FROM` sets the sender; `NOMA_CLOUD_PUBLIC_URL` prefixes links.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { connect as netConnect, type Socket } from "node:net";
import { hostname } from "node:os";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import type { CloudDigestFrequency, CloudNotification, CloudNotificationChannel, CloudUserRecord, NomaCloudDatabase } from "../cloud-db.js";

export interface MailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
}

export interface MailTransport {
  name: string;
  send(message: MailMessage): Promise<void>;
}

export interface SmtpSettings {
  host: string;
  port: number;
  secure: boolean;
  starttls: "required" | "opportunistic" | "never";
  username?: string;
  password?: string;
  insecure: boolean;
  timeoutMs: number;
}

export class SmtpError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
    this.name = "SmtpError";
  }

  /** 5xx replies are permanent: retrying the same message will not help. */
  get permanent(): boolean {
    return this.code !== undefined && this.code >= 500;
  }
}

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/;
const EMAIL_MAX_ATTEMPTS = 5;
const EMAIL_LEASE_MS = 120_000;

export function isValidEmail(value: string): boolean {
  return value.length <= 254 && EMAIL_RE.test(value);
}

export function mailFrom(): string {
  return stripHeaderBreaks(process.env.NOMA_CLOUD_MAIL_FROM?.trim() || "Noma Cloud <noreply@localhost>");
}

export function parseSmtpUrl(value: string): SmtpSettings {
  const url = new URL(value);
  if (url.protocol !== "smtp:" && url.protocol !== "smtps:") throw new Error("NOMA_CLOUD_SMTP_URL must use smtp:// or smtps://");
  const secure = url.protocol === "smtps:";
  const starttls = url.searchParams.get("starttls");
  return {
    host: url.hostname.replace(/^\[|\]$/g, ""),
    port: url.port ? Number(url.port) : secure ? 465 : 587,
    secure,
    starttls: starttls === "required" || starttls === "never" ? starttls : "opportunistic",
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    insecure: /^(?:1|true|yes)$/i.test(url.searchParams.get("insecure") ?? ""),
    timeoutMs: Number(url.searchParams.get("timeout") ?? 20_000) || 20_000,
  };
}

/** SMTP when `NOMA_CLOUD_SMTP_URL` is set (unless `NOMA_CLOUD_MAIL_TRANSPORT=log`), otherwise the log transport. */
export function mailTransportFromEnv(): MailTransport {
  const smtpUrl = process.env.NOMA_CLOUD_SMTP_URL?.trim();
  if (smtpUrl && process.env.NOMA_CLOUD_MAIL_TRANSPORT?.trim() !== "log") {
    const settings = parseSmtpUrl(smtpUrl);
    return { name: "smtp", send: (message) => sendSmtpMail(settings, message) };
  }
  return logTransport(process.env.NOMA_CLOUD_MAIL_LOG?.trim());
}

export function logTransport(file?: string): MailTransport {
  return {
    name: "log",
    async send(message) {
      const line = `${JSON.stringify({ transport: "log", at: new Date().toISOString(), ...message })}\n`;
      if (file) appendFileSync(file, line, "utf8");
      else process.stdout.write(line);
    },
  };
}

/** Sends one message over SMTP: EHLO, STARTTLS when available (or required), AUTH PLAIN/LOGIN, MAIL/RCPT/DATA, QUIT. */
export async function sendSmtpMail(settings: SmtpSettings, message: MailMessage): Promise<void> {
  const from = addressOnly(message.from);
  const to = addressOnly(message.to);
  if (!isValidEmail(from) || !isValidEmail(to)) throw new SmtpError("Invalid sender or recipient address", 550);
  const session = await SmtpSession.open(settings);
  try {
    await session.expect(220);
    const helo = hostname().replace(/[^A-Za-z0-9.-]/g, "") || "localhost";
    let capabilities = await session.command(`EHLO ${helo}`, 250);
    const offersStartTls = /^STARTTLS$/im.test(capabilities.join("\n"));
    if (!settings.secure && settings.starttls !== "never" && (offersStartTls || settings.starttls === "required")) {
      if (!offersStartTls) throw new SmtpError("Server does not offer STARTTLS");
      await session.command("STARTTLS", 220);
      await session.upgrade(settings);
      capabilities = await session.command(`EHLO ${helo}`, 250);
    }
    if (settings.username) {
      if (!session.encrypted && !settings.insecure) throw new SmtpError("Refusing to send SMTP credentials without TLS");
      const auth = capabilities.find((line) => /^AUTH\b/i.test(line))?.toUpperCase() ?? "";
      if (/\bPLAIN\b/.test(auth) || !/\bLOGIN\b/.test(auth)) {
        await session.command(`AUTH PLAIN ${Buffer.from(`\u0000${settings.username}\u0000${settings.password ?? ""}`).toString("base64")}`, 235);
      } else {
        await session.command("AUTH LOGIN", 334);
        await session.command(Buffer.from(settings.username).toString("base64"), 334);
        await session.command(Buffer.from(settings.password ?? "").toString("base64"), 235);
      }
    }
    await session.command(`MAIL FROM:<${from}>`, 250);
    await session.command(`RCPT TO:<${to}>`, [250, 251]);
    await session.command("DATA", 354);
    await session.command(`${formatMessage(message).replace(/^\./gm, "..")}\r\n.`, 250);
    await session.command("QUIT", 221).catch(() => undefined);
  } finally {
    session.close();
  }
}

class SmtpSession {
  private buffer = "";
  private lines: string[] = [];
  private waiter: ((error?: Error) => void) | undefined;
  private failure: Error | undefined;

  private constructor(private socket: Socket | TLSSocket, private readonly timeoutMs: number) {
    this.attach(socket);
  }

  static open(settings: SmtpSettings): Promise<SmtpSession> {
    return new Promise((resolve, reject) => {
      const socket = settings.secure
        ? tlsConnect({ host: settings.host, port: settings.port, servername: isIpLiteral(settings.host) ? undefined : settings.host, rejectUnauthorized: !settings.insecure })
        : netConnect({ host: settings.host, port: settings.port });
      const ready = settings.secure ? "secureConnect" : "connect";
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new SmtpError("SMTP connection timed out"));
      }, settings.timeoutMs);
      socket.once(ready, () => {
        clearTimeout(timer);
        resolve(new SmtpSession(socket, settings.timeoutMs));
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  get encrypted(): boolean {
    return "encrypted" in this.socket && this.socket.encrypted === true;
  }

  async upgrade(settings: SmtpSettings): Promise<void> {
    const plain = this.socket;
    plain.removeAllListeners("data");
    const secured = await new Promise<TLSSocket>((resolve, reject) => {
      const tls = tlsConnect({ socket: plain, servername: isIpLiteral(settings.host) ? undefined : settings.host, rejectUnauthorized: !settings.insecure });
      tls.once("secureConnect", () => resolve(tls));
      tls.once("error", reject);
    });
    this.buffer = "";
    this.lines = [];
    this.socket = secured;
    this.attach(secured);
  }

  async expect(codes: number | number[]): Promise<string[]> {
    const reply = await this.readReply();
    const allowed = Array.isArray(codes) ? codes : [codes];
    if (!allowed.includes(reply.code)) throw new SmtpError(`SMTP ${reply.code}: ${reply.lines.join(" ").slice(0, 300)}`, reply.code);
    return reply.lines;
  }

  async command(line: string, codes: number | number[]): Promise<string[]> {
    this.socket.write(`${line}\r\n`);
    return this.expect(codes);
  }

  close(): void {
    this.socket.end();
    this.socket.destroy();
  }

  private attach(socket: Socket | TLSSocket): void {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      let index = this.buffer.indexOf("\r\n");
      while (index >= 0) {
        this.lines.push(this.buffer.slice(0, index));
        this.buffer = this.buffer.slice(index + 2);
        index = this.buffer.indexOf("\r\n");
      }
      this.wake();
    });
    socket.on("error", (error: Error) => {
      this.failure = error;
      this.wake();
    });
    socket.on("close", () => {
      this.failure ??= new SmtpError("SMTP connection closed");
      this.wake();
    });
  }

  private wake(): void {
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.();
  }

  private async readReply(): Promise<{ code: number; lines: string[] }> {
    const collected: string[] = [];
    for (;;) {
      while (this.lines.length > 0) {
        const line = this.lines.shift()!;
        const match = /^(\d{3})([ -])(.*)$/.exec(line);
        if (!match) throw new SmtpError(`Malformed SMTP reply: ${line.slice(0, 120)}`);
        collected.push(match[3]!);
        if (match[2] === " ") return { code: Number(match[1]), lines: collected };
      }
      if (this.failure) throw this.failure;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new SmtpError("SMTP reply timed out")), this.timeoutMs);
        this.waiter = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  }
}

function formatMessage(message: MailMessage): string {
  const domain = addressOnly(message.from).split("@")[1] ?? "localhost";
  const headers = [
    `From: ${stripHeaderBreaks(message.from)}`,
    `To: ${stripHeaderBreaks(message.to)}`,
    `Subject: ${encodeHeader(stripHeaderBreaks(message.subject))}`,
    `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${randomUUID()}@${domain}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "Auto-Submitted: auto-generated",
  ];
  const body = Buffer.from(message.text.replace(/\r?\n/g, "\r\n"), "utf8").toString("base64").replace(/.{1,76}/g, (chunk) => `${chunk}\r\n`).trimEnd();
  return `${headers.join("\r\n")}\r\n\r\n${body}`;
}

function encodeHeader(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function stripHeaderBreaks(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function addressOnly(value: string): string {
  return (/<([^>]+)>/.exec(value)?.[1] ?? value).trim();
}

function isIpLiteral(host: string): boolean {
  return /^[\d.]+$/.test(host) || host.includes(":");
}

function publicLink(path: string): string {
  const base = process.env.NOMA_CLOUD_PUBLIC_URL?.trim().replace(/\/+$/, "");
  return base ? `${base}${path}` : path;
}

/**
 * Applies the recipient's channel for this notification type. Returns false when the user turned
 * the type off (nothing is stored); queues an email as well when the channel is `email` and the
 * user has an address.
 */
export function routeNotificationByPreference(store: NomaCloudDatabase, notification: CloudNotification, now: string): boolean {
  const channel: CloudNotificationChannel = store.notificationPreferences(notification.userId).channels[notification.type] ?? "in_app";
  if (channel === "off") return false;
  if (channel === "email") {
    const user = store.readUser(notification.userId);
    if (user?.email) {
      const link = notification.resourceType === "document" && notification.resourceId ? `\n\nOpen: ${publicLink(`/cloud.html?doc=${encodeURIComponent(notification.resourceId)}`)}` : "";
      store.enqueueEmail({
        id: `em_${randomUUID().replace(/-/g, "")}`,
        userId: user.id,
        to: user.email,
        subject: notification.title.slice(0, 200),
        text: `${notification.body}${link}\n\nYou get this email because your Noma notification preferences send "${notification.type}" by email.`,
        kind: "notification",
        nextAttemptAt: now,
        createdAt: now,
      });
    }
  }
  return true;
}

export interface EmailDrainResult {
  attempted: number;
  sent: number;
  failed: number;
  retrying: number;
}

/** Sends due outbox emails; transient failures retry after 1, 2, 4, 8 minutes, then give up. */
export async function drainEmailOutbox(store: NomaCloudDatabase, now: () => Date, transport: MailTransport = mailTransportFromEnv(), limit = 20): Promise<EmailDrainResult> {
  const started = now();
  const due = store.claimDueEmails(started.toISOString(), new Date(started.getTime() + EMAIL_LEASE_MS).toISOString(), limit);
  const result: EmailDrainResult = { attempted: due.length, sent: 0, failed: 0, retrying: 0 };
  for (const email of due) {
    const attempts = email.attempts + 1;
    try {
      await transport.send({ from: mailFrom(), to: email.to, subject: email.subject, text: email.text });
      store.completeEmail(email.id, { status: "sent", attempts, nextAttemptAt: now().toISOString(), sentAt: now().toISOString() });
      result.sent += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 300) : "Send failed";
      const permanent = error instanceof SmtpError && error.permanent;
      if (permanent || attempts >= EMAIL_MAX_ATTEMPTS) {
        store.completeEmail(email.id, { status: "failed", attempts, nextAttemptAt: now().toISOString(), lastError: message });
        result.failed += 1;
      } else {
        store.completeEmail(email.id, { status: "pending", attempts, nextAttemptAt: new Date(now().getTime() + 60_000 * 2 ** (attempts - 1)).toISOString(), lastError: message });
        result.retrying += 1;
      }
    }
  }
  if (due.length > 0) store.pruneEmails(new Date(started.getTime() - 30 * 86_400_000).toISOString());
  return result;
}

/**
 * Queues digest emails for users whose daily/weekly period elapsed: unread notifications since the
 * previous digest. Users without an address, or with nothing unread, just advance their schedule.
 */
export function buildDueDigests(store: NomaCloudDatabase, now: Date, limit = 50): number {
  const at = now.toISOString();
  let queued = 0;
  for (const due of store.dueDigestUsers(at, limit)) {
    const user = store.readUser(due.userId);
    const periodMs = due.digest === "weekly" ? 7 * 86_400_000 : 86_400_000;
    const since = due.lastDigestAt ?? new Date(now.getTime() - periodMs).toISOString();
    const notifications = user?.email
      ? store.unreadNotificationsSince(due.userId, since, 200).filter((item) => item.resourceType !== "document" || !item.resourceId || store.documentAccessRole(due.userId, item.resourceId) !== undefined).slice(0, 50)
      : [];
    if (user?.email && notifications.length > 0) {
      store.enqueueEmail({
        id: `em_${randomUUID().replace(/-/g, "")}`,
        userId: user.id,
        to: user.email,
        subject: `Your Noma ${due.digest} digest: ${notifications.length} update${notifications.length === 1 ? "" : "s"}`,
        text: digestText(user, due.digest, notifications),
        kind: "digest",
        nextAttemptAt: at,
        createdAt: at,
      });
      queued += 1;
    }
    store.markDigestSent(due.userId, at);
  }
  return queued;
}

function digestText(user: CloudUserRecord, digest: Exclude<CloudDigestFrequency, "off">, notifications: CloudNotification[]): string {
  const lines = notifications.map((notification) => {
    const link = notification.resourceType === "document" && notification.resourceId ? ` — ${publicLink(`/cloud.html?doc=${encodeURIComponent(notification.resourceId)}`)}` : "";
    return `• ${notification.title}\n  ${notification.body.slice(0, 240)}${link}`;
  });
  return [
    `Hi ${user.name},`,
    "",
    `Here is your ${digest} Noma digest with ${notifications.length} unread update${notifications.length === 1 ? "" : "s"}:`,
    "",
    ...lines,
    "",
    "Change how often you get this in Noma Cloud → Notification settings.",
  ].join("\n");
}
