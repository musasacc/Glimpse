import { SCENE_PALETTE, tagForWidget } from "./scene-geometry";
import { WidgetIcon } from "./scene-icons";
import { useSceneMode } from "./scene-mode";
import { store } from "./store";

/**
 * The palette for terminal UIs and native GUIs: their widgets, sized for the
 * target (cells or pixels) and named after the real widget class of the
 * toolkit when the scene file says which one it is (Textual, Tkinter).
 */
export function ScenePalette() {
  const sm = useSceneMode();
  const target = sm.target;
  const framework = typeof sm.extras.meta?.framework === "string" ? sm.extras.meta.framework : undefined;
  return (
    <div className="palette scene-palette">
      {SCENE_PALETTE.filter((p) => !p.only || p.only === target).map((p) => (
        <button
          key={p.label}
          className="pal"
          title={`Add ${p.label.toLowerCase()}`}
          onClick={() => {
            const [w, h] = p.size[target];
            store.addElement(p.type, tagForWidget(framework, p.type) ?? "", {
              // A width of 0 spans the parent (bars and rules).
              layout: { x: 0, y: 0, w: w === "fill" ? 0 : w, h },
              props: { ...p.props },
              style: { ...p.style?.[target] },
            });
          }}
        >
          <WidgetIcon type={p.type} />
          <span>{p.label}</span>
        </button>
      ))}
    </div>
  );
}
