import { useEffect, useRef, useState, type ReactNode } from "react";
import { describeNode, type Align } from "@glimpse/core";
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
