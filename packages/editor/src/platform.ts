/** Modifier key label for shortcuts: ⌘ on macOS, Ctrl+ on Windows and Linux. */
const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = IS_MAC ? "⌘" : "Ctrl+";

/** Enter that isn't confirming an IME composition (Japanese, Chinese, Korean input), so it may submit or commit. */
export function isEnter(e: { key: string; keyCode?: number; isComposing?: boolean; nativeEvent?: { isComposing?: boolean } }): boolean {
  return e.key === "Enter" && !(e.isComposing || e.nativeEvent?.isComposing || e.keyCode === 229);
}
