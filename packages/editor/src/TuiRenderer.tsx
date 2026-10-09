import { memo, type CSSProperties, type ReactNode } from "react";
import type { Layout, Scene, SceneNode } from "@glimpse/core";
import { samePreviewFor, selectedTab, shownPane, type Cell } from "./scene-geometry";
import { BORDER_FG, cellWidth, fitCells, graphemes, mix, padCells, SCREEN_BG, SCREEN_FG, textStyle, tuiColor, wrapCells, type TextStyle } from "./tui-colors";

/**
 * Draws a terminal UI mock: every widget of the scene on a character-cell grid,
 * the way a modern terminal shows a Textual / Ink / Ratatui app. Frames and rules
 * are continuous lines through the middle of their cells (as terminals draw
 * box-drawing characters); text sits on the grid in the terminal font.
 */

export interface TuiProps {
  scene: Scene;
  cell: Cell;
  /** Layout overrides while a drag or resize is in progress. */
  preview?: ReadonlyMap<string, Layout>;
  /** Changes whenever the scene does: it is edited in place, so the object alone doesn't tell. */
  rev?: number;
}

/**
 * The whole screen: the root's size in cells, its background, and every widget on it.
 * Memoized, as are its widgets: hovering, the terminal's output and a drag redraw only what changed.
 */
export const TuiScreen = memo(function TuiScreen({ scene, cell, preview, rev }: TuiProps) {
  const root = scene.nodes[scene.rootId]!;
  const bg = tuiColor(root.style.background) ?? SCREEN_BG;
  const fg = tuiColor(root.style.color, bg) ?? SCREEN_FG;
  const ctx: Ctx = { scene, cell, preview, bg, fg, rev };
  return (
    <div className="tui-screen" style={{ width: root.layout.w * cell.w, height: root.layout.h * cell.h, background: bg, color: fg }}>
      {root.children.map((id) => (
        <TuiNode key={id} id={id} ctx={ctx} />
      ))}
    </div>
  );
});

interface Ctx {
  scene: Scene;
  cell: Cell;
  preview?: ReadonlyMap<string, Layout>;
  /** Inherited background and text color (terminal styles inherit). */
  bg: string;
  fg: string;
  rev?: number;
}

const TuiNode = memo(TuiNodeView, (a, b) => {
  const x = a.ctx;
  const y = b.ctx;
  return (
    a.id === b.id &&
    x.scene === y.scene &&
    x.cell === y.cell &&
    x.bg === y.bg &&
    x.fg === y.fg &&
    x.rev === y.rev &&
    samePreviewFor(y.scene, b.id, x.preview, y.preview)
  );
});

function TuiNodeView({ id, ctx }: { id: string; ctx: Ctx }) {
  const n = ctx.scene.nodes[id];
  if (!n) return null;
  const l = ctx.preview?.get(id) ?? n.layout;
  const { cell } = ctx;
  const ownBg = tuiColor(n.style.background, ctx.bg);
  const bg = ownBg ?? ctx.bg;
  const fg = tuiColor(n.style.color, bg) ?? ctx.fg;
  const inner: Ctx = { ...ctx, bg, fg };
  // Tabs show only the pane of the selected tab.
  const pane = n.type === "tabs" ? shownPane(n) : undefined;
  return (
    <div
      className={`tui-node${n.hidden ? " is-hidden" : ""}`}
      data-scene-id={id}
      style={{ left: l.x * cell.w, top: l.y * cell.h, width: l.w * cell.w, height: l.h * cell.h }}
    >
      <div className="tui-c" style={{ background: ownBg, color: fg }}>
        {draw(n, { w: l.w, h: l.h }, inner)}
      </div>
      {n.children.map((c) => (n.type !== "tabs" || c === pane ? <TuiNode key={c} id={c} ctx={inner} /> : null))}
    </div>
  );
}

/* ── Primitives ───────────────────────────────────────────────────────── */

type Size = { w: number; h: number };
type Pen = Partial<TextStyle> & { fg?: string; bg?: string };

/** Text at a cell, in the terminal font. Wide or symbol glyphs get their own cells so the grid never drifts. */
function Text({ x, y, text, pen = {}, cell, width }: { x: number; y: number; text: string; pen?: Pen; cell: Cell; width?: number }) {
  if (!text) return null;
  const fg = pen.reverse ? (pen.bg ?? SCREEN_BG) : pen.fg;
  const bg = pen.reverse ? (pen.fg ?? SCREEN_FG) : pen.bg;
  const style: CSSProperties = {
    left: x * cell.w,
    top: y * cell.h,
    height: cell.h,
    ...(width !== undefined && { width: width * cell.w }),
    color: fg,
    background: bg,
    fontWeight: pen.bold ? 700 : undefined,
    fontStyle: pen.italic ? "italic" : undefined,
    textDecoration: [pen.underline && "underline", pen.strike && "line-through"].filter(Boolean).join(" ") || undefined,
    opacity: pen.dim ? 0.6 : undefined,
  };
  return (
    <div className="tui-text" style={style}>
      {glyphs(text, cell)}
    </div>
  );
}

/** Plain runs as text; anything that may come from a fallback font in a box exactly its cells wide. */
function glyphs(text: string, cell: Cell): ReactNode[] {
  const out: ReactNode[] = [];
  let run = "";
  let k = 0;
  // Grapheme by grapheme: an emoji sequence (👩‍💻, a flag, ✅︎) is one glyph in one box.
  for (const g of graphemes(text)) {
    const w = cellWidth(g);
    if (g.codePointAt(0)! < 0x2000 && w === 1) {
      run += g;
      continue;
    }
    if (run) out.push(run);
    run = "";
    out.push(
      <span key={k++} className="tui-g" style={{ width: w * cell.w }}>
        {g}
      </span>,
    );
  }
  if (run) out.push(run);
  return out;
}

function Fill({ x, y, w, h, bg, cell, style }: { x: number; y: number; w: number; h: number; bg: string; cell: Cell; style?: CSSProperties }) {
  if (w <= 0 || h <= 0) return null;
  return <div className="tui-fill" style={{ left: x * cell.w, top: y * cell.h, width: w * cell.w, height: h * cell.h, background: bg, ...style }} />;
}

/** A horizontal rule through the middle of row `y`, `w` cells long. */
function HLine({ x, y, w, color, heavy, cell }: { x: number; y: number; w: number; color: string; heavy?: boolean; cell: Cell }) {
  if (w <= 0) return null;
  const t = heavy ? 3 : 1;
  return <div className="tui-fill" style={{ left: x * cell.w, top: (y + 0.5) * cell.h - t / 2, width: w * cell.w, height: t, background: color }} />;
}

function VLine({ x, y, h, color, heavy, cell }: { x: number; y: number; h: number; color: string; heavy?: boolean; cell: Cell }) {
  if (h <= 0) return null;
  const t = heavy ? 3 : 1;
  return <div className="tui-fill" style={{ left: (x + 0.5) * cell.w - t / 2, top: y * cell.h, width: t, height: h * cell.h, background: color }} />;
}

type BorderKind = "solid" | "round" | "heavy" | "double" | "dashed" | "ascii" | "tall" | "panel";

const BORDER_KINDS: Record<string, BorderKind> = {
  solid: "solid",
  round: "round",
  heavy: "heavy",
  thick: "heavy",
  double: "double",
  dashed: "dashed",
  ascii: "ascii",
  tall: "tall",
  wide: "tall",
  outer: "tall",
  inner: "tall",
  hkey: "solid",
  vkey: "solid",
  panel: "panel",
};

interface Border {
  kind: BorderKind;
  color: string;
}

/** style.border ("round $accent", "heavy red", "none"), or the frame a panel or card draws by default. */
function borderOf(n: SceneNode, bg: string): Border | null {
  const [kind = "", ...rest] = (n.style.border ?? "").trim().split(/\s+/);
  if (kind === "none" || kind === "hidden" || kind === "blank") return null;
  const color = tuiColor(rest.join(" "), bg) ?? BORDER_FG;
  if (kind) return { kind: BORDER_KINDS[kind] ?? "solid", color };
  if (n.type === "panel") return { kind: "solid", color };
  if (n.type === "card") return { kind: "round", color };
  return null;
}

/** A frame around `w`×`h` cells at (x, y), with an optional title in its top edge. */
function Frame({ x, y, w, h, b, title, titleFg, bg, cell }: { x: number; y: number; w: number; h: number; b: Border; title?: string; titleFg: string; bg: string; cell: Cell }) {
  if (w < 2 || h < 2) return null;
  let frame: ReactNode;
  if (b.kind === "ascii") {
    const edge = `+${"-".repeat(w - 2)}+`;
    frame = (
      <>
        <Text x={x} y={y} text={edge} pen={{ fg: b.color }} cell={cell} />
        {Array.from({ length: h - 2 }, (_, i) => (
          <span key={i}>
            <Text x={x} y={y + 1 + i} text="|" pen={{ fg: b.color }} cell={cell} />
            <Text x={x + w - 1} y={y + 1 + i} text="|" pen={{ fg: b.color }} cell={cell} />
          </span>
        ))}
        <Text x={x} y={y + h - 1} text={edge} pen={{ fg: b.color }} cell={cell} />
      </>
    );
  } else if (b.kind === "tall") {
    // Textual's tall frame: thin lines at the very top and bottom, thick bars at the sides.
    frame = (
      <div
        className="tui-frame"
        style={{
          left: x * cell.w,
          top: y * cell.h,
          width: w * cell.w,
          height: h * cell.h,
          borderStyle: "solid",
          borderColor: b.color,
          borderWidth: `${Math.max(1, Math.round(cell.h / 8))}px ${Math.round(cell.w / 4)}px`,
        }}
      />
    );
  } else if (b.kind === "panel") {
    frame = (
      <>
        <Fill x={x} y={y} w={w} h={1} bg={b.color} cell={cell} />
        <div className="tui-frame" style={{ left: x * cell.w, top: y * cell.h, width: w * cell.w, height: h * cell.h, border: `${Math.round(cell.w / 4)}px solid ${b.color}` }} />
      </>
    );
  } else {
    const t = b.kind === "heavy" ? 3 : b.kind === "double" ? 4 : 1;
    const radius = b.kind === "round" ? Math.min(cell.w, cell.h) * 0.75 : 0;
    frame = (
      <div
        className="tui-frame"
        style={{
          left: (x + 0.5) * cell.w - t / 2,
          top: (y + 0.5) * cell.h - t / 2,
          width: (w - 1) * cell.w + t,
          height: (h - 1) * cell.h + t,
          border: `${t}px ${b.kind === "double" ? "double" : b.kind === "dashed" ? "dashed" : "solid"} ${b.color}`,
          borderRadius: radius,
        }}
      />
    );
  }
  const label = title ? fitCells(` ${title} `, w - 2) : "";
  return (
    <>
      {frame}
      {label && (
        <Text
          x={x + 1}
          y={y}
          text={label}
          pen={b.kind === "panel" ? { fg: mix(SCREEN_FG, b.color, 0.95), bg: b.color, bold: true } : { fg: titleFg, bg }}
          cell={cell}
        />
      )}
    </>
  );
}

/* ── Widgets ──────────────────────────────────────────────────────────── */

const V = (name: string) => tuiColor(`$${name}`)!;

/** Index props ("selected") as a number, or undefined. */
function index(v: string | undefined): number | undefined {
  if (v === undefined || v === "" || !/^-?\d+$/.test(v.trim())) return undefined;
  return Number(v);
}

function lines(v: string | undefined): string[] {
  return v ? v.split("\n") : [];
}

function on(v: string | undefined): boolean {
  return v === "true";
}

/** "1 2" → top/bottom 1, left/right 2 (CSS order for 1, 2 or 4 values). */
function padding(v: string | undefined): { t: number; r: number; b: number; l: number } {
  const p = (v ?? "").trim().split(/\s+/).filter(Boolean).map((s) => Math.max(0, Math.round(parseFloat(s)) || 0));
  if (p.length === 1) return { t: p[0]!, r: p[0]!, b: p[0]!, l: p[0]! };
  if (p.length === 2) return { t: p[0]!, r: p[1]!, b: p[0]!, l: p[1]! };
  if (p.length === 3) return { t: p[0]!, r: p[1]!, b: p[2]!, l: p[1]! };
  if (p.length >= 4) return { t: p[0]!, r: p[1]!, b: p[2]!, l: p[3]! };
  return { t: 0, r: 0, b: 0, l: 0 };
}

/** Where text goes in a w-cell line: "left" | "center" | "right" (text-align, or Textual's content-align). */
function alignX(n: SceneNode, fallback: "left" | "center" | "right" = "left"): "left" | "center" | "right" {
  const a = (n.style["text-align"] ?? n.style["content-align"] ?? n.style["content-align-horizontal"] ?? "").split(/\s+/)[0];
  return a === "center" || a === "right" || a === "left" ? a : fallback;
}

function alignY(n: SceneNode, fallback: "top" | "middle" | "bottom" = "top"): "top" | "middle" | "bottom" {
  const a = (n.style["content-align"] ?? "").split(/\s+/)[1] ?? n.style["content-align-vertical"] ?? n.style["vertical-align"];
  return a === "middle" || a === "bottom" || a === "top" ? a : fallback;
}

function offset(width: number, used: number, how: "left" | "center" | "right" | "top" | "middle" | "bottom"): number {
  const free = Math.max(0, width - used);
  return how === "center" || how === "middle" ? Math.floor(free / 2) : how === "right" || how === "bottom" ? free : 0;
}

/** Text wrapped into a box, aligned per the node's style. */
function Paragraph({ n, box, text, pen, cell, wrap = true }: { n: SceneNode; box: Layout; text: string; pen: Pen; cell: Cell; wrap?: boolean }) {
  const rows = (wrap ? wrapCells(text, box.w) : text.split("\n").map((t) => fitCells(t, box.w))).slice(0, Math.max(0, box.h));
  const top = box.y + offset(box.h, rows.length, alignY(n));
  return (
    <>
      {rows.map((row, i) => (
        <Text key={i} x={box.x + offset(box.w, cellWidth(row), alignX(n))} y={top + i} text={row} pen={pen} cell={cell} />
      ))}
    </>
  );
}

const VARIANT: Record<string, string> = {
  primary: "primary",
  success: "success",
  warning: "warning",
  error: "error",
  danger: "error",
};

/** Content of one widget (frames, text, bars) inside its w×h cells. Children are drawn by TuiNode. */
function draw(n: SceneNode, size: Size, ctx: Ctx): ReactNode {
  const { cell, bg, fg } = ctx;
  const { w, h } = size;
  const ts = textStyle(n.style["text-style"]);
  const pen: Pen = { ...ts, fg };
  const disabled = on(n.props.disabled);
  const b = borderOf(n, bg);
  const pad = padding(n.style.padding);
  const edge = b ? 1 : 0;
  const box: Layout = { x: edge + pad.l, y: edge + pad.t, w: w - 2 * edge - pad.l - pad.r, h: h - 2 * edge - pad.t - pad.b };
  const mid = box.y + Math.max(0, Math.floor((box.h - 1) / 2));
  const frame = b ? <Frame x={0} y={0} w={w} h={h} b={b} title={n.props.title} titleFg={fg} bg={bg} cell={cell} /> : null;
  const text = n.props.text ?? "";
  const dim = disabled ? { opacity: 0.5 } : undefined;

  switch (n.type) {
    case "text":
    case "label":
    case "icon":
      return (
        <>
          {frame}
          <Paragraph n={n} box={box} text={text} pen={pen} cell={cell} />
        </>
      );

    case "link":
      return (
        <>
          {frame}
          <Paragraph n={n} box={box} text={text} pen={{ ...pen, fg: tuiColor(n.style.color, bg) ?? V("text-primary"), underline: true }} cell={cell} />
        </>
      );

    case "button": {
      // Textual's button: a block of color, a lighter top edge, a darker bottom edge, bold centered text.
      const base = tuiColor(n.style.background, bg) ?? (VARIANT[n.props.variant ?? ""] ? V(VARIANT[n.props.variant!]!) : mix("#ffffff", bg, 0.12));
      const tall = h >= 3;
      const t = Math.max(1, Math.round(cell.h / 8));
      return (
        <div style={dim}>
          <Fill x={0} y={0} w={w} h={h} bg={base} cell={cell} />
          {tall && <Fill x={0} y={0} w={w} h={t / cell.h} bg={mix("#ffffff", base, 0.3)} cell={cell} />}
          {tall && <div className="tui-fill" style={{ left: 0, top: h * cell.h - t, width: w * cell.w, height: t, background: mix("#000000", base, 0.45) }} />}
          <Paragraph
            n={{ ...n, style: { "content-align": "center middle", ...n.style } }}
            box={{ x: 1, y: 0, w: w - 2, h }}
            text={text}
            pen={{ ...ts, bold: true, fg: tuiColor(n.style.color ?? "auto", base) }}
            cell={cell}
            wrap={false}
          />
        </div>
      );
    }

    case "input":
    case "select": {
      const tall = h >= 3;
      const back = tuiColor(n.style.background, bg) ?? V("surface");
      const inside: Layout = tall ? { x: 2, y: 1, w: w - 4, h: h - 2 } : { x: 1, y: 0, w: w - 2, h };
      const isSelect = n.type === "select";
      const items = lines(n.props.items);
      const value = isSelect ? (items[index(n.props.selected) ?? -1] ?? "") : on(n.props.password) ? "•".repeat(cellWidth(text)) : text;
      const shown = value || n.props.placeholder || (isSelect ? "Select" : "");
      const arrowW = isSelect ? 2 : 0;
      return (
        <div style={dim}>
          <Fill x={0} y={0} w={w} h={h} bg={back} cell={cell} />
          {tall && <Frame x={0} y={0} w={w} h={h} b={b ?? { kind: "tall", color: V("border-blurred") }} titleFg={fg} bg={back} cell={cell} />}
          {on(n.props.multiline) && !isSelect ? (
            <Paragraph n={n} box={inside} text={shown} pen={{ ...ts, fg: value ? fg : V("text-disabled") }} cell={cell} />
          ) : (
            <Text x={inside.x} y={inside.y} text={fitCells(shown, inside.w - arrowW)} pen={{ ...ts, fg: value ? fg : V("text-disabled") }} cell={cell} />
          )}
          {isSelect && <Text x={inside.x + inside.w - 1} y={inside.y} text="▼" pen={{ fg: V("text-muted") }} cell={cell} />}
        </div>
      );
    }

    case "checkbox":
    case "radio": {
      const checked = on(n.props.checked);
      const toggle = mix("#ffffff", bg, 0.14);
      return (
        <div style={dim}>
          {frame}
          {/* Textual's ▐X▌ toggle: a small block with the mark in it. */}
          <div className="tui-fill" style={{ left: (box.x + 0.5) * cell.w, top: mid * cell.h, width: 2 * cell.w, height: cell.h, background: toggle }} />
          <Text x={box.x + 1} y={mid} text={n.type === "radio" ? "●" : "X"} pen={{ fg: checked ? V("success") : mix("#000000", toggle, 0.3), bold: true }} cell={cell} />
          <Text x={box.x + 4} y={mid} text={fitCells(text, box.w - 4)} pen={pen} cell={cell} />
        </div>
      );
    }

    case "switch": {
      const checked = on(n.props.checked);
      const track = checked ? mix(V("success"), bg, 0.35) : mix("#ffffff", bg, 0.12);
      const knob = checked ? V("success") : mix("#ffffff", bg, 0.35);
      const tw = Math.min(6, Math.max(2, box.w));
      return (
        <div style={dim}>
          {frame}
          <Fill x={box.x} y={mid} w={tw} h={1} bg={track} cell={cell} />
          <Fill x={box.x + (checked ? tw - 2 : 0)} y={mid} w={2} h={1} bg={knob} cell={cell} />
          <Text x={box.x + tw + 1} y={mid} text={fitCells(text, box.w - tw - 1)} pen={pen} cell={cell} />
        </div>
      );
    }

    case "list": {
      const sel = index(n.props.selected);
      return (
        <div style={dim}>
          {frame}
          {lines(n.props.items)
            .slice(0, Math.max(0, box.h))
            .map((item, i) => (
              <span key={i}>
                {i === sel && <Fill x={box.x} y={box.y + i} w={box.w} h={1} bg={V("block-cursor-background")} cell={cell} />}
                <Text x={box.x} y={box.y + i} text={fitCells(item, box.w)} pen={i === sel ? { ...pen, fg: V("block-cursor-foreground"), bold: true } : pen} cell={cell} />
              </span>
            ))}
        </div>
      );
    }

    case "table":
      return (
        <div style={dim}>
          {frame}
          <Table n={n} box={box} pen={pen} cell={cell} />
        </div>
      );

    case "tree":
      return (
        <div style={dim}>
          {frame}
          <Tree n={n} box={box} pen={pen} cell={cell} />
        </div>
      );

    case "tabs": {
      const labels = lines(n.props.items);
      const sel = selectedTab(n, labels.length);
      let x = box.x;
      const parts = labels.map((label, i) => {
        const at = x;
        const width = cellWidth(label) + 2;
        x += width + 1;
        return { label, at, width, active: i === sel };
      });
      const accent = V("block-cursor-background");
      return (
        <>
          {frame}
          {parts.map((p, i) => (
            <Text key={i} x={p.at} y={box.y} text={fitCells(` ${p.label} `, box.x + box.w - p.at)} pen={p.active ? { ...pen, bold: true } : { ...pen, fg: V("text-muted") }} cell={cell} />
          ))}
          {box.h >= 2 && <HLine x={box.x} y={box.y + 1} w={box.w} color={mix("#ffffff", bg, 0.12)} heavy cell={cell} />}
          {box.h >= 2 && parts.filter((p) => p.active).map((p) => <HLine key="u" x={p.at} y={box.y + 1} w={Math.min(p.width, box.x + box.w - p.at)} color={accent} heavy cell={cell} />)}
        </>
      );
    }

    case "progress":
    case "slider": {
      const max = Number(n.props.max ?? 100) || 100;
      const min = n.type === "slider" ? Number(n.props.min ?? 0) || 0 : 0;
      const value = Number(n.props.value ?? 0) || 0;
      const ratio = Math.max(0, Math.min(1, (value - min) / (max - min || 1)));
      const label = n.type === "progress" ? `${Math.round(ratio * 100)}%` : "";
      const row = box.h >= 2 && text ? box.y + 1 : mid;
      const barW = Math.max(1, box.w - (label ? cellWidth(label) + 1 : 0));
      const filled = Math.round(ratio * barW);
      const color = tuiColor(n.style.color, bg) ?? (n.type === "progress" ? V("primary") : V("accent"));
      return (
        <div style={dim}>
          {frame}
          {box.h >= 2 && text && <Text x={box.x} y={box.y} text={fitCells(text, box.w)} pen={pen} cell={cell} />}
          <HLine x={box.x} y={row} w={barW} color={mix("#ffffff", bg, 0.15)} heavy={n.type === "progress"} cell={cell} />
          <HLine x={box.x} y={row} w={filled} color={color} heavy={n.type === "progress"} cell={cell} />
          {n.type === "slider" && <Text x={box.x + Math.min(barW - 1, filled)} y={row} text="●" pen={{ fg: color }} cell={cell} />}
          {label && <Text x={box.x + barW + 1} y={row} text={label} pen={pen} cell={cell} />}
        </div>
      );
    }

    case "menu": {
      const back = tuiColor(n.style.background, bg) ?? V("panel");
      return (
        <>
          <Fill x={0} y={0} w={w} h={h} bg={back} cell={cell} />
          <Text x={1} y={0} text={fitCells(lines(n.props.items).map((i) => ` ${i} `).join(" "), w - 2)} pen={{ ...pen, fg: tuiColor(n.style.color, back) ?? fg }} cell={cell} />
        </>
      );
    }

    case "statusbar":
      return <StatusBar n={n} size={size} ctx={ctx} pen={pen} />;

    case "divider":
      return w >= h ? (
        <HLine x={0} y={Math.floor((h - 1) / 2)} w={w} color={tuiColor(n.style.color, bg) ?? BORDER_FG} cell={cell} />
      ) : (
        <VLine x={Math.floor((w - 1) / 2)} y={0} h={h} color={tuiColor(n.style.color, bg) ?? BORDER_FG} cell={cell} />
      );

    case "image":
      return (
        <>
          <div className="tui-fill tui-image" style={{ left: 0, top: 0, width: w * cell.w, height: h * cell.h }} />
          {frame}
          <Paragraph
            n={{ ...n, style: { "content-align": "center middle" } }}
            box={box}
            text={n.props.alt ?? n.props.src ?? "image"}
            pen={{ fg: V("text-muted") }}
            cell={cell}
          />
        </>
      );

    case "custom":
      return (
        <>
          {frame ?? <div className="tui-custom" />}
          {text ? <Paragraph n={n} box={box} text={text} pen={pen} cell={cell} /> : <Text x={box.x} y={box.y} text={fitCells(n.tag ?? "custom", box.w)} pen={{ fg: V("text-disabled") }} cell={cell} />}
        </>
      );

    default:
      // Containers (box, panel, card, nav, window): a frame and its title; children draw themselves.
      return (
        <>
          {frame}
          {text && n.children.length === 0 && <Paragraph n={n} box={box} text={text} pen={pen} cell={cell} />}
        </>
      );
  }
}

/** A data table: a bold header row, then rows of tab-separated cells in columns sized to their content. */
function Table({ n, box, pen, cell }: { n: SceneNode; box: Layout; pen: Pen; cell: Cell }) {
  const header = lines(n.props.columns).map((c) => c.split("\t")[0]!);
  const rows = lines(n.props.items).map((r) => r.split("\t"));
  const cols = Math.max(header.length, ...rows.map((r) => r.length));
  const widths = Array.from({ length: cols }, (_, c) => Math.max(cellWidth(header[c] ?? ""), ...rows.map((r) => cellWidth(r[c] ?? ""))) + 2);
  const line = (cells: string[]) => fitCells(widths.map((wd, c) => padCells(` ${cells[c] ?? ""}`, wd)).join(""), box.w);
  const sel = index(n.props.selected);
  const at = header.length ? 1 : 0;
  return (
    <>
      {header.length > 0 && (
        <>
          <Fill x={box.x} y={box.y} w={box.w} h={1} bg={V("panel")} cell={cell} />
          <Text x={box.x} y={box.y} text={line(header)} pen={{ ...pen, bold: true, fg: V("text") }} cell={cell} />
        </>
      )}
      {rows.slice(0, Math.max(0, box.h - at)).map((r, i) => (
        <span key={i}>
          {i === sel && <Fill x={box.x} y={box.y + at + i} w={box.w} h={1} bg={V("block-cursor-background")} cell={cell} />}
          <Text x={box.x} y={box.y + at + i} text={line(r)} pen={i === sel ? { ...pen, fg: V("block-cursor-foreground") } : pen} cell={cell} />
        </span>
      ))}
    </>
  );
}

/** A tree: one line per node, indented two spaces per level, drawn with guide lines like Textual's Tree. */
function Tree({ n, box, pen, cell }: { n: SceneNode; box: Layout; pen: Pen; cell: Cell }) {
  const items = lines(n.props.items).map((raw) => {
    const indent = raw.length - raw.trimStart().length;
    return { depth: Math.floor(indent / 2), label: raw.trim() };
  });
  const sel = index(n.props.selected);
  const guide = V("text-disabled");
  /** Another node at `depth` follows before the branch ends. */
  const more = (i: number, depth: number) => {
    for (let j = i + 1; j < items.length; j++) {
      if (items[j]!.depth < depth) return false;
      if (items[j]!.depth === depth) return true;
    }
    return false;
  };
  return (
    <>
      {items.slice(0, Math.max(0, box.h)).map((it, i) => {
        let prefix = "";
        for (let d = 1; d < it.depth; d++) prefix += more(i, d) ? "│   " : "    ";
        if (it.depth > 0) prefix += more(i, it.depth) ? "├── " : "└── ";
        const open = items[i + 1] && items[i + 1]!.depth > it.depth ? "▼ " : "";
        const x = box.x + cellWidth(prefix);
        return (
          <span key={i}>
            {i === sel && <Fill x={box.x} y={box.y + i} w={box.w} h={1} bg={V("block-cursor-background")} cell={cell} />}
            <Text x={box.x} y={box.y + i} text={fitCells(prefix, box.w)} pen={{ fg: guide }} cell={cell} />
            <Text x={x} y={box.y + i} text={fitCells(open + it.label, box.x + box.w - x)} pen={i === sel ? { ...pen, bold: true } : pen} cell={cell} />
          </span>
        );
      })}
    </>
  );
}

/** A header (title centered) or a footer (key hints "q Quit": the key bold in the accent color). */
function StatusBar({ n, size, ctx, pen }: { n: SceneNode; size: Size; ctx: Ctx; pen: Pen }) {
  const { cell, bg } = ctx;
  const back = tuiColor(n.style.background, bg) ?? V("footer-background");
  const fg = tuiColor(n.style.color, back) ?? V("text");
  const items = lines(n.props.items);
  const text = n.props.text ?? "";
  const row = Math.floor((size.h - 1) / 2);
  let x = 1;
  const hints = items.map((item, i) => {
    const sp = item.indexOf(" ");
    const key = sp > 0 ? item.slice(0, sp) : "";
    const label = sp > 0 ? item.slice(sp + 1) : item;
    const at = x;
    x += (key ? cellWidth(key) + 1 : 0) + cellWidth(label) + 2;
    return (
      <span key={i}>
        {key && <Text x={at} y={row} text={key} pen={{ fg: V("footer-key-foreground"), bold: true }} cell={cell} />}
        <Text x={at + (key ? cellWidth(key) + 1 : 0)} y={row} text={label} pen={{ ...pen, fg }} cell={cell} />
      </span>
    );
  });
  const title = text && fitCells(text, size.w - 4);
  return (
    <>
      <Fill x={0} y={0} w={size.w} h={size.h} bg={back} cell={cell} />
      {title && !items.length && <Text x={1} y={row} text="⭘" pen={{ fg }} cell={cell} />}
      {title && (
        <Text x={items.length ? 1 : Math.floor((size.w - cellWidth(title)) / 2)} y={row} text={title} pen={{ ...pen, fg }} cell={cell} />
      )}
      {!title && hints}
    </>
  );
}
