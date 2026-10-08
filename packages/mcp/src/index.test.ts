import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
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
      "glimpse_status",
      "glimpse_update",
      "glimpse_wait_for_done",
    ]);
  });

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
});
