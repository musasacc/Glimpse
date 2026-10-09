import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { describeChange, type ChangeList } from "@glimpse/core";
import { Canvas, handleKey, type Mode } from "./Canvas";
import { Activity, Inspector } from "./Panels";
import { BoxPromptToggle, DiscardButton } from "./EditTools";
import { Sidebar } from "./Sidebar";
import { MOD } from "./platform";
import { Home } from "./Home";
import { HistoryView } from "./HistoryView";
import { SourceDialog } from "./SourceDialog";
import { Modal } from "./Modal";
import * as I from "./icons";
import { store, useStore, type Device } from "./store";
import { connectLive } from "./live";
import { handoffScreenshot, initLoop, loop, useTimelineOpen } from "./loop";
import { LoopStage, LoopToolbar } from "./Timeline";
import { SceneCanvas } from "./SceneCanvas";
import { SceneToolbar } from "./SceneToolbar";
import { isSceneTarget } from "./scene-geometry";
import { sceneMode } from "./scene-mode";

export function App() {
  const state = useStore();

  useEffect(() => connectLive(), []);
  useEffect(() => initLoop(), []);
  useEffect(() => sceneMode.init(), []);
  useEffect(() => {
    void store.refreshHandoffs();
  }, []);

  return (
    <div className={`shell${state.sidebarOpen ? "" : " no-sidebar"}`}>
      {state.sidebarOpen && <Sidebar />}
      <main className="main">
        {state.view === "home" && <Home />}
        {state.view === "history" && <HistoryView />}
        {/* The editor stays mounted so the page and unsent edits survive view switches. */}
        <Editor hidden={state.view !== "editor"} />
        {/* After the toolbar it sits on: in the macOS app a later no-drag region wins over the toolbar's drag one. */}
        {!state.sidebarOpen && (
          <button className="icon-btn floating" title="Show sidebar" onClick={() => store.set({ sidebarOpen: true })}>
            <I.Sidebar />
          </button>
        )}
      </main>
    </div>
  );
}

const DEVICES: { id: Device; label: string; icon: React.ReactNode }[] = [
  { id: "desktop", label: "Desktop", icon: <I.Monitor /> },
  { id: "tablet", label: "Tablet", icon: <I.Tablet /> },
  { id: "mobile", label: "Mobile", icon: <I.Phone /> },
];

function Editor({ hidden }: { hidden: boolean }) {
  const state = useStore();
  const [mode, setMode] = useState<Mode>("edit");
  const [talkOpen, setTalkOpen] = useState(false);
  const [sending, setSending] = useState<ChangeList | null>(null);
  const [editing, setEditing] = useState<ChangeList | null>(null);
  const timelineOpen = useTimelineOpen();
  const modeRef = useRef(mode);
  modeRef.current = mode;

  useEffect(() => {
    if (hidden) return;
    const onKey = (e: KeyboardEvent) => {
      // Not while a past version, comparison or variants dialog is on screen.
      if (!loop.blocksEditorKeys) handleKey(e, () => setTalkOpen(true), modeRef.current);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hidden]);
  useEffect(() => setTalkOpen(false), [state.selected]);

  const toolbar = useRef<HTMLElement>(null);
  const compact = useCompactToolbar(toolbar);
  const pending = store.pendingCount;
  // A terminal UI or native GUI: its mock from glimpse.scene.json instead of a live page.
  const scene = isSceneTarget(state.project?.target);

  return (
    <div className={`editor${state.inspectorOpen ? "" : " no-inspector"}${timelineOpen ? " with-timeline" : ""}`} hidden={hidden}>
      <header className={`toolbar${compact ? " compact" : ""}`} ref={toolbar}>
        <div className="seg" role="group" aria-label="Mode">
          <button className={mode === "edit" ? "active" : ""} onClick={() => setMode("edit")} title="Edit: select, move and change elements">
            <I.Pointer size={14} /> <span className="tb-label">Edit</span>
          </button>
          <button className={mode === "interact" ? "active" : ""} onClick={() => setMode("interact")} title="Interact: use the page normally">
            <I.Hand size={14} /> <span className="tb-label">Interact</span>
          </button>
        </div>
        <BoxPromptToggle onEnable={() => setMode("edit")} />
        {scene ? (
          <SceneToolbar />
        ) : (
          <div className="seg" role="group" aria-label="Device width">
            {DEVICES.map((d) => (
              <button
                key={d.id}
                className={state.device === d.id ? "active" : ""}
                onClick={() => store.set({ device: d.id })}
                title={d.label}
                aria-label={d.label}
                aria-pressed={state.device === d.id}
              >
                {d.icon}
              </button>
            ))}
          </div>
        )}
        <span className={`live${state.connected ? " on" : ""}`} title="Changes your AI makes to the files appear here instantly">
          <span className="dot" />
          <span className="tb-label">{state.connected ? "Live" : "Offline"}</span>
        </span>
        <LoopToolbar />
        <div className="spacer" />
        <button className="icon-btn" title={`Undo (${MOD}Z)`} disabled={!store.log?.canUndo} onClick={() => store.undo()}>
          <I.Undo />
        </button>
        <button className="icon-btn" title={`Redo (${MOD}Shift+Z)`} disabled={!store.log?.canRedo} onClick={() => store.redo()}>
          <I.Redo />
        </button>
        <DiscardButton />
        <button
          className="btn"
          disabled={pending === 0}
          title="Glimpse writes your edits straight into the files (with a diff preview)"
          onClick={() => setEditing(store.changeList())}
        >
          <I.Code size={14} /> <span className="tb-label">Edit source</span>
        </button>
        <button className="btn primary" disabled={pending === 0} title="Send your edits to the AI" onClick={() => setSending(store.changeList())}>
          <I.Send size={14} /> <span className="tb-label">Send to AI</span> <span className="count">{pending}</span>
        </button>
        <button
          className={`icon-btn${state.inspectorOpen ? " on" : ""}`}
          title={state.inspectorOpen ? "Hide inspector" : "Show inspector"}
          onClick={() => store.set({ inspectorOpen: !state.inspectorOpen })}
        >
          <I.PanelRight />
        </button>
      </header>

      {scene ? <SceneCanvas mode={mode} talkOpen={talkOpen} setTalkOpen={setTalkOpen} /> : <Canvas mode={mode} talkOpen={talkOpen} setTalkOpen={setTalkOpen} />}
      <LoopStage mode={mode} openTalk={() => setTalkOpen(true)} />
      {state.inspectorOpen && (
        <aside className="inspector">
          <Inspector openTalk={() => setTalkOpen(true)} />
          <Activity />
        </aside>
      )}

      {sending && <SendDialog list={sending} onClose={() => setSending(null)} />}
      {editing && <SourceDialog list={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

/** "Send instructions to AI": review the change list, add a note, hand it off. */
/**
 * The toolbar's labels give way to their icons once its controls don't fit, and come back when it is as wide
 * again as they needed.
 */
function useCompactToolbar(ref: React.RefObject<HTMLElement | null>): boolean {
  const [compact, setCompact] = useState(false);
  const needed = useRef(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => {
      if (!el.classList.contains("compact")) {
        if (el.scrollWidth > el.clientWidth + 1) {
          needed.current = el.scrollWidth;
          setCompact(true);
        }
      } else if (el.clientWidth >= needed.current) setCompact(false);
    };
    const resized = new ResizeObserver(check);
    resized.observe(el);
    // Buttons that come and go (Compare, a native mock's platform switch).
    const changed = new MutationObserver(check);
    changed.observe(el, { childList: true, subtree: true });
    check();
    return () => {
      resized.disconnect();
      changed.disconnect();
    };
  }, [ref]);
  return compact;
}

function SendDialog({ list: opened, onClose }: { list: ChangeList; onClose: () => void }) {
  const state = useStore();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The AI may save while this is open: its change is replayed under the edits, so list them as they are now
  // (what is sent and what becomes the new base must be the same).
  const log = store.log;
  const entries = log?.entries.length;
  const list = useMemo(() => store.changeList() ?? opened, [log, entries, opened]);

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const current = store.changeList() ?? list;
      if (current.changes.length === 0) throw new Error("Nothing to send right now: your edits no longer differ from the page (the AI's latest change may include them).");
      const changeList = { ...current, ...(note.trim() ? { note: note.trim() } : {}) };
      // A picture of the edited page helps the agent see what was meant (best effort, ≤ 3 s).
      const screenshot = await handoffScreenshot();
      // A scene mock: Glimpse writes the edited scene into its file first, so the agent only changes the code.
      const res = await sceneMode.writes(
        fetch("/api/handoff", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind: "ai", changeList, ...(screenshot ? { screenshot } : {}), ...sceneMode.body({ handoff: true }) }),
        }),
      );
      const body = (await res.json()) as { warning?: string; error?: string };
      if (!res.ok) throw new Error(body.error ?? res.statusText);
      if (body.warning) store.activity("warn", body.warning);
      store.commitHandoff();
      void store.refreshHandoffs();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} busy={busy}>
      <header>
        <h2>Send instructions to AI</h2>
        <p>
          Your agent receives these {list.changes.length} changes and applies them to the real code. Watch it happen live.
          {!state.agentWaiting && " No agent is listening right now. It'll get them as soon as it runs `glimpse wait`."}
        </p>
      </header>
      <div className="body">
        <ol className="changes">
          {list.changes.map((c, i) => (
            <li key={i}>
              <span className="op">{c.op}</span> {describeChange(c)}
            </li>
          ))}
        </ol>
        <textarea
          className="input"
          autoFocus
          aria-label="Note for the AI"
          placeholder="Anything else the AI should know? (optional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        {error && <p style={{ color: "var(--danger)" }}>{error}</p>}
      </div>
      <footer>
        <button className="btn" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button className="btn primary" onClick={send} disabled={busy}>
          <I.Send size={14} /> {busy ? "Sending…" : "Send to AI"}
        </button>
      </footer>
    </Modal>
  );
}
