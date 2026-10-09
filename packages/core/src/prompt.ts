import type { Change, ChangeList } from "./changes.js";

/**
 * Render a change list as plain-language instructions for an AI agent.
 * The JSON change list stays the source of truth; this is the readable summary
 * that accompanies it.
 */
export function changeListToPrompt(list: ChangeList): string {
  const lines: string[] = [
    `The human edited the ${list.target} UI in Glimpse. Apply these changes 1:1 to the real source code.`,
    "Prefer idiomatic layout changes (flex/grid order, spacing, alignment) over hard-coded pixel positions; use the intent hints.",
    "",
  ];
  const where = positionsNote(list);
  if (where) lines.splice(2, 0, where);
  if (list.note) lines.push(`Note from the human: ${list.note}`, "");
  if (list.changes.length === 0) lines.push("No changes were made.");
  lines.push(...numberedChanges(list.changes));
  return lines.join("\n");
}

/**
 * The changes as a numbered list. When the editor numbered them (the markers
 * on the annotated screenshot), those numbers are kept, so they still match
 * the picture after some changes were dealt with elsewhere.
 */
export function numberedChanges(changes: Change[]): string[] {
  const marked = changes.length > 0 && changes.every((c) => c.mark !== undefined) && new Set(changes.map((c) => c.mark)).size === changes.length;
  return changes.map((c, i) => `${marked ? c.mark : i + 1}. ${describeChange(c)}`);
}

/** What the coordinates in "Position:" mean, when any change has one. */
export function positionsNote(list: ChangeList): string | undefined {
  if (!list.changes.some((c) => c.place)) return undefined;
  if (list.target === "tui") return "Positions are terminal cells from the top-left of the screen (column, row).";
  if (list.target === "native") return "Positions are pixels from the top-left of the window's client area.";
  const wide = list.viewport ? ` with the preview ${list.viewport.width}px wide` : "";
  return `Positions are page coordinates in CSS px from the top-left of the page${wide}; they say where things should end up, build it with the layout, not absolute positioning.`;
}

function asList(value: string): (string | string[])[] {
  if (value === "") return [];
  return value.split("\n").map((line) => (line.includes("\t") ? line.split("\t") : line));
}

export function describeChange(c: Change): string {
  const text = describeOp(c);
  if (!c.place || c.op === "region" || c.op === "comment") return text;
  return `${text} Position: ${c.place}.`;
}

function describeOp(c: Change): string {
  const at = c.src ? ` (${c.src})` : "";
  const who = c.label ?? "element";
  const hint = c.intent ? ` — ${c.intent}` : "";
  const place = c.anchor
    ? ` In code: ${[c.anchor.after && `after the element at ${c.anchor.after}`, c.anchor.before && `before the element at ${c.anchor.before}`].filter(Boolean).join(", ")}.`
    : "";
  switch (c.op) {
    case "delete":
      return `Delete ${who}${at}${hint}.`;
    case "add": {
      const top = c.nodes[0]!;
      const styles = Object.entries(top.style).map(([k, v]) => `${k}: ${v}`).join("; ");
      return `Add ${who}${styles ? ` with style {${styles}}` : ""}${hint}.${place}`;
    }
    case "reorder":
      return `Move ${who}${at} in the tree${hint}.${place}`;
    case "move":
      return `Reposition ${who}${at}${hint}.`;
    case "resize":
      return `Resize ${who}${at}: ${c.intent ?? `${c.to.w}×${c.to.h}`}.`;
    case "setText":
      return `Change the text of ${who}${at} from "${c.from}" to "${c.to}".`;
    case "setStyle":
      return c.to === null
        ? `Remove style \`${c.key}\` from ${who}${at}.`
        : `Set style \`${c.key}: ${c.to}\` on ${who}${at}${c.from !== null ? ` (was \`${c.from}\`)` : ""}.`;
    case "setProp":
      if (c.to === null) return `Remove attribute \`${c.key}\` from ${who}${at}.`;
      // Multi-line props are lists (rows of a list, options of a select, table rows with tab-separated cells).
      if (c.to.includes("\n") || c.from?.includes("\n")) {
        return `Set \`${c.key}\` of ${who}${at} to ${JSON.stringify(asList(c.to))}${c.from !== null ? ` (was ${JSON.stringify(asList(c.from))})` : ""}.`;
      }
      return `Set attribute \`${c.key}="${c.to}"\` on ${who}${at}.`;
    case "swapType":
      return `Turn ${who}${at} from a ${c.from} into a ${c.to}.`;
    case "setHidden":
      return c.to ? `Hide ${who}${at}.` : `Show ${who}${at}.`;
    case "setLocked":
      return `${c.to ? "Lock" : "Unlock"} ${who}${at} (editor-only; no code change needed).`;
    case "comment":
      return `Instruction for ${who}${at}${c.place ? `, ${c.place}` : ""}: "${c.text}"`;
    case "behavior":
      return `Behavior for ${who}${at}: on ${c.event} → ${c.action}${c.detail ? ` (${c.detail})` : ""}.`;
    case "region":
      // `who`/`at` name the element the box was drawn in; the rect is relative to it.
      if (c.place) return `In the box the human drew ${c.place}: "${c.text}"`;
      return `In the area ${c.rect.x},${c.rect.y} ${c.rect.w}×${c.rect.h} inside ${c.label ?? "the page"}${at}: "${c.text}"`;
  }
}
