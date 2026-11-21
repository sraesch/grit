import { KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";

export interface MenuItem {
  label: string;
  /** Marks a destructive action. */
  danger?: boolean;
  disabled?: boolean;
  /** Tooltip, e.g. why the item is disabled. */
  title?: string;
  onSelect: () => void;
}

interface ContextMenuProps {
  /** Where the menu was asked for, in viewport coordinates. */
  x: number;
  y: number;
  /** What the menu is about, for screen readers. */
  label: string;
  items: MenuItem[];
  onClose: () => void;
}

/** A menu at the pointer. Closes on a choice, Escape, a click elsewhere, or when the window scrolls, resizes or loses focus. */
export function ContextMenu({ x, y, label, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // Keep the menu inside the window, and start on the first item so the keyboard works right away.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      left: Math.max(4, Math.min(x, window.innerWidth - width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - height - 4)),
    });
    (el.querySelector<HTMLElement>("button:not(:disabled)") ?? el).focus();
  }, [x, y]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const close = () => onClose();
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
      // Unless the choice moved focus elsewhere, e.g. into a dialog.
      if (!document.activeElement || document.activeElement === document.body) previous?.focus?.();
    };
  }, [onClose]);

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const enabled = Array.from(ref.current?.querySelectorAll<HTMLElement>("button:not(:disabled)") ?? []);
      if (enabled.length === 0) return;
      const i = enabled.indexOf(document.activeElement as HTMLElement);
      const step = e.key === "ArrowDown" ? 1 : -1;
      enabled[(i + step + enabled.length) % enabled.length].focus();
    }
  }

  return (
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      aria-label={label}
      tabIndex={-1}
      style={pos}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item) => (
        <button
          key={item.label}
          role="menuitem"
          className={item.danger ? "danger" : undefined}
          disabled={item.disabled}
          title={item.title}
          onClick={() => {
            onClose();
            item.onSelect();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
