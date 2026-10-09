/**
 * Script injected into every previewed HTML page. It connects to the Glimpse
 * server and applies the AI's file changes live:
 *   - CSS changes are hot-swapped without touching the page
 *   - HTML changes are morphed into the live DOM (scroll, state and selection survive), <head> included
 *   - a new or changed script reloads the page, since it can only run on a fresh load
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
    setTimeout(() => {
      el.classList.remove("__glimpse-flash");
      if (!(el.getAttribute("class") || "").trim()) el.removeAttribute("class");
    }, 1300);
  }

  function sameNode(a, b) {
    if (a.nodeType !== b.nodeType) return false;
    if (a.nodeType !== 1) return true;
    if (a.tagName !== b.tagName) return false;
    const ia = a.getAttribute("id"), ib = b.getAttribute("id");
    return !ia || !ib || ia === ib;
  }

  const internal = (n) => n.nodeType === 1 && n.hasAttribute("data-glimpse-internal");
  // What a node looks like, minus what changes without the page changing: source line numbers
  // (they shift whenever lines are added above) and Glimpse's own flash class.
  function sig(n) {
    if (n.nodeType !== 1) return n.nodeType + ":" + n.nodeValue;
    return n.outerHTML.replace(/ data-glimpse-src="[^"]*"/g, "").replace(/ class="([^"]*)"/g, (_, c) => {
      const v = c.replace(/(^|\s)__glimpse-flash(?=\s|$)/g, "").trim();
      return v ? ' class="' + v + '"' : "";
    });
  }

  // Index pairs of equal entries of a and b, in order: their longest common subsequence
  // (lists too long to compare whole only match at their common start and end).
  function lineUp(a, b) {
    let s = 0;
    while (s < a.length && s < b.length && a[s] === b[s]) s++;
    let ea = a.length, eb = b.length;
    while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
    const pairs = [];
    for (let i = 0; i < s; i++) pairs.push([i, i]);
    const n = ea - s, m = eb - s, w = m + 1;
    if (n > 0 && m > 0 && n * m <= 250000) {
      const t = new Uint32Array((n + 1) * w);
      for (let i = n - 1; i >= 0; i--)
        for (let j = m - 1; j >= 0; j--)
          t[i * w + j] = a[s + i] === b[s + j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
      for (let i = 0, j = 0; i < n && j < m; ) {
        if (a[s + i] === b[s + j]) pairs.push([s + i++, s + j++]);
        else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) i++;
        else j++;
      }
    }
    for (let k = 0; ea + k < a.length; k++) pairs.push([ea + k, eb + k]);
    return pairs;
  }

  // Keyed DOM morph: children that are unchanged (apart from line numbers) keep their element, so
  // listeners, input values and focus stay with what they belong to; new ones are inserted and gone
  // ones removed, rather than every following sibling being rewritten. Between unchanged children,
  // the rest are paired in order and updated in place (attributes and text), and subtrees whose shape
  // changed are replaced. Collects the elements that changed.
  function morph(from, to, changed) {
    if (from.nodeType === 3 || from.nodeType === 8) {
      if (from.nodeValue !== to.nodeValue) { from.nodeValue = to.nodeValue; changed.add(from.parentElement); }
      return;
    }
    if (from.nodeType !== 1) return;
    if (from.tagName === "SCRIPT") return; // never re-run scripts in place (a changed script reloads the page)
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
    const a = [...from.childNodes].filter((n) => !internal(n));
    const b = [...to.childNodes].filter((n) => !internal(n));
    const pairs = lineUp(a.map(sig), b.map(sig));
    pairs.push([a.length, b.length]);
    const added = (n) => changed.add(n.nodeType === 1 ? n : from);
    let i = 0, j = 0;
    for (const [pi, pj] of pairs) {
      const anchor = a[pi] || null;
      // The changed run between two unchanged children: pair it up in order.
      for (; i < pi && j < pj; i++, j++) {
        if (sameNode(a[i], b[j])) morph(a[i], b[j], changed);
        else { const n = b[j].cloneNode(true); from.replaceChild(n, a[i]); added(n); }
      }
      for (; j < pj; j++) { const n = b[j].cloneNode(true); from.insertBefore(n, anchor); added(n); }
      for (; i < pi; i++) { from.removeChild(a[i]); changed.add(from); }
      if (pi < a.length) morph(a[pi], b[pj], changed);
      i = pi + 1; j = pj + 1;
    }
  }

  // <head>: what the page's own scripts added there (CSS-in-JS styles, analytics) must stay, so only what
  // changed between the previous and the new source is applied: gone elements removed, new ones inserted
  // in source order. A changed <style> or <title> is one of each.
  function headKey(el) {
    if (el.tagName !== "LINK") return sig(el);
    return "link|" + el.getAttribute("rel") + "|" + (el.getAttribute("href") || "").replace(/[?&]__glimpse=\d+/, "") + "|" + el.getAttribute("media");
  }
  const headOf = (doc) => [...doc.head.children].filter((el) => el.tagName !== "SCRIPT" && !internal(el));
  function syncHead(prev, next, count) {
    const was = headOf(prev).map(headKey);
    const now = headOf(next);
    const pairs = lineUp(was, now.map(headKey));
    const live = headOf(document);
    const claimed = new Set();
    const liveOf = was.map((k) => {
      const el = live.find((e) => !claimed.has(e) && headKey(e) === k);
      if (el) claimed.add(el);
      return el;
    });
    const kept = new Map(pairs.map(([i, j]) => [j, i]));
    const keptWas = new Set(pairs.map(([i]) => i));
    was.forEach((_, i) => { if (!keptWas.has(i) && liveOf[i]) { liveOf[i].remove(); count.n++; } });
    let anchor = null;
    for (let j = now.length - 1; j >= 0; j--) {
      if (kept.has(j)) { anchor = liveOf[kept.get(j)] || anchor; continue; }
      const n = now[j].cloneNode(true);
      document.head.insertBefore(n, anchor && anchor.parentNode === document.head ? anchor : null);
      anchor = n;
      count.n++;
    }
  }

  // Attributes of <html> (lang, a theme class) that changed in the source.
  function syncRootAttributes(prev, next, count) {
    const a = prev.documentElement, b = next.documentElement, el = document.documentElement;
    for (const { name, value } of [...b.attributes]) if (a.getAttribute(name) !== value) { el.setAttribute(name, value); count.n++; }
    for (const { name } of [...a.attributes]) if (!b.hasAttribute(name)) { el.removeAttribute(name); count.n++; }
  }

  // The page's scripts as written: a new or changed one can only take effect by loading the page again.
  const scriptsOf = (doc) =>
    [...doc.querySelectorAll("script")].filter((s) => !internal(s))
      .map((s) => (s.getAttribute("type") || "") + "|" + (s.getAttribute("src") || "") + "|" + (s.hasAttribute("src") ? "" : s.textContent)).join("\n");

  // The page as last served: what the live page is compared against when the source changes.
  const parse = (html) => new DOMParser().parseFromString(html, "text/html");
  const load = () => fetch(location.href, { cache: "no-store" }).then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))));
  let served = null;
  load().then((t) => { served = parse(t); }, () => {});

  // Every stylesheet the page uses that is the file at path or @imports it: <link>s to re-fetch, <style>s to re-parse.
  function cssUsers(path) {
    const matches = (href) => {
      try {
        const p = decodeURIComponent(new URL(href, location.href).pathname);
        return p === "/" + path || p.endsWith("/" + path);
      } catch { return false; }
    };
    const users = new Set();
    const visit = (sheet, owner) => {
      let rules;
      try { rules = sheet.cssRules; } catch { return; } // another origin's stylesheet
      for (const r of rules) {
        if (!(r instanceof CSSImportRule) || !r.styleSheet) continue;
        if (r.styleSheet.href && matches(r.styleSheet.href)) users.add(owner);
        visit(r.styleSheet, owner);
      }
    };
    for (const sheet of document.styleSheets) {
      const owner = sheet.ownerNode;
      if (!owner || internal(owner)) continue;
      if (owner.tagName === "LINK" && sheet.href && matches(sheet.href)) users.add(owner);
      visit(sheet, owner);
    }
    // A link whose file didn't exist yet has no stylesheet: it counts too, so the new file shows up.
    for (const link of document.querySelectorAll('link[rel~="stylesheet"][href]')) if (matches(link.href)) users.add(link);
    return users;
  }

  // Swap a stylesheet without reloading. CSS the page doesn't use (another page's, a partial nobody imports) is ignored.
  function hotSwapCss(path) {
    for (const owner of cssUsers(path)) {
      if (owner.tagName === "LINK") {
        const url = new URL(owner.href);
        url.searchParams.set("__glimpse", Date.now());
        owner.href = url.toString();
      } else {
        owner.textContent = owner.textContent; // re-parses the <style>, which loads its @imports again
      }
    }
  }

  // Saves can come quickly: the morph of an older fetch that resolves late must not undo a newer one.
  let updates = 0;
  async function updateHtml() {
    const mine = ++updates;
    const doc = parse(await load());
    if (mine !== updates) return; // a newer update is on its way
    if (!served || scriptsOf(served) !== scriptsOf(doc)) return location.reload();
    const changed = new Set();
    const count = { n: 0 };
    // The editor takes the human's unsent edits off the page around the morph (it pairs
    // elements by position) and puts them back after. Both events are synchronous.
    dispatchEvent(new Event("glimpse:before-morph"));
    try {
      syncRootAttributes(served, doc, count);
      syncHead(served, doc, count);
      morph(document.body, doc.body, changed);
    } finally {
      served = doc;
      dispatchEvent(new Event("glimpse:after-morph"));
    }
    for (const el of changed) flash(el);
    parent.postMessage({ glimpse: "morphed", count: changed.size + count.n }, "*");
  }

  function connect() {
    const ws = new WebSocket(proto + "//" + location.host + "/__glimpse/ws?role=preview");
    ws.onmessage = async (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type !== "file-changed") return;
      if (msg.path.endsWith(".css")) return hotSwapCss(msg.path);
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
