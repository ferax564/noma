/** Search panel filters: type/date/label/author dropdowns plus removable chips for filters typed into the query. */
import { fetchCloudJson } from "./api.js";
import { globalSearchInput } from "./dom.js";
import { state } from "./state.js";

export interface SearchQueryEcho {
  labels: string[];
  authors: string[];
  spaces: string[];
  types: string[];
  phrases: string[];
  updatedAfter?: string;
  updatedBefore?: string;
}

const typeFilter = requireElement<HTMLSelectElement>("searchTypeFilter");
const updatedFilter = requireElement<HTMLSelectElement>("searchUpdatedFilter");
const labelFilter = requireElement<HTMLInputElement>("searchLabelFilter");
const labelOptions = requireElement<HTMLDataListElement>("searchLabelOptions");
const authorFilter = requireElement<HTMLSelectElement>("searchAuthorFilter");
const chipList = requireElement<HTMLElement>("searchFilterChips");

let labelsLoaded = false;

/** Adds the dropdown filters to a search request. */
export function applySearchFilterParams(params: URLSearchParams): void {
  if (typeFilter.value) params.set("type", typeFilter.value);
  const days = Number(updatedFilter.value);
  if (Number.isInteger(days) && days > 0) params.set("updatedAfter", new Date(Date.now() - days * 86_400_000).toISOString());
  const label = labelFilter.value.trim();
  if (label) params.set("label", label);
  if (authorFilter.value) params.set("author", authorFilter.value);
}

/** True when a dropdown filter is set, so a search may run without free text. */
export function hasSearchFilterSelection(): boolean {
  return Boolean(typeFilter.value || updatedFilter.value || labelFilter.value.trim() || authorFilter.value);
}

export function bindSearchFilters(runSearch: () => void): void {
  for (const control of [typeFilter, updatedFilter, authorFilter]) control.addEventListener("change", () => runSearch());
  labelFilter.addEventListener("change", () => runSearch());
  labelFilter.addEventListener("focus", () => void loadFilterOptions());
  authorFilter.addEventListener("focus", () => void loadFilterOptions());
}

/** Renders one chip per active filter; removing a typed filter rewrites the query text. */
export function renderSearchFilterChips(echo: SearchQueryEcho | undefined): void {
  chipList.textContent = "";
  if (!echo) return;
  const chips: Array<{ text: string; token?: RegExp; control?: () => void }> = [
    ...echo.labels.map((label) => ({ text: `label: ${label}`, token: tokenPattern("label", label), control: label === labelFilter.value.trim().toLowerCase() ? () => (labelFilter.value = "") : undefined })),
    ...echo.authors.map((author) => ({ text: `author: ${author}`, token: tokenPattern("author", author), control: author === authorFilter.value ? () => (authorFilter.value = "") : undefined })),
    ...echo.spaces.map((space) => ({ text: `space: ${space}`, token: tokenPattern("space", space) })),
    ...echo.types.map((type) => ({ text: `type: ${type}`, token: tokenPattern("type", type), control: type === typeFilter.value ? () => (typeFilter.value = "") : undefined })),
    ...echo.phrases.map((phrase) => ({ text: `"${phrase}"`, token: new RegExp(`"${escapeRegExp(phrase)}"`, "i") })),
    ...(echo.updatedAfter ? [{ text: `after ${echo.updatedAfter.slice(0, 10)}`, token: /\b(?:after|updatedafter):\S+/i, control: () => (updatedFilter.value = "") }] : []),
    ...(echo.updatedBefore ? [{ text: `before ${echo.updatedBefore.slice(0, 10)}`, token: /\b(?:before|updatedbefore):\S+/i }] : []),
  ];
  for (const chip of chips) {
    const element = document.createElement("span");
    element.className = "search-filter-chip";
    element.textContent = chip.text;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Remove filter ${chip.text}`);
    remove.addEventListener("click", () => {
      if (chip.control) chip.control();
      if (chip.token) globalSearchInput.value = globalSearchInput.value.replace(chip.token, "").replace(/\s+/g, " ").trim();
      globalSearchInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    });
    element.append(remove);
    chipList.append(element);
  }
}

async function loadFilterOptions(): Promise<void> {
  if (labelsLoaded || !state.cloudUser) return;
  labelsLoaded = true;
  try {
    const [labels, users] = await Promise.all([
      fetchCloudJson<{ labels: Array<{ label: string; count: number }> }>("/api/labels"),
      fetchCloudJson<{ users: Array<{ id: string; name: string }> }>("/api/users?q="),
    ]);
    labelOptions.textContent = "";
    for (const { label, count } of labels.labels) {
      const option = document.createElement("option");
      option.value = label;
      option.label = `${label} (${count})`;
      labelOptions.append(option);
    }
    const selected = authorFilter.value;
    authorFilter.textContent = "";
    authorFilter.append(new Option("Anyone", ""), new Option("Me", "me"));
    for (const user of users.users) {
      if (user.id !== state.cloudUser?.id) authorFilter.append(new Option(user.name, user.id));
    }
    authorFilter.value = selected;
  } catch {
    labelsLoaded = false;
  }
}

function tokenPattern(key: string, value: string): RegExp {
  return new RegExp(`\\b${key}:(?:"${escapeRegExp(value)}"|@?${escapeRegExp(value)})(?=\\s|$)`, "i");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}
