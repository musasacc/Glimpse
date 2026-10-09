import { useState } from "react";
import * as I from "./icons";
import { applyProjectState } from "./live";
import { useStore } from "./store";
import "./react.css";

/**
 * Why the React preview can't run (e.g. Vite isn't installed yet), shown in
 * place of a broken page: on the canvas, and as a notice on the home screen.
 * The server starts the preview by itself once the dependencies are installed;
 * "Check again" asks it right away (a lockfile outside the folder isn't watched).
 */
export function PreviewError({ compact = false }: { compact?: boolean }) {
  const state = useStore();
  const [checking, setChecking] = useState(false);
  if (!state.previewError) return null;

  const check = async () => {
    setChecking(true);
    try {
      const res = await fetch("/api/session");
      if (res.ok) applyProjectState(await res.json());
    } catch {
      // server not reachable: the live connection catches up once it is back
    } finally {
      setChecking(false);
    }
  };
  const again = (
    <button className={compact ? "ghost" : "btn"} onClick={() => void check()} disabled={checking}>
      {checking ? "Checking…" : "Check again"}
    </button>
  );

  if (compact) {
    return (
      <div className="preview-error compact" role="status">
        <span className="preview-error-dot" />
        <p>
          <strong>The React preview can't start.</strong> {withCode(state.previewError)}
        </p>
        {again}
      </div>
    );
  }
  return (
    <div className="preview-error" role="status">
      <div className="preview-error-icon">
        <I.Code size={22} />
      </div>
      <h3>The React preview can't start</h3>
      <p>{withCode(state.previewError)}</p>
      {again}
      <p className="hint">The page appears here as soon as it can run; Glimpse notices when the dependencies get installed.</p>
    </div>
  );
}

/** Commands in the message ("run npm install in …") as code. */
function withCode(text: string) {
  return text.split(/\b((?:npm|pnpm|yarn|bun) install)\b/).map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part));
}
