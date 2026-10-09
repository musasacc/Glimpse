import { memo, type CSSProperties, type ReactNode } from "react";
import type { Layout, Scene, SceneNode, SceneTheme } from "@glimpse/core";
import { samePreviewFor } from "./scene-geometry";

/**
 * Draws a native GUI mock: a desktop window in the chosen platform's look
 * (macOS, Windows 11 or GNOME), with every widget of the scene at its pixel
 * position in the client area. The look lives in scene.css, keyed by
 * data-theme; scene styles (color, font-size, border, …) apply on top.
 */

export interface NativeProps {
  scene: Scene;
  theme: SceneTheme;
  /** Window title when the root has none (meta.title). */
  title?: string;
  /** Layout overrides while a drag or resize is in progress. */
  preview?: ReadonlyMap<string, Layout>;
  /** Where the scene file lives, for image paths (relative to it). */
  base?: string;
  /** Changes whenever the scene does: it is edited in place, so the object alone doesn't tell. */
  rev?: number;
}

/**
 * The window: title bar per theme, then the client area (the root) with its widgets.
 * Memoized, as are its widgets: hovering, the app's output and a drag redraw only what changed.
 */
export const NativeWindow = memo(function NativeWindow({ scene, theme, title, preview, base = "", rev }: NativeProps) {
  const root = scene.nodes[scene.rootId]!;
  const name = root.props.title ?? title ?? "";
  return (
    <div className="nat-window" data-theme={theme}>
      <TitleBar theme={theme} title={name} />
      <div className="nat-client" style={{ width: root.layout.w, height: root.layout.h, ...css(root) }}>
        {root.children.map((id) => (
          <NativeNode key={id} id={id} scene={scene} preview={preview} base={base} rev={rev} />
        ))}
      </div>
    </div>
  );
});

function TitleBar({ theme, title }: { theme: SceneTheme; title: string }) {
  if (theme === "macos") {
    return (
      <div className="nat-titlebar">
        <span className="nat-lights">
          <i className="close" />
          <i className="min" />
          <i className="max" />
        </span>
        <span className="nat-title">{title}</span>
      </div>
    );
  }
  if (theme === "windows") {
    return (
      <div className="nat-titlebar">
        <span className="nat-appicon" />
        <span className="nat-title">{title}</span>
        <span className="nat-caption">
          <svg viewBox="0 0 10 10" aria-hidden="true">
            <path d="M0 5h10" />
          </svg>
          <svg viewBox="0 0 10 10" aria-hidden="true">
            <rect x="0.5" y="0.5" width="9" height="9" rx="1" />
          </svg>
          <svg viewBox="0 0 10 10" aria-hidden="true">
            <path d="M0 0l10 10M10 0L0 10" />
          </svg>
        </span>
      </div>
    );
  }
  return (
    <div className="nat-titlebar">
      <span className="nat-title">{title}</span>
      <span className="nat-close" aria-hidden="true">
        <svg viewBox="0 0 10 10">
          <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" />
        </svg>
      </span>
    </div>
  );
}

type NodeProps = { id: string; scene: Scene; preview?: ReadonlyMap<string, Layout>; base: string; rev?: number };

const NativeNode = memo(
  NativeNodeView,
  (a, b) => a.id === b.id && a.scene === b.scene && a.base === b.base && a.rev === b.rev && samePreviewFor(b.scene, b.id, a.preview, b.preview),
);

function NativeNodeView({ id, scene, preview, base, rev }: NodeProps) {
  const n = scene.nodes[id];
  if (!n) return null;
  const l = preview?.get(id) ?? n.layout;
  const pane = n.type === "tabs" ? n.children[num(n.props.selected) ?? 0] : undefined;
  return (
    <div className={`nat-node${n.hidden ? " is-hidden" : ""}`} data-scene-id={id} style={{ left: l.x, top: l.y, width: l.w, height: l.h }}>
      {widget(n, l, base)}
      {n.children.map((c) => (n.type !== "tabs" || c === pane ? <NativeNode key={c} id={c} scene={scene} preview={preview} base={base} rev={rev} /> : null))}
    </div>
  );
}

/** Scene styles that are CSS on a native mock (others, like layout, are ignored). */
const CSS_KEYS = [
  "color",
  "background",
  "background-color",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "border",
  "border-color",
  "border-width",
  "border-style",
  "border-radius",
  "padding",
  "text-align",
  "text-decoration",
  "letter-spacing",
  "line-height",
  "opacity",
];

/** Keys whose bare numbers aren't pixels. */
const UNITLESS = new Set(["font-weight", "opacity"]);

/** A bare number in pixels, or as is. A small line-height (1.4) is a multiple of the font size, a large one (20) pixels. */
function cssValue(key: string, v: string): string {
  if (!/^-?\d+(\.\d+)?$/.test(v) || UNITLESS.has(key)) return v;
  return key === "line-height" && Number(v) <= 4 ? v : `${v}px`;
}

function css(n: SceneNode): CSSProperties {
  const out: Record<string, string> = {};
  for (const key of CSS_KEYS) {
    const v = n.style[key];
    if (v !== undefined && v !== "") out[key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = cssValue(key, v);
  }
  return out as CSSProperties;
}

function num(v: string | undefined): number | undefined {
  return v !== undefined && /^-?\d+$/.test(v.trim()) ? Number(v) : undefined;
}

function on(v: string | undefined): boolean {
  return v === "true";
}

function lines(v: string | undefined): string[] {
  return v ? v.split("\n") : [];
}

const Check = () => (
  <svg viewBox="0 0 12 12" aria-hidden="true">
    <path d="M2.5 6.2l2.4 2.4 4.6-5" />
  </svg>
);

const Chevrons = () => (
  <svg viewBox="0 0 10 14" aria-hidden="true">
    <path d="M2.5 5L5 2.5 7.5 5M2.5 9L5 11.5 7.5 9" />
  </svg>
);

const ChevronDown = () => (
  <svg viewBox="0 0 12 12" aria-hidden="true">
    <path d="M3 4.5l3 3 3-3" />
  </svg>
);

/** One widget in its box (children are drawn by NativeNode on top). */
function widget(n: SceneNode, l: Layout, base: string): ReactNode {
  const style = css(n);
  const text = n.props.text ?? "";
  const disabled = on(n.props.disabled) ? " is-disabled" : "";
  switch (n.type) {
    case "button": {
      const kind = on(n.props.default) ? "default" : (n.props.variant ?? "");
      return (
        <div className={`nat-button${disabled}`} data-variant={kind} style={style}>
          <span>{text}</span>
        </div>
      );
    }
    case "input": {
      const value = on(n.props.password) ? "•".repeat([...text].length) : text;
      return (
        <div className={`nat-input${disabled}${on(n.props.multiline) ? " multiline" : ""}`} style={style}>
          {value ? <span>{value}</span> : <span className="nat-placeholder">{n.props.placeholder ?? ""}</span>}
        </div>
      );
    }
    case "select": {
      const items = lines(n.props.items);
      const value = items[num(n.props.selected) ?? -1] ?? "";
      return (
        <div className={`nat-select${disabled}`} style={style}>
          {value ? <span>{value}</span> : <span className="nat-placeholder">{n.props.placeholder ?? ""}</span>}
          <span className="nat-arrow">{l.h >= 16 ? <Chevrons /> : null}</span>
          <span className="nat-arrow-down">
            <ChevronDown />
          </span>
        </div>
      );
    }
    case "checkbox":
    case "radio":
      return (
        <div className={`nat-check${disabled}`} data-kind={n.type} data-on={on(n.props.checked) || undefined} style={style}>
          <span className="nat-mark">{n.type === "checkbox" ? <Check /> : <i />}</span>
          <span className="nat-label">{text}</span>
        </div>
      );
    case "switch":
      return (
        <div className={`nat-switch${disabled}`} data-on={on(n.props.checked) || undefined} style={style}>
          <span className="nat-label">{text}</span>
          <span className="nat-toggle">
            <i />
          </span>
        </div>
      );
    case "list": {
      const sel = num(n.props.selected);
      return (
        <div className={`nat-list${disabled}`} style={style}>
          {lines(n.props.items).map((item, i) => (
            <div key={i} className={`nat-row${i === sel ? " selected" : ""}`}>
              {item}
            </div>
          ))}
        </div>
      );
    }
    case "table": {
      const header = lines(n.props.columns);
      const rows = lines(n.props.items).map((r) => r.split("\t"));
      const sel = num(n.props.selected);
      const cols = Math.max(1, header.length, ...rows.map((r) => r.length));
      const grid = { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` };
      return (
        <div className={`nat-table${disabled}`} style={style}>
          {header.length > 0 && (
            <div className="nat-thead" style={grid}>
              {header.map((h, i) => (
                <span key={i}>{h}</span>
              ))}
            </div>
          )}
          {rows.map((r, i) => (
            <div key={i} className={`nat-row${i === sel ? " selected" : ""}`} style={grid}>
              {Array.from({ length: cols }, (_, c) => (
                <span key={c}>{r[c] ?? ""}</span>
              ))}
            </div>
          ))}
        </div>
      );
    }
    case "tree": {
      const items = lines(n.props.items).map((raw) => ({ depth: Math.floor((raw.length - raw.trimStart().length) / 2), label: raw.trim() }));
      const sel = num(n.props.selected);
      return (
        <div className={`nat-list nat-tree${disabled}`} style={style}>
          {items.map((it, i) => {
            const parent = items[i + 1] !== undefined && items[i + 1]!.depth > it.depth;
            return (
              <div key={i} className={`nat-row${i === sel ? " selected" : ""}`} style={{ paddingLeft: 6 + it.depth * 16 }}>
                <span className="nat-disclosure">{parent ? "▾" : ""}</span>
                {it.label}
              </div>
            );
          })}
        </div>
      );
    }
    case "tabs": {
      const sel = num(n.props.selected) ?? 0;
      return (
        <div className={`nat-tabs${disabled}`} style={style}>
          <div className="nat-tabbar">
            {lines(n.props.items).map((t, i) => (
              <span key={i} className={i === sel ? "active" : ""}>
                {t}
              </span>
            ))}
          </div>
          <div className="nat-tabpane" />
        </div>
      );
    }
    case "progress": {
      const max = Number(n.props.max ?? 100) || 100;
      const ratio = Math.max(0, Math.min(1, (Number(n.props.value ?? 0) || 0) / max));
      return (
        <div className={`nat-progress${disabled}`} style={style}>
          {text && l.h >= 28 && <span className="nat-label">{text}</span>}
          <span className="nat-track">
            <i style={{ width: `${ratio * 100}%` }} />
          </span>
        </div>
      );
    }
    case "slider": {
      const min = Number(n.props.min ?? 0) || 0;
      const max = Number(n.props.max ?? 100) || 100;
      const ratio = Math.max(0, Math.min(1, ((Number(n.props.value ?? 0) || 0) - min) / (max - min || 1)));
      return (
        <div className={`nat-slider${disabled}`} style={style}>
          <span className="nat-track">
            <i style={{ width: `${ratio * 100}%` }} />
          </span>
          <span className="nat-knob" style={{ left: `calc(${ratio * 100}% - ${ratio * 16}px)` }} />
        </div>
      );
    }
    case "panel":
    case "window":
      return (
        <div className="nat-panel" style={style}>
          {(n.props.title ?? text) && <span className="nat-legend">{n.props.title ?? text}</span>}
        </div>
      );
    case "card":
      return <div className="nat-card" style={style} />;
    case "nav":
      return <div className="nat-nav" style={style} />;
    case "label":
      return (
        <div className="nat-text nat-single" style={{ lineHeight: `${l.h}px`, ...style }}>
          {text}
        </div>
      );
    case "text":
      return (
        <div className="nat-text" style={style}>
          {text}
        </div>
      );
    case "link":
      return (
        <div className="nat-text nat-link nat-single" style={{ lineHeight: `${l.h}px`, ...style }}>
          {text}
        </div>
      );
    case "icon":
      return (
        <div className="nat-icon" style={style}>
          {text}
        </div>
      );
    case "divider":
      return <div className={`nat-divider ${l.w >= l.h ? "h" : "v"}`} style={style} />;
    case "menu":
      return (
        <div className="nat-menu" style={style}>
          {lines(n.props.items).map((t, i) => (
            <span key={i}>{t}</span>
          ))}
        </div>
      );
    case "statusbar": {
      const items = lines(n.props.items);
      return (
        <div className="nat-status" style={style}>
          {text && <span>{text}</span>}
          {items.map((t, i) => (
            <span key={i}>{t}</span>
          ))}
        </div>
      );
    }
    case "image": {
      const src = n.props.src && !/^[a-z]+:/i.test(n.props.src) ? `/preview/${[base, n.props.src].filter(Boolean).join("/")}` : undefined;
      return (
        <div className="nat-image" style={style}>
          {src ? <img src={src} alt={n.props.alt ?? ""} draggable={false} /> : <span>{n.props.alt ?? "Image"}</span>}
        </div>
      );
    }
    case "custom":
      return (
        <div className="nat-custom" style={style}>
          <span>{text || n.tag || "custom"}</span>
        </div>
      );
    default:
      // box (and any other container): only what its style asks for.
      return Object.keys(style).length ? <div className="nat-box" style={style} /> : null;
  }
}
