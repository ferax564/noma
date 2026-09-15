import { autoUpdate, computePosition, flip, offset, shift, size } from "@floating-ui/dom";
import {
  AlertTriangle,
  Bell,
  Bold,
  Bug,
  ChevronDown,
  CircleCheck,
  Code,
  Command,
  FileText,
  Filter,
  Hand,
  Heading1,
  Heading2,
  Highlighter,
  Image,
  Import,
  Info,
  Italic,
  Lightbulb,
  Link,
  List,
  ListChecks,
  ListOrdered,
  Maximize2,
  Moon,
  MousePointer2,
  Plus,
  Presentation,
  Quote,
  Search,
  Settings,
  SquareKanban,
  StickyNote,
  Strikethrough,
  Sun,
  Table,
  Underline,
  User,
  Video,
  ZoomIn,
  ZoomOut,
  createElement,
  createIcons,
  type IconNode,
} from "lucide";
import { statusPath } from "./status-path";

const ICONS = {
  AlertTriangle,
  Bell,
  Bold,
  Bug,
  ChevronDown,
  CircleCheck,
  Code,
  Command,
  FileText,
  Filter,
  Hand,
  Heading1,
  Heading2,
  Highlighter,
  Image,
  Import,
  Info,
  Italic,
  Lightbulb,
  Link,
  List,
  ListChecks,
  ListOrdered,
  Maximize2,
  Moon,
  MousePointer2,
  Plus,
  Presentation,
  Quote,
  Search,
  Settings,
  SquareKanban,
  StickyNote,
  Strikethrough,
  Sun,
  Table,
  Underline,
  User,
  Video,
  ZoomIn,
  ZoomOut,
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
            floating.style.width = `${Math.max(rects.reference.width, 220)}px`;
            floating.style.maxWidth = `${Math.min(640, Math.max(220, availableWidth))}px`;
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
  let dragging = false;

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest(".ew-column-add")) return;
    const card = target.closest<HTMLElement>(".ew-card");
    if (!card || !board.contains(card)) return;
    const issueId = card.dataset.issue ?? "";
    if (!issueId) return;
    const origin = card.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    let ghost: HTMLElement | undefined;
    dragging = false;

    const highlight = (clientX: number, clientY: number): HTMLElement | undefined => {
      for (const column of board.querySelectorAll(".ew-column")) column.classList.remove("is-drop");
      const hit = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>(".ew-column");
      hit?.classList.add("is-drop");
      return hit ?? undefined;
    };

    const onMove = (move: PointerEvent): void => {
      const dx = move.clientX - startX;
      const dy = move.clientY - startY;
      if (!dragging && dx * dx + dy * dy < 36) return;
      if (!dragging) {
        dragging = true;
        board.classList.add("is-sorting");
        card.classList.add("is-dragging");
        ghost = card.cloneNode(true) as HTMLElement;
        ghost.classList.add("ew-drag-ghost");
        ghost.setAttribute("aria-hidden", "true");
        ghost.style.width = `${origin.width}px`;
        document.body.appendChild(ghost);
      }
      if (ghost) {
        ghost.style.left = `${move.clientX - 16}px`;
        ghost.style.top = `${move.clientY - 12}px`;
      }
      highlight(move.clientX, move.clientY);
    };

    const onUp = (up: PointerEvent): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      ghost?.remove();
      card.classList.remove("is-dragging");
      const column = highlight(up.clientX, up.clientY);
      for (const node of board.querySelectorAll(".ew-column")) node.classList.remove("is-drop");
      board.classList.remove("is-sorting");
      if (!dragging || !column) return;
      let beforeId = "";
      for (const other of column.querySelectorAll<HTMLElement>(".ew-card")) {
        if (other === card) continue;
        const box = other.getBoundingClientRect();
        if (up.clientY < box.top + box.height / 2) {
          beforeId = other.dataset.issue ?? "";
          break;
        }
      }
      onDrop({ issueId, beforeId, statusId: column.dataset.status ?? "" });
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  board.addEventListener("pointerdown", onPointerDown);
  const onClick = (event: MouseEvent): void => {
    if (!dragging) return;
    event.preventDefault();
    event.stopPropagation();
    dragging = false;
  };
  board.addEventListener("click", onClick, true);
  return () => {
    board.removeEventListener("pointerdown", onPointerDown);
    board.removeEventListener("click", onClick, true);
  };
}

export interface VisualMove {
  id: string;
  x: number;
  y: number;
}

export interface VisualStageHandlers {
  onMove: (move: VisualMove) => void;
  onEdit?: (id: string, text: string) => void;
  onPlaceSticky?: (x: number, y: number) => void;
}

function pageScale(page: HTMLElement): number {
  const match = /scale\(([-0-9.]+)\)/.exec(page.style.transform);
  return match ? Number(match[1]) : 1;
}

export function setCanvasZoom(stage: HTMLElement, zoom: number): void {
  const page = stage.querySelector<HTMLElement>(".pd-page");
  if (!page) return;
  const next = Math.min(2.5, Math.max(0.35, zoom));
  stage.dataset.zoom = String(next);
  page.style.transform = `scale(${next})`;
  page.style.transformOrigin = "top left";
  const label = document.getElementById("zoom-label");
  if (label) label.textContent = `${Math.round(next * 100)}%`;
}

export function bindVisualStage(stage: HTMLElement, handlers: VisualStageHandlers): () => void {
  let dragging = false;

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("video, input, textarea, button, a, select")) return;
    const page = stage.querySelector<HTMLElement>(".pd-page");
    if (!page) return;
    const tool = stage.dataset.tool ?? "select";
    const scale = pageScale(page);

    if (tool === "sticky") {
      const box = page.getBoundingClientRect();
      handlers.onPlaceSticky?.((event.clientX - box.left) / scale, (event.clientY - box.top) / scale);
      return;
    }

    if (tool === "pan") {
      dragging = true;
      const startX = event.clientX;
      const startY = event.clientY;
      const originLeft = stage.scrollLeft;
      const originTop = stage.scrollTop;
      const onMove = (move: PointerEvent): void => {
        stage.scrollLeft = originLeft - (move.clientX - startX);
        stage.scrollTop = originTop - (move.clientY - startY);
      };
      const onUp = (): void => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        dragging = false;
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      return;
    }

    const card = target.closest<HTMLElement>(".pd-el");
    if (!card || card.classList.contains("pd-el-arrow") || !stage.contains(card)) return;
    const id = card.dataset.id ?? "";
    if (!id) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const originLeft = Number.parseFloat(card.style.left) || 0;
    const originTop = Number.parseFloat(card.style.top) || 0;
    dragging = false;

    const onMove = (move: PointerEvent): void => {
      const dx = move.clientX - startX;
      const dy = move.clientY - startY;
      if (!dragging && dx * dx + dy * dy < 36) return;
      dragging = true;
      card.classList.add("is-dragging");
      card.style.left = `${originLeft + dx / scale}px`;
      card.style.top = `${originTop + dy / scale}px`;
    };
    const onUp = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      card.classList.remove("is-dragging");
      if (!dragging) return;
      handlers.onMove({
        id,
        x: Number.parseFloat(card.style.left) || originLeft,
        y: Number.parseFloat(card.style.top) || originTop,
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const onDblClick = (event: MouseEvent): void => {
    const card = (event.target as HTMLElement).closest<HTMLElement>(".pd-el");
    if (!card || card.classList.contains("pd-el-arrow")) return;
    const label = card.querySelector<HTMLElement>(".pd-el-text");
    if (!label) return;
    label.contentEditable = "true";
    label.focus();
    const finish = (): void => {
      label.contentEditable = "false";
      label.removeEventListener("blur", finish);
      handlers.onEdit?.(card.dataset.id ?? "", label.textContent ?? "");
    };
    label.addEventListener("blur", finish);
  };

  const onWheel = (event: WheelEvent): void => {
    if (!event.ctrlKey && !event.metaKey) return;
    const page = stage.querySelector<HTMLElement>(".pd-page");
    if (!page) return;
    event.preventDefault();
    const current = Number(stage.dataset.zoom ?? String(pageScale(page)));
    setCanvasZoom(stage, current + (event.deltaY < 0 ? 0.08 : -0.08));
  };

  const onClick = (event: MouseEvent): void => {
    if (!dragging) return;
    event.preventDefault();
    event.stopPropagation();
    dragging = false;
  };

  stage.addEventListener("pointerdown", onPointerDown);
  stage.addEventListener("dblclick", onDblClick);
  stage.addEventListener("wheel", onWheel, { passive: false });
  stage.addEventListener("click", onClick, true);
  return () => {
    stage.removeEventListener("pointerdown", onPointerDown);
    stage.removeEventListener("dblclick", onDblClick);
    stage.removeEventListener("wheel", onWheel);
    stage.removeEventListener("click", onClick, true);
  };
}

export function enhanceSelects(root: ParentNode): void {
  for (const select of root.querySelectorAll<HTMLSelectElement>("select")) {
    if (select.closest(".ew-select")) continue;
    const wrap = document.createElement("div");
    wrap.className = "ew-select";
    select.parentNode?.insertBefore(wrap, select);
    wrap.append(select);
    select.classList.add("ew-select-native");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ew-select-btn";
    button.setAttribute("aria-haspopup", "listbox");
    button.setAttribute("aria-expanded", "false");
    if (select.id) button.setAttribute("aria-controls", `${select.id}-menu`);
    const chevron = iconSvg("ChevronDown");
    const label = (): string => select.options[select.selectedIndex]?.text ?? "Select";
    const sync = (): void => {
      button.innerHTML = `<span>${label()}</span>${chevron}`;
    };
    sync();
    const menu = document.createElement("div");
    menu.className = "ew-select-menu";
    menu.hidden = true;
    menu.setAttribute("role", "listbox");
    if (select.id) menu.id = `${select.id}-menu`;
    wrap.append(button, menu);
    let stop: (() => void) | undefined;
    const close = (): void => {
      menu.hidden = true;
      button.setAttribute("aria-expanded", "false");
      stop?.();
      stop = undefined;
    };
    const open = (): void => {
      menu.innerHTML = [...select.options]
        .map(
          (option) =>
            `<button type="button" role="option" class="ew-select-option${option.selected ? " is-active" : ""}" data-value="${option.value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")}">${(option.textContent ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")}</button>`,
        )
        .join("");
      menu.hidden = false;
      button.setAttribute("aria-expanded", "true");
      stop = positionPopup(button, menu);
    };
    button.addEventListener("click", () => (menu.hidden ? open() : close()));
    menu.addEventListener("click", (event) => {
      const option = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-value]");
      if (!option) return;
      select.value = option.dataset.value ?? "";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      sync();
      close();
    });
    document.addEventListener("pointerdown", (event) => {
      if (!wrap.isConnected) return;
      if (!wrap.contains(event.target as Node)) close();
    });
  }
}

export function bindMentionBox(
  input: HTMLTextAreaElement,
  people: Array<{ id: string; name: string }>,
  onPick?: (name: string) => void,
): () => void {
  const menu = document.createElement("div");
  menu.className = "ew-mention";
  menu.hidden = true;
  menu.setAttribute("role", "listbox");
  menu.setAttribute("aria-label", "Mention someone");
  document.body.append(menu);
  let stop: (() => void) | undefined;
  const close = (): void => {
    menu.hidden = true;
    stop?.();
    stop = undefined;
  };
  const onInput = (): void => {
    const match = input.value.slice(0, input.selectionStart ?? 0).match(/@([a-zA-Z][\w.-]*)$/);
    if (!match) {
      close();
      return;
    }
    const needle = (match[1] ?? "").toLowerCase();
    const hits = people.filter((person) => person.name.toLowerCase().includes(needle)).slice(0, 6);
    if (!hits.length) {
      close();
      return;
    }
    menu.hidden = false;
    menu.innerHTML = hits
      .map((person) => `<button type="button" role="option" data-name="${person.name}">${person.name}</button>`)
      .join("");
    stop?.();
    stop = positionPopup(input, menu);
  };
  menu.addEventListener("mousedown", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-name]");
    if (!button?.dataset.name) return;
    event.preventDefault();
    const start = input.value.slice(0, input.selectionStart ?? 0).replace(/@([a-zA-Z][\w.-]*)$/, `@${button.dataset.name} `);
    input.value = `${start}${input.value.slice(input.selectionStart ?? 0)}`;
    close();
    onPick?.(button.dataset.name);
    input.focus();
  });
  input.addEventListener("input", onInput);
  input.addEventListener("blur", () => window.setTimeout(close, 120));
  return () => {
    input.removeEventListener("input", onInput);
    menu.remove();
  };
}
