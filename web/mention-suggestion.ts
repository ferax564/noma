import { computePosition, flip, offset, shift } from "@floating-ui/dom";
import type { SuggestionOptions, SuggestionProps } from "@tiptap/suggestion";

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export interface MentionPerson {
  id: string;
  name: string;
}

export interface MentionItem {
  id: string;
  label: string;
}

export function mentionSuggestion(people: MentionPerson[]): Omit<SuggestionOptions<MentionItem, MentionItem>, "editor"> {
  return {
    char: "@",
    allowSpaces: false,
    items: ({ query }) => {
      const needle = query.toLowerCase();
      return people
        .filter((person) => person.name.toLowerCase().includes(needle) || person.id.toLowerCase().includes(needle))
        .slice(0, 8)
        .map((person) => ({ id: person.id, label: person.name }));
    },
    render: () => {
      const menu = document.createElement("div");
      menu.className = "ew-mention-suggest";
      menu.hidden = true;
      menu.setAttribute("role", "listbox");
      menu.setAttribute("aria-label", "Mention someone in the page");
      document.body.appendChild(menu);
      let active = 0;
      let current: SuggestionProps<MentionItem, MentionItem> | undefined;

      const hide = (): void => {
        menu.hidden = true;
      };

      const place = (props: SuggestionProps<MentionItem, MentionItem>): void => {
        const rect = props.clientRect?.();
        const reference = props.decorationNode ?? (rect ? { getBoundingClientRect: () => rect } : undefined);
        if (!reference) return;
        void computePosition(reference, menu, {
          strategy: "fixed",
          placement: "bottom-start",
          middleware: [offset(8), flip(), shift({ padding: 8 })],
        }).then(({ x, y }) => {
          menu.style.position = "fixed";
          menu.style.left = `${x}px`;
          menu.style.top = `${y}px`;
        });
      };

      const paint = (props: SuggestionProps<MentionItem, MentionItem>): void => {
        current = props;
        if (!props.items.length) {
          hide();
          return;
        }
        active = Math.max(0, Math.min(active, props.items.length - 1));
        menu.hidden = false;
        menu.innerHTML = props.items
          .map(
            (item, index) =>
              `<button type="button" role="option" class="ew-mention-suggest-item${index === active ? " is-active" : ""}" data-mention-id="${escapeHtml(item.id)}">${escapeHtml(item.label)}</button>`,
          )
          .join("");
        place(props);
      };

      menu.addEventListener("mousedown", (event) => {
        const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-mention-id]");
        if (!button?.dataset.mentionId || !current) return;
        event.preventDefault();
        const item = current.items.find((entry) => entry.id === button.dataset.mentionId);
        if (item) current.command(item);
      });

      return {
        onStart: (props) => {
          active = 0;
          paint(props);
        },
        onUpdate: (props) => paint(props),
        onKeyDown: ({ event }) => {
          if (menu.hidden || !current?.items.length) return false;
          if (event.key === "ArrowDown") {
            event.preventDefault();
            active = (active + 1) % current.items.length;
            paint(current);
            return true;
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            active = (active - 1 + current.items.length) % current.items.length;
            paint(current);
            return true;
          }
          if (event.key === "Enter") {
            const item = current.items[active];
            if (item) {
              event.preventDefault();
              current.command(item);
              return true;
            }
          }
          if (event.key === "Escape") {
            event.preventDefault();
            hide();
            return true;
          }
          return false;
        },
        onExit: () => {
          hide();
          menu.replaceChildren();
        },
      };
    },
  };
}
