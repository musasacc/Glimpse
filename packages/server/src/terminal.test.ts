import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bridgeTerminal,
  handleTerminalMessage,
  TerminalSession,
  terminalSnapshot,
  type TerminalServerMessage,
  type TerminalStartOptions,
} from "./terminal.js";

/**
 * A `node -e` command line that works in /bin/sh and in cmd.exe alike: the code
 * may use single quotes but no double quotes, $, %, ! or backticks.
 */
const node = (code: string) => `"${process.execPath}" -e "${code}"`;
const cwd = tmpdir();

const sessions: TerminalSession[] = [];
afterEach(async () => {
  while (sessions.length) await sessions.pop()!.stop();
});

function session(): { term: TerminalSession; out: () => string; exits: (number | null)[]; waitFor: (pred: (out: string) => boolean, ms?: number) => Promise<string>; exited: () => Promise<number | null> } {
  const term = new TerminalSession();
  sessions.push(term);
  let out = "";
  const exits: (number | null)[] = [];
  term.on("data", (d) => (out += d));
  term.on("exit", (code) => exits.push(code));
  const waitFor = async (pred: (out: string) => boolean, ms = 10_000) => {
    const end = Date.now() + ms;
    while (!pred(out)) {
      if (Date.now() > end) throw new Error(`Timed out; output so far: ${JSON.stringify(out)}`);
      await new Promise((r) => setTimeout(r, 20));
    }
    return out;
  };
  const exited = () => new Promise<number | null>((resolve) => (exits.length ? resolve(exits.at(-1)!) : term.once("exit", (code) => resolve(code))));
  return { term, out: () => out, exits, waitFor, exited };
}

/** Whether a process exists (zombies, which only wait for their parent to reap them, count as gone). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const stat = `/proc/${pid}/stat`;
  if (process.platform === "linux" && existsSync(stat)) {
    try {
      return readFileSync(stat, "utf8").split(") ")[1]?.[0] !== "Z";
    } catch {
      return false;
    }
  }
  return true;
}

async function gone(pid: number, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (alive(pid)) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
}

/** Prints "pids:<self>,<child>;" and keeps a grandchild running, so stop() has a tree to kill. */
const TREE = node(
  "const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); process.stdout.write('pids:' + process.pid + ',' + c.pid + ';'); setInterval(() => {}, 1000)",
);
const pidsOf = (out: string) => /pids:(\d+),(\d+);/.exec(out)!.slice(1, 3).map(Number) as [number, number];

async function runModes(): Promise<("pty" | "pipe")[]> {
  const probe = new TerminalSession();
  try {
    const info = await probe.start({ command: node("process.exit(0)"), cwd, mode: "auto" });
    return info?.mode === "pty" ? ["pipe", "pty"] : ["pipe"];
  } catch {
    return ["pipe"];
  } finally {
    await probe.stop();
  }
}
const MODES = await runModes();

describe("TerminalSession (pipe fallback)", () => {
  const start = (term: TerminalSession, opts: Partial<TerminalStartOptions> & { command: string }) => term.start({ cwd, mode: "pipe", ...opts });

  it("streams output and reports the exit code", async () => {
    const s = session();
    const info = await start(s.term, { command: node("process.stdout.write('hi'); process.stderr.write(' there')") });
    expect(info).toMatchObject({ mode: "pipe", cols: 80, rows: 24 });
    expect(s.term.mode).toBe("pipe");
    expect(await s.exited()).toBe(0);
    expect(s.out()).toContain("hi");
    expect(s.out()).toContain("there");
    expect(s.term.running).toBe(false);
    expect(s.term.output).toBe(s.out());
  });

  it("reports non-zero exit codes", async () => {
    const s = session();
    await start(s.term, { command: node("process.exit(3)") });
    expect(await s.exited()).toBe(3);
  });

  it("sets the terminal environment and turns newlines into CRLF for xterm.js", async () => {
    const s = session();
    await start(s.term, {
      command: node("console.log([process.env.COLUMNS, process.env.LINES, process.env.TERM, process.env.FORCE_COLOR, process.env.GLIMPSE_TEST].join(','))"),
      cols: 100,
      rows: 30,
      env: { GLIMPSE_TEST: "yes" },
    });
    await s.exited();
    expect(s.out()).toBe("100,30,xterm-256color,1,yes\r\n");
  });

  it("writes input to stdin, turning Enter into a newline", async () => {
    const s = session();
    await start(s.term, { command: node("process.stdin.once('data', (d) => { process.stdout.write('got:' + JSON.stringify(String(d))); process.exit(0) })") });
    expect(s.term.write("abc\r")).toBe(true);
    expect(await s.exited()).toBe(0);
    expect(s.out()).toBe('got:"abc\\n"');
    expect(s.term.write("late")).toBe(false);
  });

  it("decodes UTF-8 split across chunks", async () => {
    const s = session();
    await start(s.term, { command: node("const b = Buffer.from('✔ done'); process.stdout.write(b.subarray(0, 1)); setTimeout(() => process.stdout.write(b.subarray(1)), 50)") });
    await s.exited();
    expect(s.out()).toBe("✔ done");
  });

  it("hooks process exit only while the app runs, so it never outlives Glimpse", async () => {
    const s = session();
    const before = process.listenerCount("exit");
    await start(s.term, { command: node("setInterval(() => {}, 1000)") });
    expect(process.listenerCount("exit")).toBe(before + 1);
    await s.term.stop();
    expect(process.listenerCount("exit")).toBe(before);
  });

  it("reports a command that can't start", async () => {
    const s = session();
    await start(s.term, { command: node("0"), cwd: join(cwd, "glimpse-no-such-dir-" + process.pid) });
    await s.exited();
    expect(s.out()).toMatch(/\[glimpse\] couldn't run/);
  });
});

describe.each(MODES)("TerminalSession (%s)", (mode) => {
  it("stops the whole process tree without hanging", async () => {
    const s = session();
    await s.term.start({ command: TREE, cwd, mode });
    const [child, grandchild] = pidsOf(await s.waitFor((o) => /pids:\d+,\d+;/.test(o)));
    expect(alive(child)).toBe(true);
    expect(alive(grandchild)).toBe(true);
    const t0 = Date.now();
    await s.term.stop();
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(s.term.running).toBe(false);
    expect(s.exits).toHaveLength(1);
    expect(await gone(child)).toBe(true);
    expect(await gone(grandchild)).toBe(true);
  }, 20_000);

  it("restarts the same command", async () => {
    const s = session();
    await s.term.start({ command: TREE, cwd, mode });
    const [first] = pidsOf(await s.waitFor((o) => /pids:/.test(o)));
    const info = await s.term.restart();
    expect(info?.command).toBe(TREE);
    const [second] = pidsOf(await s.waitFor((o) => (o.match(/pids:/g) ?? []).length === 2).then((o) => o.slice(o.lastIndexOf("pids:"))));
    expect(second).not.toBe(first);
    expect(await gone(first)).toBe(true);
    expect(s.exits).toHaveLength(1);
    expect(s.term.running).toBe(true);
    // The buffer only holds the current run.
    expect((s.term.output.match(/pids:/g) ?? []).length).toBe(1);
  }, 20_000);
});

describe.runIf(MODES.includes("pty"))("TerminalSession (pty)", () => {
  it("runs in a real terminal of the requested size", async () => {
    const s = session();
    await s.term.start({ command: node("process.stdout.write('tty=' + process.stdout.isTTY + ' cols=' + process.stdout.columns + ' rows=' + process.stdout.rows)"), cwd, cols: 100, rows: 30 });
    expect(s.term.mode).toBe("pty");
    await s.exited();
    await s.waitFor((o) => /rows=\d+/.test(o));
    expect(s.out()).toContain("tty=true cols=100 rows=30");
  });

  it.skipIf(process.platform === "win32")("passes resizes to the app", async () => {
    const s = session();
    await s.term.start({
      command: node("process.stdout.on('resize', () => { process.stdout.write('size=' + process.stdout.columns + 'x' + process.stdout.rows); process.exit(0) }); process.stdout.write('ready'); setInterval(() => {}, 1000)"),
      cwd,
    });
    await s.waitFor((o) => o.includes("ready"));
    s.term.resize(120, 40);
    expect(await s.exited()).toBe(0);
    expect(s.out()).toContain("size=120x40");
    expect([s.term.cols, s.term.rows]).toEqual([120, 40]);
  });

  it("sends keystrokes", async () => {
    const s = session();
    await s.term.start({
      command: node("process.stdin.setRawMode(true); process.stdin.once('data', (d) => { process.stdout.write('key=' + JSON.stringify(String(d))); process.exit(0) }); process.stdout.write('ready')"),
      cwd,
    });
    await s.waitFor((o) => o.includes("ready"));
    s.term.write("q");
    await s.exited();
    await s.waitFor((o) => o.includes("key="));
    expect(s.out()).toContain('key="q"');
  });
});

describe("terminal protocol", () => {
  it("bridges events, catches up late clients and handles editor messages", async () => {
    const term = new TerminalSession();
    sessions.push(term);
    const sent: TerminalServerMessage[] = [];
    const unsubscribe = bridgeTerminal(term, (m) => sent.push(m));
    expect(terminalSnapshot(term)).toEqual([]);

    await term.start({ command: node("process.stdin.on('data', (d) => process.stdout.write('echo:' + d))"), cwd, mode: "pipe", cols: 90, rows: 20 });
    expect(sent[0]).toMatchObject({ type: "term-start", mode: "pipe", cols: 90, rows: 20 });

    expect(await handleTerminalMessage(term, { type: "term-input", data: "x\r" })).toBe(true);
    const until = Date.now() + 10_000;
    while (!sent.some((m) => m.type === "term-data" && m.data.includes("echo:x")) && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    expect(sent.some((m) => m.type === "term-data" && m.data.includes("echo:x"))).toBe(true);

    expect(await handleTerminalMessage(term, { type: "term-resize", cols: 120, rows: 40 })).toBe(true);
    expect([term.cols, term.rows]).toEqual([120, 40]);
    // Bad messages are swallowed; other message types are left to the caller.
    expect(await handleTerminalMessage(term, { type: "term-resize", cols: "wide" })).toBe(true);
    expect(await handleTerminalMessage(term, { type: "reload" })).toBe(false);
    expect(await handleTerminalMessage(term, null)).toBe(false);

    const snapshot = terminalSnapshot(term);
    expect(snapshot[0]).toMatchObject({ type: "term-start", cols: 120, rows: 40 });
    expect(snapshot[1]).toEqual({ type: "term-data", data: term.output });

    expect(await handleTerminalMessage(term, { type: "term-restart" })).toBe(true);
    expect(sent.filter((m) => m.type === "term-start")).toHaveLength(2);
    expect(sent.at(-1)).toMatchObject({ type: "term-start", cols: 120, rows: 40 });

    expect(await handleTerminalMessage(term, { type: "term-stop" })).toBe(true);
    expect(term.running).toBe(false);
    expect(sent.filter((m) => m.type === "term-exit")).toHaveLength(2);
    expect(terminalSnapshot(term).at(-1)).toEqual({ type: "term-exit", code: null, signal: null });

    unsubscribe();
    await term.start({ command: node("0"), cwd, mode: "pipe" });
    expect(sent.filter((m) => m.type === "term-start")).toHaveLength(2);
  }, 30_000);

  it("reports a restart before anything ran", async () => {
    const term = new TerminalSession();
    const replies: TerminalServerMessage[] = [];
    await handleTerminalMessage(term, { type: "term-restart" }, (m) => replies.push(m));
    expect(replies).toEqual([{ type: "term-error", message: "Nothing to restart: the terminal was never started" }]);
  });
});
