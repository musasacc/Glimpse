/**
 * Terminal colors for TUI mocks: ANSI names ("cyan", "bright-black",
 * "ansi_red"), #hex and CSS colors, Textual theme variables ("$accent",
 * "$primary-darken-2", "$text-muted") and an optional opacity ("red 50%").
 * Everything resolves to a CSS color the mock can paint with.
 */

/** The 16 ANSI colors, as a modern dark terminal draws them (the mock and the real terminal share them). */
export const ANSI: Record<string, string> = {
  black: "#1b1b1f",
  red: "#e5534b",
  green: "#3fb950",
  yellow: "#d4a72c",
  blue: "#4c8ff7",
  magenta: "#c97ed6",
  cyan: "#39c5cf",
  white: "#d0d0d0",
  "bright-black": "#6e7681",
  "bright-red": "#ff7b72",
  "bright-green": "#56d364",
  "bright-yellow": "#f2cc60",
  "bright-blue": "#79c0ff",
  "bright-magenta": "#e2a5f0",
  "bright-cyan": "#56d4dd",
  "bright-white": "#ffffff",
  grey: "#8b8b8b",
  gray: "#8b8b8b",
};

/** Textual's default dark theme, which most Textual apps (and their scene files) use. */
const THEME: Record<string, string> = {
  primary: "#0178d4",
  secondary: "#004578",
  accent: "#ffa62b",
  warning: "#ffa62b",
  error: "#ba3c5b",
  success: "#4ebf71",
  foreground: "#e0e0e0",
  background: "#121212",
  surface: "#1e1e1e",
  panel: "#242f38",
  boost: "#1a1a1a",
  text: "#e0e0e0",
  "text-muted": "#a0a0a0",
  "text-disabled": "#737373",
  "text-primary": "#4ca6ef",
  "text-secondary": "#5f8fbf",
  "text-accent": "#ffc067",
  "text-warning": "#ffc067",
  "text-error": "#e0768f",
  "text-success": "#7fd69c",
  border: "#0178d4",
  "border-blurred": "#262626",
  "block-cursor-background": "#0178d4",
  "block-cursor-foreground": "#e0e0e0",
  "block-cursor-blurred-background": "#1f3a52",
  "block-hover-background": "#262626",
  "footer-background": "#242f38",
  "footer-key-foreground": "#ffa62b",
  "footer-description-foreground": "#e0e0e0",
  "scrollbar": "#3a3a3a",
  "input-cursor-background": "#e0e0e0",
};

/** Screen colors when the scene sets none: Textual's background and text. */
export const SCREEN_BG = THEME.background!;
export const SCREEN_FG = THEME.foreground!;
/** A frame drawn without a color. */
export const BORDER_FG = "#5c6370";

/** CSS color for a terminal color value, or undefined when there is none (or it can't be read). */
export function tuiColor(value: string | undefined, against: string = SCREEN_BG): string | undefined {
  const v = value?.trim();
  if (!v || v === "default" || v === "none" || v === "transparent") return undefined;
  // "red 50%", "$accent 30%": a translucent color.
  const alpha = /^(.*\S)\s+(\d{1,3})%$/.exec(v);
  if (alpha) {
    const base = tuiColor(alpha[1], against);
    return base ? mix(base, against, Number(alpha[2]) / 100) : undefined;
  }
  if (v === "auto") return luminance(against) > 0.5 ? "#121212" : "#e0e0e0";
  if (v.startsWith("$")) return themeVar(v.slice(1), against);
  const name = v.toLowerCase().replace(/^ansi[_-]/, "").replace(/_/g, "-").replace(/^bright(?=[a-z])/, "bright-");
  if (ANSI[name]) return ANSI[name];
  if (/^#[0-9a-f]{3,8}$/i.test(v) || /^(rgb|rgba|hsl|hsla)\(/i.test(v)) return v;
  // Rich's "grey50"/"gray50"
  const grey = /^gr[ae]y(\d{1,3})$/.exec(name);
  if (grey) return hex(Array(3).fill(Math.round((Number(grey[1]) / 100) * 255)) as [number, number, number]);
  return typeof CSS !== "undefined" && CSS.supports("color", v) ? v : undefined;
}

/** "$primary", "$primary-darken-2", "$accent-lighten-1", "$secondary-muted", "$text-muted" … */
function themeVar(name: string, against: string): string | undefined {
  if (THEME[name]) return THEME[name];
  const shade = /^(.+)-(lighten|darken)-(\d)$/.exec(name);
  if (shade) {
    const base = themeVar(shade[1]!, against);
    return base ? shift(base, (shade[2] === "lighten" ? 1 : -1) * Number(shade[3]) * 0.08) : undefined;
  }
  const muted = /^(.+)-muted$/.exec(name);
  if (muted) {
    const base = themeVar(muted[1]!, against);
    return base ? mix(base, THEME.background!, 0.3) : undefined;
  }
  return THEME.foreground;
}

/** `color` laid over `back` at `amount` opacity, as an opaque color. */
export function mix(color: string, back: string, amount: number): string {
  const a = rgb(color);
  const b = rgb(back);
  if (!a || !b) return color;
  return hex([0, 1, 2].map((i) => a[i]! * amount + b[i]! * (1 - amount)) as [number, number, number]);
}

/** Relative brightness 0…1 (good enough to pick light or dark text). */
function luminance(color: string): number {
  const c = rgb(color);
  return c ? (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255 : 0;
}

/** Lighter (positive) or darker (negative) by a fraction of full brightness. */
function shift(color: string, by: number): string {
  const c = rgb(color);
  if (!c) return color;
  return hex(c.map((v) => v + by * 255) as [number, number, number]);
}

function rgb(color: string): [number, number, number] | null {
  let m = /^#([0-9a-f]{3})$/i.exec(color);
  if (m) return [...m[1]!].map((d) => parseInt(d + d, 16)) as [number, number, number];
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(color);
  if (m) return [0, 2, 4].map((i) => parseInt(m![1]!.slice(i, i + 2), 16)) as [number, number, number];
  const f = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(color);
  return f ? [Number(f[1]), Number(f[2]), Number(f[3])] : null;
}

function hex(c: [number, number, number]): string {
  return "#" + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
}

/** Text styles of a terminal ("bold italic underline reverse dim strike") as CSS. */
export interface TextStyle {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  reverse: boolean;
  dim: boolean;
  strike: boolean;
}

export function textStyle(value: string | undefined): TextStyle {
  const words = new Set((value ?? "").toLowerCase().split(/[\s,]+/));
  return {
    bold: words.has("bold") || words.has("b"),
    italic: words.has("italic") || words.has("i"),
    underline: words.has("underline") || words.has("u"),
    reverse: words.has("reverse"),
    dim: words.has("dim"),
    strike: words.has("strike") || words.has("strikethrough"),
  };
}

/** Terminal width of a string in cells: wide (CJK, most emoji) characters take two, combining marks none. */
export function cellWidth(text: string): number {
  let n = 0;
  for (const g of graphemes(text)) n += graphemeWidth(g);
  return n;
}

/** Cut `text` to `max` cells. */
export function fitCells(text: string, max: number): string {
  if (max <= 0) return "";
  let n = 0;
  let out = "";
  for (const g of graphemes(text)) {
    const w = graphemeWidth(g);
    if (n + w > max) break;
    n += w;
    out += g;
  }
  return out;
}

/** `text` followed by spaces up to `width` cells (String.padEnd counts UTF-16 units, not cells). */
export function padCells(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - cellWidth(text)));
}

/** Word-wrap text into lines of at most `width` cells (explicit line breaks kept). */
export function wrapCells(text: string, width: number): string[] {
  if (width <= 0) return [];
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/(\s+)/)) {
      if (word === "") continue;
      if (cellWidth(line + word) <= width) {
        line += word;
        continue;
      }
      if (line.trim()) out.push(line.trimEnd());
      line = /^\s+$/.test(word) ? "" : word;
      // A word longer than the line breaks anywhere.
      while (cellWidth(line) > width) {
        // A wide glyph in a 1-cell line doesn't fit at all: take it anyway, or the line never gets shorter.
        const head = fitCells(line, width) || graphemes(line)[0]!;
        out.push(head);
        line = line.slice(head.length);
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

const segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

/**
 * The characters of `text` as a terminal draws them: grapheme clusters, so an emoji with a skin tone, a ZWJ
 * sequence (👩‍💻), a flag or a letter with combining accents is one glyph.
 */
export function graphemes(text: string): string[] {
  if (!segmenter) return [...text];
  const out: string[] = [];
  for (const s of segmenter.segment(text)) out.push(s.segment);
  return out;
}

const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}]/u;
const EMOJI_PRESENTATION = /^\p{Emoji_Presentation}/u;
const EMOJI = /^\p{Emoji}/u;

/** Cells one grapheme cluster takes: wcwidth of its first character, wide when an emoji variation selector follows. */
function graphemeWidth(g: string): number {
  const cp = g.codePointAt(0);
  if (cp === undefined || ZERO_WIDTH.test(g)) return 0;
  if (isWide(cp) || EMOJI_PRESENTATION.test(g)) return g.includes("︎") ? 1 : 2;
  // A text-style symbol shown as an emoji (☀️, ❤️) is drawn wide.
  if (g.includes("️") && (cp > 0xff || g.includes("⃣")) && EMOJI.test(g)) return 2;
  return 1;
}

/** East Asian Wide and Fullwidth ranges (emoji are matched by their Emoji_Presentation property). */
function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x16fe0 && cp <= 0x18aff) ||
    (cp >= 0x1b000 && cp <= 0x1b2ff) ||
    (cp >= 0x1f200 && cp <= 0x1f2ff) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x1fa70 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}
