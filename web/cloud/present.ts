/** "Present" in the page header: opens the saved page as a presentation (`/d/:id/present`) in a new tab. */
import { presentPageButton } from "./dom.js";
import { state } from "./state.js";

export function presentationUrl(pageId: string): string {
  return `/d/${encodeURIComponent(pageId)}/present`;
}

export function installPresentButton(): void {
  presentPageButton.addEventListener("click", () => {
    const page = state.currentPage;
    if (!page) return;
    if (state.dirty && !window.confirm("This page has unsaved changes. Present the last saved version?")) return;
    window.open(presentationUrl(page.id), "_blank", "noopener");
  });
}
