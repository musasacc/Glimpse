import { useState } from "react";
import { formatSource, NODE_TYPE_DOCS, NODE_TYPES, type Layout, type NodeType, type Op, type SceneNode } from "@glimpse/core";
import { canUngroup, ungroupSelection } from "./arrange";
import { BehaviorSection } from "./Panels";
import { MOD } from "./platform";
import { editableProp, type SceneTarget } from "./scene-geometry";
import { sceneMode, useSceneMode } from "./scene-mode";
import { store, useStore } from "./store";
import { tuiColor } from "./tui-colors";

/**
 * Inspector for a widget of a terminal UI or native GUI mock: its type, content
 * (text, rows one per line, a table as a grid, checked/disabled…), position and
 * size in cells or pixels, and the style keys the target understands.
 */
export function SceneInspector({ openTalk }: { openTalk: () => void }) {
  const state = useStore();
  const sm = useSceneMode();
  const scene = store.scene;
  const node = state.selected ? scene?.nodes[state.selected] : undefined;
  if (!scene) {
    return (
      <div className="section">
        <h3>Inspector</h3>
        <div className="hint">{sm.status === "missing" ? `Waiting for ${sm.file}…` : "Loading the scene…"}</div>
      </div>
    );
  }
  if (!node || node.parent === null) return <RootInspector target={sm.target} />;
  return <WidgetInspector key={node.id} node={node} target={sm.target} openTalk={openTalk} />;
}

function WidgetInspector({ node, target, openTalk }: { node: SceneNode; target: SceneTarget; openTalk: () => void }) {
  const src = formatSource(node.source);
  const comments = (store.log?.ops ?? []).filter((o): o is Extract<Op, { op: "comment" }> => o.op === "comment");
  return (
    <>
      <div className="section">
        <h3>Widget</h3>
        <div className="field">
          <label>Type</label>
          <select
            className="input"
            value={node.type}
            title={NODE_TYPE_DOCS[node.type]}
            onChange={(e) => store.edit({ op: "swapType", node: node.id, from: node.type, to: e.target.value as NodeType })}
          >
            {NODE_TYPES.filter((t) => t !== "root").map((t) => (
              <option key={t} value={t} title={NODE_TYPE_DOCS[t]}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div className="hint scene-doc">{NODE_TYPE_DOCS[node.type]}</div>
        <div className="scene-meta">
          {node.tag && <code>{node.tag}</code>}
          <code>#{node.id}</code>
          {src && <code title="Where the code creates it">{src}</code>}
        </div>
        <div className="row">
          {editableProp(node) && (
            <button className="btn" onClick={() => sceneMode.surface.editText?.(node.id)}>
              Edit text
            </button>
          )}
          <button className="btn" onClick={() => store.duplicateSelected()}>
            Duplicate
          </button>
          <button className="btn" onClick={() => store.edit({ op: "setHidden", node: node.id, from: !!node.hidden, to: !node.hidden })}>
            {node.hidden ? "Show" : "Hide"}
          </button>
          <button className="btn" onClick={() => store.edit({ op: "setLocked", node: node.id, from: !!node.locked, to: !node.locked })}>
            {node.locked ? "Unlock" : "Lock"}
          </button>
          {canUngroup(node) && (
            <button className="btn" title={`Replace this container by its children (${MOD}Shift+G)`} onClick={ungroupSelection}>
              Ungroup
            </button>
          )}
          <button className="btn" style={{ color: "var(--danger)" }} onClick={() => store.deleteSelected()}>
            Delete
          </button>
        </div>
      </div>

      <ContentSection node={node} />
      <LayoutSection node={node} target={target} />
      <StyleSection node={node} target={target} />
      <BehaviorSection node={node} />

      <div className="section">
        <h3>Talk to the AI</h3>
        {comments
          .filter((c) => c.node === node.id)
          .map((c) => (
            <div className="pin" key={c.id}>
              <span className="num">{comments.indexOf(c) + 1}</span>
              <span>{c.text}</span>
            </div>
          ))}
        <button className="btn" onClick={openTalk}>
          🎤 Point &amp; talk <span className="kbd">T</span>
        </button>
      </div>
    </>
  );
}

/** Nothing selected: the screen (terminal size) or the window (title, client size). */
function RootInspector({ target }: { target: SceneTarget }) {
  const sm = useSceneMode();
  const root = store.scene!.nodes[store.scene!.rootId]!;
  const meta = sm.extras.meta;
  return (
    <>
      <div className="section">
        <h3>{target === "tui" ? "Screen" : "Window"}</h3>
        {target === "native" && <TextField node={root} k="title" label="Title" placeholder={typeof meta?.title === "string" ? meta.title : "Window title"} />}
        <SizeFields node={root} target={target} />
        <div className="scene-meta">
          <code>{sm.file}</code>
          {typeof meta?.framework === "string" && <code>{meta.framework}</code>}
          {typeof meta?.command === "string" && <code title="How the real app runs">{meta.command}</code>}
        </div>
      </div>
      <div className="section">
        <h3>Inspector</h3>
        <div className="hint">
          Click a widget to select it. Drag to move it and pull its handles to resize: both snap to {target === "tui" ? "whole cells" : "pixels"}.
          Double-click to edit its text.
          <br />
          <span className="kbd">T</span> talk to the AI about it · <span className="kbd">Del</span> delete · <span className="kbd">{MOD}D</span> duplicate ·{" "}
          <span className="kbd">{MOD}Z</span> undo · arrows nudge 1 {target === "tui" ? "cell" : "px"}
          <br />
          Shift-click or drag on the background to select several · <span className="kbd">{MOD}G</span> group · <span className="kbd">R</span> or Alt-drag:
          draw a box and tell the AI what goes there
        </div>
      </div>
    </>
  );
}

/* ── Content ──────────────────────────────────────────────────────────── */

/** Which props each type shows, besides text. */
const TEXT_TYPES = new Set<NodeType>(["text", "label", "button", "link", "icon", "input", "checkbox", "radio", "switch", "statusbar", "progress", "custom"]);
const TITLE_TYPES = new Set<NodeType>(["panel", "box", "card", "window", "nav"]);
const ITEM_TYPES = new Set<NodeType>(["list", "select", "tabs", "menu", "tree", "statusbar"]);
const SELECT_TYPES = new Set<NodeType>(["list", "select", "tabs", "table", "tree"]);
const DISABLE_TYPES = new Set<NodeType>(["button", "input", "checkbox", "radio", "switch", "select", "list", "table", "tree", "slider", "tabs", "link"]);
const TOGGLES: { key: string; label: string; types: Set<NodeType> }[] = [
  { key: "checked", label: "Checked", types: new Set(["checkbox", "radio", "switch"]) },
  { key: "disabled", label: "Disabled", types: DISABLE_TYPES },
  { key: "default", label: "Default button", types: new Set(["button"]) },
  { key: "password", label: "Password", types: new Set(["input"]) },
  { key: "multiline", label: "Multi-line", types: new Set(["input"]) },
  { key: "readonly", label: "Read-only", types: new Set(["input"]) },
  { key: "expanded", label: "Expanded", types: new Set(["tree"]) },
];
const VARIANTS = ["default", "primary", "success", "warning", "error"];
/** Props with a field of their own; anything else the agent wrote shows under "Other". */
const KNOWN = new Set(["text", "title", "placeholder", "items", "columns", "selected", "value", "min", "max", "step", "variant", "group", "href", "src", "alt", ...TOGGLES.map((t) => t.key)]);

function setProp(node: SceneNode, key: string, value: string | null): void {
  const from = node.props[key] ?? null;
  if (from !== value) store.edit({ op: "setProp", node: node.id, key, from, to: value });
}

function ContentSection({ node }: { node: SceneNode }) {
  const t = node.type;
  const items = (node.props.items ?? "").split("\n").filter((_, i, a) => a.length > 1 || a[0] !== "");
  const other = Object.keys(node.props).filter((k) => !KNOWN.has(k));
  return (
    <div className="section">
      <h3>Content</h3>
      {(TEXT_TYPES.has(t) || (node.props.text !== undefined && !TITLE_TYPES.has(t))) && <TextField node={node} k="text" label={t === "input" ? "Value" : "Text"} multiline={t === "text" || !!node.props.multiline} />}
      {(TITLE_TYPES.has(t) || node.props.title !== undefined) && <TextField node={node} k="title" label="Title" />}
      {(t === "input" || t === "select") && <TextField node={node} k="placeholder" label="Placeholder" />}
      {(ITEM_TYPES.has(t) || (node.props.items !== undefined && t !== "table")) && (
        <TextField node={node} k="items" label={t === "statusbar" ? "Key hints" : t === "tabs" ? "Tabs" : t === "tree" ? "Nodes" : "Items"} multiline hint={t === "tree" ? "One per line, two spaces per level" : t === "statusbar" ? 'One per line, e.g. "q Quit"' : "One per line"} />
      )}
      {t === "table" && <TableEditor node={node} />}
      {SELECT_TYPES.has(t) && (
        <div className="field">
          <label>Selected</label>
          <select className="input" value={node.props.selected ?? ""} onChange={(e) => setProp(node, "selected", e.target.value === "" ? null : e.target.value)}>
            <option value="">None</option>
            {(t === "table" ? (node.props.items ?? "").split("\n").map((r) => r.split("\t")[0] ?? "") : items).map((label, i) => (
              <option key={i} value={String(i)}>
                {i + 1}. {label.trim() || "(empty)"}
              </option>
            ))}
          </select>
        </div>
      )}
      {(t === "progress" || t === "slider") && <NumberField node={node} k="value" label="Value" />}
      {t === "slider" && <NumberField node={node} k="min" label="Min" />}
      {(t === "progress" || t === "slider") && <NumberField node={node} k="max" label="Max" />}
      {t === "slider" && <NumberField node={node} k="step" label="Step" />}
      {t === "button" && (
        <div className="field">
          <label>Variant</label>
          <select className="input" value={node.props.variant ?? "default"} onChange={(e) => setProp(node, "variant", e.target.value === "default" && !node.props.variant ? null : e.target.value)}>
            {VARIANTS.map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </div>
      )}
      {t === "radio" && <TextField node={node} k="group" label="Group" />}
      {t === "link" && <TextField node={node} k="href" label="Link to" />}
      {t === "image" && <TextField node={node} k="src" label="Source" placeholder="assets/logo.png" />}
      {t === "image" && <TextField node={node} k="alt" label="Description" />}
      <div className="scene-toggles">
        {TOGGLES.filter((g) => g.types.has(t) || node.props[g.key] !== undefined).map((g) => (
          <label key={g.key} className="check">
            <input type="checkbox" checked={node.props[g.key] === "true"} onChange={(e) => setProp(node, g.key, e.target.checked ? "true" : node.props[g.key] === undefined ? null : "false")} />
            {g.label}
          </label>
        ))}
      </div>
      {other.map((k) => (
        <TextField key={k} node={node} k={k} label={k} />
      ))}
    </div>
  );
}

/** A prop as a text field (or a textarea for lists), saved when it loses focus. */
function TextField({ node, k, label, multiline, placeholder, hint }: { node: SceneNode; k: string; label: string; multiline?: boolean; placeholder?: string; hint?: string }) {
  const current = node.props[k] ?? "";
  const commit = (value: string) => {
    if (value === current) return;
    if (k === "text") store.edit({ op: "setText", node: node.id, from: current, to: value });
    else setProp(node, k, value === "" ? null : value);
  };
  return (
    <div className={`field${multiline ? " tall" : ""}`}>
      <label title={hint}>{label}</label>
      {multiline ? (
        <textarea
          key={`${node.id}:${k}:${current}`}
          className="input"
          rows={Math.min(8, Math.max(2, current.split("\n").length))}
          defaultValue={current}
          placeholder={placeholder ?? hint}
          spellCheck={false}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && (e.target as HTMLTextAreaElement).blur()}
        />
      ) : (
        <input
          key={`${node.id}:${k}:${current}`}
          className="input"
          defaultValue={current}
          placeholder={placeholder}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
      )}
    </div>
  );
}

function NumberField({ node, k, label }: { node: SceneNode; k: string; label: string }) {
  const current = node.props[k] ?? "";
  return (
    <div className="field">
      <label>{label}</label>
      <input
        key={`${node.id}:${k}:${current}`}
        className="input"
        type="number"
        defaultValue={current}
        onBlur={(e) => setProp(node, k, e.target.value.trim() === "" ? null : e.target.value.trim())}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
    </div>
  );
}

/** A table's header and rows as a grid of cells (stored as lines, cells separated by tabs). */
function TableEditor({ node }: { node: SceneNode }) {
  const header = (node.props.columns ?? "").split("\n").filter((c, i, a) => c !== "" || a.length > 1);
  const rows = (node.props.items ?? "").split("\n").filter((r, i, a) => r !== "" || a.length > 1).map((r) => r.split("\t"));
  const cols = Math.max(1, header.length, ...rows.map((r) => r.length));
  const save = (h: string[], r: string[][]) => {
    const columns = h.join("\n");
    const items = r.map((row) => row.join("\t")).join("\n");
    const ops: Op[] = [];
    if (columns !== (node.props.columns ?? "")) ops.push({ op: "setProp", node: node.id, key: "columns", from: node.props.columns ?? null, to: columns || null });
    if (items !== (node.props.items ?? "")) ops.push({ op: "setProp", node: node.id, key: "items", from: node.props.items ?? null, to: items || null });
    store.edit(...ops);
  };
  const pad = (r: string[]) => Array.from({ length: cols }, (_, c) => r[c] ?? "");
  const cell = (key: string, value: string, onCommit: (v: string) => void, head?: boolean) => (
    <input
      key={`${key}:${value}`}
      className={`input${head ? " head" : ""}`}
      defaultValue={value}
      onBlur={(e) => e.target.value !== value && onCommit(e.target.value)}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    />
  );
  return (
    <div className="scene-table-edit">
      <div className="grid" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr)) 22px` }}>
        {pad(header).map((h, c) =>
          cell(`h${c}`, h, (v) => {
            const next = pad(header);
            next[c] = v;
            save(next, rows);
          }, true),
        )}
        <button className="icon-btn" title="Remove the last column" disabled={cols <= 1} onClick={() => save(pad(header).slice(0, -1), rows.map((r) => pad(r).slice(0, -1)))}>
          −
        </button>
        {rows.map((r, i) => (
          <Row key={i}>
            {pad(r).map((v, c) =>
              cell(`${i}:${c}`, v, (value) => {
                const next = rows.map(pad);
                next[i]![c] = value;
                save(header, next);
              }),
            )}
            <button className="icon-btn" title="Remove this row" onClick={() => save(header, rows.filter((_, j) => j !== i))}>
              ×
            </button>
          </Row>
        ))}
      </div>
      <div className="row">
        {/* One empty cell would be no rows at all (items ""): the first row of a one-column table gets a placeholder. */}
        <button className="btn" onClick={() => save(header, [...rows.map(pad), cols === 1 && rows.length === 0 ? ["Row 1"] : pad([])])}>
          + Row
        </button>
        <button className="btn" onClick={() => save([...pad(header), `Column ${cols + 1}`], rows.map((r) => [...pad(r), ""]))}>
          + Column
        </button>
      </div>
    </div>
  );
}

const Row = ({ children }: { children: React.ReactNode }) => <>{children}</>;

/* ── Layout ───────────────────────────────────────────────────────────── */

function LayoutSection({ node, target }: { node: SceneNode; target: SceneTarget }) {
  return (
    <div className="section">
      <h3>Layout · {target === "tui" ? "cells" : "px"}</h3>
      <div className="scene-xywh">
        {(["x", "y", "w", "h"] as const).map((k) => (
          <LayoutInput key={k} node={node} k={k} />
        ))}
      </div>
      <div className="hint">Relative to {node.parent ? `#${node.parent}` : "the screen"}.</div>
    </div>
  );
}

function SizeFields({ node, target }: { node: SceneNode; target: SceneTarget }) {
  return (
    <div className="field">
      <label>Size ({target === "tui" ? "cells" : "px"})</label>
      <div className="scene-xywh two">
        <LayoutInput node={node} k="w" />
        <LayoutInput node={node} k="h" />
      </div>
    </div>
  );
}

function LayoutInput({ node, k }: { node: SceneNode; k: keyof Layout }) {
  const current = node.layout[k];
  const commit = (raw: string) => {
    const v = Math.round(Number(raw));
    if (!Number.isFinite(v) || v === current || ((k === "w" || k === "h") && v < 1)) return;
    const to = { ...node.layout, [k]: v };
    if (k === "x" || k === "y") store.edit({ op: "move", node: node.id, from: { x: node.layout.x, y: node.layout.y }, to: { x: to.x, y: to.y } });
    else store.edit({ op: "resize", node: node.id, from: { ...node.layout }, to });
  };
  return (
    <label className="scene-num">
      <span>{k.toUpperCase()}</span>
      <input
        key={`${node.id}:${k}:${current}`}
        className="input"
        type="number"
        defaultValue={current}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
    </label>
  );
}

/* ── Style ────────────────────────────────────────────────────────────── */

interface StyleField {
  key: string;
  label: string;
  color?: boolean;
  placeholder?: string;
  options?: string[];
}

const TUI_STYLE: StyleField[] = [
  { key: "color", label: "Text color", color: true, placeholder: "$text, cyan, #ff8800" },
  { key: "background", label: "Background", color: true, placeholder: "$panel, black" },
  { key: "text-align", label: "Align", options: ["", "left", "center", "right"] },
  { key: "padding", label: "Padding", placeholder: "0 1 (rows cols)" },
];

const NATIVE_STYLE: StyleField[] = [
  { key: "color", label: "Text color", color: true },
  { key: "background", label: "Background", color: true },
  { key: "font-family", label: "Font", placeholder: "system" },
  { key: "font-size", label: "Font size", placeholder: "13px" },
  { key: "font-weight", label: "Weight", options: ["", "normal", "500", "600", "bold"] },
  { key: "text-align", label: "Align", options: ["", "left", "center", "right"] },
  { key: "padding", label: "Padding", placeholder: "8px 12px" },
  { key: "border", label: "Border", placeholder: "1px solid #c8c8c8" },
  { key: "border-radius", label: "Radius", placeholder: "6px" },
  { key: "opacity", label: "Opacity", placeholder: "1" },
];

const BORDERS = ["", "none", "solid", "round", "heavy", "double", "dashed", "ascii", "tall", "panel"];
const TEXT_STYLES = ["bold", "italic", "underline", "reverse", "dim", "strike"];
/** Suggestions for terminal colors: Textual's theme variables and the ANSI names. */
const TUI_COLORS = ["$primary", "$secondary", "$accent", "$success", "$warning", "$error", "$text", "$text-muted", "$surface", "$panel", "$background", "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "bright-black", "bright-white"];

function setStyle(node: SceneNode, key: string, value: string): void {
  const from = node.style[key] ?? null;
  const to = value.trim() === "" ? null : value.trim();
  if (from !== to) store.edit({ op: "setStyle", node: node.id, key, from, to });
}

function StyleSection({ node, target }: { node: SceneNode; target: SceneTarget }) {
  const fields = target === "tui" ? TUI_STYLE : NATIVE_STYLE;
  const known = new Set([...fields.map((f) => f.key), ...(target === "tui" ? ["text-style", "border"] : [])]);
  const other = Object.keys(node.style).filter((k) => !known.has(k));
  return (
    <div className="section">
      <h3>Style</h3>
      {target === "tui" && <TextStyleField node={node} />}
      {target === "tui" && <BorderField key={node.style.border ?? ""} node={node} />}
      {fields.map((f) => (
        <StyleInput key={f.key} node={node} f={f} target={target} />
      ))}
      {other.map((k) => (
        <StyleInput key={k} node={node} f={{ key: k, label: k }} target={target} />
      ))}
      <datalist id="tui-colors">
        {TUI_COLORS.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
    </div>
  );
}

function StyleInput({ node, f, target }: { node: SceneNode; f: StyleField; target: SceneTarget }) {
  const current = node.style[f.key] ?? "";
  if (f.options) {
    return (
      <div className="field">
        <label>{f.label}</label>
        <select className="input" value={current} onChange={(e) => setStyle(node, f.key, e.target.value)}>
          {[...new Set([...f.options, current])].map((o) => (
            <option key={o} value={o}>
              {o || "default"}
            </option>
          ))}
        </select>
      </div>
    );
  }
  const swatch = f.color ? (target === "tui" ? tuiColor(current) : current) : undefined;
  return (
    <div className="field">
      <label>{f.label}</label>
      <div className="color">
        {f.color && <input type="color" value={toHex(swatch)} title="Pick a color" onChange={(e) => setStyle(node, f.key, e.target.value)} />}
        <input
          key={`${node.id}:${f.key}:${current}`}
          className="input"
          defaultValue={current}
          placeholder={f.placeholder}
          list={f.color && target === "tui" ? "tui-colors" : undefined}
          onBlur={(e) => setStyle(node, f.key, e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
      </div>
    </div>
  );
}

/** Terminal text styles as toggles: bold, italic, underline, reverse, dim, strike. */
function TextStyleField({ node }: { node: SceneNode }) {
  const words = (node.style["text-style"] ?? "").split(/\s+/).filter(Boolean);
  const toggle = (w: string) => {
    const next = words.includes(w) ? words.filter((x) => x !== w) : [...words, w];
    setStyle(node, "text-style", next.join(" "));
  };
  return (
    <div className="field">
      <label>Text style</label>
      <div className="scene-chips">
        {TEXT_STYLES.map((w) => (
          <button key={w} className={`chip${words.includes(w) ? " on" : ""}`} aria-pressed={words.includes(w)} onClick={() => toggle(w)}>
            {w}
          </button>
        ))}
      </div>
    </div>
  );
}

/** A terminal frame: its kind and color ("round $accent"). */
function BorderField({ node }: { node: SceneNode }) {
  const [kind = "", ...rest] = (node.style.border ?? "").trim().split(/\s+/);
  const color = rest.join(" ");
  const [draft, setDraft] = useState(color);
  const save = (k: string, c: string) => setStyle(node, "border", k ? `${k}${c.trim() && k !== "none" ? ` ${c.trim()}` : ""}` : "");
  return (
    <div className="field">
      <label>Border</label>
      <div className="color">
        <select className="input" value={kind} onChange={(e) => save(e.target.value, draft)}>
          {[...new Set([...BORDERS, kind])].map((b) => (
            <option key={b} value={b}>
              {b || "default"}
            </option>
          ))}
        </select>
        <input
          className="input"
          value={draft}
          placeholder="color"
          list="tui-colors"
          disabled={!kind || kind === "none"}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => save(kind, draft)}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
      </div>
    </div>
  );
}

/** A CSS color as #rrggbb for <input type=color> (black when it isn't one). */
function toHex(color: string | undefined): string {
  if (!color) return "#000000";
  if (/^#[0-9a-f]{6}$/i.test(color)) return color;
  if (/^#[0-9a-f]{3}$/i.test(color)) return "#" + [...color.slice(1)].map((c) => c + c).join("");
  const m = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  return m ? "#" + m.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, "0")).join("") : "#000000";
}
