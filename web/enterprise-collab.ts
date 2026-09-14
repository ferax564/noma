import { mountHostedCollab } from "./hosted-collab";

const params = new URLSearchParams(window.location.search);
const token = params.get("token") ?? "";
const documentId = params.get("documentId") ?? "";
const status = document.getElementById("status");
const mount = document.getElementById("editor");
if (!mount) throw new Error("missing #editor");

function setStatus(text: string): void {
  if (status) status.textContent = text;
}

const session = mountHostedCollab({
  element: mount,
  token,
  documentId,
  onStatus: setStatus,
});

const api = {
  getText: () => session.getText(),
  acks: () => session.acks(),
  ready: () => session.ready(),
};
Object.assign(window, { nomaCollab: api });

document.querySelectorAll<HTMLButtonElement>("[data-cmd]").forEach((button) => {
  button.addEventListener("click", () => {
    const editor = session.editor();
    if (!editor) return;
    const cmd = button.dataset.cmd;
    const chain = editor.chain().focus();
    if (cmd === "bold") chain.toggleBold().run();
    if (cmd === "italic") chain.toggleItalic().run();
    if (cmd === "strike") chain.toggleStrike().run();
    if (cmd === "heading") chain.toggleHeading({ level: button.dataset.level === "1" ? 1 : 2 }).run();
    if (cmd === "bullet") chain.toggleBulletList().run();
    if (cmd === "ordered") chain.toggleOrderedList().run();
  });
});
