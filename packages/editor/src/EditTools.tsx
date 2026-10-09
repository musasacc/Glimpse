import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { describeNode, type Align, type RegionOp } from "@glimpse/core";
import { alignSelection, canArrange, distributeSelection, groupProblem, groupSelection } from "./arrange";
import * as I from "./icons";
import { Modal } from "./Modal";
import { MOD } from "./platform";
import { store, useStore } from "./store";
import "./editing.css";

const ALIGN: { how: Align; label: string; icon: ReactNode }[] = [
  { how: "left", label: "Align left edges", icon: <I.AlignLeft /> },
  { how: "center", label: "Align horizontal centers", icon: <I.AlignCenter /> },
  { how: "right", label: "Align right edges", icon: <I.AlignRight /> },
  { how: "top", label: "Align top edges", icon: <I.AlignTop /> },
  { how: "middle", label: "Align vertical centers", icon: <I.AlignMiddle /> },
  { how: "bottom", label: "Align bottom edges", icon: <I.AlignBottom /> },
];

/** Inspector for 2+ selected elements: what is selected, Arrange (align, distribute, group) and bulk actions. */
export function SelectionInspector() {
  useStore();
  const scene = store.scene;
  const ids = store.selection;
  if (!scene) return null;
  const arrange = canArrange();
  const spread = ids.length >= 3 && arrange;
  const problem = groupProblem();
  return (
    <>
      <div className="section">
        <h3>{ids.length} selected</h3>
        <div className="sel-chips">
          {ids.slice(0, 8).map((id) => (
            <button key={id} className={`sel-chip${id === store.state.selected ? " primary" : ""}`} title="Shift-click to remove" onClick={(e) => (e.shiftKey ? store.toggleSelect(id) : store.select(id))}>
              {describeNode(scene.nodes[id]!)}
            </button>
          ))}
          {ids.length > 8 && <span className="sel-more">+{ids.length - 8} more</span>}
        </div>
        <div className="row">
          <button className="btn" onClick={() => store.duplicateSelected()}>
            Duplicate <span className="kbd">{MOD}D</span>
          </button>
          <button className="btn" style={{ color: "var(--danger)" }} onClick={() => store.deleteSelected()}>
            Delete
          </button>
        </div>
      </div>

      <div className="section">
        <h3>Arrange</h3>
        <div className="arrange">
          {ALIGN.map((a) => (
            <button key={a.how} className="icon-btn" title={a.label} aria-label={a.label} disabled={!arrange} onClick={() => alignSelection(a.how)}>
              {a.icon}
            </button>
          ))}
        </div>
        <div className="arrange">
          <button className="icon-btn" title={spread ? "Distribute horizontally: even gaps" : "Select 3 or more to distribute"} aria-label="Distribute horizontally" disabled={!spread} onClick={() => distributeSelection("x")}>
            <I.DistributeH />
          </button>
          <button className="icon-btn" title={spread ? "Distribute vertically: even gaps" : "Select 3 or more to distribute"} aria-label="Distribute vertically" disabled={!spread} onClick={() => distributeSelection("y")}>
            <I.DistributeV />
          </button>
          <span className="grow" />
          <button className="btn" disabled={!!problem} title={problem ?? "Wrap the selection in a new box"} onClick={groupSelection}>
            <I.Group size={14} /> Group <span className="kbd">{MOD}G</span>
          </button>
        </div>
        <div className="hint">Shift-click elements or layers to add or remove them. Arrows nudge all of them.</div>
      </div>
    </>
  );
}

/** Toolbar toggle for the box prompt tool: draw a box on the page and tell the AI what goes there. */
export function BoxPromptToggle({ onEnable }: { onEnable: () => void }) {
  const state = useStore();
  const on = state.tool === "region";
  return (
    <button
      className={`btn tool-toggle${on ? " on" : ""}`}
      aria-pressed={on}
      title="Box prompt: draw a box on the page and tell the AI what goes there (R, or hold Alt and drag)"
      onClick={() => {
        if (!on) onEnable();
        store.setTool(on ? "select" : "region");
      }}
    >
      <I.BoxPrompt size={14} /> <span className="tb-label">Box prompt</span>
    </button>
  );
}

/** Toolbar action: drop every unsent edit after a confirmation. */
export function DiscardButton() {
  useStore();
  const [confirming, setConfirming] = useState(false);
  const log = store.log;
  const steps = log?.entries.length ?? 0;
  return (
    <>
      <button className="icon-btn" title="Discard edits: drop all unsent edits and reload the page" disabled={!log?.canUndo && !log?.canRedo} onClick={() => setConfirming(true)}>
        <I.Trash />
      </button>
      {confirming && <DiscardDialog steps={steps} onClose={() => setConfirming(false)} />}
    </>
  );
}

function DiscardDialog({ steps, onClose }: { steps: number; onClose: () => void }) {
  const confirm = useRef<HTMLButtonElement>(null);
  useEffect(() => confirm.current?.focus(), []);
  return (
    <Modal className="narrow" role="alertdialog" onClose={onClose}>
      <header>
        <h2>Discard your edits?</h2>
        <p>
          {steps > 0 ? `All ${steps} unsent edit${steps === 1 ? "" : "s"} will be dropped` : "Your undone edits will be dropped"} and the page reloads
          from its files. This can't be undone.
        </p>
      </header>
      <footer>
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          ref={confirm}
          className="btn danger"
          onClick={() => {
            store.discard();
            onClose();
          }}
        >
          <I.Trash size={14} /> Discard edits
        </button>
      </footer>
    </Modal>
  );
}

/**
 * A box prompt drawn on the canvas (page or mock). The box itself lets clicks through to what is under it; its
 * number and text select it (then Delete removes it), × removes it, and a right-click on them offers Remove.
 */
export function RegionBox({ region, num, rect, selected }: { region: RegionOp; num: number; rect: { left: number; top: number; width: number; height: number }; selected: boolean }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const select = (e: React.MouseEvent | React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    store.selectNote(region.id);
  };
  const remove = () => {
    setMenu(null);
    store.removeNote(region.id);
  };
  return (
    <div className={`region${selected ? " selected" : ""}`} style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}>
      <span
        className="region-num live-ui"
        title={region.text}
        onPointerDown={select}
        onMouseDown={(e) => e.stopPropagation()}
        onContextMenu={(e) => {
          select(e);
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        {num}
      </span>
      <span
        className="region-text live-ui"
        title={`${region.text}\nClick to select · Del removes it`}
        onPointerDown={select}
        onMouseDown={(e) => e.stopPropagation()}
        onContextMenu={(e) => {
          select(e);
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        {region.text}
      </span>
      <button
        type="button"
        className="region-del live-ui"
        title="Remove this box prompt (Del)"
        aria-label={`Remove box prompt ${num}`}
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          remove();
        }}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
      {menu && <RegionMenu at={menu} text={region.text} onRemove={remove} onClose={() => setMenu(null)} />}
    </div>
  );
}

/** Right-click menu of a box prompt (in the editor's document, so the canvas can't clip it). */
function RegionMenu({ at, text, onRemove, onClose }: { at: { x: number; y: number }; text: string; onRemove: () => void; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const page = store.bridge?.doc;
    window.addEventListener("pointerdown", onClose);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    window.addEventListener("keydown", onKey);
    page?.addEventListener("mousedown", onClose);
    return () => {
      window.removeEventListener("pointerdown", onClose);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("keydown", onKey);
      page?.removeEventListener("mousedown", onClose);
    };
  }, [onClose]);
  const left = Math.max(4, Math.min(at.x, window.innerWidth - 224));
  const top = Math.max(4, Math.min(at.y, window.innerHeight - 100));
  return createPortal(
    <div className="menu ctx-menu" role="menu" style={{ left, top }} onPointerDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
      <div className="ctx-title ellipsis">Box prompt: {text}</div>
      <button role="menuitem" className="danger" onClick={onRemove}>
        <I.Trash size={14} /> Remove box prompt <span className="kbd">Del</span>
      </button>
    </div>,
    document.body,
  );
}

/** Inspector for a selected box prompt: what it asks for, and Remove. */
export function NoteInspector({ id }: { id: string }) {
  useStore();
  const regions = store.regions;
  const i = regions.findIndex((r) => r.id === id);
  const region = regions[i];
  if (!region) return null;
  return (
    <div className="section">
      <h3>Box prompt {i + 1}</h3>
      <p className="note-text">{region.text}</p>
      <div className="row">
        <button className="btn danger" onClick={() => store.removeNote(id)}>
          <I.Trash size={14} /> Remove <span className="kbd">Del</span>
        </button>
      </div>
      <div className="hint">Removing it takes its instruction out of what goes to the AI. {MOD}Z brings it back.</div>
    </div>
  );
}
