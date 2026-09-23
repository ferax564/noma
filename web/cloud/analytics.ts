/** Page view beacon, "N views" in the page header (with a viewer breakdown for editors), and popular pages per space. */
import { fetchCloudJson } from "./api.js";
import { selectPage } from "./navigation.js";
import { state } from "./state.js";
import { emptyState, formatDate } from "./util.js";

interface PageAnalytics {
  totalViews: number;
  uniqueViewers: number;
  anonymousViews: number;
  viewsByDay: Array<{ date: string; views: number }>;
  viewers?: Array<{ userId: string; name: string; views: number; lastViewedAt: string }>;
  viewersVisible: boolean;
}

const viewsButton = requireElement<HTMLButtonElement>("pageViewsButton");
const viewsPanel = requireElement<HTMLElement>("pageViewsPanel");
const popularList = requireElement<HTMLElement>("popularPagesList");

let trackedPageId: string | undefined;
let popularSiteId: string | undefined;

export function bindPageAnalytics(): void {
  viewsButton.addEventListener("click", () => void togglePanel());
}

/** Sends one view beacon per page open; the server deduplicates repeat views for 30 minutes. */
export async function trackPageView(): Promise<void> {
  const page = state.currentPage;
  viewsPanel.hidden = true;
  if (!page || !state.cloudUser) {
    trackedPageId = undefined;
    viewsButton.hidden = true;
    return;
  }
  trackedPageId = page.id;
  try {
    const response = await fetchCloudJson<{ views: number }>(`/api/documents/${encodeURIComponent(page.id)}/views`, { method: "POST" });
    if (trackedPageId !== page.id) return;
    viewsButton.hidden = false;
    viewsButton.textContent = `${response.views} view${response.views === 1 ? "" : "s"}`;
    viewsButton.title = "Views in the last 30 days";
  } catch {
    viewsButton.hidden = true;
  }
}

/** Reloads the popular-pages list when the current space changes. */
export function renderPopularPages(): void {
  const siteId = state.currentSite?.id;
  if (siteId === popularSiteId) return;
  popularSiteId = siteId;
  popularList.textContent = "";
  if (!siteId || !state.cloudUser) {
    popularList.append(emptyState("Open a space"));
    return;
  }
  void fetchCloudJson<{ pages: Array<{ documentId: string; title: string; views: number }> }>(`/api/sites/${encodeURIComponent(siteId)}/popular?limit=5`)
    .then((response) => {
      if (popularSiteId !== siteId) return;
      popularList.textContent = "";
      if (response.pages.length === 0) popularList.append(emptyState("No views yet"));
      for (const page of response.pages) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "navigation-row";
        const title = document.createElement("span");
        title.className = "row-title";
        title.textContent = page.title;
        const meta = document.createElement("span");
        meta.className = "row-meta";
        meta.textContent = `${page.views} view${page.views === 1 ? "" : "s"}`;
        button.append(title, meta);
        button.addEventListener("click", () => selectPage(page.documentId));
        popularList.append(button);
      }
    })
    .catch(() => {
      popularSiteId = undefined;
    });
}

async function togglePanel(): Promise<void> {
  const page = state.currentPage;
  if (!page) return;
  if (!viewsPanel.hidden) {
    viewsPanel.hidden = true;
    return;
  }
  const analytics = await fetchCloudJson<PageAnalytics>(`/api/documents/${encodeURIComponent(page.id)}/analytics?days=30`);
  viewsPanel.textContent = "";
  const summary = document.createElement("p");
  summary.textContent = `${analytics.totalViews} views · ${analytics.uniqueViewers} people${analytics.anonymousViews ? ` · ${analytics.anonymousViews} via share links` : ""} · last 30 days`;
  viewsPanel.append(summary);
  const max = Math.max(1, ...analytics.viewsByDay.map((day) => day.views));
  const chart = document.createElement("div");
  chart.className = "page-views-chart";
  chart.setAttribute("role", "img");
  chart.setAttribute("aria-label", analytics.viewsByDay.map((day) => `${day.date}: ${day.views}`).join(", ") || "No views");
  for (const day of analytics.viewsByDay.slice(-30)) {
    const bar = document.createElement("span");
    bar.style.height = `${Math.max(8, Math.round((day.views / max) * 100))}%`;
    bar.title = `${day.date}: ${day.views}`;
    chart.append(bar);
  }
  viewsPanel.append(chart);
  if (analytics.viewersVisible && analytics.viewers?.length) {
    const list = document.createElement("ul");
    list.className = "page-viewers";
    for (const viewer of analytics.viewers.slice(0, 20)) {
      const item = document.createElement("li");
      item.textContent = `${viewer.name} · ${viewer.views} · ${formatDate(viewer.lastViewedAt)}`;
      list.append(item);
    }
    viewsPanel.append(list);
  }
  viewsPanel.hidden = false;
}

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}
