import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startServer } from "@glimpse/server";
import { createGlimpseMcp } from "./index.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "glimpse-mcp-"));
  await writeFile(join(dir, "index.html"), "<!doctype html><html><body><button>Hi</button></body></html>");
  const { mcp, close } = createGlimpseMcp({ browser: false, port: 0 });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([mcp.connect(a), client.connect(b)]);
  cleanups.push(async () => {
    await client.close();
    await close();
    await rm(dir, { recursive: true, force: true });
  });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[] };
    return res.content[0]!.text;
  };
  return { dir, client, call };
}

describe("glimpse MCP", () => {
  it("lists the Glimpse tools", async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "glimpse_close",
      "glimpse_get_changes",
      "glimpse_open",
      "glimpse_scene_schema",
      "glimpse_scene_validate",
      "glimpse_status",
      "glimpse_update",
      "glimpse_wait_for_done",
    ]);
  });

  it("reports its package version and how to work with scene files", async () => {
    const { client } = await setup();
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(client.getServerVersion()).toMatchObject({ name: "glimpse", version: pkg.version });
    expect(client.getInstructions()).toContain("glimpse.scene.json");
  });

  it("opens a terminal UI project, reports its scene problems and runs the app", async () => {
    const { dir, call } = await setup();
    await writeFile(
      join(dir, "glimpse.scene.json"),
      JSON.stringify({ target: "tui", root: { type: "root", layout: { x: 0, y: 0, w: 40, h: 10 }, children: [{ type: "button", props: { text: "OK" } }] } }),
    );
    const command = `${JSON.stringify(process.execPath)} -e "console.log('tui up')"`;
    const opened = await call("glimpse_open", { dir, command });
    expect(opened).toContain("tui, entry glimpse.scene.json");
    expect(opened).toMatch(/glimpse\.scene\.json has \d+ problems?; .*glimpse_scene_validate/);
    expect(opened).toContain("Running `");
    const url = /open at (\S+) /.exec(opened)![1]!;
    await expect.poll(async () => ((await (await fetch(`${url}/api/terminal`)).json()) as { command: string }).command).toBe(command);
  }, 30_000);

  it("asks a Glimpse started elsewhere to run the app, with the token from server.json", async () => {
    const { dir, call } = await setup();
    const srv = await startServer({ dir, port: 0 });
    try {
      await mkdir(join(dir, ".glimpse"), { recursive: true });
      await writeFile(join(dir, ".glimpse", "server.json"), JSON.stringify({ url: srv.url, pid: process.pid + 1, token: srv.token }));
      const command = `${JSON.stringify(process.execPath)} -e "console.log('elsewhere')"`;
      const opened = await call("glimpse_open", { dir, command });
      expect(opened).toContain(`open at ${srv.url} `);
      expect(opened).toContain("Running `");
      await expect.poll(() => srv.terminal.output, { timeout: 10_000 }).toContain("elsewhere");

      // A wrong token is refused, and says so.
      await writeFile(join(dir, ".glimpse", "server.json"), JSON.stringify({ url: srv.url, pid: process.pid + 1, token: "nope" }));
      expect(await call("glimpse_close", { dir })).toContain("Detached");
      expect(await call("glimpse_open", { dir, command })).toContain("Couldn't run");
    } finally {
      await call("glimpse_close", { dir });
      await srv.close();
    }
  }, 30_000);

  it("opens a project and hands the human's request to the agent", async () => {
    const { dir, call } = await setup();
    const opened = await call("glimpse_open", { dir });
    const url = /open at (\S+) /.exec(opened)![1]!;
    expect(opened).toContain("The human can now see and edit it.");

    expect(await call("glimpse_wait_for_done", { timeout_sec: 5 })).toContain("Still editing");

    const waiting = call("glimpse_wait_for_done", { timeout_sec: 30 });
    await fetch(`${url}/api/request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "five buttons and a moving donut" }),
    });
    const got = await waiting;
    expect(got).toContain("five buttons and a moving donut");
    expect(got).toContain('"request"');

    expect(await call("glimpse_get_changes")).toContain("five buttons and a moving donut");
    expect(await call("glimpse_status", { message: "Building…" })).toBe("Posted.");
    expect(await call("glimpse_close")).toBe("Closed.");
  }, 30_000);

  it("waits less than common client timeouts by default", async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    const wait = tools.find((t) => t.name === "glimpse_wait_for_done")!;
    expect(wait.description).toContain("default 45 s");
  });

  for (const where of ["in process", "on a Glimpse started elsewhere"] as const) {
    it(`never loses what the human sends while a cancelled wait is pending (${where})`, async () => {
      const { dir, client, call } = await setup();
      let url: string;
      if (where === "in process") {
        url = /open at (\S+) /.exec(await call("glimpse_open", { dir }))![1]!;
      } else {
        const srv = await startServer({ dir, port: 0 });
        cleanups.push(() => srv.close());
        await mkdir(join(dir, ".glimpse"), { recursive: true });
        await writeFile(join(dir, ".glimpse", "server.json"), JSON.stringify({ url: srv.url, pid: process.pid + 1, token: srv.token }));
        url = /open at (\S+) /.exec(await call("glimpse_open", { dir }))![1]!;
        expect(url).toBe(srv.url);
      }
      // The client gives up on the tool call (its timeout, or the user pressing Esc).
      const ac = new AbortController();
      const cancelled = client.callTool({ name: "glimpse_wait_for_done", arguments: { timeout_sec: 30 } }, undefined, { signal: ac.signal });
      await new Promise((r) => setTimeout(r, 200));
      ac.abort();
      await expect(cancelled).rejects.toThrow();
      await new Promise((r) => setTimeout(r, 200));
      await fetch(`${url}/api/request`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "a pricing table" }),
      });
      // The agent's next wait gets it.
      expect(await call("glimpse_wait_for_done", { timeout_sec: 5 })).toContain("a pricing table");
    }, 30_000);
  }

  it("applies a new entry to a Glimpse it started, and says when it can't", async () => {
    const { dir, call } = await setup();
    await writeFile(join(dir, "about.html"), "<!doctype html><html><body><p>About</p></body></html>");
    expect(await call("glimpse_open", { dir })).toContain("entry index.html");
    const reopened = await call("glimpse_open", { dir, entry: "about.html" });
    expect(reopened).toContain("entry about.html");
    expect(reopened).not.toContain("applied");
    await call("glimpse_close", { dir });

    const srv = await startServer({ dir, port: 0 });
    cleanups.push(() => srv.close());
    await writeFile(join(dir, ".glimpse", "server.json"), JSON.stringify({ url: srv.url, pid: process.pid + 1, token: srv.token }));
    const elsewhere = await call("glimpse_open", { dir, entry: "about.html" });
    expect(elsewhere).toContain("entry index.html");
    expect(elsewhere).toContain("the entry you passed wasn't applied");
  }, 30_000);

  it("doesn't attach to another project's Glimpse through a stale server.json", async () => {
    const { dir, call } = await setup();
    const otherDir = await mkdtemp(join(tmpdir(), "glimpse-mcp-other-"));
    const other = await startServer({ dir: otherDir, port: 0 });
    cleanups.push(async () => {
      await other.close();
      await rm(otherDir, { recursive: true, force: true });
    });
    await mkdir(join(dir, ".glimpse"), { recursive: true });
    await writeFile(join(dir, ".glimpse", "server.json"), JSON.stringify({ url: other.url, pid: process.pid + 1, token: other.token }));
    const opened = await call("glimpse_open", { dir });
    expect(opened).not.toContain(`open at ${other.url} `);
    expect(opened).toContain(`project ${dir},`);
  }, 30_000);

  it("returns the human's screenshot as an image next to the edits", async () => {
    const { dir, client, call } = await setup();
    const url = /open at (\S+) /.exec(await call("glimpse_open", { dir }))![1]!;
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    type Content = { type: string; text?: string; data?: string; mimeType?: string }[];

    const waiting = client.callTool({ name: "glimpse_wait_for_done", arguments: { timeout_sec: 30 } });
    await fetch(`${url}/api/handoff`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "ai",
        screenshot: `data:image/png;base64,${png}`,
        changeList: {
          version: 1,
          target: "html",
          createdAt: new Date().toISOString(),
          changes: [{ op: "setText", node: "n1", src: "index.html:1:28", from: "Hi", to: "Hello" }],
        },
      }),
    });
    for (const result of [await waiting, await client.callTool({ name: "glimpse_get_changes", arguments: {} })]) {
      const [text, image] = result.content as Content;
      expect(text!.text).toContain("Screenshot of the human's edited version:");
      expect(image).toEqual({ type: "image", data: png, mimeType: "image/png" });
    }

    // Variants requests carry the job as structured data.
    const waitingVariants = call("glimpse_wait_for_done", { timeout_sec: 30 });
    await fetch(`${url}/api/variants`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: 'button "Hi"', src: "index.html:1:28", count: 2 }),
    });
    const got = await waitingVariants;
    expect(got).toContain("Create 2 different design variants");
    expect(got).toContain('"variants"');
  }, 30_000);
});
