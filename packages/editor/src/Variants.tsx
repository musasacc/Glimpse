import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { describeNode, formatSource } from "@glimpse/core";
import type { Mode } from "./Canvas";
import * as L from "./loop-icons";
import { enc, loop, readOnly, useLoop, variantPage } from "./loop";
import { Modal } from "./Modal";
import { isEnter, MOD } from "./platform";
import { DEVICE_WIDTH, store, useStore } from "./store";
import "./loop.css";

const COUNTS = [2, 3, 4];

/** Variants are written as files, so the element has to be in one. */
export const NO_SOURCE = "Variants need an element that is in the files. Send or write this one to the source first.";
export const NO_REACT =
  "Variants aren't available for React projects yet: Glimpse can't show a variant of a component outside your running app. Use Point & talk to ask your agent for alternatives.";

/** Why "Variants…" can't be used on this element, or undefined when it can. */
export function variantsBlocked(node: { source?: unknown }): string | undefined {
  if (store.state.project?.target === "react") return NO_REACT;
  return node.source ? undefined : NO_SOURCE;
}

/** "Variants…": ask the agent for a few alternative designs of one element, to pick from side by side. */
export function VariantsDialog({ nodeId, onClose }: { nodeId: string; onClose: () => void }) {
  const state = useStore();
  const [count, setCount] = useState(3);
  const [hint, setHint] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const node = store.scene?.nodes[nodeId];

  // The element can vanish under the dialog (the AI changed the page).
  useEffect(() => {
    if (!node) onClose();
  }, [node, onClose]);

  if (!node) return null;
  const label = describeNode(node);
  const src = formatSource(node.source);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await loop.requestVariants({ ...(src ? { src } : {}), label, count, ...(hint.trim() ? { hint: hint.trim() } : {}) });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} busy={busy}>
      <header>
        <h2>Variants of {label}</h2>
        <p>
          Your agent designs a few alternatives and you compare them side by side. Pick one and Glimpse puts it into the code.
          {!state.agentWaiting && " No agent is listening right now. It'll get the request as soon as it runs `glimpse wait`."}
        </p>
      </header>
      <div className="body">
        <div className="field">
          <label>How many</label>
          <div className="seg vr-count" role="radiogroup" aria-label="How many variants">
            {COUNTS.map((n) => (
              <button key={n} role="radio" aria-checked={n === count} className={n === count ? "active" : ""} onClick={() => setCount(n)}>
                {n}
              </button>
            ))}
          </div>
        </div>
        <textarea
          className="input"
          autoFocus
          placeholder="What should the variants explore? (optional) e.g. bolder, more playful, with an icon"
          value={hint}
          onChange={(e) => setHint(e.target.value)}
          onKeyDown={(e) => {
            if (isEnter(e) && (e.metaKey || e.ctrlKey)) void submit();
          }}
        />
        {src && (
          <p className="hint">
            Element in <code>{src}</code>
          </p>
        )}
        {error && <p style={{ color: "var(--danger)" }}>{error}</p>}
      </div>
      <footer>
        <button className="btn" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button className="btn primary" onClick={() => void submit()} disabled={busy} title={`${MOD}Enter`}>
          <L.Grid size={14} /> {busy ? "Asking…" : `Ask for ${count} variants`}
        </button>
      </footer>
    </Modal>
  );
}

/** One line per open variants job, floating at the bottom of the canvas. */
export function VariantBanners() {
  const ls = useLoop();
  if (ls.jobs.length === 0) return null;
  return (
    <div className="loop-banners">
      {ls.jobs.map((job) => {
        const ready = job.ready.length;
        const done = ready >= job.count;
        return (
          <div key={job.id} className="loop-banner" role="status">
            <span className={`agent-dot${done ? " on" : ""}`} />
            <span className="grow ellipsis">
              {done ? (
                <>
                  {job.count} variants of <b>{job.label}</b> are ready
                </>
              ) : (
                <>
                  Waiting for your agent: {job.count} variants of <b>{job.label}</b> · {ready}/{job.count} ready
                </>
              )}
            </span>
            <button className={`btn${ready ? " primary" : ""}`} onClick={() => loop.showVariants(job.id)}>
              <L.Grid size={14} /> Show variants
            </button>
            <button className="btn" onClick={() => void loop.discard(job.id)}>
              Discard
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** The variants of one job side by side, each the full page with that variant in place. */
export function VariantsView({ jobId }: { jobId: string }) {
  const ls = useLoop();
  const state = useStore();
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && loop.backToLive();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const job = ls.jobs.find((j) => j.id === jobId);
  if (!job) return null;
  const ks = Array.from({ length: job.count }, (_, i) => i + 1);
  // Desktop pages need the room of a 2×2 grid; phone-width ones fit in a row.
  const cols = state.device === "mobile" ? job.count : Math.min(2, job.count);
  // Lay each variant out as wide as the live page is shown, then scale it into its cell.
  const pageWidth = DEVICE_WIDTH[state.device] ?? (store.bridge?.doc.documentElement.clientWidth || 1280);

  const use = async (k: number) => {
    setBusy(k);
    setError(null);
    try {
      await loop.choose(job.id, k);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  };

  return (
    <div className="canvas loop-stage">
      <div className="loop-bar">
        <L.Grid size={14} />
        <span className="grow ellipsis">
          Variants of <b>{job.label}</b> · {job.ready.length}/{job.count} ready
          {job.hint ? ` · “${job.hint}”` : ""}
        </span>
        <button className="btn" onClick={() => void loop.discard(job.id)} title="Throw these variants away">
          Discard
        </button>
        <button className="btn primary" onClick={() => loop.backToLive()} title="Back to the live page (Esc)">
          Back to live
        </button>
      </div>
      {error && <div className="loop-error">{error}</div>}
      <div className="vr-grid" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
        {ks.map((k) => {
          const ready = job.ready.includes(k);
          return (
            <section key={k} className={`vr-cell${ready ? "" : " is-waiting"}`}>
              <header>
                <span className="vr-name">Variant {k}</span>
                {!ready && <span className="meta">waiting for your agent…</span>}
                <span className="spacer" />
                <button className="btn primary" disabled={!ready || busy !== null} onClick={() => void use(k)}>
                  {busy === k ? "Applying…" : "Use this"}
                </button>
              </header>
              {ready ? (
                <ScaledFrame src={`/variant/${enc(job.id)}/${k}/${variantPage(job)}`} pageWidth={pageWidth} title={`Variant ${k} of ${job.label}`} rev={ls.cellRev[`${job.id}:${k}`] ?? 0} />
              ) : (
                <div className="vr-wait">
                  <svg viewBox="0 0 64 64" aria-hidden="true">
                    <path d="M5 32C14 16 50 16 59 32C50 48 14 48 5 32Z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
                    <circle cx="35" cy="31" r="8" fill="currentColor" />
                  </svg>
                  <span>Your agent hasn't written variant {k} yet</span>
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

/**
 * A page laid out at `pageWidth` CSS px and scaled down to fit its box, like
 * a zoomed-out browser, so a desktop page in a small cell keeps its layout.
 * Reloads in place whenever `rev` changes (the agent saved that variant).
 */
function ScaledFrame({ src, pageWidth, title, rev }: { src: string; pageWidth: number; title: string; rev: number }) {
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The first load already has the latest files; reload on later saves only.
  const loadedRev = useRef(rev);
  useEffect(() => {
    if (rev !== loadedRev.current) frame.current?.contentWindow?.location.reload();
    loadedRev.current = rev;
  }, [rev]);

  const scale = size.w ? Math.min(1, size.w / pageWidth) : 1;
  return (
    <div className="vr-frame" ref={box}>
      <iframe
        ref={frame}
        src={src}
        title={title}
        style={{ width: pageWidth, height: size.h / scale || "100%", transform: `scale(${scale})` }}
        onLoad={(e) => readOnly(e.currentTarget.contentDocument, () => loop.backToLive())}
      />
    </div>
  );
}

/**
 * Right-click an element of the live page for the usual things to do with it.
 * Listens on the preview document itself, so the canvas needs no extra hook.
 */
export function CanvasContextMenu({ mode, openTalk }: { mode: Mode; openTalk: () => void }) {
  useStore(); // re-render when the preview document is (re)attached
  const doc = store.bridge?.doc;
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  useEffect(() => {
    if (!doc) return;
    const onMenu = (e: MouseEvent) => {
      if (modeRef.current !== "edit" || !loop.live) return;
      const id = store.bridge?.pick(e.target);
      if (!id) return;
      e.preventDefault();
      // The page's coordinates are relative to the iframe; the menu lives in the editor.
      const frame = doc.defaultView?.frameElement?.getBoundingClientRect();
      // Right-clicking one of several selected elements keeps them all (Duplicate/Delete act on all).
      const keep = store.state.multi.includes(id) && store.selection.length > 1;
      store.set(keep ? { selected: id, multi: store.state.multi } : { selected: id });
      setMenu({ id, x: (frame?.left ?? 0) + e.clientX, y: (frame?.top ?? 0) + e.clientY });
    };
    const close = () => setMenu(null);
    const win = doc.defaultView;
    doc.addEventListener("contextmenu", onMenu);
    doc.addEventListener("mousedown", close);
    win?.addEventListener("scroll", close, { passive: true });
    return () => {
      doc.removeEventListener("contextmenu", onMenu);
      doc.removeEventListener("mousedown", close);
      win?.removeEventListener("scroll", close);
    };
  }, [doc]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    // The right-click left focus in the page, so Esc arrives there. Catch it before the page's
    // shortcuts do (they would clear the selection the menu acts on) and only close the menu.
    const pageWin = store.bridge?.doc.defaultView;
    const onPageKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    pageWin?.addEventListener("keydown", onPageKey, true);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
      pageWin?.removeEventListener("keydown", onPageKey, true);
    };
  }, [menu]);

  const node = menu ? store.scene?.nodes[menu.id] : undefined;
  if (!menu || !node) return null;
  const count = store.selection.length;
  const run = (fn: () => void) => () => {
    setMenu(null);
    fn();
  };
  // Keep the menu on screen near the window edges.
  const left = Math.max(4, Math.min(menu.x, window.innerWidth - 224));
  const top = Math.max(4, Math.min(menu.y, window.innerHeight - 200));
  return (
    <div className="menu ctx-menu" role="menu" style={{ left, top }} onMouseDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
      <div className="ctx-title ellipsis">{count > 1 ? `${describeNode(node)} + ${count - 1} more` : describeNode(node)}</div>
      <button role="menuitem" onClick={run(openTalk)}>
        <L.Message size={14} /> Talk to AI <span className="kbd">T</span>
      </button>
      <button role="menuitem" disabled={!!variantsBlocked(node)} title={variantsBlocked(node)} onClick={run(() => loop.openVariants(menu.id))}>
        <L.Grid size={14} /> Variants…
      </button>
      <button role="menuitem" onClick={run(() => store.duplicateSelected())}>
        <L.Copy size={14} /> Duplicate <span className="kbd">{MOD}D</span>
      </button>
      <button role="menuitem" className="danger" onClick={run(() => store.deleteSelected())}>
        <L.Trash size={14} /> Delete <span className="kbd">Del</span>
      </button>
    </div>
  );
}
