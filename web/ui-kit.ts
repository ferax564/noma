import { autoUpdate, computePosition, flip, offset, shift, size } from "@floating-ui/dom";
import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import { draggable, dropTargetForElements, monitorForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import {
  Bell,
  Bold,
  FileText,
  Heading1,
  Heading2,
  Image,
  Import,
  Italic,
  List,
  ListOrdered,
  Moon,
  Plus,
  Presentation,
  Search,
  Settings,
  SquareKanban,
  Strikethrough,
  Sun,
  Video,
  createElement,
  createIcons,
  type IconNode,
} from "lucide";

const ICONS = {
  Bell,
  Bold,
  FileText,
  Heading1,
  Heading2,
  Image,
  Import,
  Italic,
  List,
  ListOrdered,
  Moon,
  Plus,
  Presentation,
  Search,
  Settings,
  SquareKanban,
  Strikethrough,
  Sun,
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
            floating.style.maxWidth = `${Math.max(280, availableWidth)}px`;
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

export function bindIssueBoard(board: HTMLElement, onDrop: (drop: BoardDrop) => void): () => void {
  const cleanups: Array<() => void> = [];
  for (const card of board.querySelectorAll<HTMLButtonElement>(".ew-card")) {
    const issueId = card.dataset.issue ?? "";
    cleanups.push(
      draggable({
        element: card,
        getInitialData: () => ({ type: "issue-card", issueId }),
        onDragStart: () => card.classList.add("is-dragging"),
        onDrop: () => card.classList.remove("is-dragging"),
      }),
      dropTargetForElements({
        element: card,
        getData: () => ({ type: "issue-card", issueId }),
        canDrop: ({ source }) => source.data.type === "issue-card" && source.data.issueId !== issueId,
      }),
    );
  }
  for (const column of board.querySelectorAll<HTMLElement>(".ew-column")) {
    const statusId = column.dataset.status ?? "";
    cleanups.push(
      dropTargetForElements({
        element: column,
        getData: () => ({ type: "column", statusId }),
        canDrop: ({ source }) => source.data.type === "issue-card",
        onDragEnter: () => column.classList.add("is-drop"),
        onDragLeave: () => column.classList.remove("is-drop"),
        onDrop: () => column.classList.remove("is-drop"),
      }),
    );
  }
  cleanups.push(
    monitorForElements({
      canMonitor: ({ source }) => source.data.type === "issue-card",
      onDrop: ({ source, location }) => {
        const issueId = String(source.data.issueId ?? "");
        const column = location.current.dropTargets.find((target) => target.data.type === "column");
        const card = location.current.dropTargets.find((target) => target.data.type === "issue-card");
        if (!issueId || !column) return;
        onDrop({
          issueId,
          beforeId: String(card?.data.issueId ?? ""),
          statusId: String(column.data.statusId ?? ""),
        });
      },
    }),
  );
  return combine(...cleanups);
}
