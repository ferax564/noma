/** Wikilink panel, resolution and wiki page creation. */
import { extractWikilinks } from "../../src/inline.js";
import { parse } from "../../src/parser.js";
import { walk } from "../../src/ast.js";
import { fetchCloudJson } from "./api.js";
import { showWikiContextMenu } from "./context-menu.js";
import { wikiLinksList, wikiSummary } from "./dom.js";
import { saveCurrentPage, setCurrentPage } from "./editor.js";
import { renderChrome } from "./layout.js";
import { refreshSites, selectPage, sourceTitle, updateAddress } from "./navigation.js";
import { canCreatePage } from "./permissions.js";
import { state } from "./state.js";
import type { CloudDocumentResponse, WikiResolvedLink } from "./types.js";
import { emptyState, errorMessage, setBusy, setCloudStatus, slug } from "./util.js";

export function renderWikiPanel(): void {
  wikiLinksList.textContent = "";
  if (!state.currentPage) {
    wikiSummary.textContent = "No wiki links";
    wikiSummary.dataset.state = "ok";
    wikiLinksList.append(emptyState("No page"));
    return;
  }

  const outgoing = wikiLinksForPage(state.currentPage);
  const backlinks = state.pages
    .filter((page) => page.id !== state.currentPage?.id)
    .flatMap((page) => wikiLinksForPage(page).filter((link) => link.page?.id === state.currentPage?.id).map((link) => ({ page, link })));
  const missing = outgoing.filter((link) => link.missing);
  wikiSummary.textContent = `${outgoing.length} links / ${backlinks.length} backlinks / ${missing.length} missing`;
  wikiSummary.dataset.state = missing.length > 0 ? "warning" : "ok";

  if (outgoing.length > 0) {
    wikiLinksList.append(wikiLabel("Links"));
    for (const link of outgoing) wikiLinksList.append(wikiLinkRow(link));
  }

  if (backlinks.length > 0) {
    wikiLinksList.append(wikiLabel("Backlinks"));
    for (const item of backlinks) {
      wikiLinksList.append(wikiLinkRow({ ...item.link, page: item.page, missing: false }, "backlink"));
    }
  }

  if (outgoing.length === 0 && backlinks.length === 0) {
    wikiLinksList.append(emptyState("No wiki links on this page"));
  }
}

function wikiLabel(text: string): HTMLElement {
  const label = document.createElement("div");
  label.className = "wiki-section-label";
  label.textContent = text;
  return label;
}

function wikiLinkRow(link: WikiResolvedLink, kind: "link" | "backlink" = "link"): HTMLElement {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "wiki-row";
  row.dataset.kind = kind;
  row.dataset.state = link.missing ? "missing" : "resolved";
  row.innerHTML = `<span class="row-title"></span><span class="row-meta"></span>`;
  const title = row.querySelector<HTMLElement>(".row-title");
  const meta = row.querySelector<HTMLElement>(".row-meta");
  if (title) title.textContent = link.page?.title ?? link.label;
  if (meta) meta.textContent = link.missing ? `Create [[${link.target}]]` : kind === "backlink" ? `Linked from ${link.page?.title ?? "page"}` : `Open [[${link.target}]]`;
  row.addEventListener("click", () => {
    if (kind === "backlink" && link.page) {
      selectPage(link.page.id);
      return;
    }
    void openWikiTarget(link.target);
  });
  row.addEventListener("contextmenu", (event) => showWikiContextMenu(event, link, kind));
  return row;
}

function wikiLinksForPage(page: CloudDocumentResponse): WikiResolvedLink[] {
  return extractWikilinks(stripFencedCode(page.source)).map((link) => {
    const resolved = resolveWikiPage(link.target) ?? resolveWikiBlockPage(link.target);
    return {
      ...link,
      ...(resolved ? { page: resolved } : {}),
      missing: !resolved,
    };
  });
}

export function installPreviewWikiLinks(previewDoc: Document): void {
  for (const anchor of [...previewDoc.querySelectorAll<HTMLAnchorElement>("a.noma-ref[href^='#']")]) {
    const target = decodeWikiHrefTarget(anchor.getAttribute("href") ?? "");
    if (!target) continue;
    const page = resolveWikiPage(target) ?? resolveWikiBlockPage(target);
    if (page || canCreatePage()) {
      anchor.dataset.nomaWikiTarget = target;
      anchor.title = page ? `Open ${page.title}` : `Create ${target}`;
    }
    anchor.addEventListener("click", (event) => {
      const currentBlock = target.split("#", 1)[0] ?? target;
      if (!page && hasCurrentDocumentBlock(currentBlock)) return;
      event.preventDefault();
      event.stopPropagation();
      void openWikiTarget(target);
    });
  }
}

export async function openWikiTarget(target: string): Promise<void> {
  const page = resolveWikiPage(target) ?? resolveWikiBlockPage(target);
  if (page) {
    selectPage(page.id);
    return;
  }
  if (!canCreatePage()) {
    setCloudStatus(`Missing page: ${target}`, "warning");
    return;
  }
  await createWikiPage(wikiPageTitleFromTarget(target));
}

async function createWikiPage(title: string): Promise<void> {
  if (!state.currentSite || !state.cloudUser) return;
  if (state.dirty) await saveCurrentPage();
  setBusy(true, "Creating wiki page", "warning");
  try {
    const page = await fetchCloudJson<CloudDocumentResponse>(`/api/sites/${encodeURIComponent(state.currentSite.id)}/documents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title,
        source: wikiPage(title, state.currentSite.title, state.currentPage?.title ?? state.currentSite.title),
      }),
    });
    state.pages = [...state.pages, page];
    state.currentSite = {
      ...state.currentSite,
      documentIds: [...state.currentSite.documentIds, page.id],
      documents: state.pages,
    };
    setCurrentPage(page);
    await refreshSites({ silent: true });
    updateAddress();
    setCloudStatus(`Created wiki page: ${title}`, "ok");
  } catch (error) {
    setCloudStatus(errorMessage(error), "error");
  } finally {
    setBusy(false);
    renderChrome();
  }
}

function resolveWikiPage(target: string): CloudDocumentResponse | undefined {
  const base = wikiPageTitleFromTarget(target);
  const key = wikiKey(base);
  const slugKey = slug(base);
  return state.pages.find((page) => {
    const title = sourceTitle(page.source) || page.title;
    return (
      wikiKey(page.id) === key ||
      wikiKey(page.title) === key ||
      wikiKey(title) === key ||
      slug(page.title) === slugKey ||
      slug(title) === slugKey
    );
  });
}

function resolveWikiBlockPage(target: string): CloudDocumentResponse | undefined {
  const base = wikiPageTitleFromTarget(target);
  const key = wikiKey(base);
  for (const page of state.pages) {
    try {
      const doc = parse(page.source, { filename: `${page.id}.noma` });
      for (const node of walk(doc)) {
        if (wikiKey(node.id ?? "") === key || (node.aliases ?? []).some((alias) => wikiKey(alias) === key)) return page;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

function hasCurrentDocumentBlock(target: string): boolean {
  const doc = state.renderState.doc;
  if (!doc) return false;
  for (const node of walk(doc)) {
    if (node.id === target || node.aliases?.includes(target)) return true;
  }
  return false;
}

function decodeWikiHrefTarget(href: string): string {
  if (!href.startsWith("#")) return "";
  const raw = href.slice(1);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function wikiPageTitleFromTarget(target: string): string {
  return (target.split("#", 1)[0] || target).trim();
}

function wikiKey(value: string): string {
  return value.trim().toLowerCase().replace(/\.noma$/i, "").replace(/\s+/g, " ");
}

function stripFencedCode(source: string): string {
  return source.replace(/```[\s\S]*?```/g, "");
}

function wikiPage(title: string, siteName: string, relatedTitle: string): string {
  const id = slug(title) || "wiki-page";
  return `# ${title} {id="${id}"}

::summary{id="summary"}
Summarize what this page captures in ${siteName}. Keep it connected to the related pages below.
::

## Notes {id="notes"}

Start writing the durable explanation here.

## Related {id="related"}

- [[${relatedTitle}]]

## Agent Tasks {id="agent-tasks"}

::agent_task{id="task-expand-${id}" scope="wiki-maintenance" owner="agent"}
Expand this page with definitions, sources, backlinks, and missing related pages without rewriting unrelated pages.
::
`;
}
