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
  if (list.note) lines.push(`Note from the human: ${list.note}`, "");
  if (list.changes.length === 0) lines.push("No changes were made.");
  list.changes.forEach((c, i) => lines.push(`${i + 1}. ${describeChange(c)}`));
  return lines.join("\n");
}

export function describeChange(c: Change): string {
  const at = c.src ? ` (${c.src})` : "";
  const who = c.label ?? "element";
  const hint = c.intent ? ` — ${c.intent}` : "";
  const place = c.anchor
    ? ` In code: ${[c.anchor.after && `after the element at ${c.anchor.after}`, c.anchor.before && `before the element at ${c.anchor.before}`].filter(Boolean).join(", ")}.`
    : "";
  switch (c.op) {
    case "delete":
      return `Delete ${who}${at}.`;
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
      return c.to === null
        ? `Remove attribute \`${c.key}\` from ${who}${at}.`
        : `Set attribute \`${c.key}="${c.to}"\` on ${who}${at}.`;
    case "swapType":
      return `Turn ${who}${at} from a ${c.from} into a ${c.to}.`;
    case "setHidden":
      return c.to ? `Hide ${who}${at}.` : `Show ${who}${at}.`;
    case "setLocked":
      return `${c.to ? "Lock" : "Unlock"} ${who}${at} (editor-only; no code change needed).`;
    case "comment":
      return `Instruction for ${who}${at}: "${c.text}"`;
    case "behavior":
      return `Behavior for ${who}${at}: on ${c.event} → ${c.action}${c.detail ? ` (${c.detail})` : ""}.`;
    case "region":
      return `In the area x=${c.rect.x}, y=${c.rect.y}, ${c.rect.w}×${c.rect.h}: "${c.text}"`;
  }
}
