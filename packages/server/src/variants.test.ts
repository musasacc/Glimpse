import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { startServer, type GlimpseServer, type PublicSnapshot, type VariantJob } from "./index.js";

let dir: string;
let srv: GlimpseServer;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "glimpse-variants-"));
  await writeFile(join(dir, "index.html"), "<!doctype html><html><body><button>Hi</button></body></html>");
  await writeFile(join(dir, "style.css"), "button{color:red}");
  srv = await startServer({ dir, port: 0 });
});

afterEach(async () => {
  await srv.close();
  await rm(dir, { recursive: true, force: true });
});

type Msg = { type: string; [k: string]: unknown };

const get = async <T>(path: string) => (await fetch(`${srv.url}${path}`)).json() as Promise<T>;
const post = (path: string, body: unknown = {}) =>
  fetch(`${srv.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

async function listen() {
  const ws = new WebSocket(`${srv.url.replace("http", "ws")}/__glimpse/ws`);
  const messages: Msg[] = [];
  const pending = new Set<() => void>();
  ws.on("message", (raw) => {
    messages.push(JSON.parse(String(raw)) as Msg);
    for (const check of pending) check();
  });
  await new Promise((ok) => ws.once("open", ok));
  return {
    messages,
    waitFor<T = Msg>(pred: (m: Msg) => boolean, timeoutMs = 6000): Promise<T> {
      return new Promise((ok, fail) => {
        const timer = setTimeout(() => fail(new Error("timed out waiting for a websocket message")), timeoutMs);
        const check = () => {
          const hit = messages.find(pred);
          if (!hit) return;
          clearTimeout(timer);
          pending.delete(check);
          ok(hit as T);
        };
        pending.add(check);
        check();
      });
    },
    close: () => ws.close(),
  };
}

async function createJob(count = 3): Promise<VariantJob> {
  const res = await post("/api/variants", { src: "index.html:1:28", label: 'button "Hi"', count, hint: "rounder, friendlier" });
  return ((await res.json()) as { job: VariantJob }).job;
}

/** Write a file as the agent would: into .glimpse/variants/<id>/<k>/<path>. */
async function writeVariant(id: string, k: number, path: string, content: string): Promise<void> {
  const file = join(dir, ".glimpse", "variants", id, String(k), ...path.split("/"));
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, content);
}

describe("variants", () => {
  it("creates a job and hands it to the agent as a variants handoff", async () => {
    const live = await listen();
    const job = await createJob();
    expect(job).toMatchObject({ id: "v1", src: "index.html:1:28", label: 'button "Hi"', count: 3, hint: "rounder, friendlier", ready: [], seq: 1 });
    await live.waitFor((m) => m.type === "variants");
    expect(await get("/api/variants")).toEqual({ jobs: [job] });

    const h = await srv.nextHandoff(undefined, 1000);
    expect(h).toMatchObject({ kind: "variants", variants: { id: "v1", count: 3, label: 'button "Hi"' } });
    expect(h!.prompt).toContain('Create 3 different design variants of button "Hi" at index.html:1:28.');
    expect(h!.prompt).toContain("Hint from the human: rounder, friendlier");
    expect(h!.prompt).toContain(".glimpse/variants/v1/<k>/");
    expect(h!.prompt).toContain(".glimpse/variants/v1/2/index.html");
    expect(h!.prompt).toContain("Never modify the real project files.");
    const list = await get<{ handoffs: { kind: string; title: string }[] }>("/api/handoffs");
    expect(list.handoffs[0]).toMatchObject({ kind: "variants", title: '3 variants of button "Hi"' });

    expect((await post("/api/variants", { label: "x", count: 5 })).status).toBe(400);
    expect((await post("/api/variants", { count: 2 })).status).toBe(400);
    live.close();
  });

  it("tracks ready variants and serves them overlaid on the project", async () => {
    const job = await createJob();
    const live = await listen();
    await writeVariant(job.id, 2, "style.css", "button{color:green}");
    const ready = await live.waitFor<{ job: VariantJob }>((m) => m.type === "variants" && (m.job as VariantJob).ready.length > 0);
    expect(ready.job.ready).toEqual([2]);
    await live.waitFor((m) => m.type === "variant-updated" && m.id === "v1" && m.k === 2 && m.path === "style.css");

    // The variant's own file wins; everything else comes from the project.
    expect(await (await fetch(`${srv.url}/variant/v1/2/style.css`)).text()).toBe("button{color:green}");
    expect(await (await fetch(`${srv.url}/variant/v1/1/style.css`)).text()).toBe("button{color:red}");
    const page = await (await fetch(`${srv.url}/variant/v1/2/`)).text();
    expect(page).toContain('<button data-glimpse-src="index.html:1:28">Hi</button>');
    expect(page).toContain('<script data-glimpse-internal src="/__glimpse/client.js"></script>');

    await writeVariant(job.id, 2, "index.html", "<!doctype html><html><body>\n  <a class=pill>Hi</a></body></html>");
    await writeVariant(job.id, 3, "index.html", "<!doctype html><html><body><b>Hi</b></body></html>");
    await live.waitFor((m) => m.type === "variants" && (m.job as VariantJob).ready.length === 2);
    // Source locations point at the project-relative file the variant replaces.
    expect(await (await fetch(`${srv.url}/variant/v1/2/index.html`)).text()).toContain('<a data-glimpse-src="index.html:2:3" class=pill>Hi</a>');
    expect((await get<{ jobs: VariantJob[] }>("/api/variants")).jobs[0]!.ready).toEqual([2, 3]);
    const detail = await get<{ files: Record<string, string[]> }>("/api/variants/v1");
    expect(detail.files).toEqual({ 1: [], 2: ["index.html", "style.css"], 3: ["index.html"] });

    for (const bad of ["..%2f1%2fstyle.css", "..%2f..%2f..%2f..%2f..%2fetc%2fpasswd", "%2e%2e%2f%2e%2e%2f%2e%2e%2f%2e%2e%2fx"]) {
      expect([403, 404]).toContain((await fetch(`${srv.url}/variant/v1/2/${bad}`)).status);
    }
    expect((await fetch(`${srv.url}/variant/v1/4/`)).status).toBe(404);
    expect((await fetch(`${srv.url}/variant/v7/1/`)).status).toBe(404);

    // Variant files are neither project changes nor AI rounds.
    await sleep(2200);
    expect(live.messages.filter((m) => m.type === "file-changed")).toEqual([]);
    expect((await get<{ snapshots: PublicSnapshot[] }>("/api/history")).snapshots.map((s) => s.kind)).toEqual(["initial"]);
    live.close();
  }, 15_000);

  it("uses the chosen variant: copies its files over the project and keeps a backup", async () => {
    const job = await createJob(2);
    const live = await listen();
    await writeVariant(job.id, 1, "index.html", "<!doctype html><html><body><button class=big>Hi</button></body></html>");
    await writeVariant(job.id, 1, "css/extra.css", ".big{font-size:2em}");
    await live.waitFor((m) => m.type === "variants" && (m.job as VariantJob).ready.length === 1);
    await writeFile(join(dir, "style.css"), "button{color:purple}");

    expect((await post(`/api/variants/v1/choose`, { k: 3 })).status).toBe(400);
    expect((await post(`/api/variants/v1/choose`, { k: 2 })).status).toBe(409);
    const res = await post(`/api/variants/v1/choose`, { k: 1 });
    const body = (await res.json()) as { files: string[]; backup: PublicSnapshot };
    expect(body.files).toEqual(["css/extra.css", "index.html"]);
    expect(body.backup).toMatchObject({ kind: "variant", label: 'Before using variant 1 of button "Hi"' });

    expect(await readFile(join(dir, "index.html"), "utf8")).toContain("<button class=big>Hi</button>");
    expect(await readFile(join(dir, "css", "extra.css"), "utf8")).toBe(".big{font-size:2em}");
    expect(await readFile(join(dir, "style.css"), "utf8")).toBe("button{color:purple}");
    expect(existsSync(join(dir, ".glimpse", "variants", "v1"))).toBe(false);
    expect(await get("/api/variants")).toEqual({ jobs: [] });
    await live.waitFor((m) => m.type === "variants-removed" && m.id === "v1");

    // The backup has the project as it was before.
    expect(await (await fetch(`${srv.url}/snapshot/${body.backup.id}/index.html`)).text()).toContain("<button>Hi</button>");
    expect((await post(`/api/variants/v1/choose`, { k: 1 })).status).toBe(404);
    live.close();
  });

  it("discards a job and never reuses its id", async () => {
    const job = await createJob(2);
    await writeVariant(job.id, 2, "index.html", "<p>nope</p>");
    const live = await listen();
    expect(await (await post("/api/variants/v1/discard")).json()).toEqual({ ok: true });
    await live.waitFor((m) => m.type === "variants-removed" && m.id === "v1");
    expect(existsSync(join(dir, ".glimpse", "variants", "v1"))).toBe(false);
    expect(await readFile(join(dir, "index.html"), "utf8")).toContain("<button>Hi</button>");
    expect((await post("/api/variants/v1/discard")).status).toBe(404);
    live.close();

    await srv.close();
    srv = await startServer({ dir, port: 0 });
    expect((await createJob(2)).id).toBe("v2");
  });
});
