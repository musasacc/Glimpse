import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { describeNode, topLevel, type Layout, type Op, type SceneNode } from "@glimpse/core";
import { elementsIn, regionRect, regionTarget, type Rect } from "./arrange";
import type { Mode } from "./Canvas";
import * as I from "./icons";
import * as L from "./loop-icons";
import { NativeWindow } from "./NativeRenderer";
import { MOD } from "./platform";
import { captureFrame, renderThumbnail } from "./scene-capture";
import { absBox, editableProp, unitSize, type Cell, type SceneTarget } from "./scene-geometry";
import { sceneMode, useSceneMode } from "./scene-mode";
import { store, useStore } from "./store";
import { TalkPopover } from "./Talk";
import { TuiScreen } from "./TuiRenderer";
import { TuiWindow } from "./SceneView";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-700.css";
import "./editing.css";
import "./scene.css";

// xterm.js is only needed for terminal UIs and native GUIs: load it with the pane.
const TerminalPane = lazy(() => import("./TerminalPane").then((m) => ({ default: m.TerminalPane })));

/** A box prompt that has been drawn and is waiting for its instruction. */
type Draft = { parent: string; rect: Layout };

type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** A pointer gesture on the mock, in layout units (cells or px). */
type Gesture =
  | { kind: "move"; start: Pt; ids: string[]; from: Map<string, Layout>; moved: boolean; single: string | null; startPx: Pt }
  | { kind: "resize"; id: string; handle: Handle; start: Pt; from: Layout }
  | { kind: "marquee"; start: Pt; base: string[] }
  | { kind: "region"; start: Pt };

interface Pt {
  x: number;
  y: number;
}

/**
 * The canvas for terminal UIs and native GUIs: the scene drawn as a terminal
 * screen or a desktop window, with the editing overlay on top, and the real app
 * (terminal, or a log for native apps) docked next to it. Moves and resizes snap
 * to whole cells (or pixels); every edit is an op on the scene, like on a page.
 */
export function SceneCanvas({ mode, talkOpen, setTalkOpen }: { mode: Mode; talkOpen: boolean; setTalkOpen: (v: boolean) => void }) {
  const state = useStore();
  const sm = useSceneMode();
  const scene = store.scene;
  const target = sm.target;
  const unit = unitSize(target, sm.cell);

  const stage = useRef<HTMLDivElement>(null);
  const board = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const screen = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const [preview, setPreview] = useState<Map<string, Layout> | null>(null);
  const [marquee, setMarquee] = useState<Layout | null>(null);
  const [drawing, setDrawing] = useState<Layout | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  /** The frame's unscaled size. */
  const [size, setSize] = useState({ w: 0, h: 0 });
  /** Where the screen (client area) sits in the board, in unscaled px. */
  const [origin, setOrigin] = useState<Pt>({ x: 0, y: 0 });
  const [showProblems, setShowProblems] = useState(false);

  // Fit the mock into the stage (never larger than 1:1), and find where its screen sits.
  const hasScene = !!scene;
  useLayoutEffect(() => {
    const el = stage.current;
    const fr = frame.current;
    if (!el || !fr) return;
    const fit = () => {
      const w = fr.offsetWidth;
      const h = fr.offsetHeight;
      if (!w || !h) return;
      const z = Math.max(0.25, Math.min(1, (el.clientWidth - 48) / w, (el.clientHeight - 48) / h));
      setZoom((old) => (Math.abs(old - z) > 0.001 ? z : old));
      setSize((old) => (old.w !== w || old.h !== h ? { w, h } : old));
      const next = originOf(fr, screen.current);
      setOrigin((o) => (Math.abs(o.x - next.x) > 0.1 || Math.abs(o.y - next.y) > 0.1 ? next : o));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    ro.observe(fr);
    return () => ro.disconnect();
  }, [hasScene, target, sm.theme, sm.cell, sm.dock.open, sm.dock.side]);

  // Pictures of the mock for handoffs and the timeline.
  useEffect(() => {
    sceneMode.capture = {
      screenshot: () => {
        const el = frame.current;
        if (!el || !store.scene) return Promise.resolve(null);
        const regions = (store.log?.ops ?? []).filter((o): o is Extract<Op, { op: "region" }> => o.op === "region");
        const u = unitSize(sceneMode.state.target, sceneMode.state.cell);
        const o = originOf(el, screen.current);
        const boxes = regions.flatMap((r, i) => {
          const b = regionRect(r);
          return b ? [{ left: o.x + b.left * u.w, top: o.y + b.top * u.h, width: b.width * u.w, height: b.height * u.h, num: i + 1, text: r.text }] : [];
        });
        return captureFrame(el, boxes);
      },
      thumbnail: (id, maxWidth) => renderThumbnail(id, maxWidth),
    };
    return () => {
      sceneMode.capture = null;
    };
  }, []);

  // Escape (handled by the editor's shortcuts too) stops whatever is in progress here.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      cancel();
      setDraft(null);
      setMenu(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (mode !== "edit") {
      cancel();
      setDraft(null);
    }
  }, [mode]);

  const cancel = () => {
    gesture.current = null;
    setPreview(null);
    setMarquee(null);
    setDrawing(null);
  };

  /* ── Coordinates ────────────────────────────────────────────────────── */

  /** Pointer position in layout units (cells or px) relative to the screen's top-left. */
  const toUnits = (e: { clientX: number; clientY: number }): Pt => {
    const r = board.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left - origin.x * zoom) / (unit.w * zoom), y: (e.clientY - r.top - origin.y * zoom) / (unit.h * zoom) };
  };
  /** A box in layout units, as overlay pixels. */
  const toPx = (b: Layout | Rect | null): Rect | null => {
    if (!b) return null;
    const { x, y, w, h } = "left" in b ? { x: b.left, y: b.top, w: b.width, h: b.height } : b;
    return { left: (origin.x + x * unit.w) * zoom, top: (origin.y + y * unit.h) * zoom, width: w * unit.w * zoom, height: h * unit.h * zoom };
  };
  /** Absolute box of a node, following an in-progress drag or resize. */
  const boxOf = (id: string | null): Layout | null => {
    if (!id || !scene) return null;
    const b = absBox(scene, id);
    if (!b) return null;
    // A dragged ancestor (or the node itself) shifts it.
    for (let p: string | null = id; p !== null; p = scene.nodes[p]?.parent ?? null) {
      const over = preview?.get(p);
      if (!over) continue;
      const base = scene.nodes[p]!.layout;
      return p === id ? { x: b.x + over.x - base.x, y: b.y + over.y - base.y, w: over.w, h: over.h } : { ...b, x: b.x + over.x - base.x, y: b.y + over.y - base.y };
    }
    return b;
  };

  /* ── Gestures ───────────────────────────────────────────────────────── */

  const pick = (t: EventTarget | null): string | null => {
    const el = (t as Element | null)?.closest?.("[data-scene-id]");
    return el && screen.current?.contains(el) ? el.getAttribute("data-scene-id") : null;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (mode !== "edit" || e.button !== 0 || !scene) return;
    if ((e.target as Element).closest(".scene-overlay .live-ui")) return;
    e.preventDefault();
    (document.activeElement as HTMLElement | null)?.blur?.();
    board.current!.setPointerCapture(e.pointerId);
    setDraft(null);
    setMenu(null);
    const start = toUnits(e);
    if (state.tool === "region" || e.altKey) {
      gesture.current = { kind: "region", start };
      store.set({ hovered: null });
      return;
    }
    const id = pick(e.target);
    if (!id) {
      gesture.current = { kind: "marquee", start, base: e.shiftKey ? store.selection : [] };
      if (!e.shiftKey) store.select(null);
      return;
    }
    if (e.shiftKey) {
      store.toggleSelect(id);
      return;
    }
    const keep = state.multi.includes(id) && store.selection.length > 1;
    if (keep) store.set({ selected: id, multi: state.multi });
    else store.select(id);
    if (scene.nodes[id]?.locked) return;
    const ids = topLevel(scene, keep ? store.selection : [id]).filter((x) => !scene.nodes[x]!.locked);
    const from = new Map(ids.map((x): [string, Layout] => [x, { ...scene.nodes[x]!.layout }]));
    gesture.current = { kind: "move", start, ids, from, moved: false, single: keep ? id : null, startPx: { x: e.clientX, y: e.clientY } };
  };

  const startResize = (id: string, handle: Handle) => (e: React.PointerEvent) => {
    const n = scene?.nodes[id];
    if (!n || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    board.current!.setPointerCapture(e.pointerId);
    gesture.current = { kind: "resize", id, handle, start: toUnits(e), from: { ...n.layout } };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g) {
      if (mode !== "edit" || state.tool !== "select") return;
      const id = pick(e.target);
      if (id !== state.hovered) store.set({ hovered: id });
      return;
    }
    const p = toUnits(e);
    const dx = p.x - g.start.x;
    const dy = p.y - g.start.y;
    if (g.kind === "move") {
      if (!g.moved && Math.hypot(e.clientX - g.startPx.x, e.clientY - g.startPx.y) < 3) return;
      g.moved = true;
      const sx = Math.round(dx);
      const sy = Math.round(dy);
      setPreview(new Map([...g.from].map(([id, l]) => [id, { ...l, x: l.x + sx, y: l.y + sy }])));
    } else if (g.kind === "resize") {
      setPreview(new Map([[g.id, resized(g.from, g.handle, Math.round(dx), Math.round(dy))]]));
    } else if (g.kind === "marquee") {
      const r = span(g.start, p);
      setMarquee(r);
      const ids = [...new Set([...g.base, ...elementsIn({ left: r.x, top: r.y, width: r.w, height: r.h })])];
      if (ids.join() !== store.state.multi.join()) store.selectMany(ids);
    } else {
      setDrawing(cells(g.start, p, target));
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    gesture.current = null;
    const p = toUnits(e);
    const dx = Math.round(p.x - g.start.x);
    const dy = Math.round(p.y - g.start.y);
    if (g.kind === "move") {
      if (!g.moved) {
        if (g.single) store.select(g.single);
      } else if (dx || dy) {
        store.edit(
          ...g.ids.map((id): Op => {
            const f = g.from.get(id)!;
            return { op: "move", node: id, from: { x: f.x, y: f.y }, to: { x: f.x + dx, y: f.y + dy } };
          }),
        );
      }
    } else if (g.kind === "resize") {
      const to = resized(g.from, g.handle, dx, dy);
      if (to.x !== g.from.x || to.y !== g.from.y || to.w !== g.from.w || to.h !== g.from.h) store.edit({ op: "resize", node: g.id, from: g.from, to });
    } else if (g.kind === "region") {
      const r = cells(g.start, p, target);
      const big = target === "tui" ? r.w >= 1 && r.h >= 1 : r.w >= 8 && r.h >= 8;
      if (big) setDraft(regionTarget({ left: r.x, top: r.y, width: r.w, height: r.h }));
    }
    setPreview(null);
    setMarquee(null);
    setDrawing(null);
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    if (mode !== "edit" || state.tool !== "select") return;
    // The board captured the pointer, so the event's target is the board: look underneath.
    const id = pick(document.elementFromPoint(e.clientX, e.clientY));
    if (id) sceneMode.surface.editText?.(id);
  };

  const onContextMenu = (e: React.MouseEvent) => {
    if (mode !== "edit") return;
    const id = pick(e.target);
    if (!id) return;
    e.preventDefault();
    const keep = state.multi.includes(id) && store.selection.length > 1;
    store.set(keep ? { selected: id, multi: state.multi } : { selected: id });
    setMenu({ id, x: e.clientX, y: e.clientY });
  };

  /* ── Render ─────────────────────────────────────────────────────────── */

  if (sm.status === "missing" || (!state.entryExists && !scene)) {
    return (
      <div className="canvas">
        <div className="waiting">
          <div className="waiting-eye">
            <svg viewBox="0 0 64 64" aria-hidden="true">
              <path d="M5 32C14 16 50 16 59 32C50 48 14 48 5 32Z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
              <circle cx="35" cy="31" r="8" fill="currentColor" />
            </svg>
          </div>
          <h3>{state.agentWaiting ? "Your agent is listening" : "Waiting for your agent to describe the UI"}</h3>
          <p>
            As soon as it saves <code>{sm.file}</code>, the {target === "tui" ? "terminal UI" : "window"} appears here to edit.
          </p>
        </div>
      </div>
    );
  }

  const ops = store.log?.ops ?? [];
  const pins = ops.filter((o): o is Extract<Op, { op: "comment" }> => o.op === "comment");
  const regions = ops.filter((o): o is Extract<Op, { op: "region" }> => o.op === "region");
  const multi = store.selection;
  const single = multi.length <= 1;
  const selected = state.selected ? scene?.nodes[state.selected] : undefined;
  const selRect = toPx(boxOf(state.selected));
  const hovRect = state.tool === "select" && state.hovered && !multi.includes(state.hovered) ? toPx(boxOf(state.hovered)) : null;
  const draftRect = draft ? toPx(regionRect({ op: "region", id: "draft", text: "", ...draft })) : null;
  const meta = sm.extras.meta;
  const title = meta?.title ?? (typeof meta?.command === "string" ? meta.command : undefined);
  const root = scene?.nodes[scene.rootId];
  const editingNode = sm.editing ? scene?.nodes[sm.editing] : undefined;
  const base = sm.file.includes("/") ? sm.file.slice(0, sm.file.lastIndexOf("/")) : "";

  return (
    <div className={`canvas scene-canvas dock-${sm.dock.side}${sm.dock.open ? " docked" : ""}`}>
      <div className="scene-split">
        <div className="scene-stage" ref={stage}>
          <div className="scene-banners">
            {sm.invalid && (
              <div className="banner scene-error">
                <L.Message size={14} />
                <span>
                  <code>{sm.file}</code> isn't valid JSON{sm.invalid.line ? ` (line ${sm.invalid.line}, column ${sm.invalid.column})` : ""}. Showing the last good version
                  until the agent fixes it.
                </span>
              </div>
            )}
            {sm.loadError && !scene && <div className="banner scene-error">Couldn't load {sm.file}: {sm.loadError}</div>}
            {state.stale && (
              <div className="banner">
                Some edits could not be replayed after the AI changed the scene.
                <button className="btn" onClick={() => store.set({ stale: false })}>
                  OK
                </button>
              </div>
            )}
          </div>
          {scene && root ? (
            <div
              className={`scene-board${mode === "edit" && state.tool === "region" ? " drawing" : ""}`}
              ref={board}
              style={{ width: size.w * zoom || undefined, height: size.h * zoom || undefined }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={cancel}
              onPointerLeave={() => !gesture.current && state.hovered && store.set({ hovered: null })}
              onDoubleClick={onDoubleClick}
              onContextMenu={onContextMenu}
            >
              <div className="scene-zoom" style={{ transform: `scale(${zoom})` }}>
                <div className="scene-frame" ref={frame}>
                  {target === "tui" ? (
                    <TuiWindow title={title} size={`${root.layout.w}×${root.layout.h}`} screenRef={screen}>
                      <TuiScreen scene={scene} cell={sm.cell} preview={preview ?? undefined} />
                    </TuiWindow>
                  ) : (
                    <NativeShell screenRef={screen}>
                      <NativeWindow scene={scene} theme={sm.theme} title={meta?.title} preview={preview ?? undefined} base={base} />
                    </NativeShell>
                  )}
                </div>
              </div>

              {mode === "edit" && (
                <div className="overlay scene-overlay">
                  {regions.map((r, i) => {
                    const box = toPx(regionRect(r));
                    return box ? (
                      <div key={r.id} className="region" style={rectStyle(box)}>
                        <span className="region-num">{i + 1}</span>
                        <span className="region-text">{r.text}</span>
                      </div>
                    ) : null;
                  })}
                  {hovRect && <div className="box hover" style={rectStyle(hovRect)} />}
                  {multi.map((id) => {
                    const r = id === state.selected ? selRect : toPx(boxOf(id));
                    if (!r) return null;
                    const primary = id === state.selected && selected;
                    const locked = scene.nodes[id]?.locked;
                    return (
                      <div key={id} className={`box selected${single ? "" : " multi"}`} style={rectStyle(r)}>
                        {primary && (
                          <span className="label">
                            {single ? describeNode(selected) : `${multi.length} selected`}
                            {single && <span className="scene-dims">{dims(boxOf(id), target)}</span>}
                          </span>
                        )}
                        {primary && single && !locked && HANDLES.map((h) => <span key={h} className={`scene-handle live-ui h-${h}`} onPointerDown={startResize(id, h)} />)}
                      </div>
                    );
                  })}
                  {marquee && <div className="marquee" style={rectStyle(toPx(marquee)!)} />}
                  {drawing && <div className="region drawing" style={rectStyle(toPx(drawing)!)} />}
                  {pins.map((p, i) => {
                    const r = toPx(boxOf(p.node));
                    return r ? (
                      <div key={p.id} className="badge" title={p.text} style={{ left: r.left + r.width, top: r.top }}>
                        {i + 1}
                      </div>
                    ) : null;
                  })}
                  {editingNode && <InlineEditor key={editingNode.id} node={editingNode} rect={toPx(boxOf(editingNode.id))!} target={target} cell={sm.cell} zoom={zoom} />}
                  {draft && draftRect && (
                    <div className="live-ui">
                      <div className="region drawing" style={rectStyle(draftRect)} />
                      <TalkPopover
                        anchor={draftRect}
                        placeholder="What should the AI put here? e.g. a search field with a filter button"
                        onPin={(text) => store.edit({ op: "region", id: `r${Date.now().toString(36)}`, parent: draft.parent, rect: draft.rect, text })}
                        onClose={() => setDraft(null)}
                      />
                    </div>
                  )}
                  {talkOpen && selRect && selected && (
                    <div className="live-ui">
                      <TalkPopover node={selected.id} anchor={selRect} onClose={() => setTalkOpen(false)} />
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="side-empty">Loading {sm.file}…</div>
          )}
          {sm.errors.length > 0 && (
            <div className="scene-problems">
              <button className="btn" onClick={() => setShowProblems(!showProblems)} title="Problems Glimpse patched over while reading the scene file">
                <span className="scene-warn-dot" /> {sm.errors.length} problem{sm.errors.length === 1 ? "" : "s"} in {sm.file}
              </button>
              {showProblems && (
                <ul>
                  {sm.errors.map((m, i) => (
                    <li key={i}>{m}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <span className="scene-zoom-label" title="Fitted to the canvas">
            {Math.round(zoom * 100)}%
          </span>
        </div>
        {sm.dock.open && (
          <Suspense fallback={<section className="term-pane" style={sm.dock.side === "right" ? { width: sm.dock.size ?? "45%" } : { height: sm.dock.size ?? "45%" }} />}>
            <TerminalPane target={target} />
          </Suspense>
        )}
      </div>
      {menu && <SceneMenu menu={menu} onClose={() => setMenu(null)} openTalk={() => setTalkOpen(true)} />}
    </div>
  );
}

/** Marks the client area of a native window so the overlay lines up with it. */
function NativeShell({ screenRef, children }: { screenRef: React.RefObject<HTMLDivElement | null>; children: ReactNode }) {
  const wrap = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const client = wrap.current?.querySelector<HTMLDivElement>(".nat-client") ?? null;
    (screenRef as React.MutableRefObject<HTMLDivElement | null>).current = client;
  });
  return <div ref={wrap}>{children}</div>;
}

/** Where the screen (client area) sits inside the frame, in unscaled px. */
function originOf(frame: HTMLElement, screen: HTMLElement | null): Pt {
  if (!screen) return { x: 0, y: 0 };
  const fb = frame.getBoundingClientRect();
  const sb = screen.getBoundingClientRect();
  const k = fb.width / (frame.offsetWidth || 1) || 1;
  return { x: (sb.left - fb.left) / k, y: (sb.top - fb.top) / k };
}

function rectStyle(r: Rect) {
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

function dims(b: Layout | null, target: SceneTarget): string {
  if (!b) return "";
  return target === "tui" ? ` ${b.w}×${b.h}` : ` ${Math.round(b.w)}×${Math.round(b.h)}`;
}

/** The box between two points, in layout units. */
function span(a: Pt, b: Pt): Layout {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

/** A drawn box snapped outward to whole cells (or pixels). */
function cells(a: Pt, b: Pt, target: SceneTarget): Layout {
  if (target !== "tui") {
    const r = span(a, b);
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) };
  }
  const x = Math.floor(Math.min(a.x, b.x));
  const y = Math.floor(Math.min(a.y, b.y));
  return { x, y, w: Math.ceil(Math.max(a.x, b.x)) - x, h: Math.ceil(Math.max(a.y, b.y)) - y };
}

/** A layout after dragging `handle` by (dx, dy) units; at least one unit big. */
function resized(from: Layout, handle: Handle, dx: number, dy: number): Layout {
  let { x, y, w, h } = from;
  if (handle.includes("e")) w = Math.max(1, from.w + dx);
  if (handle.includes("s")) h = Math.max(1, from.h + dy);
  if (handle.includes("w")) {
    w = Math.max(1, from.w - dx);
    x = from.x + from.w - w;
  }
  if (handle.includes("n")) {
    h = Math.max(1, from.h - dy);
    y = from.y + from.h - h;
  }
  return { x, y, w, h };
}

/** In-place editing of a widget's text (or its rows) over the mock. Enter keeps it, Escape drops it. */
function InlineEditor({ node, rect, target, cell, zoom }: { node: SceneNode; rect: Rect; target: SceneTarget; cell: Cell; zoom: number }) {
  const what = editableProp(node);
  const from = what ? (node.props[what.key] ?? "") : "";
  const [value, setValue] = useState(from);
  const input = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);

  useEffect(() => {
    if (!what) sceneMode.set({ editing: null });
    input.current?.focus();
    input.current?.select();
  }, []);
  if (!what) return null;

  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    sceneMode.set({ editing: null });
    if (!commit || value === from) return;
    if (what.key === "text") store.edit({ op: "setText", node: node.id, from, to: value });
    else store.edit({ op: "setProp", node: node.id, key: what.key, from: node.props[what.key] ?? null, to: value === "" ? null : value });
  };

  const rows = Math.max(1, value.split("\n").length);
  const lineH = target === "tui" ? cell.h * zoom : 18 * zoom;
  return (
    <textarea
      ref={input}
      className={`scene-inline live-ui${target === "tui" ? " mono" : ""}`}
      style={{
        left: rect.left,
        top: rect.top,
        width: Math.max(rect.width, 120),
        height: Math.max(rect.height, rows * lineH + 8),
        fontSize: target === "tui" ? 14 * zoom : 13 * zoom,
        lineHeight: `${lineH}px`,
      }}
      value={value}
      spellCheck={false}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(true)}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") finish(false);
        else if (e.key === "Enter" && (!what.multiline ? !e.shiftKey : e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          finish(true);
        }
      }}
      title={what.multiline ? `One per line · ${MOD}Enter to keep, Esc to cancel` : "Enter to keep, Esc to cancel"}
    />
  );
}

/** Right-click menu on a widget of the mock. */
function SceneMenu({ menu, onClose, openTalk }: { menu: { id: string; x: number; y: number }; onClose: () => void; openTalk: () => void }) {
  useStore();
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener("pointerdown", close);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [onClose]);
  const node = store.scene?.nodes[menu.id];
  if (!node) return null;
  const count = store.selection.length;
  const run = (fn: () => void) => () => {
    onClose();
    fn();
  };
  const left = Math.max(4, Math.min(menu.x, window.innerWidth - 224));
  const top = Math.max(4, Math.min(menu.y, window.innerHeight - 220));
  return (
    <div className="menu ctx-menu" role="menu" style={{ left, top }} onPointerDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
      <div className="ctx-title ellipsis">{count > 1 ? `${describeNode(node)} + ${count - 1} more` : describeNode(node)}</div>
      <button role="menuitem" onClick={run(openTalk)}>
        <L.Message size={14} /> Talk to AI <span className="kbd">T</span>
      </button>
      {editableProp(node) && (
        <button role="menuitem" onClick={run(() => sceneMode.surface.editText?.(node.id))}>
          <I.Type size={14} /> Edit text
        </button>
      )}
      <button role="menuitem" onClick={run(() => store.duplicateSelected())}>
        <L.Copy size={14} /> Duplicate <span className="kbd">{MOD}D</span>
      </button>
      <button role="menuitem" onClick={run(() => store.edit({ op: "setHidden", node: node.id, from: !!node.hidden, to: !node.hidden }))}>
        <I.Eye size={14} /> {node.hidden ? "Show" : "Hide"}
      </button>
      <button role="menuitem" className="danger" onClick={run(() => store.deleteSelected())}>
        <L.Trash size={14} /> Delete <span className="kbd">Del</span>
      </button>
    </div>
  );
}
