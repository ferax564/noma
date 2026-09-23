/** Shared mutable app state. ES module bindings cannot be reassigned by importers, so every mutable value lives on the exported `state` object. */
import { panelsOpenStorageKey, previewPaperWidthStorageKey, query, splitSourceRatioStorageKey, themeStorageKey, userStorageKey, viewModeStorageKey } from "./constants.js";
import type { AgentInboxItem, AskNomaResponse, CloudActivityEvent, CloudApproval, CloudCollaboratorGrant, CloudComment, CloudDocumentResponse, CloudDocumentRevisionSummary, CloudGroup, CloudGroupGrant, CloudIssue, CloudIssueDetail, CloudNavigationItem, CloudNotification, CloudPageTemplate, CloudPatchProposal, CloudProject, CloudSearchResult, CloudShareGrant, CloudSiteResponse, CloudSprint, CloudTrashItem, CloudUserSession, KnowledgeHealthItem, LocalOfflineDraft, RenderState, ScopedAgentSummary, ThemeMode, ViewMode } from "./types.js";
import { clamp } from "./util.js";

export interface CloudAppState {
  cloudAvailable: boolean;
  busy: boolean;
  cloudUser: CloudUserSession | undefined;
  sites: CloudSiteResponse[];
  currentSite: CloudSiteResponse | undefined;
  pages: CloudDocumentResponse[];
  currentPage: CloudDocumentResponse | undefined;
  documentRevisions: CloudDocumentRevisionSummary[];
  pageTemplates: CloudPageTemplate[];
  cloudSearchResults: CloudSearchResult[];
  recentItems: CloudNavigationItem[];
  favoriteItems: CloudNavigationItem[];
  currentLabels: string[];
  currentWatching: boolean;
  trashItems: CloudTrashItem[];
  notifications: CloudNotification[];
  comments: CloudComment[];
  approvals: CloudApproval[];
  activityEvents: CloudActivityEvent[];
  groups: CloudGroup[];
  workProjects: CloudProject[];
  workIssues: CloudIssue[];
  workSprints: CloudSprint[];
  selectedIssue: CloudIssueDetail | undefined;
  patchProposals: CloudPatchProposal[];
  collaboratorGrants: CloudCollaboratorGrant[];
  groupGrants: CloudGroupGrant[];
  shareGrants: CloudShareGrant[];
  activeFolder: string;
  dirty: boolean;
  renderTimer: number | undefined;
  renderState: RenderState;
  viewMode: ViewMode;
  panelsOpen: boolean;
  splitSourceRatio: number;
  previewPaperWidth: number;
  themeMode: ThemeMode;
  pendingPreviewFocusLine: number | undefined;
  askNomaResponse: AskNomaResponse | undefined;
  knowledgeHealth: KnowledgeHealthItem[];
  agentInbox: AgentInboxItem[];
  scopedAgents: ScopedAgentSummary[];
  pendingLocalDraft: LocalOfflineDraft | undefined;
  savedPageSource: string;
  savedPageHash: string;
  savedPageTitle: string;
}

export const state: CloudAppState = {
  cloudAvailable: false,
  busy: false,
  cloudUser: readCloudUser(),
  sites: [],
  currentSite: undefined,
  pages: [],
  currentPage: undefined,
  documentRevisions: [],
  pageTemplates: [],
  cloudSearchResults: [],
  recentItems: [],
  favoriteItems: [],
  currentLabels: [],
  currentWatching: false,
  trashItems: [],
  notifications: [],
  comments: [],
  approvals: [],
  activityEvents: [],
  groups: [],
  workProjects: [],
  workIssues: [],
  workSprints: [],
  selectedIssue: undefined,
  patchProposals: [],
  collaboratorGrants: [],
  groupGrants: [],
  shareGrants: [],
  activeFolder: "",
  dirty: false,
  renderTimer: undefined,
  renderState: emptyRenderState(),
  viewMode: readViewMode(),
  panelsOpen: readPanelsOpen(),
  splitSourceRatio: readSplitSourceRatio(),
  previewPaperWidth: readPreviewPaperWidth(),
  themeMode: readThemeMode(),
  pendingPreviewFocusLine: undefined,
  askNomaResponse: undefined,
  knowledgeHealth: [],
  agentInbox: [],
  scopedAgents: [],
  pendingLocalDraft: undefined,
  savedPageSource: "",
  savedPageHash: "",
  savedPageTitle: "",
};

export const shareToken = readShareToken();

function readCloudUser(): CloudUserSession | undefined {
  const stored = localStorage.getItem(userStorageKey);
  if (!stored) return undefined;
  try {
    const parsed = JSON.parse(stored) as Partial<CloudUserSession>;
    if (parsed.id && parsed.name && parsed.token) {
      return {
        id: parsed.id,
        name: parsed.name,
        token: parsed.token,
        tokenPreview: parsed.tokenPreview,
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function readShareToken(): string | undefined {
  const token = query.get("share");
  return token && /^ns_[A-Za-z0-9_-]{16,}$/.test(token) ? token : undefined;
}

export function readCloudId(value: string | null): string | undefined {
  return value && /^[A-Za-z0-9_-]{8,80}$/.test(value) ? value : undefined;
}

function readViewMode(): ViewMode {
  const user = readCloudUser();
  const stored = (user ? localStorage.getItem(`${viewModeStorageKey}:${user.id}`) : null) ?? localStorage.getItem(viewModeStorageKey);
  return stored === "source" || stored === "preview" || stored === "split" || stored === "visual" ? stored : "visual";
}

function readPanelsOpen(): boolean {
  return localStorage.getItem(panelsOpenStorageKey) !== "false";
}

function readSplitSourceRatio(): number {
  const stored = localStorage.getItem(splitSourceRatioStorageKey);
  if (stored === null) return 46;
  const parsed = Number(stored);
  return Number.isFinite(parsed) ? clamp(parsed, 30, 66) : 46;
}

function readPreviewPaperWidth(): number {
  const stored = localStorage.getItem(previewPaperWidthStorageKey);
  if (stored === null) return 1040;
  const parsed = Number(stored);
  return Number.isFinite(parsed) ? clamp(parsed, 680, 1280) : 1040;
}

function readThemeMode(): ThemeMode {
  const stored = localStorage.getItem(themeStorageKey);
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function emptyRenderState(): RenderState {
  return {
    doc: null,
    diagnostics: [],
    llm: "",
  };
}
