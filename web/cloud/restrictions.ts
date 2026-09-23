/** Page view/edit restrictions: header lock badge, page-tree lock indicators, and the Restrictions dialog. */
import { fetchCloudJson } from "./api.js";
import { renderChrome } from "./layout.js";
import { loadSite } from "./navigation.js";
import { state } from "./state.js";
import type { CloudGroup } from "./types.js";
import { errorMessage, setCloudStatus, setPanelStatus } from "./util.js";

type RestrictionKind = "view" | "edit";

interface RestrictionPrincipal {
  id: string;
  name: string;
}

interface RestrictionsResponse {
  documentId: string;
  view: { users: RestrictionPrincipal[]; groups: RestrictionPrincipal[] };
  edit: { users: RestrictionPrincipal[]; groups: RestrictionPrincipal[] };
  inherited: Array<{ documentId: string; title?: string }>;
  restricted: { view: boolean; edit: boolean };
  canManage: boolean;
}

interface RestrictionFlags {
  view: boolean;
  edit: boolean;
  inheritedView: boolean;
}

interface TreeNode {
  id: string;
  restrictions?: RestrictionFlags;
  children: TreeNode[];
}

interface DraftPrincipal extends RestrictionPrincipal {
  type: "user" | "group";
}

const badge = requireElement<HTMLButtonElement>("restrictionBadge");
const dialog = requireElement<HTMLDialogElement>("restrictionsDialog");
const dialogTitle = requireElement<HTMLElement>("restrictionsTitle");
const summary = requireElement<HTMLElement>("restrictionsSummary");
const inheritedNote = requireElement<HTMLElement>("restrictionsInherited");
const viewList = requireElement<HTMLElement>("restrictionsViewList");
const editList = requireElement<HTMLElement>("restrictionsEditList");
const kindSelect = requireElement<HTMLSelectElement>("restrictionsKindSelect");
const principalInput = requireElement<HTMLInputElement>("restrictionsPrincipalInput");
const principalOptions = requireElement<HTMLDataListElement>("restrictionsPrincipalOptions");
const addButton = requireElement<HTMLButtonElement>("restrictionsAddButton");
const clearButton = requireElement<HTMLButtonElement>("restrictionsClearButton");
const cancelButton = requireElement<HTMLButtonElement>("restrictionsCancelButton");
const saveButton = requireElement<HTMLButtonElement>("restrictionsSaveButton");
const dialogStatus = requireElement<HTMLElement>("restrictionsStatus");

let currentRestrictions: RestrictionsResponse | undefined;
let flagsSiteId: string | undefined;
let treeFlags = new Map<string, RestrictionFlags>();
let dialogPageId: string | undefined;
let dialogCanManage = false;
let draft: Record<RestrictionKind, DraftPrincipal[]> = { view: [], edit: [] };
let candidates: DraftPrincipal[] = [];

export function installRestrictions(): void {
  badge.addEventListener("click", () => {
    if (state.currentPage) void openRestrictionsDialog(state.currentPage.id, state.currentPage.title);
  });
  addButton.addEventListener("click", () => addPrincipal());
  principalInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    addPrincipal();
  });
  clearButton.addEventListener("click", () => {
    draft = { view: [], edit: [] };
    renderDraft();
  });
  cancelButton.addEventListener("click", () => dialog.close());
  saveButton.addEventListener("click", () => void saveRestrictions());
}

/** Loads the current page's restrictions (header badge) and the space's lock flags (page tree). */
export async function refreshRestrictions(): Promise<void> {
  const page = state.currentPage;
  currentRestrictions = undefined;
  renderRestrictionBadge();
  if (!page || !state.cloudUser) return;
  try {
    const [restrictions] = await Promise.all([
      fetchCloudJson<RestrictionsResponse>(`/api/documents/${encodeURIComponent(page.id)}/restrictions`),
      refreshTreeFlags(),
    ]);
    if (state.currentPage?.id !== page.id) return;
    currentRestrictions = restrictions;
  } catch {
    return;
  } finally {
    renderChrome();
  }
}

async function refreshTreeFlags(): Promise<void> {
  const site = state.currentSite;
  if (!site) {
    flagsSiteId = undefined;
    treeFlags = new Map();
    return;
  }
  const tree = await fetchCloudJson<{ pages: TreeNode[] }>(`/api/sites/${encodeURIComponent(site.id)}/tree`);
  const next = new Map<string, RestrictionFlags>();
  const visit = (nodes: TreeNode[]) => {
    for (const node of nodes) {
      if (node.restrictions) next.set(node.id, node.restrictions);
      visit(node.children);
    }
  };
  visit(tree.pages);
  flagsSiteId = site.id;
  treeFlags = next;
}

export function renderRestrictionBadge(): void {
  const restrictions = state.currentPage && currentRestrictions?.documentId === state.currentPage.id ? currentRestrictions : undefined;
  const inherited = (restrictions?.inherited.length ?? 0) > 0;
  const locked = Boolean(restrictions && (restrictions.restricted.view || restrictions.restricted.edit || inherited));
  badge.hidden = !restrictions || (!locked && !restrictions.canManage);
  badge.dataset.state = locked ? "restricted" : "open";
  badge.textContent = locked ? restrictionLabel(restrictions!.restricted.view, restrictions!.restricted.edit, inherited) : "Unrestricted";
  badge.title = locked ? "This page has view or edit restrictions. Open to review them." : "Anyone with access to this space can view and edit per their role. Click to add restrictions.";
}

/** Lock indicator for a page-tree row, or undefined when the page is unrestricted. */
export function restrictionIndicator(pageId: string): HTMLElement | undefined {
  if (flagsSiteId !== state.currentSite?.id) return undefined;
  const flags = treeFlags.get(pageId);
  if (!flags || (!flags.view && !flags.edit && !flags.inheritedView)) return undefined;
  const lock = document.createElement("span");
  lock.className = "restriction-lock";
  lock.dataset.kind = flags.view || flags.inheritedView ? "view" : "edit";
  const label = restrictionLabel(flags.view, flags.edit, flags.inheritedView);
  lock.title = label;
  lock.setAttribute("aria-label", label);
  lock.innerHTML = '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path fill="currentColor" d="M5 7V5a3 3 0 0 1 6 0v2h.5A1.5 1.5 0 0 1 13 8.5v5A1.5 1.5 0 0 1 11.5 15h-7A1.5 1.5 0 0 1 3 13.5v-5A1.5 1.5 0 0 1 4.5 7H5Zm1.5 0h3V5a1.5 1.5 0 0 0-3 0v2Z"/></svg>';
  return lock;
}

export async function openRestrictionsDialog(pageId: string, title: string): Promise<void> {
  if (!state.cloudUser) {
    setCloudStatus("Sign in to manage page restrictions", "warning");
    return;
  }
  try {
    const [restrictions, users, groups] = await Promise.all([
      fetchCloudJson<RestrictionsResponse>(`/api/documents/${encodeURIComponent(pageId)}/restrictions`),
      fetchCloudJson<{ users: RestrictionPrincipal[] }>("/api/users").catch(() => ({ users: [] as RestrictionPrincipal[] })),
      fetchCloudJson<{ groups: CloudGroup[] }>("/api/groups").catch(() => ({ groups: [] as CloudGroup[] })),
    ]);
    dialogPageId = pageId;
    dialogCanManage = restrictions.canManage;
    draft = {
      view: principalsOf(restrictions.view),
      edit: principalsOf(restrictions.edit),
    };
    candidates = [
      ...users.users.map((user) => ({ type: "user" as const, id: user.id, name: user.name })),
      ...groups.groups.map((group) => ({ type: "group" as const, id: group.id, name: group.name })),
    ];
    principalOptions.textContent = "";
    for (const candidate of candidates) {
      const option = document.createElement("option");
      option.value = `${candidate.type}:${candidate.id}`;
      option.label = `${candidate.name} (${candidate.type})`;
      principalOptions.append(option);
    }
    dialogTitle.textContent = `Restrictions: ${title}`;
    summary.textContent = restrictions.canManage
      ? "Only listed people and groups (plus page owners and workspace admins) can view or edit. Leave a list empty to inherit the space permissions."
      : "Only the page owner, a space owner, or a workspace admin can change these restrictions.";
    inheritedNote.hidden = restrictions.inherited.length === 0;
    inheritedNote.textContent = restrictions.inherited.length
      ? `Also inherits view restrictions from: ${restrictions.inherited.map((item) => item.title ?? "a restricted parent page").join(", ")}.`
      : "";
    setPanelStatus(dialogStatus, "", "ok");
    renderDraft();
    if (!dialog.open) dialog.showModal();
  } catch (error) {
    setCloudStatus(errorMessage(error), "error");
  }
}

function principalsOf(entry: RestrictionsResponse["view"]): DraftPrincipal[] {
  return [
    ...entry.users.map((user) => ({ type: "user" as const, ...user })),
    ...entry.groups.map((group) => ({ type: "group" as const, ...group })),
  ];
}

function renderDraft(): void {
  for (const kind of ["view", "edit"] as const) {
    const list = kind === "view" ? viewList : editList;
    list.textContent = "";
    if (draft[kind].length === 0) {
      const empty = document.createElement("span");
      empty.className = "restrictions-empty";
      empty.textContent = kind === "view" ? "Everyone with access to the space" : "Everyone who can edit in the space";
      list.append(empty);
      continue;
    }
    for (const principal of draft[kind]) {
      const chip = document.createElement("span");
      chip.className = "label-chip restrictions-chip";
      chip.dataset.type = principal.type;
      chip.textContent = `${principal.name}${principal.type === "group" ? " (group)" : ""}`;
      if (dialogCanManage) {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "×";
        remove.setAttribute("aria-label", `Remove ${principal.name} from ${kind} restrictions`);
        remove.addEventListener("click", () => {
          draft[kind] = draft[kind].filter((item) => !(item.type === principal.type && item.id === principal.id));
          renderDraft();
        });
        chip.append(remove);
      }
      list.append(chip);
    }
  }
  for (const control of [kindSelect, principalInput, addButton, clearButton, saveButton]) control.disabled = !dialogCanManage;
}

function addPrincipal(): void {
  const value = principalInput.value.trim();
  if (!value) return;
  const kind: RestrictionKind = kindSelect.value === "edit" ? "edit" : "view";
  const match = /^(user|group):([A-Za-z0-9_-]{8,80})$/.exec(value);
  const principal =
    (match ? candidates.find((item) => item.type === match[1] && item.id === match[2]) : undefined) ??
    candidates.find((item) => item.name.toLowerCase() === value.toLowerCase()) ??
    (/^[A-Za-z0-9_-]{8,80}$/.test(value) ? candidates.find((item) => item.id === value) ?? { type: "user" as const, id: value, name: value } : undefined);
  if (!principal) {
    setPanelStatus(dialogStatus, `No user or group matches "${value}"`, "error");
    return;
  }
  if (!draft[kind].some((item) => item.type === principal.type && item.id === principal.id)) draft[kind] = [...draft[kind], principal];
  principalInput.value = "";
  setPanelStatus(dialogStatus, "", "ok");
  renderDraft();
}

async function saveRestrictions(): Promise<void> {
  if (!dialogPageId || !dialogCanManage) return;
  const body = {
    view: { users: idsOf(draft.view, "user"), groups: idsOf(draft.view, "group") },
    edit: { users: idsOf(draft.edit, "user"), groups: idsOf(draft.edit, "group") },
  };
  saveButton.disabled = true;
  try {
    await fetchCloudJson<RestrictionsResponse>(`/api/documents/${encodeURIComponent(dialogPageId)}/restrictions`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    dialog.close();
    setCloudStatus("Saved page restrictions", "ok");
    if (state.currentSite) await loadSite(state.currentSite.id, state.currentPage?.id);
    await refreshRestrictions();
  } catch (error) {
    setPanelStatus(dialogStatus, errorMessage(error), "error");
  } finally {
    saveButton.disabled = !dialogCanManage;
  }
}

function idsOf(principals: DraftPrincipal[], type: DraftPrincipal["type"]): string[] {
  return principals.filter((item) => item.type === type).map((item) => item.id);
}

function restrictionLabel(view: boolean, edit: boolean, inheritedView: boolean): string {
  if (view && edit) return "View and edit restricted";
  if (view) return "View restricted";
  if (inheritedView && edit) return "Inherited view and edit restricted";
  if (inheritedView) return "Inherits view restrictions";
  return "Edit restricted";
}

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}
