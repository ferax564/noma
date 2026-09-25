/**
 * Page templates: blueprint variable form on page creation, "Save page as template", and the
 * Manage templates dialog (edit or delete workspace/space templates; built-ins stay read-only).
 */
import { fetchCloudJson } from "./api.js";
import { collaborationActions, collaborationRow } from "./collaboration.js";
import { refreshTemplates } from "./navigation.js";
import { canCreatePage, canEditSite } from "./permissions.js";
import { shareToken, state } from "./state.js";
import type { CloudPageTemplate } from "./types.js";
import { actionButton, emptyState, errorMessage, formatDate, setCloudStatus, setPanelStatus } from "./util.js";

const saveButton = element<HTMLButtonElement>("templateSaveButton");
const saveDialog = element<HTMLDialogElement>("templateSaveDialog");
const saveForm = element<HTMLFormElement>("templateSaveForm");
const nameInput = element<HTMLInputElement>("templateSaveName");
const descriptionInput = element<HTMLInputElement>("templateSaveDescription");
const scopeSelect = element<HTMLSelectElement>("templateSaveScope");
const saveStatus = element<HTMLElement>("templateSaveStatus");
const saveCancel = element<HTMLButtonElement>("templateSaveCancel");
const variablesDialog = element<HTMLDialogElement>("templateVariablesDialog");
const variablesForm = element<HTMLFormElement>("templateVariablesForm");
const variablesFields = element<HTMLElement>("templateVariablesFields");
const variablesTitle = element<HTMLElement>("templateVariablesTitle");
const variablesCancel = element<HTMLButtonElement>("templateVariablesCancel");
const manageButton = element<HTMLButtonElement>("templateManageButton");
const manageDialog = element<HTMLDialogElement>("templateManageDialog");
const manageList = element<HTMLElement>("templateManageList");
const manageStatus = element<HTMLElement>("templateManageStatus");
const manageClose = element<HTMLButtonElement>("templateManageClose");
const editDialog = element<HTMLDialogElement>("templateEditDialog");
const editForm = element<HTMLFormElement>("templateEditForm");
const editTitle = element<HTMLElement>("templateEditTitle");
const editName = element<HTMLInputElement>("templateEditName");
const editDescription = element<HTMLInputElement>("templateEditDescription");
const editCategory = element<HTMLSelectElement>("templateEditCategory");
const editSource = element<HTMLTextAreaElement>("templateEditSource");
const editVariables = element<HTMLElement>("templateEditVariables");
const editAddVariable = element<HTMLButtonElement>("templateEditAddVariable");
const editStatus = element<HTMLElement>("templateEditStatus");
const editCancel = element<HTMLButtonElement>("templateEditCancel");

type TemplateVariable = NonNullable<CloudPageTemplate["variables"]>[number];

let editingTemplate: CloudPageTemplate | undefined;

export function installTemplateTools(): void {
  saveButton.addEventListener("click", () => openSaveDialog());
  saveCancel.addEventListener("click", () => saveDialog.close());
  saveForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveAsTemplate();
  });
  variablesCancel.addEventListener("click", () => variablesDialog.close("cancel"));
  manageButton.addEventListener("click", () => void openManageDialog());
  manageClose.addEventListener("click", () => manageDialog.close());
  editCancel.addEventListener("click", () => editDialog.close());
  editAddVariable.addEventListener("click", () => {
    editVariables.append(variableRow());
    editVariables.querySelector<HTMLInputElement>(".template-variable-row:last-child input")?.focus();
  });
  editForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveEditedTemplate();
  });
}

export function renderTemplateToolsChrome(): void {
  saveButton.disabled = state.busy || !state.cloudUser || !state.currentPage || Boolean(shareToken);
  manageButton.disabled = state.busy || !state.cloudUser || Boolean(shareToken);
}

/**
 * Ask for a blueprint's declared variables. Resolves to `{}` for templates
 * without variables, the entered values on submit, or `undefined` if cancelled.
 */
export function promptTemplateVariables(template: CloudPageTemplate | undefined): Promise<Record<string, string> | undefined> {
  const variables = template?.variables ?? [];
  if (!template || variables.length === 0) return Promise.resolve({});
  variablesTitle.textContent = `New page from “${template.title}”`;
  variablesFields.textContent = "";
  for (const variable of variables) {
    const label = document.createElement("label");
    label.className = "wiki-dialog-field";
    label.textContent = `${variable.label}${variable.required ? " *" : ""}`;
    const input = document.createElement("input");
    input.type = "text";
    input.name = variable.name;
    input.maxLength = 500;
    input.required = variable.required;
    input.value = variable.default ?? "";
    label.append(input);
    variablesFields.append(label);
  }
  return new Promise((resolve) => {
    const onSubmit = (event: SubmitEvent): void => {
      event.preventDefault();
      const values: Record<string, string> = {};
      for (const input of variablesFields.querySelectorAll<HTMLInputElement>("input[name]")) values[input.name] = input.value;
      variablesDialog.close("submit");
      resolve(values);
    };
    variablesForm.addEventListener("submit", onSubmit, { once: true });
    variablesDialog.addEventListener(
      "close",
      () => {
        variablesForm.removeEventListener("submit", onSubmit);
        if (variablesDialog.returnValue !== "submit") resolve(undefined);
      },
      { once: true },
    );
    variablesDialog.returnValue = "";
    variablesDialog.showModal();
    variablesFields.querySelector<HTMLInputElement>("input")?.focus();
  });
}

function openSaveDialog(): void {
  if (!state.currentPage) return;
  nameInput.value = state.currentPage.title;
  descriptionInput.value = "";
  const siteOption = scopeSelect.querySelector<HTMLOptionElement>('option[value="site"]');
  if (siteOption) siteOption.disabled = !state.currentSite || !canEditSite();
  scopeSelect.value = state.currentSite && canEditSite() ? "site" : "workspace";
  setPanelStatus(
    saveStatus,
    state.dirty ? "Unsaved edits are not included: the template uses the last saved version." : "The page's first heading becomes the {{title}} placeholder.",
    state.dirty ? "warning" : "ok",
  );
  saveDialog.showModal();
}

async function saveAsTemplate(): Promise<void> {
  const page = state.currentPage;
  if (!page) return;
  const scope = scopeSelect.value === "site" ? "site" : "workspace";
  try {
    await fetchCloudJson("/api/templates", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope,
        ...(scope === "site" && state.currentSite ? { siteId: state.currentSite.id } : {}),
        name: nameInput.value.trim(),
        description: descriptionInput.value.trim(),
        fromDocumentId: page.id,
      }),
    });
    saveDialog.close();
    setCloudStatus(`Saved “${nameInput.value.trim()}” as a ${scope === "site" ? "space" : "workspace"} template`, "ok");
    if (canCreatePage()) await refreshTemplates();
  } catch (error) {
    setPanelStatus(saveStatus, errorMessage(error), "error");
  }
}

async function openManageDialog(): Promise<void> {
  if (!state.cloudUser) return;
  setPanelStatus(manageStatus, "Loading templates", "warning");
  if (!manageDialog.open) manageDialog.showModal();
  try {
    await refreshTemplates();
    renderManageList();
    setPanelStatus(manageStatus, "", "ok");
  } catch (error) {
    setPanelStatus(manageStatus, errorMessage(error), "error");
  }
}

function renderManageList(): void {
  manageList.textContent = "";
  if (state.pageTemplates.length === 0) {
    manageList.append(emptyState("No templates"));
    return;
  }
  for (const template of state.pageTemplates) {
    const scope = template.scope === "site" ? "space" : template.scope === "workspace" ? "workspace" : "built-in";
    const variables = template.variables?.length ?? 0;
    const row = collaborationRow(
      template.title,
      template.description || "No description",
      `${scope} · ${template.category}${variables ? ` · ${variables} variable${variables === 1 ? "" : "s"}` : ""}${template.updatedAt ? ` · updated ${formatDate(template.updatedAt)}` : ""}${template.editable ? "" : " · read-only"}`,
    );
    row.dataset.templateId = template.id;
    if (template.editable) {
      const actions = collaborationActions();
      actions.append(
        actionButton("Edit", () => openEditDialog(template), false, `Edit template ${template.title}`),
        actionButton("Delete", () => void deleteTemplate(template), false, `Delete template ${template.title}`),
      );
      row.append(actions);
    }
    manageList.append(row);
  }
}

function openEditDialog(template: CloudPageTemplate): void {
  editingTemplate = template;
  editTitle.textContent = `Edit “${template.title}”`;
  editName.value = template.title;
  editDescription.value = template.description;
  editCategory.value = [...editCategory.options].some((option) => option.value === template.category) ? template.category : "general";
  editSource.value = template.source;
  editVariables.textContent = "";
  for (const variable of template.variables ?? []) editVariables.append(variableRow(variable));
  setPanelStatus(editStatus, "", "ok");
  editDialog.showModal();
  editName.focus();
}

function variableRow(variable?: TemplateVariable): HTMLElement {
  const row = document.createElement("div");
  row.className = "template-variable-row";
  const field = (key: "name" | "label" | "default", label: string, value: string): HTMLInputElement => {
    const input = document.createElement("input");
    input.type = "text";
    input.dataset.field = key;
    input.placeholder = label;
    input.setAttribute("aria-label", `Variable ${label.toLowerCase()}`);
    input.value = value;
    if (key === "name") {
      input.pattern = "[a-z][a-z0-9_]{0,39}";
      input.required = true;
      input.maxLength = 40;
    }
    return input;
  };
  const required = document.createElement("label");
  required.className = "wiki-dialog-check";
  const requiredInput = document.createElement("input");
  requiredInput.type = "checkbox";
  requiredInput.dataset.field = "required";
  requiredInput.checked = variable?.required ?? false;
  required.append(requiredInput, document.createTextNode(" Required"));
  const remove = actionButton("Remove", () => row.remove(), false, `Remove variable ${variable?.name ?? ""}`.trim());
  row.append(field("name", "Name", variable?.name ?? ""), field("label", "Label", variable?.label ?? ""), field("default", "Default", variable?.default ?? ""), required, remove);
  return row;
}

function editedVariables(): TemplateVariable[] {
  return [...editVariables.querySelectorAll<HTMLElement>(".template-variable-row")].map((row) => {
    const value = (key: string): string => row.querySelector<HTMLInputElement>(`input[data-field="${key}"]`)?.value.trim() ?? "";
    const name = value("name");
    const defaultValue = row.querySelector<HTMLInputElement>('input[data-field="default"]')?.value ?? "";
    return {
      name,
      label: value("label") || name,
      ...(defaultValue ? { default: defaultValue } : {}),
      required: row.querySelector<HTMLInputElement>('input[data-field="required"]')?.checked ?? false,
    };
  });
}

async function saveEditedTemplate(): Promise<void> {
  const template = editingTemplate;
  if (!template) return;
  try {
    await fetchCloudJson(`/api/templates/${encodeURIComponent(template.id)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: editName.value.trim(),
        description: editDescription.value.trim(),
        category: editCategory.value,
        source: editSource.value,
        variables: editedVariables(),
      }),
    });
    editDialog.close();
    editingTemplate = undefined;
    await refreshTemplates();
    renderManageList();
    setPanelStatus(manageStatus, `Saved template “${editName.value.trim()}”`, "ok");
  } catch (error) {
    setPanelStatus(editStatus, errorMessage(error), "error");
  }
}

async function deleteTemplate(template: CloudPageTemplate): Promise<void> {
  if (!window.confirm(`Delete the template “${template.title}”? Pages created from it are not affected.`)) return;
  try {
    await fetchCloudJson(`/api/templates/${encodeURIComponent(template.id)}`, { method: "DELETE" });
    await refreshTemplates();
    renderManageList();
    setPanelStatus(manageStatus, `Deleted template “${template.title}”`, "ok");
  } catch (error) {
    setPanelStatus(manageStatus, errorMessage(error), "error");
  }
}

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing #${id}`);
  return found as T;
}
