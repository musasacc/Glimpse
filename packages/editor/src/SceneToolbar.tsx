import type { SceneTheme } from "@glimpse/core";
import * as I from "./icons";
import { sceneMode, useSceneMode } from "./scene-mode";

const THEMES: { id: SceneTheme; label: string }[] = [
  { id: "macos", label: "macOS" },
  { id: "windows", label: "Windows" },
  { id: "linux", label: "Linux" },
];

/** Toolbar controls of the scene canvas: the platform look of a native mock, and the terminal (or log) pane. */
export function SceneToolbar() {
  const sm = useSceneMode();
  const t = sm.terminal;
  return (
    <>
      {sm.target === "native" && (
        <div className="seg" role="group" aria-label="Platform look">
          {THEMES.map((th) => (
            <button key={th.id} className={sm.theme === th.id ? "active" : ""} title={`Draw the window the way ${th.label} does`} onClick={() => sceneMode.setTheme(th.id)}>
              {th.label}
            </button>
          ))}
        </div>
      )}
      <button
        className={`btn tool-toggle${sm.dock.open ? " on" : ""}`}
        aria-pressed={sm.dock.open}
        title={sm.target === "tui" ? "The real app, running in a terminal next to the mock" : "Output of the real app"}
        onClick={() => sceneMode.setDock({ open: !sm.dock.open })}
      >
        <I.Terminal size={14} /> {sm.target === "tui" ? "Terminal" : "App log"}
        <span className={`term-dot${t.running ? " on" : ""}`} />
      </button>
    </>
  );
}
