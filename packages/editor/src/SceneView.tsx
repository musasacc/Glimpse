import type { ReactNode, Ref } from "react";
import type { Scene, SceneTheme } from "@glimpse/core";
import { NativeWindow } from "./NativeRenderer";
import type { Cell, SceneTarget } from "./scene-geometry";
import { TuiScreen } from "./TuiRenderer";

/** The terminal window around a TUI mock: a title bar with the app's title and the terminal size. */
export function TuiWindow({ title, size, screenRef, children }: { title?: string; size: string; screenRef?: Ref<HTMLDivElement>; children: ReactNode }) {
  return (
    <div className="tui-window">
      <div className="tui-titlebar">
        <span className="tui-dots">
          <i />
          <i />
          <i />
        </span>
        <span className="tui-title">
          {title ? `${title} — ` : ""}
          {size}
        </span>
      </div>
      <div className="tui-body">
        <div ref={screenRef}>{children}</div>
      </div>
    </div>
  );
}

/** A scene drawn read-only, the way the canvas draws it (versions, comparisons, thumbnails). */
export function SceneView({ scene, target, cell, theme, title }: { scene: Scene; target: SceneTarget; cell: Cell; theme: SceneTheme; title?: string }) {
  const root = scene.nodes[scene.rootId]!;
  return target === "tui" ? (
    <TuiWindow title={title} size={`${root.layout.w}×${root.layout.h}`}>
      <TuiScreen scene={scene} cell={cell} />
    </TuiWindow>
  ) : (
    <NativeWindow scene={scene} theme={theme} title={title} />
  );
}
