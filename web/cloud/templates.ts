/** Page templates: blueprint variable form on page creation and "Save page as template". */
import { fetchCloudJson } from "./api.js";
import { refreshTemplates } from "./navigation.js";
import { canCreatePage, canEditSite } from "./permissions.js";
import { shareToken, state } from "./state.js";
import type { CloudPageTemplate } from "./types.js";
import { errorMessage, setCloudStatus, setPanelStatus } from "./util.js";

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

export function installTemplateTools(): void {
  saveButton.addEventListener("click", () => openSaveDialog());
  saveCancel.addEventListener("click", () => saveDialog.close());
  saveForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveAsTemplate();
  });
  variablesCancel.addEventListener("click", () => variablesDialog.close("cancel"));
}

export function renderTemplateToolsChrome(): void {
  saveButton.disabled = state.busy || !state.cloudUser || !state.currentPage || Boolean(shareToken);
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

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing #${id}`);
  return found as T;
}
