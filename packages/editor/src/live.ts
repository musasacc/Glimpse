import { loop } from "./loop";
import { store, type ProjectInfo } from "./store";

/**
 * Live mode: listen to the Glimpse server. File saves (usually the AI editing
 * code) and agent status lines show up in the activity feed as they happen.
 * The preview page updates itself via the injected client; we only rebuild the
 * scene once it reports back.
 */
export function connectLive(): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const open = () => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}/__glimpse/ws`);
    ws.onopen = () => store.set({ connected: true });
    ws.onclose = () => {
      store.set({ connected: false });
      if (!closed) retry = setTimeout(open, 1000);
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      switch (msg.type) {
        case "hello": {
          const first = store.state.project === null;
          store.set({ project: msg.project, agentWaiting: !!msg.agentWaiting, entryExists: msg.entryExists !== false, previewError: msg.previewError ?? null });
          // Start on the editor when there is already a page to edit.
          if (first && msg.entryExists !== false) store.set({ view: "editor" });
          break;
        }
        case "agent":
          store.set({ agentWaiting: !!msg.waiting });
          break;
        case "project":
          applyProjectState(msg);
          break;
        case "reload":
          store.set({ reloadKey: store.state.reloadKey + 1 });
          break;
        case "handoff-delivered":
          void store.refreshHandoffs();
          break;
        case "file-changed": {
          store.activity("ai-file", `${msg.event === "unlink" ? "deleted" : msg.event === "add" ? "created" : "edited"} \`${msg.path}\``);
          const entry = store.state.project?.entry;
          if (entry && msg.path === entry) {
            if (msg.event === "add" && !store.state.entryExists) store.set({ entryExists: true, view: "editor", reloadKey: store.state.reloadKey + 1 });
            if (msg.event === "unlink") store.set({ entryExists: false });
          }
          break;
        }
        case "status":
          store.activity("ai-status", msg.message);
          break;
        case "handoff":
          if (msg.kind !== "request" && msg.kind !== "variants") store.activity("handoff", `Sent ${msg.count} change${msg.count === 1 ? "" : "s"} to the AI (#${msg.seq})`);
          void store.refreshHandoffs();
          break;
        // Version history and variants (see loop.ts).
        case "snapshot":
        case "snapshot-updated":
        case "variants":
        case "variant-updated":
        case "variants-removed":
          loop.onMessage(msg);
          break;
      }
    };
  };
  open();

  return () => {
    closed = true;
    clearTimeout(retry);
    ws?.close();
  };
}

/**
 * The server detected the project again ("project" message, or GET /api/session):
 * an empty folder became an app, its entry page appeared, or a React app's
 * dependencies got installed. Load the page afresh whenever there is a new one to show.
 */
export function applyProjectState(next: { project: ProjectInfo; entryExists?: boolean; previewError?: string | null }): void {
  const s = store.state;
  const entryExists = next.entryExists !== false;
  const previewError = next.previewError ?? null;
  const switched = !!s.project && (next.project.target !== s.project.target || next.project.entry !== s.project.entry);
  const appeared = entryExists && !s.entryExists;
  const fixed = !!s.previewError && !previewError;
  store.set({ project: next.project, entryExists, previewError });
  if (switched || appeared || fixed) store.set({ reloadKey: s.reloadKey + 1, ...(appeared && { view: "editor" as const }) });
}
