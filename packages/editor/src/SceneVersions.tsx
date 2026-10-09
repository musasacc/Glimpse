import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { parseSceneFile, type Scene } from "@glimpse/core";
import { enc } from "./loop";
import { useSceneMode } from "./scene-mode";
import { SceneView } from "./SceneView";
import { store, useStore } from "./store";

/**
 * Versions of a terminal UI or native GUI in the timeline: a snapshot holds
 * the scene file as it was, so a version is that scene drawn read-only (there
 * is no page to load in a frame). Used in place of the iframes of web pages.
 */

/** The scene file of version `id`, parsed. */
function useSnapshotScene(id: string): { scene: Scene | null; error: string | null } {
  const [out, setOut] = useState<{ scene: Scene | null; error: string | null }>({ scene: null, error: null });
  useEffect(() => {
    let live = true;
    setOut({ scene: null, error: null });
    fetch(`/snapshot/${enc(id)}/`)
      .then(async (res) => {
        if (!res.ok) throw new Error(res.status === 404 ? "This version has no scene file." : res.statusText);
        return parseSceneFile(await res.text()).scene;
      })
      .then(
        (scene) => live && setOut({ scene, error: null }),
        (e: unknown) => live && setOut({ scene: null, error: e instanceof Error ? e.message : String(e) }),
      );
    return () => {
      live = false;
    };
  }, [id]);
  return out;
}

/** Version `id` drawn in place of the live mock. */
export function SceneVersion({ id }: { id: string }) {
  const { scene, error } = useSnapshotScene(id);
  return (
    <div className="scene-version">
      {scene ? <Drawn scene={scene} /> : <div className="side-empty">{error ?? "Loading this version…"}</div>}
    </div>
  );
}

/**
 * The two sides of a before/after comparison, stacked: version `before`
 * underneath, `after` (another version, or the mock now with unsent edits) on
 * top, clipped from the left at `pos` percent.
 */
export function SceneCompareLayers({ before, after, pos }: { before: string; after: string | null; pos: number }) {
  useStore();
  const b = useSnapshotScene(before);
  const a = useSnapshotScene(after ?? before);
  const now = after === null ? store.scene : a.scene;
  return (
    <>
      <div className="scene-version">{b.scene ? <Drawn scene={b.scene} /> : <div className="side-empty">{b.error ?? "Loading…"}</div>}</div>
      <div className="scene-version" style={{ clipPath: `inset(0 0 0 ${pos}%)` }}>
        {now ? <Drawn scene={now} /> : <div className="side-empty">{a.error ?? "Loading…"}</div>}
      </div>
    </>
  );
}

/** A scene drawn read-only, scaled to fit the space it has. */
function Drawn({ scene }: { scene: Scene }) {
  const sm = useSceneMode();
  const meta = sm.extras.meta;
  return (
    <Fit>
      <SceneView scene={scene} target={scene.target === "native" ? "native" : "tui"} cell={sm.cell} theme={sm.theme} title={typeof meta?.title === "string" ? meta.title : undefined} />
    </Fit>
  );
}

/** Scales its content down (never up) to fit, centered. */
function Fit({ children }: { children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [k, setK] = useState(1);
  useLayoutEffect(() => {
    const el = box.current;
    const c = inner.current;
    if (!el || !c) return;
    const fit = () => {
      const z = Math.min(1, (el.clientWidth - 48) / (c.offsetWidth || 1), (el.clientHeight - 48) / (c.offsetHeight || 1));
      setK(Math.floor(Math.max(0.2, z) * 1000) / 1000);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    ro.observe(c);
    return () => ro.disconnect();
  }, []);
  return (
    <div className="scene-fit" ref={box}>
      <div ref={inner} style={{ transform: `scale(${k})` }}>
        {children}
      </div>
    </div>
  );
}
