/**
 * Seeds a realistic wiki space in a throwaway Noma Cloud server and captures a
 * screenshot tour of the Cloud UI (Visual editor, live co-editing, macros,
 * history diff, restrictions, search filters, tasks, comments, attachments,
 * cited Ask, AI menu, space settings, Confluence import, published space,
 * dark mode). AI answers come from an offline demo model; no network calls.
 *
 *   npm run tour:cloud            # writes PNGs to dist/cloud-tour/
 *   TOUR_OUT=out/ npm run tour:cloud
 */
import puppeteer, { type Browser, type Page } from "puppeteer";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNomaCloudServer } from "../src/cloud-server.js";
import { FakeLlmProvider, type LlmCompletionRequest } from "../src/cloud-llm.js";

const OUT = process.env.TOUR_OUT ?? "dist/cloud-tour";
await mkdir(OUT, { recursive: true });

function tourModel(request: LlmCompletionRequest): string {
  const task = /Noma task: (\w+)/.exec(request.system)?.[1];
  const prompt = request.messages.map((message) => message.content).join("\n");
  if (task === "ask") {
    const refs = [...prompt.matchAll(/<block ref="([^"]+)"/g)].map((match) => match[1]!);
    const claim = refs.find((ref) => ref.includes("vpn-required")) ?? refs[0];
    const access = refs.find((ref) => ref.includes("access")) ?? refs[1];
    if (!claim) return "INSUFFICIENT_EVIDENCE";
    return `No. Production dashboards are only reachable over the VPN [${claim}].${access ? ` New engineers install the VPN client and verify the staging tunnel as part of laptop setup [${access}].` : ""}`;
  }
  if (task === "summarize") return "New engineers get a laptop, SSO, and VPN access on day one, then pair on an on-call shadow shift in week two.";
  return JSON.stringify({ summary: "No changes proposed.", ops: [] });
}

const root = await mkdtemp(join(tmpdir(), "noma-tour-"));
const server = createNomaCloudServer({
  dataDir: join(root, "data", "documents"),
  dbPath: join(root, "data", "noma.sqlite"),
  publicDir: "site",
  ai: { provider: new FakeLlmProvider(tourModel, "demo-model"), maintenanceTickMs: 0 },
  rateLimitMaxRequests: 100_000,
  authRateLimitMaxRequests: 1_000,
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

type ApiRecord = Record<string, string>;

async function api<T = ApiRecord>(path: string, token: string | undefined, method = "GET", body?: unknown, raw?: { data: Buffer; type: string; filename: string }): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (raw) {
    headers["content-type"] = raw.type;
    headers["x-filename"] = raw.filename;
  } else if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(origin + path, { method, headers, body: raw ? new Uint8Array(raw.data) : body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

const ada = await api("/api/users", undefined, "POST", { name: "Ada Lovelace" });
const grace = await api("/api/users", undefined, "POST", { name: "Grace Hopper" });
const linus = await api("/api/users", undefined, "POST", { name: "Linus Pauling" });
const A = ada.token as string;

const space = await api("/api/sites", A, "POST", { title: "Engineering Handbook", documentIds: [] });
for (const user of [grace, linus]) await api(`/api/sites/${space.id}/collaborators`, A, "POST", { userId: user.id, role: "editor" });

const page = (title: string, source: string, parentId?: string) =>
  api(`/api/sites/${space.id}/documents`, A, "POST", { title, source, ...(parentId ? { parentId } : {}) });

const home = await page(
  "Engineering Handbook",
  `# Engineering Handbook

::excerpt{id="handbook-excerpt"}
How the platform team onboards, ships, and runs production — maintained by humans and agents together.
::

::callout{tone="tip"}
Every page here is plain \`.noma\` source. Agents propose block-level edits; a teammate approves them.
::

## In this space

::children{depth=2}
::
`,
);
const onboarding = await page(
  "Onboarding",
  `# Onboarding

::excerpt{id="onboarding-excerpt"}
Day-one checklist and the first two weeks for new platform engineers.
::

## Week one

New engineers pair with an on-call buddy and ship a small change by Friday.

::decision{id="buddy-rotation" status="accepted" owner="ada"}
Every new hire gets a named on-call buddy for their first two weeks.
::
`,
  home.id,
);
const laptop = await page(
  "Laptop setup",
  `# Laptop setup

Order hardware through the IT portal. Enrol the laptop in device management before installing tooling.

## Access

- [ ] Request SSO and GitHub access @{${grace.id}} due:2026-09-30
- [ ] Install the VPN client and verify the staging tunnel @{${ada.id}} due:2026-10-02
- [x] Pick up the laptop from IT

::claim{id="vpn-required" confidence=0.9}
Production dashboards are only reachable over the VPN.
::
`,
  onboarding.id,
);
const runbooks = await page(
  "Runbooks",
  `# Runbooks

Operational procedures for the platform. Start with incident response.

::children
::
`,
);
const incident = await page(
  "Incident response",
  `# Incident response

## Severity levels

| Level | Meaning | Page on-call |
|---|---|---|
| SEV1 | Customer-facing outage | Immediately |
| SEV2 | Degraded service | Within 15 minutes |
| SEV3 | Internal impact only | Next business day |

## New-hire context

::include{page="${onboarding.id}" excerpt}
::

The incident commander owns communication; the on-call engineer owns the fix.
`,
  runbooks.id,
);
const security = await page(
  "Security review",
  `# Security review

Findings from the Q3 external assessment. Restricted to the security group.
`,
);

await api(`/api/documents/${laptop.id}/labels`, A, "PUT", { labels: ["how-to", "onboarding", "it"] });
await api(`/api/documents/${onboarding.id}/labels`, A, "PUT", { labels: ["onboarding", "people"] });
await api(`/api/documents/${incident.id}/labels`, A, "PUT", { labels: ["how-to", "on-call"] });
await api(`/api/documents/${security.id}/restrictions`, A, "PUT", { view: { users: [ada.id], groups: [] }, edit: { users: [ada.id], groups: [] } });

// A second revision so History has a real diff.
const laptopNow = await api(`/api/documents/${laptop.id}`, A);
await api(`/api/documents/${laptop.id}`, grace.token, "PUT", {
  source: laptopNow.source.replace(
    "## Access",
    "Dotfiles live in the `platform/dotfiles` repo; run `make bootstrap` after enrolment.\n\n## Access",
  ),
  expectedHash: laptopNow.hash,
});

// Comments with a quoted-text anchor and reactions.
const comment = await api(`/api/documents/${laptop.id}/comments`, grace.token, "POST", {
  body: `Should we mention the hardware budget here, @{${ada.id}}?`,
  anchor: { blockId: "laptop-setup", quote: "Order hardware through the IT portal", prefix: "", suffix: "." },
}).catch(async () => api(`/api/documents/${laptop.id}/comments`, grace.token, "POST", { body: `Should we mention the hardware budget here, @{${ada.id}}?` }));
await api(`/api/documents/${laptop.id}/comments`, A, "POST", { body: "Good call — adding it after the next budget review.", parentId: comment.id }).catch(() => undefined);
await api(`/api/documents/${laptop.id}/comments/${comment.id}/reactions`, linus.token, "POST", { emoji: "👍" }).catch(() => undefined);

// Page views for analytics / popular.
for (const token of [A, grace.token, linus.token]) {
  await api(`/api/documents/${laptop.id}/views`, token, "POST", {}).catch(() => undefined);
  await api(`/api/documents/${incident.id}/views`, token, "POST", {}).catch(() => undefined);
}
await api(`/api/documents/${onboarding.id}/views`, A, "POST", {}).catch(() => undefined);

const browser: Browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
const errors: string[] = [];

async function newPage(context = browser.defaultBrowserContext()): Promise<Page> {
  const p = await context.newPage();
  await p.setViewport({ width: 1512, height: 945, deviceScaleFactor: 1 });
  await p.setRequestInterception(true);
  p.on("request", (request) => {
    if (request.url().startsWith("https://rsms.me/")) void request.respond({ status: 200, contentType: "text/css", body: "" });
    else void request.continue();
  });
  p.on("pageerror", (error) => errors.push(String(error)));
  return p;
}

async function login(p: Page, token: string): Promise<void> {
  await p.goto(`${origin}/cloud.html`, { waitUntil: "networkidle0" });
  await p.locator("#cloudUserToken").fill(token);
  await p.locator("#loginUserButton").click();
  await p.waitForFunction(() => /Logged in/.test(document.querySelector("#cloudStatus")?.textContent ?? ""), { timeout: 15_000 });
}

async function open(p: Page, documentId: string, mode?: string): Promise<void> {
  await p.goto(`${origin}/cloud.html?site=${space.id}&doc=${documentId}`, { waitUntil: "networkidle0" });
  if (mode) {
    await p.click(`#${mode}ViewButton`);
    await sleep(400);
    if (mode !== "preview") {
      await p.evaluate(() => {
        if (document.querySelector<HTMLElement>(".cloud-shell")?.dataset.panels === "closed") document.querySelector<HTMLElement>("#togglePanelsButton")?.click();
      });
      await sleep(300);
    }
  }
  await sleep(900);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function shot(p: Page, name: string, clip?: { selector: string; pad?: number }): Promise<void> {
  try {
    if (clip) {
      const box = await (await p.$(clip.selector))?.boundingBox();
      if (box) {
        const pad = clip.pad ?? 12;
        await p.screenshot({ path: join(OUT, `${name}.png`), clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + pad * 2, height: box.height + pad * 2 } });
        console.log("shot", name);
        return;
      }
    }
    await p.screenshot({ path: join(OUT, `${name}.png`) });
    console.log("shot", name);
  } catch (error) {
    console.log("FAILED", name, String(error));
  }
}

async function fill(p: Page, selector: string, value: string): Promise<void> {
  await p.evaluate(
    (sel, text) => {
      const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(sel);
      if (!input) throw new Error(`missing ${sel}`);
      input.scrollIntoView({ block: "center" });
      input.value = text;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    },
    selector,
    value,
  );
}

async function clickEl(p: Page, selector: string): Promise<void> {
  await p.evaluate((sel) => {
    const el = document.querySelector<HTMLElement>(sel);
    if (!el) throw new Error(`missing ${sel}`);
    el.scrollIntoView({ block: "center" });
    el.click();
  }, selector);
}

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    console.log("STEP FAILED", name, String(error).slice(0, 300));
  }
}

const p = await newPage();
await login(p, A);

await step("visual", async () => {
  await open(p, laptop.id, "visual");
  await shot(p, "01-visual-editor");
});

await step("slash", async () => {
  await p.click(".visual-editor-surface .nv-directive p");
  await p.evaluate(() => {
    const paragraph = document.querySelector(".visual-editor-surface .nv-directive p");
    const selection = window.getSelection();
    if (!paragraph || !selection) return;
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await sleep(200);
  await p.keyboard.press("Enter");
  await p.keyboard.type("/");
  await p.waitForSelector(".visual-slash-menu", { timeout: 5000 });
  await sleep(300);
  await shot(p, "02-slash-menu");
  await p.keyboard.press("Escape");
  await p.keyboard.press("Backspace");
  await p.keyboard.press("Backspace");
});

await step("presence", async () => {
  await open(p, onboarding.id, "visual");
  const ctx = await browser.createBrowserContext();
  const g = await newPage(ctx);
  await login(g, grace.token);
  await g.goto(`${origin}/cloud.html?site=${space.id}&doc=${onboarding.id}`, { waitUntil: "networkidle0" });
  await sleep(1500);
  await g.click(".visual-editor-surface p");
  await g.keyboard.press("End");
  await g.keyboard.type(" Grace is typing here live.");
  await p.waitForFunction(() => document.querySelectorAll("#visualPresence .visual-avatar").length >= 2, { timeout: 10_000 });
  await sleep(1200);
  await shot(p, "03-live-coediting");
});

await step("preview-macros", async () => {
  await open(p, incident.id, "split");
  await sleep(800);
  await shot(p, "04-split-macros");
});

await step("history-diff", async () => {
  await open(p, laptop.id, "split");
  await p.evaluate(() => {
    const button = [...document.querySelectorAll<HTMLButtonElement>("#historyList button")].find((b) => b.textContent === "Diff");
    button?.scrollIntoView({ block: "center" });
    button?.click();
  });
  await p.waitForSelector("#revisionDiffOutput:not([hidden])", { timeout: 5000 });
  await p.evaluate(() => document.querySelector("#revisionDiffOutput")?.scrollIntoView({ block: "center" }));
  await sleep(400);
  await shot(p, "05-history-diff");
});

await step("tree-restrictions", async () => {
  await open(p, security.id, "preview");
  await sleep(800);
  await clickEl(p, "#restrictionBadge");
  await p.waitForSelector("#restrictionsDialog[open]", { timeout: 8000 });
  await sleep(400);
  await shot(p, "06-restrictions");
  await p.keyboard.press("Escape");
});

await step("search", async () => {
  await open(p, home.id, "split");
  await fill(p, "#globalSearchInput", "label:how-to vpn");
  await clickEl(p, "#searchButton");
  await sleep(1200);
  await shot(p, "07-search-filters");
});

await step("tasks-popular", async () => {
  await p.evaluate(() => document.querySelector("#myTasksList")?.scrollIntoView({ block: "start" }));
  await p.click("#myTasksRefreshButton").catch(() => undefined);
  await sleep(1000);
  await shot(p, "08-my-tasks-popular");
});

await step("comments", async () => {
  await open(p, laptop.id, "split");
  await p.evaluate(() => document.querySelector("#commentList")?.scrollIntoView({ block: "center" }));
  await sleep(600);
  await shot(p, "09-comments");
});

await step("attachments", async () => {
  const shotPage = await newPage();
  await shotPage.setViewport({ width: 900, height: 420 });
  await shotPage.setContent(`<body style="margin:0;background:linear-gradient(135deg,#0f666b,#173f45);display:grid;place-items:center;height:100vh;font:600 34px system-ui;color:#fff">Service map · platform-v2</body>`);
  const png = Buffer.from(await shotPage.screenshot({ type: "png" }));
  await shotPage.close();
  const attachment = await api(`/api/documents/${runbooks.id}/attachments`, A, "POST", undefined, { data: png, type: "image/png", filename: "service-map.png" });
  const current = await api(`/api/documents/${runbooks.id}`, A);
  await api(`/api/documents/${runbooks.id}`, A, "PUT", {
    source: `${current.source}\n::figure{src="att:${attachment.id}" alt="Service map" caption="Platform service map, uploaded as an attachment."}\n::\n`,
    expectedHash: current.hash,
  });
  await open(p, runbooks.id, "split");
  await p.evaluate(() => document.querySelector("#attachmentsList")?.scrollIntoView({ block: "center" }));
  await sleep(1200);
  await shot(p, "10-attachments");
});

await step("ai", async () => {
  await open(p, laptop.id, "split");
  await p.evaluate(() => document.querySelector("#askNomaInput")?.scrollIntoView({ block: "center" }));
  await fill(p, "#askNomaInput", "Are production dashboards reachable without the VPN?");
  await p.evaluate(() => {
    const toggle = document.querySelector<HTMLInputElement>("#aiGenerateToggle");
    if (toggle && !toggle.checked) toggle.click();
  });
  await clickEl(p, "#askNomaButton");
  await p.waitForFunction(() => (document.querySelector("#askNomaResult")?.textContent ?? "").length > 40, { timeout: 10_000 });
  await sleep(500);
  await shot(p, "11-ask-generative");
  await clickEl(p, "#aiMenuButton");
  await sleep(300);
  await shot(p, "12-ai-menu");
  await p.keyboard.press("Escape");
});

await step("space-settings", async () => {
  await open(p, home.id, "split");
  await p.evaluate(() => document.querySelector("#spaceKeyInput")?.scrollIntoView({ block: "center" }));
  await sleep(500);
  await shot(p, "13-space-settings");
});

await step("import", async () => {
  await clickEl(p, "#confluenceImportButton");
  await p.waitForSelector("#confluenceImportDialog[open]", { timeout: 8000 });
  await sleep(300);
  await shot(p, "14-confluence-import");
  await p.keyboard.press("Escape");
});

await step("published", async () => {
  const siteShare = await api(`/api/sites/${space.id}/shares`, A, "POST", { role: "viewer", label: "Handbook readers" });
  await p.goto(`${origin}/s/${space.id}?share=${encodeURIComponent(siteShare.token)}`, { waitUntil: "networkidle0" });
  await sleep(500);
  await shot(p, "15-published-space");
});

await step("dark", async () => {
  await open(p, incident.id, "visual");
  await p.click("#themeToggleButton");
  await sleep(700);
  await shot(p, "16-dark-mode");
});

await writeFile(join(OUT, "errors.json"), JSON.stringify(errors, null, 2));
console.log("page errors:", errors.length, errors.slice(0, 5));
await browser.close();
server.close();
process.exit(0);
