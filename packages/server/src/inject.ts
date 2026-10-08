/**
 * Script injected into every previewed HTML page. It connects to the Glimpse
 * server and applies the AI's file changes live:
 *   - CSS changes are hot-swapped without touching the page
 *   - HTML changes are morphed into the live DOM (scroll, state and selection survive)
 *   - anything else falls back to a reload
 * Elements whose markup changed get a short glow, so you can see what the AI touched.
 */
export const CLIENT_SCRIPT = String.raw`(() => {
  if (window.__glimpse) return;
  const g = (window.__glimpse = { version: 1 });
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const pagePath = decodeURIComponent(location.pathname.replace(/^\/preview\//, "")) || "index.html";

  const style = document.createElement("style");
  style.textContent = "@keyframes __glimpse_flash{0%{outline:2px solid rgba(92,225,255,.95);box-shadow:0 0 18px rgba(92,225,255,.7)}100%{outline:2px solid rgba(92,225,255,0);box-shadow:0 0 0 rgba(92,225,255,0)}}" +
    ".__glimpse-flash{animation:__glimpse_flash 1.2s ease-out;outline-offset:2px}";
  document.documentElement.appendChild(style);

  function flash(el) {
    if (!(el instanceof Element) || el === document.body || el === document.documentElement) return;
    el.classList.remove("__glimpse-flash");
    void el.offsetWidth;
    el.classList.add("__glimpse-flash");
    setTimeout(() => el.classList.remove("__glimpse-flash"), 1300);
  }

  function sameNode(a, b) {
    if (a.nodeType !== b.nodeType) return false;
    if (a.nodeType !== 1) return true;
    if (a.tagName !== b.tagName) return false;
    const ia = a.getAttribute("id"), ib = b.getAttribute("id");
    return !ia || !ib || ia === ib;
  }

  // Minimal keyed DOM morph: updates attributes and text in place and only
  // replaces subtrees whose shape changed. Returns elements that changed.
  function morph(from, to, changed) {
    if (from.nodeType === 3 || from.nodeType === 8) {
      if (from.nodeValue !== to.nodeValue) { from.nodeValue = to.nodeValue; changed.add(from.parentElement); }
      return;
    }
    if (from.nodeType !== 1) return;
    if (from.tagName === "SCRIPT") return; // never re-run scripts in place
    const ownClass = (el) => (el.getAttribute("class") || "").replace(/\s*__glimpse-flash/g, "").trim();
    for (const { name, value } of [...to.attributes]) {
      const same = name === "class" ? ownClass(from) === value.trim() : from.getAttribute(name) === value;
      if (same) continue;
      from.setAttribute(name, value);
      // Source line numbers shift whenever the file is edited; that alone isn't a visible change.
      if (name !== "data-glimpse-src") changed.add(from);
    }
    for (const { name } of [...from.attributes]) {
      if (to.hasAttribute(name)) continue;
      if (name === "class" && !ownClass(from)) continue;
      from.removeAttribute(name); changed.add(from);
    }
    const real = (n) => !(n.nodeType === 1 && n.hasAttribute("data-glimpse-internal"));
    const a = [...from.childNodes].filter(real);
    const b = [...to.childNodes].filter(real);
    let i = 0;
    for (; i < b.length; i++) {
      const cur = a[i];
      if (!cur) { const n = b[i].cloneNode(true); from.appendChild(n); changed.add(n.nodeType === 1 ? n : from); continue; }
      if (sameNode(cur, b[i])) morph(cur, b[i], changed);
      else { const n = b[i].cloneNode(true); from.replaceChild(n, cur); changed.add(n.nodeType === 1 ? n : from); }
    }
    for (; i < a.length; i++) { from.removeChild(a[i]); changed.add(from); }
  }

  function hotSwapCss(path) {
    let hit = false;
    for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
      const url = new URL(link.href);
      if (url.pathname.endsWith("/" + path) || url.pathname.endsWith(path)) {
        url.searchParams.set("__glimpse", Date.now());
        link.href = url.toString();
        hit = true;
      }
    }
    return hit;
  }

  async function updateHtml() {
    const res = await fetch(location.href, { cache: "no-store" });
    const doc = new DOMParser().parseFromString(await res.text(), "text/html");
    const changed = new Set();
    // The editor takes the human's unsent edits off the page around the morph (it pairs
    // elements by position) and puts them back after. Both events are synchronous.
    dispatchEvent(new Event("glimpse:before-morph"));
    try { morph(document.body, doc.body, changed); }
    finally { dispatchEvent(new Event("glimpse:after-morph")); }
    for (const el of changed) flash(el);
    parent.postMessage({ glimpse: "morphed", count: changed.size }, "*");
  }

  function connect() {
    const ws = new WebSocket(proto + "//" + location.host + "/__glimpse/ws");
    ws.onmessage = async (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type !== "file-changed") return;
      if (msg.path.endsWith(".css")) { if (!hotSwapCss(msg.path)) location.reload(); return; }
      if (msg.path === pagePath || (pagePath.endsWith("/") && msg.path === pagePath + "index.html")) {
        try { await updateHtml(); } catch { location.reload(); }
        return;
      }
      if (/\.(js|mjs|json|svg|png|jpe?g|gif|webp)$/.test(msg.path)) location.reload();
    };
    ws.onclose = () => setTimeout(connect, 1000);
  }
  connect();
})();`;

/** Insert the Glimpse client into an HTML document. */
export function injectClient(html: string): string {
  const tag = `<script data-glimpse-internal src="/__glimpse/client.js"></script>`;
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>(?![\s\S]*<\/body>)/i, `${tag}</body>`);
  return html + tag;
}
