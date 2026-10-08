import { useEffect, useState } from "react";
import { describeChange, type ChangeList } from "@glimpse/core";
import { Canvas, handleKey, type Mode } from "./Canvas";
import { Activity, Inspector } from "./Panels";
import { BoxPromptToggle, DiscardButton } from "./EditTools";
import { Sidebar } from "./Sidebar";
import { MOD } from "./platform";
import { Home } from "./Home";
import { HistoryView } from "./HistoryView";
import { SourceDialog } from "./SourceDialog";
import * as I from "./icons";
import { store, useStore, type Device } from "./store";
import { connectLive } from "./live";
import { handoffScreenshot, initLoop, loop, useTimelineOpen } from "./loop";
import { LoopStage, LoopToolbar } from "./Timeline";

export function App() {
  const state = useStore();

  useEffect(() => connectLive(), []);
  useEffect(() => initLoop(), []);
  useEffect(() => {
    void store.refreshHandoffs();
  }, []);

  return (
    <div className={`shell${state.sidebarOpen ? "" : " no-sidebar"}`}>
      {state.sidebarOpen && <Sidebar />}
      <main className="main">
        {!state.sidebarOpen && (
          <button className="icon-btn floating" title="Show sidebar" onClick={() => store.set({ sidebarOpen: true })}>
            <I.Sidebar />
          </button>
        )}
        {state.view === "home" && <Home />}
        {state.view === "history" && <HistoryView />}
        {/* The editor stays mounted so the page and unsent edits survive view switches. */}
        <Editor hidden={state.view !== "editor"} />
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

  useEffect(() => {
    if (hidden) return;
    const onKey = (e: KeyboardEvent) => {
      // Not while a past version, comparison or variants dialog is on screen.
      if (!loop.blocksEditorKeys) handleKey(e, () => setTalkOpen(true));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hidden]);
  useEffect(() => setTalkOpen(false), [state.selected]);

  const pending = store.pendingCount;

  return (
    <div className={`editor${state.inspectorOpen ? "" : " no-inspector"}${timelineOpen ? " with-timeline" : ""}`} hidden={hidden}>
      <header className="toolbar">
        <div className="seg" role="group" aria-label="Mode">
          <button className={mode === "edit" ? "active" : ""} onClick={() => setMode("edit")} title="Edit: select, move and change elements">
            <I.Pointer size={14} /> Edit
          </button>
          <button className={mode === "interact" ? "active" : ""} onClick={() => setMode("interact")} title="Interact: use the page normally">
            <I.Hand size={14} /> Interact
          </button>
        </div>
        <BoxPromptToggle onEnable={() => setMode("edit")} />
        <div className="seg" role="group" aria-label="Device width">
          {DEVICES.map((d) => (
            <button key={d.id} className={state.device === d.id ? "active" : ""} onClick={() => store.set({ device: d.id })} title={d.label}>
              {d.icon}
            </button>
          ))}
        </div>
        <span className={`live${state.connected ? " on" : ""}`} title="Changes your AI makes to the files appear here instantly">
          <span className="dot" />
          {state.connected ? "Live" : "Offline"}
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
          <I.Code size={14} /> Edit source
        </button>
        <button className="btn primary" disabled={pending === 0} onClick={() => setSending(store.changeList())}>
          <I.Send size={14} /> Send to AI <span className="count">{pending}</span>
        </button>
        <button
          className={`icon-btn${state.inspectorOpen ? " on" : ""}`}
          title={state.inspectorOpen ? "Hide inspector" : "Show inspector"}
          onClick={() => store.set({ inspectorOpen: !state.inspectorOpen })}
        >
          <I.PanelRight />
        </button>
      </header>

      <Canvas mode={mode} talkOpen={talkOpen} setTalkOpen={setTalkOpen} />
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
function SendDialog({ list, onClose }: { list: ChangeList; onClose: () => void }) {
  const state = useStore();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const changeList = { ...list, ...(note.trim() ? { note: note.trim() } : {}) };
      // A picture of the edited page helps the agent see what was meant (best effort, ≤ 3 s).
      const screenshot = await handoffScreenshot();
      const res = await fetch("/api/handoff", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "ai", changeList, ...(screenshot ? { screenshot } : {}) }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
      store.commitHandoff();
      void store.refreshHandoffs();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="scrim" onMouseDown={onClose}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
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
            placeholder="Anything else the AI should know? (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          {error && <p style={{ color: "var(--danger)" }}>{error}</p>}
        </div>
        <footer>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={send} disabled={busy}>
            <I.Send size={14} /> {busy ? "Sending…" : "Send to AI"}
          </button>
        </footer>
      </div>
    </div>
  );
}
