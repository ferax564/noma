/** Role checks for the current user against pages, spaces and projects. */
import { inviteRoleSelect, shareRoleSelect } from "./dom.js";
import { state } from "./state.js";
import type { CloudRole, CloudSiteResponse } from "./types.js";
import { selectedWorkProject } from "./work.js";

export function canEditSiteRecord(site: CloudSiteResponse): boolean {
  const role = cloudRole(site.access?.role ?? site.currentRole);
  return Boolean(state.cloudAvailable && state.cloudUser && roleRank(role) >= roleRank("editor"));
}

function cloudRole(value: unknown): CloudRole {
  return value === "owner" || value === "editor" || value === "viewer" ? value : "viewer";
}

export function canEditPage(): boolean {
  return roleRank(currentPageRole()) >= roleRank("editor");
}

export function canCreatePage(): boolean {
  return Boolean(state.cloudAvailable && state.cloudUser && state.currentSite && roleRank(state.currentSite.access?.role ?? "viewer") >= roleRank("editor"));
}

export function canEditSite(): boolean {
  return Boolean(state.cloudAvailable && state.cloudUser && state.currentSite && roleRank(state.currentSite.access?.role ?? "viewer") >= roleRank("editor"));
}

export function canManagePermissions(): boolean {
  const role = state.currentSite?.access?.role ?? state.currentPage?.access?.role ?? "viewer";
  return role === "owner";
}

export function canEditWorkProject(): boolean {
  return roleRank(selectedWorkProject()?.access?.role ?? "viewer") >= roleRank("editor");
}

export function currentPageRole(): CloudRole {
  return state.currentPage?.access?.role ?? state.currentSite?.access?.role ?? "viewer";
}

export function selectedShareRole(): Exclude<CloudRole, "owner"> {
  return shareRoleSelect.value === "viewer" ? "viewer" : "editor";
}

export function selectedInviteRole(): Exclude<CloudRole, "owner"> {
  return inviteRoleSelect.value === "viewer" ? "viewer" : "editor";
}

export function roleRank(role: CloudRole): number {
  return role === "owner" ? 3 : role === "editor" ? 2 : 1;
}
