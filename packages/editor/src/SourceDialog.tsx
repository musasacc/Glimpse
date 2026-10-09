import { useEffect, useRef, useState } from "react";
import { describeChange, type Change, type ChangeList } from "@glimpse/core";
import * as I from "./icons";
import { handoffScreenshot } from "./loop";
import { sceneMode } from "./scene-mode";
import { store } from "./store";
import { Modal } from "./Modal";
import "./react.css";

interface Preview {
  files: { file: string; diff: string }[];
  applied: Change[];
  needsAi: Change[];
  /** Sent back on apply: the server refuses (409) when the files changed since this diff. */
  planId?: string;
}

/**
 * "Edit source": Glimpse writes the edits straight into the files. Shows the
 * diff first; whatever can't be written safely (layout moves, logic, notes)
 * can be sent on to the AI in the same click.
 */
export function SourceDialog({ list, onClose }: { list: ChangeList; onClose: () => void }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sendRest, setSendRest] = useState(true);
  /** The files were written (and the edits committed): a retry only sends the rest to the AI. */
  const [written, setWritten] = useState(false);
  const shot = useRef<string | null | undefined>(undefined);
  // Elements the page renders more than once (list items, shared components): their edits go to the AI.
  const [repeats] = useState(() => store.repeats);
  const repeated = [...repeats.keys()];

  useEffect(() => {
    // A scene mock sends the edited scene along: Glimpse writes it into the scene file.
    sceneMode
      .writes(
        fetch("/api/patch/preview", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ changeList: list, repeated, ...sceneMode.body() }),
        }),
      )
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.error ?? r.statusText);
        setPreview(body as Preview);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [list]);

  const apply = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    let wrote = written;
    try {
      const toAi = sendRest && preview.needsAi.length > 0;
      // Picture the edited page before the files change under it (best effort, ≤ 3 s).
      if (toAi && shot.current === undefined) shot.current = await handoffScreenshot();
      if (!wrote && preview.files.length > 0) {
        // React renders from its own record of the page: our edits come off before the files change, and the
        // update Vite sends for them shows the written source (see Store.takeOffEdits).
        const react = store.isVitePage;
        if (react) store.takeOffEdits();
        let body: { files?: string[]; applied?: number; backup?: string; error?: string };
        try {
          body = await store.writingSource(async () => {
            const res = await sceneMode.writes(
              fetch("/api/patch/apply", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ changeList: list, repeated, planId: preview.planId, ...sceneMode.body() }),
              }),
            );
            const body = (await res.json()) as { files?: string[]; applied?: number; backup?: string; error?: string };
            if (!res.ok) throw new Error(body.error ?? res.statusText);
            return body;
          });
        } catch (e) {
          if (react) store.putBackEdits(); // nothing was written: show the edits again
          throw e;
        }
        wrote = true;
        setWritten(true);
        const n = body.applied ?? 0;
        store.activity("handoff", `Wrote ${n} change${n === 1 ? "" : "s"} to \`${(body.files ?? []).join("`, `")}\`${body.backup ? ` (backup in \`${body.backup}\`)` : ""}`);
      }
      if (toAi) {
        const screenshot = shot.current;
        const res = await sceneMode.writes(
          fetch("/api/handoff", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ kind: "ai", changeList: { ...list, changes: preview.needsAi }, ...(screenshot ? { screenshot } : {}), ...sceneMode.body({ handoff: true }) }),
          }),
        );
        const body = (await res.json()) as { warning?: string; error?: string };
        if (!res.ok) throw new Error(body.error ?? res.statusText);
        if (body.warning) store.activity("warn", body.warning);
      }
      // A write commits on its own (see writingSource).
      if (!wrote) store.commitHandoff();
      void store.refreshHandoffs();
      onClose();
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      setError(wrote ? `Your edits were written, but sending the other ${preview.needsAi.length} to your AI failed: ${why}` : why);
      setBusy(false);
    }
  };

  const nothingToWrite = preview !== null && preview.files.length === 0;

  return (
    <Modal className="wide" onClose={onClose} busy={busy}>
      <header>
        <h2>Edit source</h2>
        <p>Glimpse writes your edits straight into the files. Review the changes first; a backup is kept in <code>.glimpse/backups</code>.</p>
      </header>
      <div className="body">
        {!preview && !error && <p className="hint">Working out the changes…</p>}
        {preview && preview.files.map((f) => <DiffView key={f.file} file={f.file} diff={f.diff} />)}
        {nothingToWrite && <p className="hint">None of these edits can be written safely by Glimpse. They need your AI.</p>}
        {preview && preview.needsAi.length > 0 && (
          <div className="needs-ai">
            <h3>Needs AI ({preview.needsAi.length})</h3>
            <p className="hint">
              {sceneMode.state.active
                ? `Glimpse writes your edits into ${sceneMode.state.file}, but the real code still has to follow: your agent does that.`
                : "Moves, resizes, behaviors and notes need judgement about the code, so your agent does them."}
            </p>
            {preview.needsAi.some((c) => c.src && repeats.has(c.src)) && (
              <p className="hint">
                So do edits of elements the page shows more than once (list items, shared components): writing them into the source would change every copy.
              </p>
            )}
            <ol className="changes">
              {preview.needsAi.map((c, i) => (
                <li key={i}>
                  <span className="op">{c.op}</span> {describeChange(c)}
                  {c.src && repeats.has(c.src) && <span className="repeat-note">used in {repeats.get(c.src)} places → sent to AI</span>}
                </li>
              ))}
            </ol>
            <label className="check">
              <input type="checkbox" checked={sendRest} onChange={(e) => setSendRest(e.target.checked)} />
              Send these {preview.needsAi.length} to your AI
            </label>
          </div>
        )}
        {error && <p style={{ color: "var(--danger)" }}>{error}</p>}
      </div>
      <footer>
        <button className="btn" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          className="btn primary"
          onClick={apply}
          disabled={busy || !preview || ((nothingToWrite || written) && (!sendRest || preview.needsAi.length === 0))}
        >
          {nothingToWrite || written ? (
            <>
              <I.Send size={14} /> Send to AI
            </>
          ) : (
            <>
              <I.Code size={14} /> {busy ? "Writing…" : sendRest && preview && preview.needsAi.length > 0 ? "Apply & send the rest" : "Apply"}
            </>
          )}
        </button>
      </footer>
    </Modal>
  );
}

function DiffView({ file, diff }: { file: string; diff: string }) {
  // Skip the "Index/===/---/+++" header lines of the unified diff.
  const lines = diff.split("\n").filter((l) => !/^(Index:|={3,}|--- |\+\+\+ |\\ No newline)/.test(l));
  return (
    <div className="diff">
      <div className="diff-file">
        <I.Code size={14} /> {file}
      </div>
      <pre>
        {lines.map((l, i) => (
          <div key={i} className={l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : l.startsWith("@@") ? "hunk" : ""}>
            {l || " "}
          </div>
        ))}
      </pre>
    </div>
  );
}
