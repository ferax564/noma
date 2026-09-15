import { autoUpdate, computePosition, flip, offset, shift, size } from "@floating-ui/dom";
import {
  Bell,
  Bold,
  Bug,
  Code,
  Command,
  FileText,
  Filter,
  Heading1,
  Heading2,
  Image,
  Import,
  Italic,
  Link,
  List,
  ListOrdered,
  Moon,
  Plus,
  Presentation,
  Quote,
  Search,
  Settings,
  SquareKanban,
  Strikethrough,
  Sun,
  Underline,
  User,
  Video,
  createElement,
  createIcons,
  type IconNode,
} from "lucide";
import Sortable from "sortablejs";
import { statusPath } from "./status-path";

const ICONS = {
  Bell,
  Bold,
  Bug,
  Code,
  Command,
  FileText,
  Filter,
  Heading1,
  Heading2,
  Image,
  Import,
  Italic,
  Link,
  List,
  ListOrdered,
  Moon,
  Plus,
  Presentation,
  Quote,
  Search,
  Settings,
  SquareKanban,
  Strikethrough,
  Sun,
  Underline,
  User,
  Video,
} as const;

export type IconName = keyof typeof ICONS;

const ICON_ATTRS = {
  width: 16,
  height: 16,
  "stroke-width": 2,
  class: "ew-icon",
  "aria-hidden": "true",
};

export function iconSvg(name: IconName, size = 16): string {
  const icon: IconNode = ICONS[name];
  return createElement(icon, { ...ICON_ATTRS, width: size, height: size }).outerHTML;
}

export function hydrateIcons(root: Element | Document = document): void {
  createIcons({
    icons: ICONS,
    attrs: ICON_ATTRS,
    root,
  });
}

export function positionPopup(anchor: Element, floating: HTMLElement): () => void {
  floating.style.position = "absolute";
  floating.style.transform = "none";
  return autoUpdate(anchor, floating, () => {
    void computePosition(anchor, floating, {
      placement: "bottom-start",
      middleware: [
        offset(6),
        flip(),
        shift({ padding: 8 }),
        size({
          apply({ rects, availableWidth }) {
            floating.style.width = `${Math.max(rects.reference.width, 320)}px`;
            floating.style.maxWidth = `${Math.min(640, Math.max(280, availableWidth))}px`;
          },
        }),
      ],
    }).then(({ x, y }) => {
      floating.style.left = `${x}px`;
      floating.style.top = `${y}px`;
    });
  });
}

export interface BoardDrop {
  issueId: string;
  beforeId: string;
  statusId: string;
}

export { statusPath };

export function bindIssueBoard(board: HTMLElement, onDrop: (drop: BoardDrop) => void): () => void {
  const sortables: Sortable[] = [];
  for (const list of board.querySelectorAll<HTMLElement>(".ew-column-list")) {
    const column = list.closest<HTMLElement>(".ew-column");
    sortables.push(
      new Sortable(list, {
        group: "noma-issues",
        animation: 160,
        ghostClass: "is-ghost",
        chosenClass: "is-chosen",
        dragClass: "is-dragging",
        draggable: ".ew-card",
        filter: ".ew-column-add",
        fallbackTolerance: 3,
        onStart: () => board.classList.add("is-sorting"),
        onEnd: (event) => {
          board.classList.remove("is-sorting");
          const card = event.item;
          const issueId = card.dataset.issue ?? "";
          const target = event.to.closest<HTMLElement>(".ew-column");
          const sibling = card.nextElementSibling;
          const beforeId = sibling instanceof HTMLElement && sibling.classList.contains("ew-card") ? (sibling.dataset.issue ?? "") : "";
          card.classList.remove("is-dragging", "is-ghost", "is-chosen");
          queueMicrotask(() => {
            for (const leftover of document.querySelectorAll(".sortable-fallback, .sortable-drag")) {
              if (leftover !== card) leftover.remove();
            }
          });
          if (!issueId || !target) return;
          if (event.from === event.to && event.oldIndex === event.newIndex) return;
          onDrop({
            issueId,
            beforeId,
            statusId: target.dataset.status ?? column?.dataset.status ?? "",
          });
        },
      }),
    );
  }
  return () => {
    for (const sortable of sortables) sortable.destroy();
  };
}
