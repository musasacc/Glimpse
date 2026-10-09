// The home window's logic: AI info (never the key), checking what the page sends, naming new project folders, and
// handing a request to a real Glimpse server from the main process (no Origin header, like the CLI).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { saveAgentSettings, startGlimpse } from "../app/glimpse/lib.js";
import { aiInfo, parseRequest, parseSaveAi, postRequest, projectSlug, resolveEngine, uniqueFolder } from "../src/home.js";

const root = mkdtempSync(join(tmpdir(), "glimpse-home-"));
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

describe("AI info", () => {
  const none = { claude: false, codex: false, api: false };
  it("resolves the engine like the server does", () => {
    assert.equal(resolveEngine("auto", { claude: true, codex: true, api: true }), "claude");
    assert.equal(resolveEngine("auto", { claude: false, codex: true, api: true }), "codex");
    assert.equal(resolveEngine("auto", { claude: false, codex: false, api: true }), "api");
    assert.equal(resolveEngine("auto", none), "none");
    assert.equal(resolveEngine("codex", { claude: true, codex: false, api: true }), "none");
    assert.equal(resolveEngine("external", none), "external");
  });

  it("labels it and never includes the API key", () => {
    const info = aiInfo({ engine: "auto", anthropicApiKey: "sk-ant-secret" }, { claude: false, codex: false, api: true });
    assert.deepEqual(info, { preferred: "auto", engine: "api", label: "Claude API", available: { claude: false, codex: false, api: true }, keySaved: true });
    assert.ok(!JSON.stringify(info).includes("sk-ant-secret"));
    assert.equal(aiInfo({ engine: "auto" }, none).label, "Set up AI");
    assert.equal(aiInfo({ engine: "claude" }, { claude: true, codex: false, api: false }).label, "Claude Code");
  });

  it("checks settings changes from the page", () => {
    assert.deepEqual(parseSaveAi({ engine: "codex" }), { engine: "codex" });
    assert.deepEqual(parseSaveAi({ anthropicApiKey: "  sk-ant-x  " }), { anthropicApiKey: "sk-ant-x" });
    assert.deepEqual(parseSaveAi({ anthropicApiKey: null }), { anthropicApiKey: null });
    assert.deepEqual(parseSaveAi({}), {});
    assert.throws(() => parseSaveAi({ engine: "gpt" }), /Unknown engine/);
    assert.throws(() => parseSaveAi({ anthropicApiKey: "" }), /API key/);
    assert.throws(() => parseSaveAi({ anthropicApiKey: "a b" }), /API key/);
    assert.throws(() => parseSaveAi(null));
  });
});

describe("requests", () => {
  it("need text and a known target", () => {
    assert.deepEqual(parseRequest({ text: "  A todo app ", target: "tui" }), { text: "A todo app", target: "tui" });
    assert.throws(() => parseRequest({ text: "   ", target: "html" }), /Describe/);
    assert.throws(() => parseRequest({ text: "x", target: "flash" }), /Unknown target/);
    assert.throws(() => parseRequest("x"));
  });

  it("name a new project folder after the request", () => {
    assert.equal(projectSlug("A landing page for a coffee brand: hero with headline"), "landing-page");
    assert.equal(projectSlug("An analytics dashboard with a sidebar"), "analytics-dashboard");
    assert.equal(projectSlug("Make me a Café menü"), "cafe-menu");
    assert.equal(projectSlug("!!!"), "my-project");
    assert.equal(projectSlug("please build it"), "my-project");
  });

  it("pick a folder name that isn't taken", () => {
    const parent = join(root, "projects");
    mkdirSync(join(parent, "landing-page"), { recursive: true });
    mkdirSync(join(parent, "landing-page-2"), { recursive: true });
    const exists = (p: string) => ["landing-page", "landing-page-2"].some((n) => p === join(parent, n));
    assert.equal(uniqueFolder(parent, "landing-page", exists), join(parent, "landing-page-3"));
    assert.equal(uniqueFolder(parent, "dashboard", exists), join(parent, "dashboard"));
  });

  it("reach a real Glimpse server from the main process (no Origin header)", async () => {
    // Requests wait for an external agent here, so nothing runs an AI during the test.
    process.env.GLIMPSE_CONFIG_DIR = join(root, "config");
    await saveAgentSettings({ engine: "external" });
    const dir = join(root, "new-project");
    mkdirSync(dir, { recursive: true });
    const srv = await startGlimpse({ dir, port: 0 });
    try {
      const res = await postRequest(srv.url, { text: "A pricing page with three plans", target: "html" });
      assert.equal(typeof res.seq, "number");
      const handoffs = (await fetch(`${srv.url}/api/handoffs`).then((r) => r.json())) as unknown;
      assert.ok(JSON.stringify(handoffs).includes("A pricing page with three plans"), JSON.stringify(handoffs));
      await assert.rejects(postRequest(srv.url, { text: "x", target: "flash" as never }), /Expected/);
    } finally {
      await srv.close();
      delete process.env.GLIMPSE_CONFIG_DIR;
    }
  });
});
