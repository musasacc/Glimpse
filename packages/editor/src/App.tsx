import { useEffect, useState } from "react";
import { describeChange, type ChangeList } from "@glimpse/core";
import { Canvas, handleKey, type Mode } from "./Canvas";
import { Activity, Inspector, Layers } from "./Panels";
import { store, useStore, type Device } from "./store";
import { connectLive } from "./live";

export function App() {
  const state = useStore();
  const [mode, setMode] = useState<Mode>("edit");
  const [talkOpen, setTalkOpen] = useState(false);
  const [sending, setSending] = useState<ChangeList | null>(null);

  useEffect(() => connectLive(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => handleKey(e, () => setTalkOpen(true));
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => setTalkOpen(false), [state.selected]);

  const pending = store.pendingCount;
  const project = state.project;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img src="/favicon.svg" alt="" />
          glimpse
        </div>
        {project && (
          <div className="project">
            <code title={project.dir}>{project.dir.split(/[\\/]/).slice(-2).join("/")}</code>
            <span className="chip">{project.target}</span>
          </div>
        )}
        <span className={`live${state.connected ? " on" : ""}`} title="Changes your AI makes to the files appear here instantly">
          <span className="dot" />
          {state.connected ? "Live" : "Offline"}
        </span>
        <div className="spacer" />
        <div className="seg" role="group" aria-label="Mode">
          {(["edit", "interact"] as Mode[]).map((m) => (
            <button key={m} className={mode === m ? "active" : ""} onClick={() => setMode(m)}>
              {m === "edit" ? "Edit" : "Interact"}
            </button>
          ))}
        </div>
        <div className="seg" role="group" aria-label="Device width">
          {(["desktop", "tablet", "mobile"] as Device[]).map((d) => (
            <button key={d} className={state.device === d ? "active" : ""} onClick={() => store.set({ device: d })}>
              {d[0]!.toUpperCase() + d.slice(1)}
            </button>
          ))}
        </div>
        <button className="btn icon" title="Undo (⌘Z)" disabled={!store.log?.canUndo} onClick={() => store.undo()}>
          ↶
        </button>
        <button className="btn icon" title="Redo (⇧⌘Z)" disabled={!store.log?.canRedo} onClick={() => store.redo()}>
          ↷
        </button>
        <button
          className="btn"
          disabled
          title="Coming next: Glimpse writes simple edits (text, styles, deletes) straight into your files, with a diff preview"
        >
          Edit source
        </button>
        <button className="btn primary" disabled={pending === 0} onClick={() => setSending(store.changeList())}>
          Send to AI <span className="count">{pending}</span>
        </button>
      </header>

      <Layers />
      <Canvas mode={mode} talkOpen={talkOpen} setTalkOpen={setTalkOpen} />
      <aside className="panel right">
        <Inspector openTalk={() => setTalkOpen(true)} />
        <Activity />
      </aside>

      {sending && <SendDialog list={sending} onClose={() => setSending(null)} />}
    </div>
  );
}

/** "Send instructions to AI": review the change list, add a note, hand it off. */
function SendDialog({ list, onClose }: { list: ChangeList; onClose: () => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const changeList = { ...list, ...(note.trim() ? { note: note.trim() } : {}) };
      const res = await fetch("/api/handoff", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "ai", changeList }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
      store.commitHandoff();
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
            {busy ? "Sending…" : "Send to AI"}
          </button>
        </footer>
      </div>
    </div>
  );
}
