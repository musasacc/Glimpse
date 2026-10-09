import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { engineLabel, MORE_HIDDEN, normalizeAgentInfo, normalizeAgentRun, normalizeRunMessage, outputLines, queuedNote, RunFeed, type AgentInfo } from "./agent";

const INFO: AgentInfo = {
  engine: "claude",
  preferred: "auto",
  available: { claude: true, codex: false, api: false, external: false },
  running: null,
  queued: 0,
  api: null,
  behavior: null,
};

const API = {
  provider: "openai",
  model: "gpt-5",
  chosenModel: "",
  providers: {
    anthropic: { name: "Anthropic", defaultModel: "claude-opus-5-5", models: ["claude-opus-5-5"] },
    openai: { name: "OpenAI", defaultModel: "gpt-5", models: ["gpt-5"] },
    gemini: { name: "Gemini", defaultModel: "gemini-2.5-pro", models: [] },
    openrouter: { name: "OpenRouter", defaultModel: "anthropic/claude-opus-5-5", models: [] },
    ollama: { name: "Ollama", defaultModel: "llama3.2:latest", models: ["llama3.2:latest"] },
  },
  keysSaved: { anthropic: false, openai: true, gemini: false, openrouter: false },
  envKeys: { anthropic: false, openai: false, gemini: true, openrouter: false },
  ollama: { baseUrl: "http://localhost:11434", running: true, models: ["llama3.2:latest"] },
} as const;

describe("normalizeAgentInfo", () => {
  it("keeps a full object", () => {
    expect(normalizeAgentInfo(structuredClone(INFO))).toEqual(INFO);
    const running = { ...INFO, running: { seq: 4, engine: "codex", startedAt: "2026-01-01T00:00:00Z" }, queued: 2 };
    expect(normalizeAgentInfo(running)).toEqual(running);
  });

  it("is null for an older server's missing or garbled info", () => {
    expect(normalizeAgentInfo(undefined)).toBeNull();
    expect(normalizeAgentInfo(null)).toBeNull();
    expect(normalizeAgentInfo("claude")).toBeNull();
    expect(normalizeAgentInfo({})).toBeNull();
    expect(normalizeAgentInfo({ engine: "gpt" })).toBeNull();
  });

  it("fills in missing fields", () => {
    expect(normalizeAgentInfo({ engine: "none" })).toEqual({
      engine: "none",
      preferred: "auto",
      available: { claude: false, codex: false, api: false, external: false },
      running: null,
      queued: 0,
      api: null,
      behavior: null,
    });
  });

  it("reads the Direct API and behavior settings of a newer server", () => {
    const info = normalizeAgentInfo({ ...INFO, engine: "api", api: structuredClone(API), quality: "best", allowCommands: true, maxSteps: 12, customInstructions: "Tailwind" });
    expect(info?.api).toEqual(API);
    expect(info?.behavior).toEqual({ quality: "best", allowCommands: true, maxSteps: 12, customInstructions: "Tailwind" });
    // A garbled api block: defaults per provider, no flags.
    const partial = normalizeAgentInfo({ ...INFO, api: { provider: "gemini" }, quality: "nope" });
    expect(partial?.api).toMatchObject({ provider: "gemini", model: "gemini-2.5-pro", keysSaved: { gemini: false }, ollama: { running: false, models: [] } });
    expect(partial?.behavior).toBeNull();
    expect(normalizeAgentInfo({ ...INFO, api: { provider: "mistral" } })?.api).toBeNull();
  });

  it("labels the engine chip with the provider and model", () => {
    const api = (provider: string, model: string) => ({ api: { ...structuredClone(API), provider, model } }) as never;
    expect(engineLabel("claude", null)).toBe("Claude Code");
    expect(engineLabel("api", null)).toBe("Claude API");
    expect(engineLabel("api", api("anthropic", "claude-opus-5-5"))).toBe("Claude · opus-5-5");
    expect(engineLabel("api", api("openai", "gpt-5"))).toBe("GPT · OpenAI");
    expect(engineLabel("api", api("openai", "o4-mini"))).toBe("OpenAI · o4-mini");
    expect(engineLabel("api", api("gemini", "gemini-2.5-pro"))).toBe("Gemini");
    expect(engineLabel("api", api("ollama", "llama3:latest"))).toBe("Ollama · llama3");
    expect(engineLabel("api", api("openrouter", "anthropic/claude-opus-5-5"))).toBe("OpenRouter · claude-opus-5-5");
    expect(engineLabel("none", api("openai", "gpt-5"))).toBe("Set up AI");
  });
});

describe("run messages", () => {
  it("checks agent-run events", () => {
    expect(normalizeRunMessage({ type: "agent-run", event: "output", seq: 3, engine: "claude", text: "hi", at: "x" })).toEqual({
      event: "output",
      seq: 3,
      engine: "claude",
      text: "hi",
      at: "x",
    });
    expect(normalizeRunMessage({ event: "bogus", seq: 1 })).toBeNull();
    expect(normalizeRunMessage({ event: "start" })).toBeNull();
  });

  it("reads the hello's run with its output", () => {
    expect(normalizeAgentRun({ seq: 2, engine: "api", startedAt: "t", output: ["a", 5, "b"] })).toEqual({ seq: 2, engine: "api", startedAt: "t", output: ["a", "b"] });
    expect(normalizeAgentRun(null)).toBeNull();
  });

  it("only notes a queue for an external agent that isn't listening", () => {
    expect(queuedNote("external", false)).toMatch(/queued/);
    expect(queuedNote("external", true)).toBe("");
    expect(queuedNote("claude", false)).toBe("");
  });
});

describe("outputLines", () => {
  it("drops escapes, control characters and blank lines; cuts long lines", () => {
    expect(outputLines("\u001b[32mgreen\u001b[0m\n\n   \r\n  two \u0007\r\nthree")).toEqual(["green", "two", "three"]);
    const long = outputLines("x".repeat(500))[0]!;
    expect(long).toHaveLength(160);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("RunFeed", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("coalesces rapid output into one batch of the latest lines", () => {
    const batches: string[][] = [];
    const feed = new RunFeed((...rows) => batches.push(rows));
    feed.push("one\ntwo");
    feed.push("three");
    feed.push("four\nfive");
    expect(batches).toHaveLength(0);
    vi.advanceTimersByTime(300);
    expect(batches).toEqual([["…", "three", "four", "five"]]);
    feed.push("six");
    feed.flush();
    expect(batches[1]).toEqual(["six"]);
  });

  it("caps a run's rows and says so once", () => {
    const rows: string[] = [];
    const feed = new RunFeed((...r) => rows.push(...r));
    for (let i = 0; i < 100; i++) {
      feed.push(`line ${i}`);
      feed.flush();
    }
    expect(rows).toHaveLength(40);
    expect(rows.at(-1)).toBe(MORE_HIDDEN);
    expect(rows.filter((r) => r === MORE_HIDDEN)).toHaveLength(1);
    // A new run starts counting again.
    feed.reset();
    feed.push("next run");
    feed.flush();
    expect(rows.at(-1)).toBe("next run");
  });

  it("ignores blank output", () => {
    const emit = vi.fn();
    const feed = new RunFeed(emit);
    feed.push("  \n\u001b[0m\n");
    vi.advanceTimersByTime(1000);
    expect(emit).not.toHaveBeenCalled();
  });
});

/** A websocket the test drives: `last.receive(msg)` delivers a server message. */
class FakeSocket {
  static OPEN = 1;
  static last: FakeSocket | null = null;
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  constructor(public url: string) {
    FakeSocket.last = this;
  }
  send(): void {}
  close(): void {}
  receive(msg: object): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

describe("live agent messages", () => {
  const fetchMock = vi.fn(async (url: string) => (url === "/api/agent" ? new Response("Not found", { status: 404 }) : new Response(JSON.stringify({ handoffs: [] }))));

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("location", { protocol: "http:", host: "localhost:4321" });
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function connect() {
    const { store } = await import("./store");
    const { connectLive } = await import("./live");
    const stop = connectLive();
    return { store, socket: FakeSocket.last!, stop };
  }
  const rows = (store: { state: { activity: { kind: string; text: string }[] } }) => store.state.activity.map((a) => `${a.kind}: ${a.text}`).reverse();
  const project = { dir: "/tmp/p", target: "html", entry: "index.html" };

  it("an older server's hello leaves the agent info unknown (an external agent)", async () => {
    const { store, socket, stop } = await connect();
    socket.receive({ type: "hello", project, agentWaiting: false, entryExists: true });
    expect(store.state.agentInfo).toBeNull();
    expect(store.state.agentRun).toBeNull();
    const { currentEngine } = await import("./store");
    expect(currentEngine(store.state)).toBe("external");
    // It asks once whether the server has the agent API after all; a 404 changes nothing.
    expect(fetchMock).toHaveBeenCalledWith("/api/agent");
    await vi.runAllTimersAsync();
    expect(store.state.agentInfo).toBeNull();
    stop();
  });

  it("follows agent info and a run from start to done", async () => {
    const { store, socket, stop } = await connect();
    socket.receive({ type: "hello", project, agentWaiting: false, entryExists: true, agentInfo: INFO, agentRun: null });
    expect(store.state.agentInfo?.engine).toBe("claude");
    expect(fetchMock).not.toHaveBeenCalledWith("/api/agent");

    socket.receive({ type: "agent-info", info: { ...INFO, engine: "codex" } });
    expect(store.state.agentInfo?.engine).toBe("codex");
    socket.receive({ type: "agent-info", info: { nonsense: true } });
    expect(store.state.agentInfo?.engine).toBe("codex");

    socket.receive({ type: "agent-run", event: "start", seq: 7, engine: "claude", at: "2026-01-01T00:00:00Z" });
    expect(store.state.agentRun).toEqual({ seq: 7, engine: "claude", startedAt: "2026-01-01T00:00:00Z" });
    socket.receive({ type: "agent-run", event: "output", seq: 7, engine: "claude", text: "Reading files\n" });
    socket.receive({ type: "agent-run", event: "output", seq: 7, engine: "claude", text: "Writing index.html\n" });
    vi.advanceTimersByTime(300);
    socket.receive({ type: "agent-run", event: "done", seq: 7, engine: "claude" });
    expect(store.state.agentRun).toBeNull();
    expect(rows(store)).toEqual(["ai-status: Claude Code is building…", "info: Reading files", "info: Writing index.html", "handoff: Done"]);
    stop();
  });

  it("shows a stop as a neutral row and an error as a warning", async () => {
    const { store, socket, stop } = await connect();
    socket.receive({ type: "hello", project, agentInfo: INFO });
    socket.receive({ type: "agent-run", event: "start", seq: 1, engine: "codex" });
    socket.receive({ type: "agent-run", event: "error", seq: 1, engine: "codex", text: "Stopped" });
    expect(store.state.agentRun).toBeNull();
    socket.receive({ type: "agent-run", event: "start", seq: 2, engine: "codex" });
    socket.receive({ type: "agent-run", event: "output", seq: 2, engine: "codex", text: "half a line" });
    socket.receive({ type: "agent-run", event: "error", seq: 2, engine: "codex" });
    expect(rows(store)).toEqual([
      "ai-status: Codex is building…",
      "info: Stopped",
      "ai-status: Codex is building…",
      "info: half a line",
      "warn: Codex stopped with an error",
    ]);
    stop();
  });

  it("catches up with a run already going when it connects, once", async () => {
    const { store, socket, stop } = await connect();
    const hello = { type: "hello", project, agentInfo: { ...INFO, running: { seq: 5, engine: "claude", startedAt: "t" } }, agentRun: { seq: 5, engine: "claude", startedAt: "t", output: ["one", "two"] } };
    socket.receive(hello);
    expect(store.state.agentRun?.seq).toBe(5);
    // A reconnect to the same run adds nothing.
    socket.receive(hello);
    expect(rows(store)).toEqual(["ai-status: Claude Code is building…", "info: one", "info: two"]);
    // It ended while we were away.
    socket.receive({ ...hello, agentInfo: INFO, agentRun: null });
    expect(store.state.agentRun).toBeNull();
    stop();
  });

  it("sends Home's waiting request once AI settings are saved with an engine", async () => {
    const { store } = await connect();
    const then = vi.fn();
    store.openAiSettings(then);
    expect(store.state.aiSettingsOpen).toBe(true);
    store.closeAiSettings({ ...INFO, engine: "none" });
    expect(then).not.toHaveBeenCalled();
    store.openAiSettings(then);
    store.closeAiSettings();
    expect(then).not.toHaveBeenCalled();
    store.openAiSettings(then);
    store.closeAiSettings(INFO);
    expect(then).toHaveBeenCalledTimes(1);
    expect(store.state.aiSettingsOpen).toBe(false);
    expect(store.state.agentInfo).toEqual(INFO);
  });
});
