import { useEffect, useRef, useState } from "react";
import { describeNode, type Op } from "@glimpse/core";
import { DEVICE_WIDTH, store, useStore } from "./store";
import { TalkPopover } from "./Talk";

export type Mode = "edit" | "interact";

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The preview iframe plus the editing overlay. The page is same-origin, so the
 * editor reads and edits its DOM directly; every edit is recorded as an op.
 */
export function Canvas({ mode, talkOpen, setTalkOpen }: { mode: Mode; talkOpen: boolean; setTalkOpen: (v: boolean) => void }) {
  const state = useStore();
  const iframe = useRef<HTMLIFrameElement>(null);
  const [, setTick] = useState(0);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  // Re-render the overlay when the page scrolls or resizes.
  const rerender = () => setTick((t) => t + 1);

  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      if (ev.data?.glimpse === "morphed") {
        store.pageChanged();
        rerender();
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const onLoad = () => {
    const doc = iframe.current?.contentDocument;
    if (!doc) return;
    store.attach(doc);
    installPageHandlers(doc, () => modeRef.current, () => setTalkOpen(true), rerender);
    rerender();
  };

  const width = DEVICE_WIDTH[state.device];
  const doc = iframe.current?.contentDocument;
  const rectOf = (id: string | null): Rect | null => {
    if (!id || !store.bridge || !doc) return null;
    const el = store.bridge.el(id);
    if (!el || !el.isConnected) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  };

  const selected = state.selected ? store.scene?.nodes[state.selected] : undefined;
  const selRect = rectOf(state.selected);
  const hovRect = state.hovered !== state.selected ? rectOf(state.hovered) : null;
  const pins = (store.log?.ops ?? []).filter((o): o is Extract<Op, { op: "comment" }> => o.op === "comment");

  if (!state.entryExists) {
    return (
      <div className="canvas">
        <div className="waiting">
          <div className="waiting-eye">
            <svg viewBox="0 0 64 64" aria-hidden="true">
              <path d="M5 32C14 16 50 16 59 32C50 48 14 48 5 32Z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
              <circle cx="35" cy="31" r="8" fill="currentColor" />
            </svg>
          </div>
          <h3>{state.agentWaiting ? "Your agent is listening" : "Waiting for your agent to build something"}</h3>
          <p>
            As soon as it saves <code>{state.project?.entry ?? "index.html"}</code>, the page appears here live.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="canvas">
      {state.stale && (
        <div className="banner">
          Some edits could not be replayed after the AI changed the page.
          <button className="btn" onClick={() => store.set({ stale: false })}>
            OK
          </button>
        </div>
      )}
      <div className="frame" style={{ width: width ? `${width}px` : "100%" }}>
        <iframe key={state.reloadKey} ref={iframe} src="/preview/" title="Preview" onLoad={onLoad} />
        {mode === "edit" && (
          <div className="overlay">
            {hovRect && <div className="box hover" style={rectStyle(hovRect)} />}
            {selRect && selected && (
              <div className="box selected" style={rectStyle(selRect)}>
                <span className="label">{describeNode(selected)}</span>
                <ResizeHandle id={selected.id} />
              </div>
            )}
            {pins.map((p, i) => {
              const r = rectOf(p.node);
              return r ? (
                <div key={p.id} className="badge" title={p.text} style={{ left: r.left + r.width, top: r.top }}>
                  {i + 1}
                </div>
              ) : null;
            })}
            {talkOpen && selRect && selected && (
              <TalkPopover node={selected.id} anchor={selRect} onClose={() => setTalkOpen(false)} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function rectStyle(r: Rect) {
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

/** Drag the corner handle to resize the selected element. */
function ResizeHandle({ id }: { id: string }) {
  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const node = store.scene?.nodes[id];
    const el = store.bridge?.el(id) as HTMLElement | undefined;
    if (!node || !el) return;
    const from = { ...node.layout };
    const start = { x: e.clientX, y: e.clientY };
    const prev = { width: el.style.width, height: el.style.height };
    // Capture the pointer so moves over the iframe still reach this handle.
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      el.style.width = `${Math.max(4, from.w + ev.clientX - start.x)}px`;
      el.style.height = `${Math.max(4, from.h + ev.clientY - start.y)}px`;
      store.set({});
    };
    const up = (ev: PointerEvent) => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      el.style.width = prev.width;
      el.style.height = prev.height;
      const to = { ...from, w: Math.max(4, Math.round(from.w + ev.clientX - start.x)), h: Math.max(4, Math.round(from.h + ev.clientY - start.y)) };
      if (to.w !== from.w || to.h !== from.h) store.edit({ op: "resize", node: id, from, to });
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  };
  return <span className="handle" onPointerDown={onPointerDown} />;
}

/** Mouse and keyboard handling inside the previewed page. */
function installPageHandlers(doc: Document, mode: () => Mode, openTalk: () => void, rerender: () => void): void {
  const win = doc.defaultView!;
  let drag: { id: string; start: { x: number; y: number }; from: { x: number; y: number }; moved: boolean } | null = null;

  doc.addEventListener("mousemove", (e) => {
    if (mode() !== "edit") return;
    if (drag) {
      const dx = e.clientX - drag.start.x;
      const dy = e.clientY - drag.start.y;
      if (!drag.moved && Math.hypot(dx, dy) < 3) return;
      drag.moved = true;
      store.bridge?.previewMove(drag.id, { x: Math.round(drag.from.x + dx), y: Math.round(drag.from.y + dy) });
      rerender();
      return;
    }
    const id = store.bridge?.pick(e.target) ?? null;
    if (id !== store.state.hovered) store.set({ hovered: id });
  });

  doc.addEventListener("mouseleave", () => store.set({ hovered: null }));

  doc.addEventListener(
    "mousedown",
    (e) => {
      if (mode() !== "edit" || e.button !== 0) return;
      if ((e.target as HTMLElement).isContentEditable) return;
      const id = store.bridge?.pick(e.target);
      e.preventDefault();
      store.set({ selected: id ?? null });
      const node = id ? store.scene?.nodes[id] : undefined;
      if (node && !node.locked) {
        drag = { id: node.id, start: { x: e.clientX, y: e.clientY }, from: { x: node.layout.x, y: node.layout.y }, moved: false };
      }
    },
    true,
  );

  doc.addEventListener("mouseup", (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (!d.moved) return;
    const to = { x: Math.round(d.from.x + e.clientX - d.start.x), y: Math.round(d.from.y + e.clientY - d.start.y) };
    store.edit({ op: "move", node: d.id, from: d.from, to });
  });

  // In edit mode the page should not react to clicks (links, buttons, forms).
  for (const type of ["click", "submit", "auxclick"]) {
    doc.addEventListener(
      type,
      (e) => {
        if (mode() === "edit" && !(e.target as HTMLElement).isContentEditable) {
          e.preventDefault();
          e.stopPropagation();
        }
      },
      true,
    );
  }

  doc.addEventListener("dblclick", (e) => {
    if (mode() !== "edit") return;
    const id = store.bridge?.pick(e.target);
    if (id) editText(id);
  });

  doc.addEventListener("keydown", (e) => handleKey(e, openTalk), true);
  win.addEventListener("scroll", rerender, { passive: true });
  win.addEventListener("resize", rerender);
}

/** Inline text editing: the element becomes contentEditable until Enter/blur. */
export function editText(id: string): void {
  const el = store.bridge?.el(id) as HTMLElement | undefined;
  const node = store.scene?.nodes[id];
  if (!el || !node || node.children.length > 0) return;
  const from = node.props.text ?? "";
  el.contentEditable = "true";
  el.focus();
  const range = el.ownerDocument.createRange();
  range.selectNodeContents(el);
  const sel = el.ownerDocument.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  const finish = (commit: boolean) => {
    el.removeEventListener("blur", onBlur);
    el.removeEventListener("keydown", onKey);
    el.contentEditable = "false";
    el.removeAttribute("contenteditable");
    const to = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    el.textContent = from; // restore, then let the op apply the change (keeps undo exact)
    if (commit && to !== from) store.edit({ op: "setText", node: id, from, to });
  };
  const onBlur = () => finish(true);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      el.blur();
    } else if (e.key === "Escape") {
      el.removeEventListener("blur", onBlur);
      finish(false);
    } else if (e.key === " ") {
      // Space on a contentEditable <button> "clicks" it instead of typing.
      e.preventDefault();
      el.ownerDocument.execCommand("insertText", false, " ");
    }
    e.stopPropagation();
  };
  el.addEventListener("blur", onBlur);
  el.addEventListener("keydown", onKey);
}

/** Editor shortcuts; installed on both the editor window and the page. */
export function handleKey(e: KeyboardEvent, openTalk: () => void): void {
  const t = e.target as HTMLElement;
  if (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName)) return;
  const mod = e.metaKey || e.ctrlKey;
  const id = store.state.selected;
  if (mod && e.key.toLowerCase() === "z") {
    e.preventDefault();
    if (e.shiftKey) store.redo();
    else store.undo();
  } else if (mod && e.key.toLowerCase() === "y") {
    e.preventDefault();
    store.redo();
  } else if (mod && e.key.toLowerCase() === "d") {
    e.preventDefault();
    store.duplicateSelected();
  } else if (!mod && (e.key === "Delete" || e.key === "Backspace") && id) {
    e.preventDefault();
    store.deleteSelected();
  } else if (!mod && e.key.toLowerCase() === "t" && id) {
    e.preventDefault();
    openTalk();
  } else if (e.key === "Escape") {
    store.set({ selected: null });
  } else if (id && e.key.startsWith("Arrow")) {
    const node = store.scene?.nodes[id];
    if (!node || node.locked) return;
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
    const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
    const from = { x: node.layout.x, y: node.layout.y };
    store.edit({ op: "move", node: id, from, to: { x: from.x + dx, y: from.y + dy } });
  }
}
