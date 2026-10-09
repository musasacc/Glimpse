import { toPng } from "html-to-image";
import { markerLayout, type Mark } from "./markers";

export interface CaptureOptions {
  /** Scale the picture down to at most this many pixels wide. */
  maxWidth?: number;
  /** Cap the captured height in CSS pixels (thumbnails crop to a landscape card). */
  maxHeight?: number;
  /** Capture what is scrolled into view instead of the top of the page. */
  atScroll?: boolean;
  /** Give up (null) on a page with more elements than this: html-to-image copies all of them on the main thread. */
  maxElements?: number;
  /** captureUrl only: scroll the page there first (and capture what is scrolled into view). */
  scrollTo?: { x: number; y: number };
}

/**
 * Render one viewport of a same-origin page (the preview iframe, or its
 * document) to a PNG data URL with html-to-image. It reads the live DOM, so
 * unsent edits are in the picture. Capturing is always best effort: any
 * failure resolves to null and callers simply go without a picture.
 */
export async function capturePreview(target: HTMLIFrameElement | Document | null | undefined, opts: CaptureOptions = {}): Promise<string | null> {
  try {
    const doc = target && "contentDocument" in target ? target.contentDocument : target;
    const win = doc?.defaultView;
    const root = doc?.documentElement;
    if (!doc || !win || !root) return null;
    const width = root.clientWidth || win.innerWidth;
    // One viewport: a page without a doctype (quirks mode) reports its whole height as clientHeight.
    const height = Math.min(root.clientHeight || win.innerHeight, win.innerHeight || Infinity, opts.maxHeight ?? Infinity);
    if (!width || !height) return null;
    if (opts.maxElements !== undefined && doc.getElementsByTagName("*").length > opts.maxElements) return null;
    const scale = Math.min(1, (opts.maxWidth ?? width) / width);
    const dx = opts.atScroll ? win.scrollX : 0;
    const dy = opts.atScroll ? win.scrollY : 0;
    // Stop the "the AI touched this" glow so it isn't frozen into the picture.
    const calm = doc.createElement("style");
    calm.setAttribute("data-glimpse-internal", "");
    calm.textContent = ".__glimpse-flash{animation:none!important}";
    root.appendChild(calm);
    try {
      return await toPng(root, {
        width,
        height,
        canvasWidth: Math.max(1, Math.round(width * scale)),
        canvasHeight: Math.max(1, Math.round(height * scale)),
        pixelRatio: 1,
        backgroundColor: pageBackground(doc),
        // Fonts would have to be downloaded and inlined; fallback faces are fine for a preview.
        skipFonts: true,
        ...(dx || dy ? { style: { transform: `translate(${-dx}px, ${-dy}px)` } } : {}),
        filter: (n: Node) => !(n.nodeType === 1 && (n as Element).hasAttribute("data-glimpse-internal")),
      });
    } finally {
      calm.remove();
    }
  } catch {
    return null;
  }
}

/**
 * Load `url` in an off-screen iframe of the given size and capture it. Used
 * for versions that aren't what the live preview shows right now.
 */
export function captureUrl(url: string, size: { width: number; height: number }, opts: CaptureOptions = {}): Promise<string | null> {
  return new Promise((resolve) => {
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    frame.style.cssText = `position:fixed;top:0;left:${-size.width - 1000}px;width:${size.width}px;height:${size.height}px;border:0;pointer-events:none`;
    let done = false;
    const finish = (value: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      frame.remove();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 15000);
    frame.onload = () => {
      // An error (JSON) or the "this version has no page" placeholder: nothing worth a picture.
      const doc = frame.contentDocument;
      if (doc?.contentType !== "text/html" || doc.querySelector('meta[name="glimpse-missing"]')) return finish(null);
      // Give scripts, images and layout a moment to settle.
      setTimeout(() => {
        if (opts.scrollTo) frame.contentWindow?.scrollTo(opts.scrollTo.x, opts.scrollTo.y);
        void capturePreview(frame, opts.scrollTo ? { ...opts, atScroll: true } : opts).then(finish);
      }, 600);
    };
    frame.src = url;
    document.body.appendChild(frame);
  });
}

/**
 * Draw numbered markers over a capture of a view `viewWidth` CSS px wide: a
 * cyan outline around each changed element with a number badge matching the
 * change list, and box prompts the way the editor shows them (dashed, with
 * their text). They live in the editor's overlay, not in the page, so the
 * capture alone would leave them out. Best effort: on any failure the plain picture is returned.
 */
export async function drawMarkers(dataUrl: string, marks: Mark[], viewWidth: number): Promise<string> {
  if (marks.length === 0 || !viewWidth) return dataUrl;
  try {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return dataUrl;
    ctx.drawImage(img, 0, 0);
    const k = img.naturalWidth / viewWidth;
    ctx.scale(k, k);
    const accent = "#22d3ee";
    const placed = markerLayout(marks, { width: viewWidth, height: img.naturalHeight / k });
    for (const m of placed) {
      ctx.fillStyle = m.dashed ? "rgba(34, 211, 238, 0.12)" : "rgba(34, 211, 238, 0.06)";
      ctx.fillRect(m.left, m.top, m.width, m.height);
      // A dark halo under the cyan line keeps it visible on light and dark pages alike.
      ctx.setLineDash(m.dashed ? [6, 4] : []);
      ctx.lineWidth = 4;
      ctx.strokeStyle = "rgba(0, 0, 0, 0.45)";
      ctx.strokeRect(m.left + 1, m.top + 1, Math.max(0, m.width - 2), Math.max(0, m.height - 2));
      ctx.lineWidth = 2;
      ctx.strokeStyle = accent;
      ctx.strokeRect(m.left + 1, m.top + 1, Math.max(0, m.width - 2), Math.max(0, m.height - 2));
      ctx.setLineDash([]);
      ctx.textBaseline = "middle";
      if (m.text) {
        ctx.font = "500 12px system-ui, sans-serif";
        const text = fit(ctx, m.text, Math.max(0, m.width - 28));
        if (text) {
          const w = ctx.measureText(text).width + 12;
          ctx.fillStyle = "rgba(0, 0, 0, 0.78)";
          ctx.fillRect(m.left + 16, m.top + 6, w, 18);
          ctx.fillStyle = accent;
          ctx.fillText(text, m.left + 22, m.top + 15);
        }
      }
      const b = m.badge;
      ctx.beginPath();
      ctx.roundRect(b.left, b.top, b.width, b.height, b.height / 2);
      ctx.fillStyle = accent;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "rgba(0, 0, 0, 0.7)";
      ctx.stroke();
      ctx.fillStyle = "#000";
      ctx.font = "700 11px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(m.label, b.left + b.width / 2, b.top + b.height / 2 + 0.5);
      ctx.textAlign = "start";
    }
    return canvas.toDataURL("image/png");
  } catch {
    return dataUrl;
  }
}

/** `text` cut to `max` pixels with an ellipsis. */
function fit(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let s = text;
  while (s && ctx.measureText(`${s}…`).width > max) s = s.slice(0, -1);
  return s ? `${s}…` : "";
}

/** Resolve with `fallback` if `promise` takes longer than `ms`. */
export function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/** The colour the page paints behind everything (white when it sets none, like a browser). */
function pageBackground(doc: Document): string {
  const win = doc.defaultView!;
  for (const el of [doc.documentElement, doc.body]) {
    if (!el) continue;
    const bg = win.getComputedStyle(el).backgroundColor;
    if (bg && bg !== "transparent" && !/^rgba\(.*,\s*0\)$/.test(bg)) return bg;
  }
  return "#ffffff";
}
