import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Mode } from "./Canvas";
import { Compare, isReactProject, ReactVersionNote } from "./Compare";
import * as I from "./icons";
import * as L from "./loop-icons";
import { enc, KIND_TITLE, loop, readOnly, since, useLoop, type PublicSnapshot, type SnapshotKind } from "./loop";
import { DEVICE_WIDTH, store, useStore } from "./store";
import { CanvasContextMenu, VariantBanners, VariantsDialog, VariantsView } from "./Variants";
import { SceneVersion } from "./SceneVersions";
import { Modal } from "./Modal";
import "./loop.css";

const KIND_ICON: Record<SnapshotKind, (p: { size?: number }) => ReactNode> = {
  initial: L.Flag,
  ai: L.Sparkles,
  handoff: I.Send,
  source: I.Code,
  restore: L.Restore,
  variant: L.Grid,
  manual: L.Bookmark,
};

/** Arrow-key position of the "Now" card after the newest version. */
const LIVE = "";

const closeVariants = () => loop.set({ variantsFor: null });

/** Toolbar: show/hide the timeline, and compare before/after the AI's last round. */
export function LoopToolbar() {
  const ls = useLoop();
  useStore();
  // A React app's past versions can't be rendered (only its running Vite can): nothing to compare.
  const round = ls.historyAvailable && !isReactProject() ? loop.lastRound() : null;
  return (
    <>
      <button
        className={`icon-btn${ls.timelineOpen ? " on" : ""}`}
        title={ls.timelineOpen ? "Hide versions" : "Show versions"}
        aria-pressed={ls.timelineOpen}
        onClick={() => loop.toggleTimeline()}
      >
        <I.History />
      </button>
      {round && (
        <button className="btn" title={`Before/after the AI's last round: “${round.before.label}” vs. now`} onClick={() => loop.compare(round.before.id, null)}>
          <L.Split size={14} /> <span className="tb-label">Compare</span>
        </button>
      )}
    </>
  );
}

/**
 * Everything the version loop adds to the editor: a version, comparison or
 * variants shown in place of the live page, the timeline strip, banners,
 * dialogs and the canvas context menu. The live canvas stays mounted
 * underneath, so the page and unsent edits survive.
 */
export function LoopStage({ mode, openTalk }: { mode: Mode; openTalk: () => void }) {
  const ls = useLoop();
  const v = ls.view;
  return (
    <>
      {v.kind === "snapshot" && <SnapshotView id={v.id} />}
      {v.kind === "compare" && <Compare before={v.before} after={v.after} />}
      {v.kind === "variants" && <VariantsView jobId={v.job} />}
      {v.kind === "live" && <VariantBanners />}
      {ls.timelineOpen && <Timeline />}
      {ls.confirmRestore && <RestoreDialog id={ls.confirmRestore} />}
      {ls.variantsFor && <VariantsDialog nodeId={ls.variantsFor} onClose={closeVariants} />}
      <CanvasContextMenu mode={mode} openTalk={openTalk} />
    </>
  );
}

/** The strip of versions under the canvas: oldest left, newest (and "Now") right. */
export function Timeline() {
  const ls = useLoop();
  const list = useRef<HTMLDivElement>(null);
  const [, tick] = useState(0);

  // Keep "5m ago" fresh.
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const v = ls.view;
  /** The strip shows its newest end (it starts there); kept up to date as the user scrolls it. */
  const atEnd = useRef(true);

  // Follow the newest version as they arrive, unless the user is looking further back.
  useLayoutEffect(() => {
    const el = list.current;
    if (!el || !(v.kind === "live" || atEnd.current)) return;
    el.scrollLeft = el.scrollWidth;
    // Still keep the version being looked at in view.
    if (v.kind !== "live") el.querySelector(".tl-card.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [ls.snapshots.length]);

  const current = v.kind === "snapshot" ? v.id : v.kind === "compare" ? v.before : LIVE;
  const ids = [...ls.snapshots.map((s) => s.id), LIVE];

  useEffect(() => {
    list.current?.querySelector(".tl-card.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [current]);

  const go = (id: string) => (id === LIVE ? loop.backToLive() : loop.viewSnapshot(id));

  const onKeyDown = (e: React.KeyboardEvent) => {
    const at = Math.max(0, ids.indexOf(current));
    const next =
      e.key === "ArrowLeft" ? at - 1
      : e.key === "ArrowRight" ? at + 1
      : e.key === "Home" ? 0
      : e.key === "End" ? ids.length - 1
      : null;
    if (next === null) return;
    // Arrows here browse versions; they must not nudge the selected element.
    e.preventDefault();
    e.stopPropagation();
    go(ids[Math.max(0, Math.min(ids.length - 1, next))]!);
  };

  return (
    <section className="timeline" aria-label="Versions">
      <div className="tl-head">
        <div className="tl-title">
          <I.History size={13} /> Versions
          {ls.snapshots.length > 0 && <span className="tl-count">{ls.snapshots.length}</span>}
        </div>
        <button
          className="btn tl-save"
          disabled={!ls.historyAvailable}
          title="Save the project files as they are now"
          onClick={() => void loop.saveVersion()}
        >
          <L.Bookmark size={14} /> Save version
        </button>
        <button className="icon-btn tl-hide" title="Hide versions" onClick={() => loop.toggleTimeline(false)}>
          <L.ChevronDown />
        </button>
      </div>
      {!ls.historyAvailable ? (
        <div className="tl-empty">Version history needs a newer Glimpse server. Update glimpse-ui and restart it.</div>
      ) : (
        <div
          className="tl-list"
          ref={list}
          onScroll={(e) => {
            const el = e.currentTarget;
            atEnd.current = el.scrollLeft + el.clientWidth >= el.scrollWidth - 24;
          }}
          role="listbox"
          aria-label="Versions, oldest first"
          aria-orientation="horizontal"
          tabIndex={0}
          onKeyDown={onKeyDown}
        >
          {ls.snapshots.length === 0 && (
            <div className="tl-empty">No versions yet. Glimpse keeps one each time the AI finishes a round, or press Save version.</div>
          )}
          {ls.snapshots.map((s) => (
            <SnapshotCard key={s.id} s={s} active={s.id === current} rev={ls.thumbRev[s.id] ?? 0} onClick={() => go(s.id)} />
          ))}
          <button
            role="option"
            aria-selected={current === LIVE}
            tabIndex={-1}
            className={`tl-card${current === LIVE ? " active" : ""}`}
            title="The live page you're editing"
            onClick={() => go(LIVE)}
          >
            <span className="tl-thumb tl-now">
              <span className="dot" /> Live
            </span>
            <span className="tl-label">Now</span>
            <span className="tl-time">editing</span>
          </button>
        </div>
      )}
    </section>
  );
}

function SnapshotCard({ s, active, rev, onClick }: { s: PublicSnapshot; active: boolean; rev: number; onClick: () => void }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [rev]);
  const Icon = KIND_ICON[s.kind] ?? L.Bookmark;
  return (
    <button
      role="option"
      aria-selected={active}
      tabIndex={-1}
      className={`tl-card${active ? " active" : ""}`}
      title={`${s.label}\n${KIND_TITLE[s.kind] ?? s.kind} · ${new Date(s.at).toLocaleString()} · ${s.fileCount} file${s.fileCount === 1 ? "" : "s"}`}
      onClick={onClick}
    >
      <span className="tl-thumb" data-kind={s.kind}>
        {s.thumb && !broken ? (
          <img src={`/api/history/${enc(s.id)}/thumb?v=${rev}`} alt="" loading="lazy" draggable={false} onError={() => setBroken(true)} />
        ) : (
          <Icon size={20} />
        )}
        <span className="tl-badge" data-kind={s.kind} title={KIND_TITLE[s.kind]}>
          <Icon size={11} />
        </span>
      </span>
      <span className="tl-label ellipsis">{s.label}</span>
      <span className="tl-time">{since(s.at)}</span>
    </button>
  );
}

/** A past version in place of the live page, read-only, with what you can do with it. */
function SnapshotView({ id }: { id: string }) {
  const state = useStore();
  useLoop();
  const s = loop.snapshot(id);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !loop.state.confirmRestore) loop.backToLive();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!s) return null;
  const width = DEVICE_WIDTH[state.device];
  const react = isReactProject();
  return (
    <div className="canvas loop-stage">
      <div className="loop-bar">
        <span className="loop-tag" data-kind={s.kind}>
          {KIND_TITLE[s.kind] ?? s.kind}
        </span>
        <span className="grow ellipsis">
          Viewing <b>{s.label}</b> · <time title={new Date(s.at).toLocaleString()}>{since(s.at)}</time>
        </span>
        <button className="btn" onClick={() => loop.set({ confirmRestore: s.id })} title="Put the project files back to this version">
          <L.Restore size={14} /> Restore
        </button>
        {!react && (
          <button className="btn" onClick={() => loop.compare(s.id, null)} title="Before/after slider: this version vs. now">
            <L.Split size={14} /> Compare with now
          </button>
        )}
        <button className="btn primary" onClick={() => loop.backToLive()} title="Back to the live page (Esc)">
          Back to live
        </button>
      </div>
      <div className="frame" style={{ width: width ? `${width}px` : "100%" }}>
        {/* A terminal UI or native GUI has no page: draw the version's scene file instead. */}
        {store.sceneSurface ? (
          <SceneVersion key={id} id={id} />
        ) : react ? (
          <ReactVersionNote />
        ) : (
          <iframe
            key={id}
            src={`/snapshot/${enc(id)}/`}
            title={`Version: ${s.label}`}
            onLoad={(e) => readOnly(e.currentTarget.contentDocument, () => loop.backToLive())}
          />
        )}
      </div>
    </div>
  );
}

/** "Restore this version?" The server backs up the current files first, so this is undoable. */
function RestoreDialog({ id }: { id: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const s = loop.snapshot(id);
  const pending = store.pendingCount;
  const close = () => loop.set({ confirmRestore: null });

  useEffect(() => {
    if (!s) loop.set({ confirmRestore: null });
  }, [s]);

  if (!s) return null;
  const restore = async () => {
    setBusy(true);
    setError(null);
    try {
      await loop.restore(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Modal role="alertdialog" onClose={close} busy={busy}>
      <header>
        <h2>Restore this version?</h2>
        <p>
          The project files go back to <b>{s.label}</b> from {new Date(s.at).toLocaleString()}. Glimpse first saves the current files as a new
          version, so you can always come back.
        </p>
      </header>
      {(pending > 0 || error) && (
        <div className="body">
          {pending > 0 && (
            <p className="hint">
              Your {pending} unsent edit{pending === 1 ? "" : "s"} will be replayed on the restored page where they still fit.
            </p>
          )}
          {error && <p style={{ color: "var(--danger)" }}>{error}</p>}
        </div>
      )}
      <footer>
        <button className="btn" onClick={close} disabled={busy}>
          Cancel
        </button>
        <button className="btn primary" onClick={restore} disabled={busy} autoFocus>
          <L.Restore size={14} /> {busy ? "Restoring…" : "Restore"}
        </button>
      </footer>
    </Modal>
  );
}
