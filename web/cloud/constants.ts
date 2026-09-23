/** Storage keys and static configuration for the Noma Cloud browser app. */
import type { CloudIssueStatus } from "./types.js";

export const userStorageKey = "noma.cloud.user.v1";
export const activeSiteStorageKey = "noma.cloud.activeSite.v1";
export const activeDocumentStorageKey = "noma.cloud.activeDocument.v1";
export const viewModeStorageKey = "noma.cloud.viewMode.v1";
export const panelsOpenStorageKey = "noma.cloud.panelsOpen.v1";
export const splitSourceRatioStorageKey = "noma.cloud.splitSourceRatio.v1";
export const previewPaperWidthStorageKey = "noma.cloud.previewPaperWidth.v1";
export const themeStorageKey = "noma.cloud.theme.v1";
export const offlineDraftStorageKey = "noma.cloud.offlineDrafts.v1";
export const query = new URLSearchParams(window.location.search);
export const workIssueStatuses: CloudIssueStatus[] = ["backlog", "todo", "in_progress", "in_review", "done"];
