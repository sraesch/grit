import { PointerEvent as ReactPointerEvent, ReactNode, useCallback, useRef, useState } from "react";

interface SplitProps {
  direction: "horizontal" | "vertical";
  /** Initial size of the first pane in pixels. */
  initial: number;
  min?: number;
  /** Persist the size under this localStorage key. */
  storageKey?: string;
  children: [ReactNode, ReactNode];
}

function loadSize(key: string | undefined, fallback: number): number {
  if (!key) return fallback;
  try {
    const v = Number(localStorage.getItem(`split:${key}`));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  } catch {
    return fallback;
  }
}

/** Two panes with a draggable divider. The first pane has a fixed size, the second fills the rest. */
export function Split({ direction, initial, min = 120, storageKey, children }: SplitProps) {
  const [size, setSize] = useState(() => loadSize(storageKey, initial));
  const containerRef = useRef<HTMLDivElement>(null);
  const horizontal = direction === "horizontal";

  const onPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      e.preventDefault();
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const total = horizontal ? rect.width : rect.height;
      let latest = size;

      const onMove = (ev: PointerEvent) => {
        const pos = horizontal ? ev.clientX - rect.left : ev.clientY - rect.top;
        latest = Math.min(Math.max(pos, min), total - min);
        setSize(latest);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        document.body.classList.remove("resizing", `resizing-${direction}`);
        if (storageKey) {
          try {
            localStorage.setItem(`split:${storageKey}`, String(Math.round(latest)));
          } catch {
            /* storage unavailable: size is just not remembered */
          }
        }
      };
      document.body.classList.add("resizing", `resizing-${direction}`);
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [direction, horizontal, min, size, storageKey],
  );

  return (
    <div ref={containerRef} className={`split split-${direction}`}>
      <div className="split-pane" style={{ flex: `0 0 ${size}px` }}>
        {children[0]}
      </div>
      <div className="split-handle" onPointerDown={onPointerDown} />
      <div className="split-pane split-fill">{children[1]}</div>
    </div>
  );
}
