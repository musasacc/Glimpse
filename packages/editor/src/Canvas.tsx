import { useEffect, useRef, useState } from "react";
import { describeNode, topLevel, type Layout, type Op } from "@glimpse/core";
import { DEVICE_WIDTH, store, useHovered, useStore } from "./store";
import { TalkPopover } from "./Talk";
import { groupSelection, marqueeHits, nudgeSelection, regionRect, regionTarget, ungroupSelection, type Rect } from "./arrange";
import { loop, useLoopLive } from "./loop";
import { watchUpdates, whenRendered } from "./hmr";
import { cssSize } from "./dom";
import { PreviewError } from "./PreviewError";
import { modalOpen } from "./Modal";
import { isEnter } from "./platform";
import "./editing.css";

export type Mode = "edit" | "interact";

/** What the overlay draws while a gesture is in progress (written by the page handlers). */
interface Live {
  marquee: Rect | null;
  region: Rect | null;
}

/** A box prompt that has been drawn and is waiting for its instruction. */
type Draft = { parent: string; rect: Layout };

/** Lets editor shortcuts reach the canvas: Escape cancels what is in progress. */
const canvas = { cancel: () => {} };

/**
 * The preview iframe plus the editing overlay. The page is same-origin, so the
 * editor reads and edits its DOM directly; every edit is recorded as an op.
 */
export function Canvas({ mode, talkOpen, setTalkOpen }: { mode: Mode; talkOpen: boolean; setTalkOpen: (v: boolean) => void }) {
  const state = useStore();
  const hovered = useHovered();
  // A version, comparison or variants may cover the page; its notices belong to the page.
  const pageShown = useLoopLive();
  const iframe = useRef<HTMLIFrameElement>(null);
  const [, setTick] = useState(0);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const live = useRef<Live>({ marquee: null, region: null }).current;
  const cancelGesture = useRef(() => {});
  const [draft, setDraft] = useState<Draft | null>(null);
  /** The React app crashed while rendering and left a blank page: why, until it renders again. */
  const [crash, setCrash] = useState<string | null>(null);

  // Re-render the overlay when the page scrolls or resizes, at most once per frame.
  const frame = useRef(0);
  const rerender = () => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      setTick((t) => t + 1);
    });
  };
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  useEffect(() => {
    canvas.cancel = () => {
      cancelGesture.current();
      setDraft(null);
    };
  }, []);

  // A React app runs with the edits off its DOM (see Store.interact).
  useEffect(() => store.interact(mode === "interact"), [mode]);

  // Tools and half-done gestures belong to edit mode.
  useEffect(() => {
    if (mode === "edit") return;
    canvas.cancel();
    store.setTool("select");
  }, [mode]);

  // Crosshair over the page while the box prompt tool is on (onLoad covers a fresh page).
  const crosshair = mode === "edit" && state.tool === "region";
  useEffect(() => {
    const doc = iframe.current?.contentDocument;
    if (doc) setPageCursor(doc, crosshair ? "crosshair" : null);
  }, [crosshair]);

  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      // Only our own page (compare and variant frames run the live client too), once attached to it.
      if (ev.source !== iframe.current?.contentWindow) return;
      if (ev.data?.glimpse === "error") setCrash(ev.data.blank ? String(ev.data.message ?? "") : null);
      // The edits were already replayed (glimpse:after-morph, or after-update for React).
      if (ev.data?.glimpse === "morphed" && store.bridge?.doc === iframe.current?.contentDocument) {
        // The update after a crash still leaves it blank; one that renders the app again ends it.
        if (hasContent(store.bridge.doc)) setCrash(null);
        rerender();
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const onLoad = () => {
    setCrash(null);
    const doc = iframe.current?.contentDocument;
    if (!doc) return;
    // A React page renders after the load event: start once its first render has settled (if it's still the page).
    whenRendered(doc, () => iframe.current?.contentDocument === doc && attachPage(doc));
  };

  const attachPage = (doc: Document) => {
    store.attach(doc);
    // The AI saved the page and the live client morphs it in place (only our own page:
    // compare and variant frames run the client too). The edits come off around it.
    doc.defaultView?.addEventListener("glimpse:before-morph", () => store.bridge?.doc === doc && store.beforeMorph());
    doc.defaultView?.addEventListener("glimpse:after-morph", () => {
      if (store.bridge?.doc !== doc) return;
      store.pageChanged();
      rerender();
    });
    if (modeRef.current === "interact") store.interact(true);
    setDraft(null);
    cancelGesture.current = installPageHandlers(doc, {
      mode: () => modeRef.current,
      openTalk: () => setTalkOpen(true),
      rerender,
      live,
      onPress: () => setDraft(null),
      onRegion: (rect) => setDraft(regionTarget(rect)),
    });
    // React pages: our edits come off right before each HMR update and go back on once it has settled.
    watchUpdates(doc, {
      before: () => store.bridge?.doc === doc && store.beforeUpdate(),
      after: () => {
        if (store.bridge?.doc !== doc) return;
        store.pageChanged();
        rerender();
      },
    });
    setPageCursor(doc, modeRef.current === "edit" && store.state.tool === "region" ? "crosshair" : null);
    rerender();
  };

  const width = DEVICE_WIDTH[state.device];
  const rectOf = (id: string | null): Rect | null => {
    const r = id ? store.bridge?.rect(id) : null;
    return r ? { left: r.left, top: r.top, width: r.width, height: r.height } : null;
  };

  const selected = state.selected ? store.scene?.nodes[state.selected] : undefined;
  const selRect = rectOf(state.selected);
  const multi = store.selection;
  const single = multi.length <= 1;
  const hovRect = state.tool === "select" && hovered && !multi.includes(hovered) ? rectOf(hovered) : null;
  const ops = store.log?.ops ?? [];
  const pins = ops.filter((o): o is Extract<Op, { op: "comment" }> => o.op === "comment");
  const regions = ops.filter((o): o is Extract<Op, { op: "region" }> => o.op === "region");
  const draftRect = draft ? regionRect({ op: "region", id: "draft", text: "", ...draft }) : null;

  if (state.previewError) {
    return (
      <div className="canvas">
        <PreviewError />
      </div>
    );
  }

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
      {state.stale && pageShown && (
        <div className="banner">
          Some edits could not be replayed after the AI changed the page.
          <button className="btn" onClick={() => store.set({ stale: false })}>
            OK
          </button>
        </div>
      )}
      {crash !== null && (
        <div className="banner" role="alert" style={{ maxWidth: "min(720px, calc(100% - 32px))" }}>
          <span className="ellipsis" title={crash}>
            The app crashed while rendering{crash ? `: ${crash}` : ""}. The full error is in the preview's console; the page comes back once the code is fixed.
          </span>
          <button className="btn" onClick={() => setCrash(null)}>
            OK
          </button>
        </div>
      )}
      <div className="frame" style={{ width: width ? `${width}px` : "100%" }}>
        <iframe key={state.reloadKey} ref={iframe} src="/preview/" title="Preview" onLoad={onLoad} />
        {mode === "edit" && (
          <div className="overlay">
            {regions.map((r, i) => {
              const box = regionRect(r);
              return box ? (
                <div key={r.id} className="region" style={rectStyle(box)}>
                  <span className="region-num">{i + 1}</span>
                  <span className="region-text">{r.text}</span>
                </div>
              ) : null;
            })}
            {hovRect && <div className="box hover" style={rectStyle(hovRect)} />}
            {multi.map((id) => {
              const r = id === state.selected ? selRect : rectOf(id);
              if (!r) return null;
              const primary = id === state.selected && selected;
              return (
                <div key={id} className={`box selected${single ? "" : " multi"}`} style={rectStyle(r)}>
                  {primary && <span className="label">{single ? describeNode(selected) : `${multi.length} selected`}</span>}
                  {primary && single && <ResizeHandle id={id} onResize={rerender} />}
                </div>
              );
            })}
            {live.marquee && <div className="marquee" style={rectStyle(live.marquee)} />}
            {live.region && <div className="region drawing" style={rectStyle(live.region)} />}
            {draft && draftRect && (
              <>
                <div className="region drawing" style={rectStyle(draftRect)} />
                <TalkPopover
                  anchor={draftRect}
                  placeholder="What should the AI put here? e.g. a search field with a filter button"
                  onPin={(text) => store.edit({ op: "region", id: `r${Date.now().toString(36)}`, parent: draft.parent, rect: draft.rect, text })}
                  onClose={() => setDraft(null)}
                />
              </>
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
function ResizeHandle({ id, onResize }: { id: string; onResize: () => void }) {
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
      if (ev.pointerId !== e.pointerId) return;
      const size = cssSize(el, Math.max(4, from.w + ev.clientX - start.x), Math.max(4, from.h + ev.clientY - start.y));
      el.style.width = size.width;
      el.style.height = size.height;
      // Only the overlay follows the element; nothing else changes until the resize is recorded.
      onResize();
    };
    const detach = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", cancel);
      handle.removeEventListener("lostpointercapture", cancel);
      el.style.width = prev.width;
      el.style.height = prev.height;
    };
    // A cancelled pointer (touch, pen, capture lost on a window switch) puts the element back as it was.
    const cancel = () => {
      detach();
      store.set({});
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      detach();
      const to = { ...from, w: Math.max(4, Math.round(from.w + ev.clientX - start.x)), h: Math.max(4, Math.round(from.h + ev.clientY - start.y)) };
      if (to.w !== from.w || to.h !== from.h) store.edit({ op: "resize", node: id, from, to });
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", cancel);
    handle.addEventListener("lostpointercapture", cancel);
  };
  return <span className="handle" onPointerDown={onPointerDown} />;
}

interface Point {
  x: number;
  y: number;
}

/** A mouse gesture in the page, from mousedown to mouseup. */
type Gesture =
  /** Dragging the selected elements. `single` is set when the press landed on one of several selected elements. */
  | { kind: "move"; start: Point; ids: string[]; from: Map<string, Point>; moved: boolean; single: string | null }
  /** Rubber-band selection from the empty page background; `base` is kept (Shift adds). `hits` measured the page once. */
  | { kind: "marquee"; start: Point; base: string[]; hits: (rect: Rect) => string[] }
  /** Drawing a box prompt. */
  | { kind: "region"; start: Point };

interface PageHooks {
  mode: () => Mode;
  openTalk: () => void;
  rerender: () => void;
  live: Live;
  /** Any press in the page (closes an unanswered box prompt). */
  onPress: () => void;
  /** A box prompt was drawn. */
  onRegion: (rect: Rect) => void;
}

/** Mouse and keyboard handling inside the previewed page. Returns a function that cancels the current gesture. */
function installPageHandlers(doc: Document, h: PageHooks): () => void {
  const win = doc.defaultView!;
  let g: Gesture | null = null;
  let last: Point = { x: 0, y: 0 };

  const between = (a: Point, b: Point): Rect => ({
    left: Math.min(a.x, b.x),
    top: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  });
  const toolCursor = () => setPageCursor(doc, h.mode() === "edit" && store.state.tool === "region" ? "crosshair" : null);

  const cancel = () => {
    if (g?.kind === "move") for (const id of g.ids) store.bridge?.previewMove(id, g.from.get(id)!);
    g = null;
    h.live.marquee = h.live.region = null;
    toolCursor();
    h.rerender();
  };

  const track = (p: Point) => {
    if (!g) return;
    const dx = p.x - g.start.x;
    const dy = p.y - g.start.y;
    if (g.kind === "move") {
      if (!g.moved && Math.hypot(dx, dy) < 3) return;
      g.moved = true;
      for (const id of g.ids) {
        const f = g.from.get(id)!;
        store.bridge?.previewMove(id, { x: Math.round(f.x + dx), y: Math.round(f.y + dy) });
      }
    } else if (g.kind === "marquee") {
      h.live.marquee = between(g.start, p);
      const ids = [...new Set([...g.base, ...g.hits(h.live.marquee)])];
      if (ids.join() !== store.state.multi.join()) store.selectMany(ids);
    } else {
      h.live.region = between(g.start, p);
    }
    h.rerender();
  };

  const finish = (p: Point) => {
    const done = g;
    if (!done) return;
    g = null;
    h.live.marquee = h.live.region = null;
    if (done.kind === "move") {
      const dx = Math.round(p.x - done.start.x);
      const dy = Math.round(p.y - done.start.y);
      if (!done.moved) {
        // A click (no drag) on one of several selected elements selects just that one.
        if (done.single) store.select(done.single);
      } else if (dx || dy) {
        store.edit(...done.ids.map((id): Op => {
          const from = done.from.get(id)!;
          return { op: "move", node: id, from, to: { x: from.x + dx, y: from.y + dy } };
        }));
      } else {
        for (const id of done.ids) store.bridge?.previewMove(id, done.from.get(id)!); // dragged back to the start
      }
    } else if (done.kind === "region") {
      toolCursor();
      const rect = between(done.start, p);
      if (rect.width >= 8 && rect.height >= 8) h.onRegion(rect);
    }
    h.rerender();
  };

  doc.addEventListener("mousemove", (e) => {
    if (h.mode() !== "edit") return;
    last = { x: e.clientX, y: e.clientY };
    if (g) return track(last);
    const id = store.state.tool === "select" ? (store.bridge?.pick(e.target) ?? null) : null;
    if (id !== store.state.hovered) store.set({ hovered: id });
  });

  doc.addEventListener("mouseleave", () => store.set({ hovered: null }));

  doc.addEventListener(
    "mousedown",
    (e) => {
      if (h.mode() !== "edit" || e.button !== 0) return;
      if ((e.target as HTMLElement).isContentEditable) return;
      e.preventDefault();
      // preventDefault keeps focus where it was: commit a field being typed in (the Inspector) before the selection moves.
      const field = document.activeElement as HTMLElement | null;
      if (field && (field.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(field.tagName))) field.blur();
      h.onPress();
      const start = (last = { x: e.clientX, y: e.clientY });
      // Box prompt: with the tool on, or Alt+drag anywhere.
      if (store.state.tool === "region" || e.altKey) {
        g = { kind: "region", start };
        setPageCursor(doc, "crosshair");
        store.set({ hovered: null });
        return;
      }
      const id = store.bridge?.pick(e.target);
      const scene = store.scene;
      if (!id || !scene) {
        // Empty page background: marquee selection.
        g = { kind: "marquee", start, base: e.shiftKey ? store.selection : [], hits: marqueeHits() };
        if (!e.shiftKey) store.select(null);
        return;
      }
      if (e.shiftKey) {
        store.toggleSelect(id);
        return;
      }
      // Pressing on a selected element keeps the multi-selection, so all of it can be dragged.
      const keep = store.state.multi.includes(id) && store.selection.length > 1;
      if (keep) store.set({ selected: id, multi: store.state.multi });
      else store.select(id);
      if (scene.nodes[id]?.locked) return;
      const ids = topLevel(scene, store.selection).filter((x) => !scene.nodes[x]!.locked);
      const from = new Map(ids.map((x): [string, Point] => [x, { x: scene.nodes[x]!.layout.x, y: scene.nodes[x]!.layout.y }]));
      g = { kind: "move", start, ids, from, moved: false, single: keep ? id : null };
    },
    true,
  );

  doc.addEventListener("mouseup", (e) => finish({ x: e.clientX, y: e.clientY }));
  // A drag released outside the preview still ends where the mouse was last seen in it.
  const onEditorMouseUp = () => {
    if (store.bridge?.doc !== doc) return window.removeEventListener("mouseup", onEditorMouseUp);
    finish(last);
  };
  window.addEventListener("mouseup", onEditorMouseUp);

  // In edit mode the page should not react to clicks (links, buttons, forms).
  for (const type of ["click", "submit", "auxclick"]) {
    doc.addEventListener(
      type,
      (e) => {
        if (h.mode() === "edit" && !(e.target as HTMLElement).isContentEditable) {
          e.preventDefault();
          e.stopPropagation();
        }
      },
      true,
    );
  }

  doc.addEventListener("dblclick", (e) => {
    if (h.mode() !== "edit" || store.state.tool !== "select") return;
    const id = store.bridge?.pick(e.target);
    if (id) editText(id);
  });

  // Focus can stay in the page while a past version or a dialog covers it; shortcuts would act unseen.
  doc.addEventListener("keydown", (e) => !loop.blocksEditorKeys && handleKey(e, h.openTalk, h.mode()), true);
  // Keep the overlay on its elements: page and inner scrolling, resizes, layout changes.
  doc.addEventListener(
    "scroll",
    () => {
      // The boxes a marquee measured moved with the page.
      if (g?.kind === "marquee") g.hits = marqueeHits();
      h.rerender();
    },
    { capture: true, passive: true },
  );
  win.addEventListener("resize", h.rerender);
  new win.ResizeObserver(() => h.rerender()).observe(doc.documentElement);
  return cancel;
}

/** Force a cursor over the whole page (a crosshair while drawing box prompts), or restore the page's own. */
function setPageCursor(doc: Document, cursor: string | null): void {
  let style = doc.getElementById("__glimpse-cursor");
  if (!cursor) {
    style?.remove();
    return;
  }
  if (!style) {
    style = doc.createElement("style");
    style.id = "__glimpse-cursor";
    style.setAttribute("data-glimpse-internal", "");
    (doc.head ?? doc.documentElement).append(style);
  }
  style.textContent = `html, html * { cursor: ${cursor} !important; }`;
}

/** Inline text editing: the element becomes contentEditable until Enter/blur. */
export function editText(id: string): void {
  if (store.sceneSurface?.editText) return store.sceneSurface.editText(id);
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
    if (isEnter(e) && !e.shiftKey) {
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
/** The page shows something (a React app that crashed while rendering leaves an empty root). */
function hasContent(doc: Document): boolean {
  return !!doc.body && (!!doc.body.innerText.trim() || !!doc.body.querySelector("img, svg, canvas, video, input, button"));
}

export function handleKey(e: KeyboardEvent, openTalk: () => void, mode: Mode): void {
  // A dialog is open: its keys are its own, not for the page behind it.
  if (modalOpen()) return;
  const t = e.target as HTMLElement;
  if (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName)) return;
  const mod = e.metaKey || e.ctrlKey;
  const key = e.key.toLowerCase();
  // Interact mode: the page gets every key (arrows, Backspace…); only undo, redo and Escape from the editor's own UI.
  const fromEditor = (t.ownerDocument ?? t) === document;
  if (mode === "interact" && !(fromEditor && ((mod && (key === "z" || key === "y")) || e.key === "Escape"))) return;
  const id = store.state.selected;
  const any = store.selection.length > 0;
  if (mod && key === "z") {
    e.preventDefault();
    if (e.shiftKey) store.redo();
    else store.undo();
  } else if (mod && key === "y") {
    e.preventDefault();
    store.redo();
  } else if (mod && key === "d") {
    e.preventDefault();
    store.duplicateSelected();
  } else if (mod && key === "g") {
    e.preventDefault();
    if (e.shiftKey) ungroupSelection();
    else groupSelection();
  } else if (!mod && (e.key === "Delete" || e.key === "Backspace") && any) {
    e.preventDefault();
    store.deleteSelected();
  } else if (!mod && key === "t" && id) {
    e.preventDefault();
    openTalk();
  } else if (!mod && !e.altKey && key === "r" && mode === "edit") {
    e.preventDefault();
    store.setTool(store.state.tool === "region" ? "select" : "region");
  } else if (e.key === "Escape") {
    // Stop whatever is in progress, leave the box prompt tool and clear the selection.
    canvas.cancel();
    store.set({ selected: null, tool: "select" });
  } else if (any && e.key.startsWith("Arrow")) {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
    const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
    nudgeSelection(dx, dy);
  }
}
