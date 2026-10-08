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
