import { toPng } from "html-to-image";

export interface CaptureOptions {
  /** Scale the picture down to at most this many pixels wide. */
  maxWidth?: number;
  /** Cap the captured height in CSS pixels (thumbnails crop to a landscape card). */
  maxHeight?: number;
  /** Capture what is scrolled into view instead of the top of the page. */
  atScroll?: boolean;
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
    const height = Math.min(root.clientHeight || win.innerHeight, opts.maxHeight ?? Infinity);
    if (!width || !height) return null;
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
      // An error (JSON) instead of a page: nothing worth a picture.
      if (frame.contentDocument?.contentType !== "text/html") return finish(null);
      // Give scripts, images and layout a moment to settle.
      setTimeout(() => void capturePreview(frame, opts).then(finish), 600);
    };
    frame.src = url;
    document.body.appendChild(frame);
  });
}

/** A box to draw over a capture, in the captured viewport's CSS pixels. */
export interface MarkBox {
  left: number;
  top: number;
  width: number;
  height: number;
  num: number;
  text: string;
}

/**
 * Draw box prompts over a viewport capture the way the editor shows them
 * (dashed cyan, numbered, with their text). They live in the editor's overlay,
 * not in the page, so the capture alone would leave them out. Best effort:
 * on any failure the plain picture is returned.
 */
export async function drawBoxes(dataUrl: string, boxes: MarkBox[], viewportWidth: number): Promise<string> {
  if (boxes.length === 0 || !viewportWidth) return dataUrl;
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
    const k = img.naturalWidth / viewportWidth;
    ctx.scale(k, k);
    const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#5ce1ff";
    for (const b of boxes) {
      ctx.fillStyle = "rgba(92, 225, 255, 0.1)";
      ctx.fillRect(b.left, b.top, b.width, b.height);
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = accent;
      ctx.strokeRect(b.left, b.top, b.width, b.height);
      ctx.setLineDash([]);
      ctx.font = "500 12px system-ui, sans-serif";
      ctx.textBaseline = "middle";
      const text = fit(ctx, b.text, Math.max(0, b.width - 28));
      if (text) {
        const w = ctx.measureText(text).width + 12;
        ctx.fillStyle = "rgba(0, 0, 0, 0.78)";
        ctx.fillRect(b.left + 16, b.top + 6, w, 18);
        ctx.fillStyle = accent;
        ctx.fillText(text, b.left + 22, b.top + 15);
      }
      ctx.beginPath();
      ctx.arc(b.left, b.top, 10, 0, Math.PI * 2);
      ctx.fillStyle = accent;
      ctx.fill();
      ctx.fillStyle = "#000";
      ctx.font = "700 11px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(String(b.num), b.left, b.top + 0.5);
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
