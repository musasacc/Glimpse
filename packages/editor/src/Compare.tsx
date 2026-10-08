import { useEffect, useRef, useState, type RefObject } from "react";
import * as L from "./loop-icons";
import { enc, loop, readOnly, useLoop } from "./loop";
import { DEVICE_WIDTH, useStore } from "./store";
import "./loop.css";

/**
 * Before/after slider. Two same-size frames are stacked: "before" (a version)
 * underneath, "after" (the page now, or another version) on top, clipped from
 * the left at the divider, so dragging it wipes from one to the other. Both
 * pages are same-origin, so their scrolling is kept in step.
 */
export function Compare({ before, after }: { before: string; after: string | null }) {
  const state = useStore();
  useLoop();
  const [pos, setPos] = useState(50);
  const stage = useRef<HTMLDivElement>(null);
  const below = useRef<HTMLIFrameElement>(null);
  const above = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && loop.exitCompare();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const b = loop.snapshot(before);
  const a = after ? loop.snapshot(after) : null;
  if (!b) return null;
  const afterLabel = a ? a.label : "Now";

  const drag = (e: React.PointerEvent<HTMLElement>) => {
    e.preventDefault();
    // Capture the pointer so moving over the frames still drags the divider.
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const r = stage.current?.getBoundingClientRect();
      if (r?.width) setPos(clamp(((ev.clientX - r.left) / r.width) * 100));
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    move(e.nativeEvent);
  };

  const onHandleKey = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 10 : 2;
    const next =
      e.key === "ArrowLeft" ? pos - step
      : e.key === "ArrowRight" ? pos + step
      : e.key === "Home" ? 0
      : e.key === "End" ? 100
      : null;
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    setPos(clamp(next));
  };

  const width = DEVICE_WIDTH[state.device];
  return (
    <div className="canvas loop-stage">
      <div className="loop-bar">
        <L.Split size={14} />
        <span className="grow ellipsis">
          Comparing <b>{b.label}</b> with <b>{a ? a.label : "the page now"}</b> · drag the divider
        </span>
        <button className="btn primary" onClick={() => loop.exitCompare()} title="Leave the comparison (Esc)">
          Done <span className="kbd">Esc</span>
        </button>
      </div>
      <div className="frame cmp" ref={stage} style={{ width: width ? `${width}px` : "100%" }}>
        <iframe ref={below} src={`/snapshot/${enc(before)}/`} title={`Before: ${b.label}`} onLoad={() => link(below, above)} />
        <iframe
          ref={above}
          src={a ? `/snapshot/${enc(a.id)}/` : "/preview/"}
          title={`After: ${afterLabel}`}
          style={{ clipPath: `inset(0 0 0 ${pos}%)` }}
          onLoad={() => link(above, below)}
        />
        <span className="cmp-label before" style={{ opacity: pos < 12 ? 0 : 1 }}>
          Before · {b.label}
        </span>
        <span className="cmp-label after" style={{ opacity: pos > 88 ? 0 : 1 }}>
          After · {afterLabel}
        </span>
        <div className="cmp-divider" style={{ left: `${pos}%` }} onPointerDown={drag}>
          <button
            className="cmp-handle"
            role="slider"
            aria-label="Before/after divider"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(pos)}
            onKeyDown={onHandleKey}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m9 7-5 5 5 5M15 7l5 5-5 5" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Wire a freshly loaded frame to its twin: read-only, Esc leaves, and
 * scrolling one scrolls the other. A frame that (re)loads starts where its
 * twin is scrolled to.
 */
function link(self: RefObject<HTMLIFrameElement | null>, twin: RefObject<HTMLIFrameElement | null>): void {
  const win = self.current?.contentWindow;
  if (!win) return;
  readOnly(win.document, () => loop.exitCompare());
  const other = twin.current?.contentWindow;
  if (other && (other.scrollX || other.scrollY)) win.scrollTo(other.scrollX, other.scrollY);
  win.addEventListener(
    "scroll",
    () => {
      const o = twin.current?.contentWindow;
      // Only follow real differences, so the twin's own scroll event doesn't bounce back.
      if (o && (Math.abs(o.scrollX - win.scrollX) > 1 || Math.abs(o.scrollY - win.scrollY) > 1)) o.scrollTo(win.scrollX, win.scrollY);
    },
    { passive: true },
  );
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, n));
}
