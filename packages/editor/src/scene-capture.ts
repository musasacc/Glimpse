import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { toPng } from "html-to-image";
import { parseSceneFile } from "@glimpse/core";
import { drawBoxes, type MarkBox } from "./capture";
import { enc } from "./loop";
import { sceneMode } from "./scene-mode";
import { SceneView } from "./SceneView";

/**
 * Pictures of scene mocks: the edited mock for a handoff (with its box prompts
 * drawn in), and timeline thumbnails of past versions, drawn off-screen from
 * the version's scene file the way the canvas draws it.
 */

/** PNG of the mock's frame (unscaled), with `boxes` drawn over it. Best effort: null on failure. */
export async function captureFrame(frame: HTMLElement, boxes: MarkBox[], maxWidth = 1280): Promise<string | null> {
  try {
    const width = frame.offsetWidth;
    const height = frame.offsetHeight;
    if (!width || !height) return null;
    const scale = Math.min(1, maxWidth / width);
    const png = await toPng(frame, {
      width,
      height,
      canvasWidth: Math.round(width * scale),
      canvasHeight: Math.round(height * scale),
      pixelRatio: 1,
      // The frame is shown scaled to fit; capture it at its own size.
      style: { transform: "none" },
      filter: (n: Node) => !(n.nodeType === 1 && (n as Element).hasAttribute("data-glimpse-internal")),
    });
    return drawBoxes(png, boxes, width);
  } catch {
    return null;
  }
}

/** A thumbnail of version `id`: its scene file, drawn off-screen and captured. Null when it has no readable scene. */
export async function renderThumbnail(id: string, maxWidth: number): Promise<string | null> {
  let text: string;
  try {
    const res = await fetch(`/snapshot/${enc(id)}/`);
    if (!res.ok) return null;
    text = await res.text();
  } catch {
    return null;
  }
  let scene;
  try {
    scene = parseSceneFile(text).scene;
  } catch {
    return null;
  }
  const { cell, theme, extras } = sceneMode.state;
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = "position:fixed;left:-10000px;top:0;pointer-events:none";
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    flushSync(() => root.render(createElement(SceneView, { scene, target: scene.target === "native" ? "native" : "tui", cell, theme, title: extras.meta?.title })));
    const frame = host.firstElementChild as HTMLElement | null;
    return frame ? await captureFrame(frame, [], maxWidth) : null;
  } finally {
    root.unmount();
    host.remove();
  }
}
