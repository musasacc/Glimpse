import { useState } from "react";
import type { NodeType, Op, SceneNode } from "@glimpse/core";
import { canUngroup, ungroupSelection } from "./arrange";
import { SelectionInspector } from "./EditTools";
import { store, useStore } from "./store";
import { editText } from "./Canvas";
import { loop } from "./loop";
import { MOD } from "./platform";
import { SceneInspector } from "./SceneInspector";

/** Layers: the element tree of the page. */
export function Layers() {
  const state = useStore();
  const scene = store.scene;
  if (!scene) return <div className="side-empty">Loading page…</div>;
  const rows: { node: SceneNode; depth: number }[] = [];
  const walk = (id: string, depth: number) => {
    for (const c of scene.nodes[id]!.children) {
      const node = scene.nodes[c]!;
      rows.push({ node, depth });
      walk(c, depth + 1);
    }
  };
  walk(scene.rootId, 0);
  return (
    <>
      {rows.length === 0 && <div className="side-empty">This page has no elements yet.</div>}
      {rows.map(({ node, depth }) => (
        <div
          key={node.id}
          className={`layer${state.multi.includes(node.id) ? " selected" : ""}`}
          style={{ paddingLeft: 10 + depth * 12, opacity: node.hidden ? 0.45 : 1 }}
          onClick={(e) => (e.shiftKey ? store.toggleSelect(node.id) : store.select(node.id))}
          onMouseEnter={() => store.set({ hovered: node.id })}
          onMouseLeave={() => store.set({ hovered: null })}
        >
          <span className="tag">{node.tag ?? node.type}</span>
          <span className="txt">{node.props.text ?? (node.props.id ? `#${node.props.id}` : "")}</span>
        </div>
      ))}
    </>
  );
}

const STYLE_FIELDS: { key: string; label: string; color?: boolean; placeholder?: string }[] = [
  { key: "color", label: "Text color", color: true },
  { key: "background", label: "Background", color: true },
  { key: "font-size", label: "Font size", placeholder: "16px" },
  { key: "font-weight", label: "Weight", placeholder: "400" },
  { key: "padding", label: "Padding", placeholder: "8px 16px" },
  { key: "border-radius", label: "Radius", placeholder: "8px" },
  { key: "border", label: "Border", placeholder: "1px solid #000" },
  { key: "box-shadow", label: "Shadow", placeholder: "0 2px 8px #0003" },
  { key: "opacity", label: "Opacity", placeholder: "1" },
];

const TYPES: NodeType[] = ["box", "text", "button", "link", "input", "image", "list", "nav", "card"];

/** Inspector: text, style, type, visibility, behavior and pinned instructions. */
export function Inspector({ openTalk }: { openTalk: () => void }) {
  const state = useStore();
  const node = state.selected ? store.scene?.nodes[state.selected] : undefined;
  if (store.selection.length > 1) return <SelectionInspector />;
  if (store.sceneSurface) return <SceneInspector openTalk={openTalk} />;
  if (!node) {
    return (
      <div className="section">
        <h3>Inspector</h3>
        <div className="hint">
          Click an element to select it. Drag to move it, double-click to edit its text.
          <br />
          <span className="kbd">T</span> talk to the AI about it · <span className="kbd">Del</span> delete ·{" "}
          <span className="kbd">{MOD}D</span> duplicate · <span className="kbd">{MOD}Z</span> undo · arrows nudge
          <br />
          Shift-click or drag on the background to select several · <span className="kbd">{MOD}G</span> group ·{" "}
          <span className="kbd">R</span> or Alt-drag: draw a box and tell the AI what goes there
        </div>
      </div>
    );
  }
  const computed = (() => {
    const el = store.bridge?.el(node.id);
    return el ? el.ownerDocument.defaultView!.getComputedStyle(el) : null;
  })();
  const setStyle = (key: string, value: string) => {
    const from = node.style[key] ?? null;
    const to = value.trim() === "" ? null : value.trim();
    if (from !== to) store.edit({ op: "setStyle", node: node.id, key, from, to });
  };
  const comments = (store.log?.ops ?? []).filter((o): o is Extract<Op, { op: "comment" }> => o.op === "comment");

  return (
    <>
      <div className="section">
        <h3>Element</h3>
        <div className="field">
          <label>Type</label>
          <select
            className="input"
            value={node.type}
            onChange={(e) => store.edit({ op: "swapType", node: node.id, from: node.type, to: e.target.value as NodeType })}
          >
            {[...new Set([node.type, ...TYPES])].map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </div>
        {node.children.length === 0 && (
          <div className="field">
            <label>Text</label>
            <input
              key={`${node.id}:${node.props.text}`}
              className="input"
              defaultValue={node.props.text ?? ""}
              onBlur={(e) => {
                const to = e.target.value;
                if (to !== (node.props.text ?? "")) store.edit({ op: "setText", node: node.id, from: node.props.text ?? "", to });
              }}
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            />
          </div>
        )}
        <div className="row">
          <button className="btn" onClick={() => editText(node.id)} disabled={node.children.length > 0}>
            Edit text
          </button>
          <button className="btn" onClick={() => store.duplicateSelected()}>
            Duplicate
          </button>
          <button
            className="btn"
            onClick={() => store.edit({ op: "setHidden", node: node.id, from: !!node.hidden, to: !node.hidden })}
          >
            {node.hidden ? "Show" : "Hide"}
          </button>
          <button
            className="btn"
            onClick={() => store.edit({ op: "setLocked", node: node.id, from: !!node.locked, to: !node.locked })}
          >
            {node.locked ? "Unlock" : "Lock"}
          </button>
          {canUngroup(node) && (
            <button className="btn" title={`Replace this box by its children (${MOD}Shift+G)`} onClick={ungroupSelection}>
              Ungroup
            </button>
          )}
          <button className="btn" style={{ color: "var(--danger)" }} onClick={() => store.deleteSelected()}>
            Delete
          </button>
        </div>
      </div>

      <div className="section">
        <h3>Style</h3>
        {STYLE_FIELDS.map((f) => {
          const current = node.style[f.key] ?? "";
          const shown = computed?.getPropertyValue(f.key) ?? "";
          return (
            <div className="field" key={f.key}>
              <label>{f.label}</label>
              <div className="color">
                {f.color && (
                  <input type="color" value={toHex(current || shown)} onChange={(e) => setStyle(f.key, e.target.value)} />
                )}
                <input
                  key={`${node.id}:${f.key}:${current}`}
                  className="input"
                  defaultValue={current}
                  placeholder={shown || f.placeholder}
                  onBlur={(e) => setStyle(f.key, e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                />
              </div>
            </div>
          );
        })}
      </div>

      <BehaviorSection node={node} />

      <div className="section">
        <h3>Talk to the AI</h3>
        {comments.filter((c) => c.node === node.id).map((c) => (
          <div className="pin" key={c.id}>
            <span className="num">{comments.indexOf(c) + 1}</span>
            <span>{c.text}</span>
          </div>
        ))}
        <button className="btn" onClick={openTalk}>
          🎤 Point &amp; talk <span className="kbd">T</span>
        </button>
        <button className="btn" style={{ marginLeft: 6 }} title="Ask your agent for a few alternative designs of this element" onClick={() => loop.openVariants(node.id)}>
          Variants…
        </button>
      </div>
    </>
  );
}

const EVENTS = ["click", "submit", "hover", "change"];
const ACTIONS = ["open modal", "go to page", "call API", "toggle element", "custom"];

/** Edit behavior: logic instructions that always go to the AI. */
export function BehaviorSection({ node }: { node: SceneNode }) {
  const [event, setEvent] = useState("click");
  const [action, setAction] = useState("open modal");
  const [detail, setDetail] = useState("");
  const behaviors = (store.log?.ops ?? []).filter(
    (o): o is Extract<Op, { op: "behavior" }> => o.op === "behavior" && o.node === node.id,
  );
  const placeholder =
    action === "go to page" ? "/pricing" : action === "call API" ? "POST /api/signup" : action === "open modal" ? "#signup-modal" : "what should happen";
  return (
    <div className="section">
      <h3>Behavior</h3>
      {behaviors.map((b) => (
        <div className="pin" key={b.id}>
          <span>
            On <b>{b.event}</b> → {b.action}
            {b.detail ? <> · <code>{b.detail}</code></> : null}
          </span>
        </div>
      ))}
      <div className="field">
        <label>On</label>
        <select className="input" value={event} onChange={(e) => setEvent(e.target.value)}>
          {EVENTS.map((x) => (
            <option key={x}>{x}</option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Do</label>
        <select className="input" value={action} onChange={(e) => setAction(e.target.value)}>
          {ACTIONS.map((x) => (
            <option key={x}>{x}</option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Detail</label>
        <input className="input" value={detail} placeholder={placeholder} onChange={(e) => setDetail(e.target.value)} />
      </div>
      <button
        className="btn"
        onClick={() => {
          store.edit({ op: "behavior", node: node.id, id: `b${Date.now().toString(36)}`, event, action, ...(detail ? { detail } : {}) });
          setDetail("");
        }}
      >
        Add behavior
      </button>
    </div>
  );
}

/** Live activity: what the AI is doing right now. */
export function Activity() {
  const state = useStore();
  return (
    <div className="activity">
      <div className="section" style={{ borderBottom: 0, paddingBottom: 4 }}>
        <h3>Live activity</h3>
      </div>
      {state.activity.length === 0 && (
        <div className="hint" style={{ padding: "0 12px" }}>
          When your AI agent edits files, every change shows up here and in the page instantly.
        </div>
      )}
      {state.activity.map((a) => (
        <div key={a.id} className={`act ${a.kind}`}>
          <span className="k" />
          <span dangerouslySetInnerHTML={{ __html: inlineCode(a.text) }} />
          <time>{new Date(a.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
        </div>
      ))}
    </div>
  );
}

function inlineCode(text: string): string {
  const esc = text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  return esc.replace(/`([^`]+)`/g, "<code>$1</code>");
}

/** Convert a computed CSS color (rgb/rgba/hex) to #rrggbb for <input type=color>. */
function toHex(color: string): string {
  if (/^#[0-9a-f]{6}$/i.test(color)) return color;
  if (/^#[0-9a-f]{3}$/i.test(color)) return "#" + [...color.slice(1)].map((c) => c + c).join("");
  const m = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return "#000000";
  return "#" + m.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, "0")).join("");
}
