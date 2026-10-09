import { useEffect, useState } from "react";
import * as I from "./icons";
import * as L from "./loop-icons";
import { ago } from "./Sidebar";
import { store, useStore } from "./store";
import "./loop.css";
import { apiFetch } from "./session";

interface FullHandoff {
  seq: number;
  kind: string;
  createdAt: string;
  prompt: string;
  delivered: boolean;
  cancelled?: boolean;
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
    apiFetch(`/api/handoffs/${selected}`)
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
        <p>Every request and every round of edits you've sent to the AI.</p>
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
                    #{h.seq} · {ago(h.createdAt)} · {h.cancelled ? "withdrawn" : h.delivered ? "received" : "waiting"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <article className="history-detail">
            {open ? (
              <>
                <div className="meta">
                  #{open.seq} · {new Date(open.createdAt).toLocaleString()} ·{" "}
                  {open.cancelled ? "withdrawn before the AI got it" : open.delivered ? "received" : "queued"}
                  {open.screenshot && " · with screenshot"}
                </div>
                <pre>{open.prompt}</pre>
                {open.screenshot && <Screenshot seq={open.seq} />}
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

/** The picture that went with a handoff; if the server can't serve it, it just stays hidden. */
function Screenshot({ seq }: { seq: number }) {
  // Fetched with the editor's session (an <img> can't send it), shown from a blob URL.
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    setSrc(null);
    apiFetch(`/api/handoffs/${seq}/screenshot`)
      .then(async (r) => (r.ok ? r.blob() : null))
      .then((blob) => {
        if (!blob || cancelled) return;
        url = URL.createObjectURL(blob);
        setSrc(url);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [seq]);
  if (!src) return null;
  return <img className="history-shot" src={src} alt="Screenshot of the edited page sent with this handoff" onError={() => setSrc(null)} />;
}
