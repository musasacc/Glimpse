/**
 * The editor's session with its Glimpse server. The previewed page runs at the same origin as the editor, so the
 * server asks browser requests to its API (and the editor's websocket) for a per-session secret it puts into the
 * editor's own page only: requests the previewed page makes itself don't have it.
 *
 * The secret is read once, while this module loads (before any preview frame exists), and the tag that carried it
 * is removed; `fetch` and `WebSocket` are captured at the same moment, so a page that later replaces them on the
 * editor's window doesn't see the secret go by. This raises the bar; it isn't a sandbox (a project page can still
 * script the editor's window), so open projects you trust.
 */

const HEADER = "x-glimpse-session";

const hasWindow = typeof window !== "undefined" && typeof document !== "undefined";
const nativeFetch: typeof fetch | undefined = hasWindow ? window.fetch.bind(window) : typeof fetch === "function" ? fetch : undefined;
const NativeWebSocket: typeof WebSocket | undefined = hasWindow ? window.WebSocket : undefined;

let session: string | null = hasWindow ? readMeta() : null;
let loading: Promise<string | null> | null = null;

function readMeta(): string | null {
  const meta = document.querySelector('meta[name="glimpse-session"]');
  const value = meta?.getAttribute("content") || null;
  meta?.remove();
  return value;
}

/** The secret; the editor's dev server (Vite) serves a page without it, so it is asked for once there. */
function ensureSession(): Promise<string | null> {
  if (session || !nativeFetch) return Promise.resolve(session);
  loading ??= nativeFetch("/__glimpse/session", { headers: { accept: "application/json" } })
    .then(async (res) => {
      if (!res.ok) return null;
      const body = (await res.json()) as { session?: unknown };
      session = typeof body.session === "string" ? body.session : null;
      return session;
    })
    .catch(() => null)
    .finally(() => {
      loading = null;
    });
  return loading;
}

/** `fetch` for Glimpse's API: with the session header. Headers must be a plain object. */
export async function apiFetch(input: string, init: RequestInit & { headers?: Record<string, string> } = {}): Promise<Response> {
  if (!nativeFetch) throw new Error("fetch isn't available");
  const s = await ensureSession();
  return nativeFetch(input, { ...init, headers: { ...init.headers, ...(s && { [HEADER]: s }) } });
}

/** The editor's websocket to Glimpse, with the session in its URL (browsers can't set headers on websockets). */
export async function openLiveSocket(url: string): Promise<WebSocket> {
  const s = await ensureSession();
  const Ws = NativeWebSocket ?? WebSocket;
  return new Ws(s ? `${url}${url.includes("?") ? "&" : "?"}session=${encodeURIComponent(s)}` : url);
}
