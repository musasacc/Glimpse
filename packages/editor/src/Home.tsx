import { useEffect, useRef, useState, type ReactNode } from "react";
import * as I from "./icons";
import { currentEngine, store, useStore } from "./store";
import { engineLabel, isBuiltIn, stopAgent } from "./agent";
import { Mark } from "./Logo";
import { PreviewError } from "./PreviewError";
import { isEnter } from "./platform";
import { apiFetch } from "./session";

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
 * Home: describe a UI and hand it to the AI (one Glimpse runs itself, or an external agent). It builds it and
 * every file it saves shows up live in the editor.
 */
export function Home() {
  const state = useStore();
  const [text, setText] = useState("");
  const [target, setTarget] = useState<Target>((state.project?.target as Target) ?? "html");
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const menuWrap = useRef<HTMLDivElement>(null);

  useEffect(() => input.current?.focus(), []);
  // The target menu closes on a click outside it.
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => !menuWrap.current?.contains(e.target as Node) && setMenu(false);
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [menu]);
  useEffect(() => {
    if (state.project?.target) setTarget(state.project.target as Target);
  }, [state.project?.target]);

  const send = async (t: string, tgt: Target) => {
    if (!t || busy) return;
    // Nothing can run it yet: set the AI up first, and the request goes out once that's saved.
    if (currentEngine(store.state) === "none") {
      store.openAiSettings(() => void send(t, tgt));
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const res = await apiFetch("/api/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: t, target: tgt }),
      });
      const body = (await res.json()) as { seq?: number; delivered?: boolean; error?: string };
      if (!res.ok) throw new Error(body.error ?? res.statusText);
      setText("");
      const s = store.state;
      if (isBuiltIn(currentEngine(s))) {
        // Its run reports itself ("… is building"); behind another one, it waits its turn.
        if (s.agentRun || (s.agentInfo?.queued ?? 0) > 0) store.activity("handoff", "Request queued; it starts when the current build is done");
      } else {
        store.activity("handoff", body.delivered ? "Sent your request" : "Request queued until your agent picks it up");
      }
      void store.refreshHandoffs();
      store.set({ view: "editor" });
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const submit = () => void send(text.trim(), target);

  const [stopping, setStopping] = useState(false);
  const stop = async () => {
    setStopping(true);
    setNotice(null);
    try {
      await stopAgent();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setStopping(false);
    }
  };

  const current = TARGETS.find((t) => t.id === target)!;
  const folder = state.project?.dir.split(/[\\/]/).filter(Boolean).at(-1) ?? "No project";
  const run = state.agentRun;

  return (
    <section className="home">
      <Mark className="watermark" weight={1.2} outline />
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
            placeholder="Describe the UI you want…"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (isEnter(e) && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <div className="composer-foot">
            {run ? (
              <>
                <span className="agent-chip on building" role="status">
                  <span className="agent-dot" />
                  {engineLabel(run.engine, state.agentInfo)} is building…
                </span>
                <button className="ghost stop-btn" onClick={() => void stop()} disabled={stopping} title="Stop building">
                  <I.Stop size={14} /> {stopping ? "Stopping…" : "Stop"}
                </button>
              </>
            ) : (
              <EngineChip />
            )}
            <div className="spacer" />
            <div
              className="menu-wrap"
              ref={menuWrap}
              onKeyDown={(e) => {
                if (!menu) return;
                const items = [...(menuWrap.current?.querySelectorAll<HTMLElement>(".menu button") ?? [])];
                const at = items.indexOf(document.activeElement as HTMLElement);
                if (e.key === "Escape") {
                  e.preventDefault();
                  setMenu(false);
                  menuWrap.current?.querySelector<HTMLElement>(".ghost")?.focus();
                } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  const step = e.key === "ArrowDown" ? 1 : -1;
                  items[(at + step + items.length) % items.length]?.focus();
                }
              }}
            >
              <button
                className="ghost"
                aria-haspopup="menu"
                aria-expanded={menu}
                aria-label={`What to build: ${current.label}`}
                onClick={() => setMenu((m) => !m)}
                onKeyDown={(e) => {
                  if (e.key !== "ArrowDown" || menu) return;
                  e.preventDefault();
                  setMenu(true);
                }}
              >
                {current.icon} {current.label} <I.Chevron size={14} />
              </button>
              {menu && (
                <div className="menu" role="menu" onMouseLeave={() => setMenu(false)}>
                  {TARGETS.map((t) => (
                    <button
                      key={t.id}
                      role="menuitemradio"
                      aria-checked={t.id === target}
                      autoFocus={t.id === target}
                      className={t.id === target ? "active" : ""}
                      onClick={() => {
                        setTarget(t.id);
                        setMenu(false);
                        input.current?.focus();
                      }}
                    >
                      {t.icon} {t.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button className="send-btn" disabled={!text.trim() || busy} onClick={submit} title={run ? "Queue another request (Enter)" : "Send (Enter)"}>
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
    </section>
  );
}

/** What builds the request, with its state; a click opens the AI settings. */
function EngineChip() {
  const state = useStore();
  const engine = currentEngine(state);
  const external = engine === "external";
  const ready = external ? state.agentWaiting : engine !== "none";
  const title =
    engine === "none" ? "Choose what builds your UI: Claude Code, Codex, or a model's API (Claude, GPT, Gemini, OpenRouter, Ollama)"
    : external ?
      state.agentWaiting ? "Your agent is waiting for a request"
      : "Requests wait until your agent picks them up"
    : `${engineLabel(engine, state.agentInfo)} builds your request on this machine`;
  return (
    <button className={`agent-chip${ready ? " on" : ""}`} title={`${title}. AI settings…`} onClick={() => store.openAiSettings()}>
      <span className="agent-dot" />
      {engineLabel(engine, state.agentInfo)}
    </button>
  );
}
