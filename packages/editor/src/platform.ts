/** Modifier key label for shortcuts: ⌘ on macOS, Ctrl+ on Windows and Linux. */
export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = IS_MAC ? "⌘" : "Ctrl+";
