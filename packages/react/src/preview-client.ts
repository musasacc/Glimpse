/** URL of the client module the Vite plugin adds to the preview's index.html (before the base is applied). */
export const PREVIEW_CLIENT_ID = "/@glimpse/preview-client";

/**
 * Runs inside the React preview (served by Vite, so `import.meta.hot` works).
 * It tells the Glimpse editor, which lives in the parent window, when the page
 * is ready to read and when Vite's HMR changes it:
 *
 *   window.__glimpsePreview = { engine: "vite", ready, updating }
 *   "glimpse:ready"          (event on the preview's window) the first render has settled (after "load")
 *   "glimpse:before-update"  (event) Vite is about to apply an HMR update. Dispatched
 *                            synchronously before the update runs, so a same-origin
 *                            listener can put the DOM back the way React left it first
 *   "glimpse:after-update"   (event) the update was applied and the DOM has settled
 *   postMessage { glimpse: "ready", engine: "vite" }       to the parent, after "glimpse:ready"
 *   postMessage { glimpse: "morphed", engine: "vite" }     to the parent, after "glimpse:after-update"
 *                            (the same message the HTML live client sends after a morph)
 *   postMessage { glimpse: "error", engine: "vite", message, blank }   the app threw (blank: nothing is left
 *                            on the page, as after a render error, which makes React unmount the whole root)
 *
 * Vite's error overlay gets `data-glimpse-internal` so the editor skips it.
 */
export const PREVIEW_CLIENT = String.raw`const w = window;
if (!w.__glimpsePreview) {
  const state = (w.__glimpsePreview = { engine: "vite", version: 1, ready: false, updating: false });
  const emit = (name) => w.dispatchEvent(new CustomEvent(name));
  const post = (msg) => {
    msg.engine = "vite";
    try { w.parent.postMessage(msg, "*"); } catch {}
  };

  // Resolves once the DOM has not changed for quiet ms (React commits a beat after a module runs), or after max ms.
  const settled = (quiet, max) => new Promise((resolve) => {
    let timer;
    const done = () => { obs.disconnect(); clearTimeout(timer); clearTimeout(cap); resolve(); };
    const obs = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(done, quiet); });
    obs.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    timer = setTimeout(done, quiet);
    const cap = setTimeout(done, max);
  });

  // An error thrown while rendering unmounts the app and leaves an empty page with no hint (Vite's overlay is only
  // for compile errors): tell the editor. The error itself stays in the preview's console.
  const crashed = (err) => setTimeout(() => {
    const message = String((err && err.message) || err || "Unknown error");
    const blank = !!document.body && !document.body.innerText.trim() && !document.body.querySelector("img, svg, canvas, video, input, button");
    post({ glimpse: "error", message, blank });
  }, 50);
  w.addEventListener("error", (e) => crashed(e.error || e.message));
  w.addEventListener("unhandledrejection", (e) => crashed(e.reason));

  const start = () => {
    new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) {
        if (n.nodeName === "VITE-ERROR-OVERLAY") n.setAttribute("data-glimpse-internal", "");
      }
    }).observe(document.body, { childList: true });
    // The app's entry module runs after this one, once all its imports have loaded (on a cold Vite that takes
    // longer than the quiet period), and before "load": start waiting for its first render from there.
    const settle = () => settled(80, 3000).then(() => {
      state.ready = true;
      emit("glimpse:ready");
      post({ glimpse: "ready" });
    });
    if (document.readyState === "complete") settle();
    else w.addEventListener("load", settle, { once: true });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();

  const hot = import.meta.hot;
  if (hot) {
    let seq = 0;
    hot.on("vite:beforeUpdate", () => {
      if (state.updating) return;
      state.updating = true;
      emit("glimpse:before-update");
    });
    hot.on("vite:afterUpdate", () => {
      const mine = ++seq;
      settled(80, 1500).then(() => {
        if (mine !== seq) return; // a newer update is still settling
        state.updating = false;
        emit("glimpse:after-update");
        post({ glimpse: "morphed" });
      });
    });
  }
}
`;
