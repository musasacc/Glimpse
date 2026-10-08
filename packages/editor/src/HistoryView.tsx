import { useEffect, useState } from "react";
import * as I from "./icons";
import * as L from "./loop-icons";
import { ago } from "./Sidebar";
import { store, useStore } from "./store";
import "./loop.css";

interface FullHandoff {
  seq: number;
  kind: string;
  createdAt: string;
  prompt: string;
  delivered: boolean;
  /** Project-relative path of the PNG the editor sent along (newer servers). */
  screenshot?: string;
}

const KIND_LABEL: Record<string, string> = { ai: "Edits → AI", source: "Written to source", request: "Build request", variants: "Variants" };

/** Everything sent to the agent: build requests and edit handoffs. */
export function HistoryView() {
  const state = useStore();
  const [open, setOpen] = useState<FullHandoff | null>(null);
  const selected = state.openHandoff ?? state.handoffs[0]?.seq ?? null;

  useEffect(() => {
    void store.refreshHandoffs();
  }, []);

  useEffect(() => {
    if (selected === null) return setOpen(null);
    let cancelled = false;
    fetch(`/api/handoffs/${selected}`)
      .then((r) => r.json())
      .then((h: FullHandoff) => !cancelled && setOpen(h))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [selected, state.handoffs]);

  return (
    <section className="history">
      <header className="view-head">
        <h2>History</h2>
        <p>Every request and every round of edits you've sent to your agent.</p>
      </header>
      {state.handoffs.length === 0 ? (
        <div className="history-empty">
          <I.History size={28} />
          <p>Nothing here yet. Describe a UI on the home screen, or edit a page and press Send to AI.</p>
        </div>
      ) : (
        <div className="history-grid">
          <ul className="history-list">
            {state.handoffs.map((h) => (
              <li key={h.seq}>
                <button className={h.seq === selected ? "active" : ""} onClick={() => store.set({ openHandoff: h.seq })}>
                  <span className={`kind kind-${h.kind}`}>
                    {KIND_LABEL[h.kind] ?? h.kind}
                    {h.screenshot && (
                      <span className="shot" title="Sent with a screenshot of your edited page">
                        <L.Camera size={12} />
                      </span>
                    )}
                  </span>
                  <span className="title ellipsis">{h.title}</span>
                  <span className="meta">
                    #{h.seq} · {ago(h.createdAt)} · {h.delivered ? "received" : "waiting for agent"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <article className="history-detail">
            {open ? (
              <>
                <div className="meta">
                  #{open.seq} · {new Date(open.createdAt).toLocaleString()} · {open.delivered ? "received by agent" : "queued"}
                  {open.screenshot && " · with screenshot"}
                </div>
                <pre>{open.prompt}</pre>
                {open.screenshot && <Screenshot path={open.screenshot} />}
              </>
            ) : (
              <div className="side-empty">Select an entry</div>
            )}
          </article>
        </div>
      )}
    </section>
  );
}

/**
 * The picture that went with a handoff. The server keeps it inside the
 * project (`.glimpse/handoffs/<seq>.png`), so it's read through the preview;
 * if that isn't served, the image just stays hidden.
 */
function Screenshot({ path }: { path: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [path]);
  if (failed) return null;
  const src = path.startsWith("data:image/") ? path : `/preview/${path.split("/").map(encodeURIComponent).join("/")}`;
  return <img className="history-shot" src={src} alt="Screenshot of the edited page sent with this handoff" onError={() => setFailed(true)} />;
}
