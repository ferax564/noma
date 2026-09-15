import { Node, mergeAttributes } from "@tiptap/core";

export type PanelKind = "info" | "note" | "warning" | "success" | "claim" | "decision";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    nomaPanel: {
      setNomaPanel: (kind: PanelKind) => ReturnType;
    };
  }
}

const TITLES: Record<PanelKind, string> = {
  info: "Info",
  note: "Note",
  warning: "Warning",
  success: "Success",
  claim: "Claim",
  decision: "Decision",
};

export const NomaPanel = Node.create({
  name: "nomaPanel",
  group: "block",
  content: "block+",
  defining: true,
  addAttributes() {
    return {
      kind: {
        default: "info",
        parseHTML: (element) => element.getAttribute("data-noma-panel") || "info",
        renderHTML: (attributes) => ({ "data-noma-panel": attributes.kind ?? "info" }),
      },
    };
  },
  parseHTML() {
    return [{ tag: "div[data-noma-panel]" }];
  },
  renderHTML({ HTMLAttributes }) {
    const kind = String(HTMLAttributes["data-noma-panel"] ?? HTMLAttributes.kind ?? "info");
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        class: `ew-panel ew-panel-${kind}`,
        "data-panel-title": TITLES[kind as PanelKind] ?? kind,
      }),
      0,
    ];
  },
  addCommands() {
    return {
      setNomaPanel:
        (kind: PanelKind) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: { kind },
            content: [{ type: "paragraph" }],
          }),
    };
  },
});
