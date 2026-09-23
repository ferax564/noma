/** HTML rendering for `/d/:id` and `/s/:id`, plus static asset serving from the public dir. */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import type { CloudDocumentRecord, CloudSiteRecord } from "../cloud-db.js";
import { parse } from "../parser.js";
import { renderHtml } from "../renderer-html.js";
import { type AccessContext, type CloudServerConfig, readDocument } from "./context.js";
import { escapeAttr, escapeHtml, HttpError, setSecurityHeaders } from "./http.js";

export function renderDocumentHtml(record: CloudDocumentRecord, access?: AccessContext): string {
  const doc = parse(record.source, { filename: `${record.id}.noma` });
  const banner = access
    ? `<div class="noma-cloud-banner">Noma Cloud · ${escapeHtml(record.title)} · ${escapeHtml(access.role)} access</div>`
    : "";
  const html = renderHtml(doc, {
    standalone: true,
    allowEscapeHatches: false,
    externalAssets: false,
  });
  return banner ? html.replace("<body>", `<body>${banner}`) : html;
}

export async function renderSiteHtml(config: CloudServerConfig, site: CloudSiteRecord, access: AccessContext): Promise<string> {
  const visibleIds = site.documentIds.filter((id) => !config.store.isTrashed("document", id));
  const documents = await Promise.all(visibleIds.map((id) => readDocument(config, id)));
  const articles = documents
    .map((record) => {
      const doc = parse(record.source, { filename: `${record.id}.noma` });
      const body = renderHtml(doc, {
        standalone: false,
        allowEscapeHatches: false,
        externalAssets: false,
        interactive: false,
      });
      return `<article class="site-doc" id="${escapeAttr(record.id)}"><header><h2>${escapeHtml(record.title)}</h2><a href="#${escapeAttr(record.id)}">Copy link</a></header>${body}</article>`;
    })
    .join("\n");
  const nav = documents
    .map((record) => `<a href="#${escapeAttr(record.id)}">${escapeHtml(record.title)}</a>`)
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="icon" href="data:," />
<title>${escapeHtml(site.title)}</title>
<style>
body{margin:0;background:#f2f4f1;color:#20242a;font:15px/1.52 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.shell{display:grid;grid-template-columns:minmax(180px,260px) minmax(0,1fr);min-height:100vh}
nav{position:sticky;top:0;height:100vh;overflow:auto;border-right:1px solid #d9ded8;background:linear-gradient(180deg,#fffdf8,#f7f8f4);padding:18px}
nav h1{font-size:1rem;margin:0 0 14px}nav a{display:block;color:#0f666b;text-decoration:none;margin:8px 0;font-weight:650}
main{padding:30px;max-width:980px}.meta{color:#5c6670;font-size:.85rem;margin-bottom:18px}
.site-doc{background:#fffefa;border:1px solid #d9ded8;border-radius:8px;padding:26px;margin:0 0 18px;box-shadow:0 22px 58px -48px rgba(32,36,42,.54)}
.site-doc>header{display:flex;align-items:center;justify-content:space-between;gap:14px;border-bottom:1px solid #e6dfd2;margin:-4px 0 18px;padding-bottom:12px}
.site-doc>header h2{margin:0;font-size:1rem}.site-doc>header a{color:#5c6670;font-size:.82rem}
.site-doc h1{font-size:2.1rem;line-height:1.08;margin:18px 0 18px}.site-doc h2{font-size:1.45rem;margin:28px 0 12px;border-bottom:1px solid #e6dfd2;padding-bottom:8px}.site-doc p{max-width:76ch}
.site-doc table{width:100%;border-collapse:collapse;margin:14px 0 20px;font-size:.94rem}.site-doc th,.site-doc td{border-bottom:1px solid #e6dfd2;padding:9px 10px;text-align:left;vertical-align:top}.site-doc th{background:#f2eee6;color:#20242a;font-weight:750}
.noma-research,.noma-block,.noma-custom-directive{border:1px solid #e0ded7;border-radius:8px;background:#fffefa;margin:16px 0;padding:16px 18px;box-shadow:0 14px 32px -30px rgba(32,36,42,.55)}
.noma-research{border-left:4px solid #2f7048}.noma-block-claim{border-left:4px solid #2f6fa7}.noma-block-evidence{border-left:4px solid #2f7048}.noma-block-counterevidence,.noma-block-risk{border-left:4px solid #9a681f}
.noma-research-head,.noma-block-head,.noma-technical-head,.noma-comment-head,.noma-review-meta-head{display:flex;align-items:center;gap:10px;margin-bottom:10px}.noma-tag{display:inline-flex;align-items:center;border-radius:999px;background:#e9f1ee;color:#0f666b;font-size:.72rem;font-weight:800;letter-spacing:.08em;text-transform:uppercase;padding:4px 9px}
.noma-confidence{width:140px;height:5px;border-radius:999px;background:#e4e1d8;overflow:hidden}.noma-confidence-bar{height:100%;background:linear-gradient(90deg,#a4573c,#2f6fa7)}
.noma-meta{color:#5c6670;font-size:.85rem;margin-top:10px}.noma-meta-key{color:#20242a;font-weight:720}.noma-block-body>*:first-child{margin-top:0}.noma-block-body>*:last-child{margin-bottom:0}
.noma-task{display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px;align-items:start;margin:12px 0}.noma-task input{margin-top:.28em}
@media(max-width:760px){.shell{display:block}nav{position:static;height:auto}.site-doc{padding:16px}main{padding:18px}}
</style>
</head>
<body>
<div class="shell">
<nav><h1>${escapeHtml(site.title)}</h1>${nav}</nav>
<main><p class="meta">Noma Cloud site · ${escapeHtml(access.role)} access · updated ${escapeHtml(site.updatedAt)}</p>${articles}</main>
</div>
</body>
</html>`;
}

export async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  config: CloudServerConfig,
): Promise<void> {
  const filePath = await resolveStaticPath(config.publicDir, url.pathname);
  if (!filePath) throw new HttpError(404, "Not found");
  const info = await stat(filePath);
  const type = contentType(filePath);
  res.statusCode = 200;
  setSecurityHeaders(res, type.startsWith("text/html") ? staticHtmlContentSecurityPolicy : undefined);
  res.setHeader("content-type", type);
  res.setHeader("content-length", String(info.size));
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("end", resolvePromise);
    stream.pipe(res);
  });
}

async function resolveStaticPath(publicDir: string, pathname: string): Promise<string | null> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const requested = decoded === "/" ? "/index.html" : decoded;
  const candidates = [requested];
  if (!extname(requested)) candidates.push(`${requested}.html`);

  for (const candidate of candidates) {
    const resolved = resolve(publicDir, `.${candidate}`);
    const root = publicDir.endsWith(sep) ? publicDir : `${publicDir}${sep}`;
    if (resolved !== publicDir && !resolved.startsWith(root)) return null;
    try {
      const info = await stat(resolved);
      if (info.isDirectory()) {
        const indexPath = join(resolved, "index.html");
        await stat(indexPath);
        return indexPath;
      }
      if (info.isFile()) return resolved;
    } catch {
      continue;
    }
  }
  return null;
}

const staticHtmlContentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://rsms.me",
  "font-src 'self' https://rsms.me",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

function contentType(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".webmanifest":
      return "application/manifest+json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".pdf":
      return "application/pdf";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".txt":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}
