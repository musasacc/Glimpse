import { useId } from "react";

/** The cursor of the Glimpse mark, pointing into the window frame from its lower right. */
const CURSOR = "M31 31 L53 39.5 L43.5 42.5 L49.5 52 L45 54.5 L39.2 45 L32.5 51.5 Z";

/**
 * The Glimpse mark: a window frame with a cursor over its corner, in `currentColor`. The gap around the cursor is
 * cut out of the frame with a mask (no painted outline), so it sits on any background. `weight` is the frame's line
 * width in the 64-unit box; `outline` draws the cursor as a line of that width instead of filled (a faint watermark).
 * Without `size` it fills its container's width (CSS sizes it).
 */
export function Mark({ size, className, weight = 4.5, outline = false }: { size?: number; className?: string; weight?: number; outline?: boolean }) {
  const mask = `glimpse-mark-${useId().replace(/[^\w-]/g, "")}`;
  // The gap between cursor and frame: half the line width, at least 1.75 units.
  const gap = Math.max(weight / 2, 1.75);
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <defs>
        <mask id={mask} maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
          <rect width="64" height="64" fill="#fff" />
          <path d={CURSOR} fill="#000" stroke="#000" strokeWidth={gap * 2 + (outline ? weight : 1)} strokeLinejoin="round" />
        </mask>
      </defs>
      <rect x="13" y="13" width="30" height="30" rx="7" fill="none" stroke="currentColor" strokeWidth={weight} mask={`url(#${mask})`} />
      <path
        d={CURSOR}
        fill={outline ? "none" : "currentColor"}
        stroke="currentColor"
        strokeWidth={outline ? weight : 1}
        strokeLinejoin="round"
      />
    </svg>
  );
}
