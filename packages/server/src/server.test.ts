import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { WebSocket } from "ws";
import type { ChangeList } from "@glimpse/core";
import { findRunningServer, startServer, type GlimpseServer } from "./index.js";

let dir: string;
let srv: GlimpseServer;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "glimpse-"));
  await writeFile(join(dir, "index.html"), "<!doctype html><html><body><button>Hi</button></body></html>");
  await writeFile(join(dir, "style.css"), "button{color:red}");
  srv = await startServer({ dir, port: 0 });
});

afterEach(async () => {
  await srv.close();
  await rm(dir, { recursive: true, force: true });
});

describe("server", () => {
  it("detects a plain HTML project", () => {
    expect(srv.project).toMatchObject({ target: "html", entry: "index.html" });
  });

  it("serves the preview with the live client injected", async () => {
    const html = await (await fetch(`${srv.url}/preview/`)).text();
    expect(html).toContain('<button data-glimpse-src="index.html:1:28">Hi</button>');
    expect(html).toContain('<script data-glimpse-internal src="/__glimpse/client.js"></script></body>');
    const css = await fetch(`${srv.url}/preview/style.css`);
    expect(css.headers.get("content-type")).toContain("text/css");
  });

  it("refuses to serve files outside the project", async () => {
    const res = await fetch(`${srv.url}/preview/..%2f..%2fetc%2fpasswd`);
    expect([403, 404]).toContain(res.status);
  });

  it("pushes file changes over the websocket (live mode)", async () => {
    const ws = new WebSocket(`${srv.url.replace("http", "ws")}/__glimpse/ws`);
    const changed = new Promise<{ path: string }>((ok) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.type === "file-changed") ok(msg);
      });
    });
    await new Promise((ok) => ws.once("open", ok));
    await writeFile(join(dir, "style.css"), "button{color:blue}");
    expect((await changed).path).toBe("style.css");
    ws.close();
  }, 10_000);

  it("sends a previewed page's live client only file changes", async () => {
    const ws = new WebSocket(`${srv.url.replace("http", "ws")}/__glimpse/ws?role=preview`);
    const types: string[] = [];
    const changed = new Promise<void>((ok) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw));
        types.push(msg.type);
        if (msg.type === "file-changed") ok();
      });
    });
    await new Promise((ok) => ws.once("open", ok));
    await fetch(`${srv.url}/api/status`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "working" }) });
    await writeFile(join(dir, "style.css"), "button{color:blue}");
    await changed;
    expect(types).toEqual(["file-changed"]);
    ws.close();
  }, 10_000);

  it("hands the change list to a waiting agent", async () => {
    const waiting = fetch(`${srv.url}/api/handoff/next?after=0&timeout=5`).then((r) => r.json());
    const changeList: ChangeList = {
      version: 1,
      target: "html",
      createdAt: new Date().toISOString(),
      changes: [{ op: "setText", node: "n1", from: "Hi", to: "Hello", label: 'button "Hi"' }],
    };
    const post = await fetch(`${srv.url}/api/handoff`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "ai", changeList }),
    });
    expect(await post.json()).toEqual({ seq: 1, delivered: true });
    const result = (await waiting) as { status: string; handoff: { prompt: string } };
    expect(result.status).toBe("ready");
    expect(result.handoff.prompt).toContain('Change the text of button "Hi" from "Hi" to "Hello".');
  });

  it("queues a home-screen request until an agent asks for it, and delivers it once", async () => {
    const post = await fetch(`${srv.url}/api/request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "a website with 5 buttons and a moving donut" }),
    });
    expect(await post.json()).toEqual({ seq: 1, delivered: false });
    const first = (await (await fetch(`${srv.url}/api/handoff/next?timeout=1`)).json()) as {
      status: string;
      handoff: { kind: string; prompt: string };
    };
    expect(first.status).toBe("ready");
    expect(first.handoff.kind).toBe("request");
    expect(first.handoff.prompt).toContain("a website with 5 buttons and a moving donut");
    expect(first.handoff.prompt).toContain("web page (HTML/CSS/JS)");
    const again = (await (await fetch(`${srv.url}/api/handoff/next?timeout=1`)).json()) as { status: string };
    expect(again.status).toBe("editing");
    const list = (await (await fetch(`${srv.url}/api/handoffs`)).json()) as { handoffs: { title: string; delivered: boolean }[] };
    expect(list.handoffs[0]).toMatchObject({ title: "a website with 5 buttons and a moving donut", delivered: true });
  });

  it("keeps handoff history across restarts without replaying it", async () => {
    await fetch(`${srv.url}/api/request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "old request" }),
    });
    await srv.close();
    srv = await startServer({ dir, port: 0 });
    const list = (await (await fetch(`${srv.url}/api/handoffs`)).json()) as { handoffs: unknown[] };
    expect(list.handoffs).toHaveLength(1);
    expect(await srv.nextHandoff(undefined, 50)).toBeNull();
  });

  it("writes edits into the source with a backup (Edit source)", async () => {
    const changeList: ChangeList = {
      version: 1,
      target: "html",
      createdAt: new Date().toISOString(),
      changes: [
        { op: "setText", node: "n1", src: "index.html:1:28", from: "Hi", to: "Hello" },
        { op: "move", node: "n1", src: "index.html:1:28", from: { x: 0, y: 0 }, to: { x: 40, y: 0 } },
      ],
    };
    const post = (path: string) =>
      fetch(`${srv.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ changeList }) }).then(
        (r) => r.json() as Promise<{ files: unknown[]; needsAi: { op: string }[]; backup?: string }>,
      );
    const preview = await post("/api/patch/preview");
    expect(preview.files).toEqual([{ file: "index.html", diff: expect.stringContaining("+<!doctype html><html><body><button>Hello</button>") }]);
    expect(preview.needsAi.map((c) => c.op)).toEqual(["move"]);
    expect(await readFile(join(dir, "index.html"), "utf8")).toContain("<button>Hi</button>");

    const applied = await post("/api/patch/apply");
    expect(await readFile(join(dir, "index.html"), "utf8")).toContain("<button>Hello</button>");
    expect(await readFile(join(dir, applied.backup!, "index.html"), "utf8")).toContain("<button>Hi</button>");
    // Recorded in history, but an agent isn't woken for it.
    const list = (await (await fetch(`${srv.url}/api/handoffs`)).json()) as { handoffs: { kind: string }[] };
    expect(list.handoffs[0]!.kind).toBe("source");
    expect(await srv.nextHandoff(undefined, 50)).toBeNull();
  });

  it("never hands a request to an agent wait that was cancelled", async () => {
    const send = (text: string) =>
      fetch(`${srv.url}/api/request`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
    // In process: the abort stops the wait, and what the human sends next stays queued.
    const ac = new AbortController();
    const waiting = srv.nextHandoff(undefined, 10_000, ac.signal);
    ac.abort();
    expect(await waiting).toBeNull();
    await send("first");
    // Over HTTP: the agent hangs up mid-wait.
    const hangUp = new AbortController();
    const polling = fetch(`${srv.url}/api/handoff/next?after=1&timeout=10`, { signal: hangUp.signal }).catch(() => null);
    await new Promise((r) => setTimeout(r, 100));
    hangUp.abort();
    await polling;
    await new Promise((r) => setTimeout(r, 100));
    await send("second");
    expect((await srv.nextHandoff(undefined, 1000))?.request?.text).toBe("first");
    expect((await srv.nextHandoff(undefined, 1000))?.request?.text).toBe("second");
  });

  it("puts a handoff the agent never received back in the queue", async () => {
    await fetch(`${srv.url}/api/request`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "five buttons" }) });
    const h = await srv.nextHandoff(undefined, 1000);
    expect(h?.seq).toBe(1);
    expect(await srv.nextHandoff(undefined, 10)).toBeNull();
    // e.g. the MCP tool call it was returned to had been cancelled
    const res = await fetch(`${srv.url}/api/handoffs/1/requeue`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(200);
    const list = (await (await fetch(`${srv.url}/api/handoffs`)).json()) as { handoffs: { delivered: boolean }[] };
    expect(list.handoffs[0]!.delivered).toBe(false);
    expect((await srv.nextHandoff(undefined, 1000))?.seq).toBe(1);
    // Nothing else to requeue: unknown handoffs, and ones never handed out.
    expect(srv.requeueHandoff(7)).toBe(false);
    // A waiting agent gets a requeued handoff right away.
    const waiting = srv.nextHandoff(undefined, 5000);
    expect(srv.requeueHandoff(1)).toBe(true);
    expect((await waiting)?.seq).toBe(1);
  });

  it("keeps latest.json on the newest handoff when an older one is delivered", async () => {
    for (const text of ["older", "newer"]) {
      await fetch(`${srv.url}/api/request`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
    }
    expect((await srv.nextHandoff(undefined, 1000))?.request?.text).toBe("older");
    await new Promise((r) => setTimeout(r, 100));
    const latest = JSON.parse(await readFile(join(dir, ".glimpse", "latest.json"), "utf8")) as { seq: number; delivered: boolean };
    expect(latest.seq).toBe(2);
    const first = JSON.parse(await readFile(join(dir, ".glimpse", "handoffs", "1.json"), "utf8")) as { delivered: boolean };
    expect(first.delivered).toBe(true);
  });

  it("closes promptly while an agent is long-polling", async () => {
    const polling = fetch(`${srv.url}/api/handoff/next?timeout=60`).then((r) => r.json());
    const inProcess = srv.nextHandoff(undefined, 60_000);
    await new Promise((r) => setTimeout(r, 100));
    const t0 = Date.now();
    await srv.close();
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(await polling).toEqual({ status: "editing" });
    expect(await inProcess).toBeNull();
    srv = await startServer({ dir, port: 0 });
  });

  it("only reports a running Glimpse for the folder it serves", async () => {
    const other = await mkdtemp(join(tmpdir(), "glimpse-other-"));
    try {
      await mkdir(join(other, ".glimpse"), { recursive: true });
      // A crashed Glimpse for `other` left this behind, and this project's Glimpse took its port since.
      await writeFile(join(other, ".glimpse", "server.json"), JSON.stringify({ url: srv.url, pid: 1, token: "stale" }));
      expect(await findRunningServer(other)).toBeNull();
      await mkdir(join(dir, ".glimpse"), { recursive: true });
      await writeFile(join(dir, ".glimpse", "server.json"), JSON.stringify({ url: srv.url, pid: 1, token: srv.token }));
      expect(await findRunningServer(dir)).toEqual({ url: srv.url, pid: 1, token: srv.token });
      expect(await findRunningServer(join(dir, "nope"))).toBeNull();
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it("reports 'editing' when nothing was sent before the timeout", async () => {
    expect(await srv.nextHandoff(0, 50)).toBeNull();
  });

  it("starts nothing when the port is taken, so the retry on another port is the only Glimpse", async () => {
    const other = await mkdtemp(join(tmpdir(), "glimpse-busy-"));
    try {
      await expect(startServer({ dir: other, port: srv.port })).rejects.toMatchObject({ code: "EADDRINUSE" });
      // No initial snapshot, so no history (or watcher) was left running for that project.
      expect(existsSync(join(other, ".glimpse", "history"))).toBe(false);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it("refuses cross-site requests and foreign hosts", async () => {
    // Raw requests, so the headers are exactly what a browser would send.
    const raw = (method: string, path: string, headers: Record<string, string>, body?: string) =>
      new Promise<number>((ok, fail) => {
        const req = httpRequest(`${srv.url}${path}`, { method, headers }, (res) => {
          res.resume();
          ok(res.statusCode ?? 0);
        });
        req.on("error", fail);
        req.end(body);
      });
    const json = { "content-type": "application/json" };
    // A page on another site posting to Glimpse (fetch with mode "no-cors", or a form).
    expect(await raw("POST", "/api/history/s1/restore", { ...json, origin: "https://evil.example" }, "{}")).toBe(403);
    expect(await raw("POST", "/api/request", { "content-type": "text/plain", "sec-fetch-site": "cross-site" }, '{"text":"rm -rf"}')).toBe(403);
    expect(await raw("POST", "/api/request", { "content-type": "text/plain" }, '{"text":"rm -rf"}')).toBe(415);
    // DNS rebinding: the attacker's name, pointed at 127.0.0.1.
    expect(await raw("GET", "/api/history", { host: `evil.example:${srv.port}` })).toBe(403);
    expect(await raw("GET", "/preview/", { host: `evil.example:${srv.port}` })).toBe(403);
    // The editor itself, and local tools.
    expect(await raw("GET", "/api/history", { "sec-fetch-site": "same-origin", "x-glimpse-session": srv.session })).toBe(200);
    expect(await raw("POST", "/api/status", { ...json, origin: srv.url, "sec-fetch-site": "same-origin", "x-glimpse-session": srv.session }, '{"message":"hi"}')).toBe(200);
    expect(await raw("GET", "/api/session", { host: `localhost:${srv.port}` })).toBe(200);
    expect((await fetch(`${srv.url}/api/session`)).status).toBe(200);

    const opened = (origin?: string) =>
      new Promise<boolean>((ok) => {
        const ws = new WebSocket(`${srv.url.replace("http", "ws")}/__glimpse/ws?session=${srv.session}`, origin ? { origin } : {});
        ws.once("open", () => (ws.close(), ok(true)));
        ws.once("error", () => ok(false));
      });
    expect(await opened("https://evil.example")).toBe(false);
    expect(await opened(srv.url)).toBe(true);
  });

  it("serves a placeholder page, not JSON, for a version without the page", async () => {
    const empty = await mkdtemp(join(tmpdir(), "glimpse-empty-"));
    const other = await startServer({ dir: empty, port: 0 });
    try {
      await writeFile(join(empty, "index.html"), "<p>built</p>");
      const res = await fetch(`${other.url}/snapshot/s1/`);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(await res.text()).toContain("This version has no <code");
      expect((await fetch(`${other.url}/snapshot/s1/missing.css`)).headers.get("content-type")).toContain("json");
    } finally {
      await other.close();
      await rm(empty, { recursive: true, force: true });
    }
  });

  it("records an AI round as soon as the agent waits again", async () => {
    const ws = new WebSocket(`${srv.url.replace("http", "ws")}/__glimpse/ws`);
    const seen = (type: string) => new Promise<void>((ok) => ws.on("message", (raw) => JSON.parse(String(raw)).type === type && ok()));
    await new Promise((ok) => ws.once("open", ok));
    const changed = seen("file-changed");
    const recorded = seen("snapshot");
    await writeFile(join(dir, "style.css"), "button{color:blue}");
    await changed;
    const t0 = Date.now();
    // Inside the quiet period: waiting ends the round, so it's recorded right away.
    expect(await srv.nextHandoff(undefined, 10)).toBeNull();
    await recorded;
    expect(Date.now() - t0).toBeLessThan(1500);
    ws.close();
    const { snapshots } = (await (await fetch(`${srv.url}/api/history`)).json()) as { snapshots: { kind: string; label: string }[] };
    expect(snapshots.map((x) => [x.kind, x.label])).toEqual([
      ["initial", "Opened in Glimpse"],
      ["ai", "AI edited style.css"],
    ]);
  });
});

describe("robustness", () => {
  const postJson = (path: string, body: unknown) =>
    fetch(`${srv.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const request = (text: string) => postJson("/api/request", { text }).then((r) => r.json() as Promise<{ seq: number }>);

  it("closes promptly while an agent is long-polling", async () => {
    const waiting = fetch(`${srv.url}/api/handoff/next?timeout=600`).then((r) => r.json());
    await expect.poll(async () => ((await (await fetch(`${srv.url}/api/session`)).json()) as { agentWaiting: boolean }).agentWaiting).toBe(true);
    const t0 = Date.now();
    await srv.close();
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(await waiting).toEqual({ status: "editing" });
    srv = await startServer({ dir, port: 0 }); // for afterEach
  });

  it("keeps latest.json on the newest handoff when an older one is delivered", async () => {
    await request("first");
    await request("second");
    expect((await srv.nextHandoff(undefined, 100))?.seq).toBe(1);
    await srv.close(); // waits for the writes
    const latest = JSON.parse(await readFile(join(dir, ".glimpse", "latest.json"), "utf8")) as { seq: number };
    expect(latest.seq).toBe(2);
    srv = await startServer({ dir, port: 0 });
  });

  it("never reuses the number of an unreadable handoff", async () => {
    await request("one");
    await srv.close();
    await writeFile(join(dir, ".glimpse", "handoffs", "2.json"), "{ not json");
    srv = await startServer({ dir, port: 0 });
    expect((await request("three")).seq).toBe(3);
    expect(await readFile(join(dir, ".glimpse", "handoffs", "2.json"), "utf8")).toBe("{ not json");
  });

  it("validates request targets and long-poll parameters", async () => {
    expect((await postJson("/api/request", { text: "x", target: "flash" })).status).toBe(400);
    expect((await postJson("/api/request", { text: "x", target: "react" })).status).toBe(200);
    expect((await fetch(`${srv.url}/api/handoff/next?timeout=abc`)).status).toBe(400);
    expect((await fetch(`${srv.url}/api/handoff/next?timeout=1&after=x`)).status).toBe(400);
  });

  it("refuses to write edits the human didn't review (the file changed after the preview)", async () => {
    const changeList: ChangeList = {
      version: 1,
      target: "html",
      createdAt: new Date().toISOString(),
      changes: [{ op: "setText", node: "n1", src: "index.html:1:28", from: "Hi", to: "Hello" }],
    };
    const preview = (await (await postJson("/api/patch/preview", { changeList })).json()) as { planId: string };
    expect(preview.planId).toMatch(/^[\w-]{20,}$/);
    // The agent saves the page in between: the same location is now another element.
    const edited = "<!doctype html><html><body><a>Hi</a><button>Hi</button></body></html>";
    await writeFile(join(dir, "index.html"), edited);
    const res = await postJson("/api/patch/apply", { changeList, planId: preview.planId });
    expect(res.status).toBe(409);
    expect(await readFile(join(dir, "index.html"), "utf8")).toBe(edited);
    // Previewed again, it applies.
    const again = (await (await postJson("/api/patch/preview", { changeList })).json()) as { planId: string };
    expect((await postJson("/api/patch/apply", { changeList, planId: again.planId })).status).toBe(200);
  });

  it("serves a legacy-encoded page decoded, and leaves its source to the AI", async () => {
    const page = '<!doctype html><html><head><meta charset="windows-1252"></head><body><p>Caf\xe9</p></body></html>';
    await writeFile(join(dir, "index.html"), Buffer.from(page, "latin1"));
    const res = await fetch(`${srv.url}/preview/`);
    expect(res.headers.get("content-type")).toContain("utf-8");
    expect(await res.text()).toContain("Café</p>");
    const changeList: ChangeList = {
      version: 1,
      target: "html",
      createdAt: new Date().toISOString(),
      changes: [{ op: "setText", node: "n1", src: `index.html:1:${page.indexOf("<p>") + 1}`, from: "Café", to: "Bar" }],
    };
    const plan = (await (await postJson("/api/patch/preview", { changeList })).json()) as { files: unknown[]; needsAi: unknown[] };
    expect(plan.files).toEqual([]);
    expect(plan.needsAi).toHaveLength(1);
  });
});
