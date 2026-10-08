import { store } from "./store";

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
        case "hello":
          store.set({ project: msg.project });
          break;
        case "file-changed":
          store.activity("ai-file", `${msg.event === "unlink" ? "deleted" : msg.event === "add" ? "created" : "edited"} \`${msg.path}\``);
          break;
        case "status":
          store.activity("ai-status", msg.message);
          break;
        case "handoff":
          store.activity("handoff", `Sent ${msg.count} change${msg.count === 1 ? "" : "s"} to the AI (#${msg.seq})`);
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
