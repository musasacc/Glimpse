import type { ReactNode } from "react";
import type { NodeType, SceneNode } from "@glimpse/core";
import * as I from "./icons";
import { Layers } from "./Panels";
import { store, useStore, type View } from "./store";


const PALETTE: { label: string; icon: ReactNode; type: NodeType; tag: string; defaults: Partial<SceneNode> }[] = [
  { label: "Button", icon: <I.ButtonIcon />, type: "button", tag: "button", defaults: { props: { text: "Button" } } },
  { label: "Heading", icon: <I.Heading />, type: "text", tag: "h2", defaults: { props: { text: "Heading" } } },
  { label: "Text", icon: <I.Type />, type: "text", tag: "p", defaults: { props: { text: "Some text" } } },
  { label: "Link", icon: <I.Link />, type: "link", tag: "a", defaults: { props: { text: "Link", href: "#" } } },
  { label: "Input", icon: <I.Input />, type: "input", tag: "input", defaults: { props: { placeholder: "Type here…" } } },
  {
    label: "Image",
    icon: <I.Image />,
    type: "image",
    tag: "img",
    defaults: {
      props: {
        alt: "Image",
        src: "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="140"><rect width="100%" height="100%" fill="#ddd"/><text x="50%" y="54%" font-family="sans-serif" font-size="14" fill="#888" text-anchor="middle">Image</text></svg>'),
      },
    },
  },
  {
    label: "Card",
    icon: <I.Card />,
    type: "card",
    tag: "div",
    defaults: { style: { padding: "16px", border: "1px solid #ddd", "border-radius": "12px" }, props: { text: "Card" } },
  },
];

export function Sidebar() {
  const state = useStore();
  const go = (view: View) => store.set({ view });

  return (
    <nav className="sidebar" aria-label="Glimpse">
      <div className="side-top">
        <div className="brand">
          <img src="/favicon.svg" alt="" />
          glimpse
        </div>
        <button className="icon-btn" title="Hide sidebar" onClick={() => store.set({ sidebarOpen: false })}>
          <I.Sidebar />
        </button>
      </div>

      <div className="side-nav">
        <NavItem icon={<I.PlusCircle />} label="New build" active={state.view === "home"} onClick={() => go("home")} />
        <NavItem icon={<I.Eye />} label="Editor" active={state.view === "editor"} onClick={() => go("editor")} />
        <NavItem icon={<I.History />} label="History" active={state.view === "history"} onClick={() => go("history")} />
      </div>

      <div className="side-scroll">
        {state.view === "editor" && state.entryExists ? (
          <>
            <div className="side-label">Add</div>
            <div className="palette">
              {PALETTE.map((p) => (
                <button key={p.label} className="pal" title={`Add ${p.label.toLowerCase()}`} onClick={() => store.addElement(p.type, p.tag, structuredClone(p.defaults))}>
                  {p.icon}
                  <span>{p.label}</span>
                </button>
              ))}
            </div>
            <div className="side-label">Layers</div>
            <Layers />
          </>
        ) : (
          <>
            <div className="side-label">Project</div>
            {state.project ? (
              <button className="side-item" onClick={() => go("editor")} title={state.project.dir}>
                <I.Folder />
                <span className="grow">{state.project.dir.split(/[\\/]/).filter(Boolean).at(-1)}</span>
                <span className="meta">{state.project.target}</span>
              </button>
            ) : (
              <div className="side-empty">No project open</div>
            )}
            <div className="side-label">Recent</div>
            {state.handoffs.length === 0 && <div className="side-empty">Nothing sent to the AI yet</div>}
            {state.handoffs.slice(0, 30).map((h) => (
              <button key={h.seq} className="side-item" onClick={() => store.set({ view: "history", openHandoff: h.seq })}>
                <span className="grow ellipsis">{h.title}</span>
                <span className="meta">{ago(h.createdAt)}</span>
              </button>
            ))}
          </>
        )}
      </div>

      <div className="side-bottom">
        <span className={`agent-dot${state.agentWaiting ? " on" : ""}`} />
        <div className="grow">
          <div className="agent-name">{state.agentWaiting ? "Agent listening" : "No agent listening"}</div>
          <div className="agent-sub">{state.connected ? "Live · files sync instantly" : "Reconnecting…"}</div>
        </div>
        <a className="icon-btn" href="https://github.com/musasacc/Glimpse/blob/main/docs/agents.md" target="_blank" rel="noreferrer" title="Connect an agent">
          <I.Help />
        </a>
      </div>
    </nav>
  );
}

function NavItem({ icon, label, kbd, active, onClick }: { icon: ReactNode; label: string; kbd?: string; active?: boolean; onClick: () => void }) {
  return (
    <button className={`nav-item${active ? " active" : ""}`} onClick={onClick}>
      {icon}
      <span className="grow">{label}</span>
      {kbd && <span className="nav-kbd">{kbd}</span>}
    </button>
  );
}

/** "now", "5m", "3h", "15d" */
export function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
