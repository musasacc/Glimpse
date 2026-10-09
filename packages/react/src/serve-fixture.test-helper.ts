import { cp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createReactPreview, type ReactPreview } from "./dev-server.js";

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(here, "..", "fixtures");

export interface ServedFixture {
  dir: string;
  url: string;
  port: number;
  server: Server;
  preview: ReactPreview;
  /** Upgrades the server saw, and what Glimpse's handler did with them. */
  upgrades: { url: string; protocol: string; vite: boolean }[];
  close(): Promise<void>;
}

/**
 * Copy a fixture into fixtures/.tmp (inside the package, so react, vite and
 * @vitejs/plugin-react resolve from its node_modules) and serve it the way the
 * Glimpse server will: one http server, the preview on /preview/, and an
 * upgrade handler that destroys every socket except /__glimpse/ws and Vite's.
 */
export async function serveFixture(name: string, opts: { viteConfig?: string; viaLink?: boolean } = {}): Promise<ServedFixture> {
  const copy = join(FIXTURES, ".tmp", `${name}-${process.pid}-${Date.now().toString(36)}`);
  await mkdir(dirname(copy), { recursive: true });
  await cp(join(FIXTURES, name), copy, { recursive: true, filter: (src) => !/[\\/]node_modules([\\/]|$)/.test(src) });
  if (opts.viteConfig !== undefined) await writeFile(join(copy, "vite.config.ts"), opts.viteConfig);
  // Opened through a symlink (a junction on Windows, which needs no privileges), as /tmp is on macOS.
  const dir = opts.viaLink ? `${copy}-link` : copy;
  if (opts.viaLink) await symlink(copy, dir, "junction");

  let preview: ReactPreview | undefined;
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (preview && (path === "/preview" || path.startsWith("/preview/"))) return preview.handle(req, res);
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not the preview");
  });
  const upgrades: ServedFixture["upgrades"] = [];
  server.on("upgrade", (req: IncomingMessage, socket) => {
    const vite = !!preview?.isViteUpgrade(req);
    upgrades.push({ url: req.url ?? "", protocol: String(req.headers["sec-websocket-protocol"] ?? ""), vite });
    if (vite) return; // Vite's own upgrade listener answers it
    if (new URL(req.url ?? "/", "http://localhost").pathname !== "/__glimpse/ws") socket.destroy();
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as { port: number }).port;
  preview = await createReactPreview({ dir, httpServer: server });

  return {
    dir,
    url: `http://127.0.0.1:${port}`,
    port,
    server,
    preview,
    upgrades,
    async close() {
      await preview!.close();
      server.closeAllConnections();
      await new Promise<void>((ok) => server.close(() => ok()));
      if (opts.viaLink) await rm(dir, { force: true });
      await rm(copy, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}
