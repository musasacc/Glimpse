import { useId } from "react";

/** The cursor of the Glimpse mark, pointing into the window frame from its lower right. */
const CURSOR = "M31 31 L53 39.5 L43.5 42.5 L49.5 52 L45 54.5 L39.2 45 L32.5 51.5 Z";

/**
 * The frame sits on even units (14…42, 4 wide), so at half scale (1 unit = 0.5 px) its edges land on whole pixels.
 * Keep in step with assets/mark.svg and packages/editor/public/favicon.svg.
 */
const FRAME = { x: 14, size: 28, rx: 7 };

/**
 * Where to look at the mark from so it renders crisp at `size` px: half scale, with an origin that puts the frame's
 * edges on whole pixels (an even unit). Null when the mark doesn't fit that window (it is then scaled whole).
 */
function crispView(size: number | undefined): string | null {
  if (!size || size < 22 || size > 32) return null;
  // The drawing spans about 12…55 units; centre it in the 2·size units the window shows.
  const o = 2 * Math.round((33.5 - size) / 2);
  return `${o} ${o} ${2 * size} ${2 * size}`;
}

/**
 * The Glimpse mark: a window frame with a cursor over its corner, in `currentColor`. The gap around the cursor is
 * cut out of the frame with a mask (no painted outline), so it sits on any background. `weight` is the frame's line
 * width in the 64-unit box; `outline` draws the cursor as a line of that width instead of filled (a faint watermark).
 * Without `size` it fills its container's width (CSS sizes it). With a small `size` (22–32 px) it is drawn pixel-
 * aligned: a 2 px frame on whole pixels instead of a blurred 1.5 px one.
 */
export function Mark({ size, className, weight = 4, outline = false }: { size?: number; className?: string; weight?: number; outline?: boolean }) {
  const mask = `glimpse-mark-${useId().replace(/[^\w-]/g, "")}`;
  // The gap between cursor and frame: half the line width, at least 1.75 units.
  const gap = Math.max(weight / 2, 1.75);
  const view = crispView(size);
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox={view ?? "0 0 64 64"}
      shapeRendering="geometricPrecision"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <mask id={mask} maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
          <rect width="64" height="64" fill="#fff" />
          <path d={CURSOR} fill="#000" stroke="#000" strokeWidth={gap * 2 + (outline ? weight : 0)} strokeLinejoin="round" />
        </mask>
      </defs>
      <rect
        x={FRAME.x}
        y={FRAME.x}
        width={FRAME.size}
        height={FRAME.size}
        rx={FRAME.rx}
        fill="none"
        stroke="currentColor"
        strokeWidth={weight}
        mask={`url(#${mask})`}
      />
      {/* Filled, the cursor has no stroke of its own: a hairline stroke over the fill only blurred its edges. */}
      <path d={CURSOR} fill={outline ? "none" : "currentColor"} stroke={outline ? "currentColor" : "none"} strokeWidth={outline ? weight : 0} strokeLinejoin="round" />
    </svg>
  );
}
