import { useEffect, useRef, useState, type ReactNode } from "react";
import * as I from "./icons";
import { store, useStore } from "./store";
import { PreviewError } from "./PreviewError";

type Target = "html" | "react" | "tui" | "native";

const TARGETS: { id: Target; label: string; icon: ReactNode }[] = [
  { id: "html", label: "Website", icon: <I.Layout /> },
  { id: "react", label: "React app", icon: <I.Code /> },
  { id: "tui", label: "Terminal UI", icon: <I.Terminal /> },
  { id: "native", label: "Desktop app", icon: <I.AppWindow /> },
];

const IDEAS: { label: string; icon: ReactNode; target: Target; text: string }[] = [
  { label: "Landing page", icon: <I.Layout />, target: "html", text: "A landing page for a coffee brand: hero with headline and call-to-action, three feature cards, testimonials and a footer." },
  { label: "Dashboard", icon: <I.Chart />, target: "html", text: "An analytics dashboard with a sidebar, four KPI tiles, a line chart and a table of recent orders." },
  { label: "Login form", icon: <I.Lock />, target: "html", text: "A clean sign-in page with email and password fields, a 'remember me' checkbox, a primary button and a link to sign up." },
  { label: "Terminal app", icon: <I.Terminal />, target: "tui", text: "A terminal todo app with a list on the left, details on the right and a status bar with keyboard shortcuts." },
];

function greeting(): string {
  const h = new Date().getHours();
  const part = h < 5 ? "Up late" : h < 12 ? "Morning" : h < 18 ? "Afternoon" : "Evening";
  return `${part}, what are we building?`;
}

/**
 * Home: describe a UI and hand it to the connected AI agent. The agent builds
 * it and every file it saves shows up live in the editor.
 */
export function Home() {
  const state = useStore();
  const [text, setText] = useState("");
  const [target, setTarget] = useState<Target>((state.project?.target as Target) ?? "html");
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    if (state.project?.target) setTarget(state.project.target as Target);
  }, [state.project?.target]);

  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: t, target }),
      });
      const body = (await res.json()) as { seq?: number; delivered?: boolean; error?: string };
      if (!res.ok) throw new Error(body.error ?? res.statusText);
      setText("");
      store.activity("handoff", body.delivered ? "Sent your request to the agent" : "Request queued; the agent gets it as soon as it listens");
      void store.refreshHandoffs();
      store.set({ view: "editor" });
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const current = TARGETS.find((t) => t.id === target)!;
  const folder = state.project?.dir.split(/[\\/]/).filter(Boolean).at(-1) ?? "No project";

  return (
    <section className="home">
      <svg className="watermark" viewBox="0 0 64 64" aria-hidden="true">
        <path d="M5 32C14 16 50 16 59 32C50 48 14 48 5 32Z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
        <circle cx="35" cy="31" r="9" fill="none" stroke="currentColor" strokeWidth="1.2" />
      </svg>
      <h1 className="greeting">{greeting()}</h1>

      <div className="composer">
        <div className="composer-head">
          <button className="ghost" title={state.project?.dir} onClick={() => store.set({ view: "editor" })}>
            <I.Folder /> {folder}
          </button>
          <span className="composer-path">{state.project?.dir}</span>
        </div>
        <div className="composer-box">
          <textarea
            ref={input}
            rows={3}
            value={text}
            placeholder="Describe the UI you want. Your AI agent builds it, and you watch it appear live…"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div className="composer-foot">
            <span className={`agent-chip${state.agentWaiting ? " on" : ""}`} title={state.agentWaiting ? "An agent is waiting for your request" : "Requests are queued until an agent runs `glimpse wait` or connects over MCP"}>
              <span className="agent-dot" />
              {state.agentWaiting ? "Agent ready" : "No agent listening"}
            </span>
            <div className="spacer" />
            <div className="menu-wrap">
              <button className="ghost" onClick={() => setMenu((m) => !m)}>
                {current.icon} {current.label} <I.Chevron size={14} />
              </button>
              {menu && (
                <div className="menu" onMouseLeave={() => setMenu(false)}>
                  {TARGETS.map((t) => (
                    <button
                      key={t.id}
                      className={t.id === target ? "active" : ""}
                      onClick={() => {
                        setTarget(t.id);
                        setMenu(false);
                      }}
                    >
                      {t.icon} {t.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button className="send-btn" disabled={!text.trim() || busy} onClick={() => void send()} title="Send to your agent (Enter)">
              <I.ArrowUp />
            </button>
          </div>
        </div>
      </div>
      {notice && <p className="home-notice">{notice}</p>}
      <PreviewError compact />

      <div className="ideas">
        {IDEAS.map((idea) => (
          <button
            key={idea.label}
            className="idea"
            onClick={() => {
              setText(idea.text);
              setTarget(idea.target);
              input.current?.focus();
            }}
          >
            {idea.icon} {idea.label}
          </button>
        ))}
      </div>

      {!state.agentWaiting && (
        <p className="home-hint">
          Connect your agent: tell Claude Code, Codex or any agent to run <code>glimpse wait</code>, or add the MCP server (<code>glimpse mcp</code>).
        </p>
      )}
    </section>
  );
}
