// End-to-end check of the publishable package: `npm pack` glimpse-ui, install the tarball into a fresh
// directory from the registry, then run the installed `glimpse` the way users will:
//   - `npx glimpse --version` and `npx glimpse help`
//   - `npx glimpse open <copy of examples/donut> --no-browser --port <port>`: GET / is the editor, /preview/ the page
//   - `node_modules/.bin/glimpse mcp --no-browser` over stdio: list the tools (incl. the scene tools) and the version,
//     open a project, close it
//
// Usage: node packages/cli/scripts/smoke-pack.mjs [--port 4790] [--keep]
// Needs a built package (pnpm build) and registry access. Cross-platform; only kills processes it started.
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { port: { type: "string", default: "4790" }, keep: { type: "boolean", default: false } } });
const cliDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const example = resolve(cliDir, "..", "..", "examples", "donut");
const pkg = JSON.parse(readFileSync(join(cliDir, "package.json"), "utf8"));
const win = process.platform === "win32";
const work = mkdtempSync(join(tmpdir(), "glimpse-smoke-"));
const started = new Set();

const step = (msg) => console.log(`\n▸ ${msg}`);
const ok = (msg) => console.log(`  ✓ ${msg}`);
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/** Run a command to completion; npm/npx are .cmd shims on Windows, so they go through the shell there. */
function run(cmd, args, opts = {}) {
  return new Promise((resolveRun, reject) => {
    const shell = win && /^(npm|npx)$/.test(cmd);
    const child = spawn(cmd, shell ? args.map(quote) : args, { cwd: work, shell, ...opts, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolveRun(out) : reject(new Error(`${cmd} ${args.join(" ")} exited ${code}\n${out}\n${err}`))));
  });
}
const quote = (a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);

/** Stop a process we spawned, with everything it started (POSIX: its own process group; Windows: its tree). */
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((r) => child.once("exit", r));
  if (win) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  started.delete(child);
}

async function get(url) {
  const res = await fetch(url);
  return { status: res.status, type: res.headers.get("content-type") ?? "", body: await res.text() };
}

async function main() {
  step(`npm pack (glimpse-ui ${pkg.version})`);
  const packed = JSON.parse(await run("npm", ["pack", "--json", "--pack-destination", work], { cwd: cliDir }));
  const tarball = join(work, packed[0].filename);
  const files = packed[0].files.map((f) => f.path);
  ok(`${packed[0].filename}: ${files.length} files, ${(packed[0].size / 1024).toFixed(0)} kB`);
  for (const f of ["package.json", "README.md", "LICENSE", "dist/index.js", "dist/lib.js", "dist/lib.d.ts", "dist/editor/index.html"]) {
    assert(files.includes(f), `tarball is missing ${f}`);
  }
  assert(!files.some((f) => f.startsWith("src/") || f.startsWith("scripts/")), "tarball contains src/ or scripts/");
  ok("contains dist/, the editor, README and LICENSE; no sources");

  step("npm install <tarball> into a fresh directory");
  writeFileSync(join(work, "package.json"), JSON.stringify({ name: "glimpse-smoke", private: true, type: "module" }));
  await run("npm", ["install", tarball, "--no-audit", "--no-fund", "--loglevel=error"]);
  const installed = JSON.parse(readFileSync(join(work, "node_modules", "glimpse-ui", "package.json"), "utf8"));
  assert(!JSON.stringify(installed.dependencies ?? {}).includes("workspace:"), "installed manifest has workspace: dependencies");
  ok(`installed glimpse-ui ${installed.version} with ${Object.keys(installed.dependencies).length} dependencies`);

  step("npx glimpse --version / help");
  const version = (await run("npx", ["--no-install", "glimpse", "--version"])).trim();
  assert(version === pkg.version, `--version printed "${version}", expected ${pkg.version}`);
  ok(`--version → ${version}`);
  const help = await run("npx", ["--no-install", "glimpse", "help"]);
  assert(help.includes("glimpse open [dir]") && help.includes("glimpse mcp"), "help text looks wrong");
  ok("help lists open … mcp");

  step("library entry: import from \"glimpse-ui\"");
  writeFileSync(
    join(work, "lib-check.mjs"),
    `import * as g from "glimpse-ui";\nconsole.log(JSON.stringify({ version: g.VERSION, editor: !!g.editorDir(), fns: ["startServer","startGlimpse","openBrowser","runStdio","createGlimpseMcp","changeListToPrompt"].filter((k) => typeof g[k] === "function") }));\n`,
  );
  const lib = JSON.parse(await run(process.execPath, ["lib-check.mjs"]));
  assert(lib.version === pkg.version && lib.editor && lib.fns.length === 6, `library exports look wrong: ${JSON.stringify(lib)}`);
  ok(`exports ${lib.fns.join(", ")}; editorDir() found the bundled editor`);

  const project = join(work, "donut");
  cpSync(example, project, { recursive: true });
  step(`npx glimpse open <donut copy> --no-browser --port ${values.port}`);
  const openArgs = ["--no-install", "glimpse", "open", project, "--no-browser", "--port", values.port];
  const t0 = Date.now();
  const server = spawn("npx", win ? openArgs.map(quote) : openArgs, {
    cwd: work,
    shell: win,
    detached: !win, // own process group, so stop() reaches npx's children too
    stdio: ["ignore", "pipe", "pipe"],
  });
  started.add(server);
  let log = "";
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));
  const url = await new Promise((resolveUrl, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`glimpse open didn't print its URL within 90s (process ${server.exitCode === null ? "still running" : `exited ${server.exitCode}`}). Output:\n${log}`)),
      90_000,
    );
    const check = () => {
      const m = /glimpse\s+(http:\/\/\S+)/.exec(log);
      if (m) {
        clearTimeout(timer);
        resolveUrl(m[1]);
      }
    };
    server.stdout.on("data", check);
    server.on("exit", (code) => reject(new Error(`glimpse open exited (${code}):\n${log}`)));
  });
  ok(`listening at ${url} after ${((Date.now() - t0) / 1000).toFixed(1)}s (pid ${server.pid})`);
  const home = await get(`${url}/`);
  assert(home.status === 200 && home.type.includes("text/html") && home.body.includes('id="root"') && /assets\/index-[^"]+\.js/.test(home.body), `GET / isn't the editor:\n${home.body.slice(0, 300)}`);
  ok("GET / → the editor (index.html with its built assets)");
  const asset = /src="(\/assets\/index-[^"]+\.js)"/.exec(home.body)?.[1];
  if (asset) {
    const js = await get(`${url}${asset}`);
    assert(js.status === 200 && js.body.length > 10_000, `editor bundle ${asset} didn't load`);
    ok(`GET ${asset} → ${(js.body.length / 1024).toFixed(0)} kB`);
  }
  const preview = await get(`${url}/preview/`);
  assert(preview.status === 200 && preview.body.includes("Donut Shop") && preview.body.includes("data-glimpse-src"), `GET /preview/ isn't the instrumented page:\n${preview.body.slice(0, 300)}`);
  ok("GET /preview/ → donut page with data-glimpse-src locations");
  const session = JSON.parse((await get(`${url}/api/session`)).body);
  assert(session.project?.target === "html", "GET /api/session looks wrong");
  ok(`GET /api/session → target ${session.project.target}, entry ${session.project.entry}`);
  assert(existsSync(join(project, ".glimpse", "server.json")), ".glimpse/server.json wasn't written");
  const info = JSON.parse(readFileSync(join(project, ".glimpse", "server.json"), "utf8"));
  assert(info.url === url && typeof info.token === "string" && info.token.length >= 40, `.glimpse/server.json looks wrong: ${JSON.stringify(Object.keys(info))}`);
  ok(".glimpse/server.json has the URL and the server's token");
  await stop(server);
  ok(`stopped pid ${server.pid}`);

  step("node_modules/.bin/glimpse mcp --no-browser (stdio) via @modelcontextprotocol/sdk");
  const req = createRequire(join(work, "package.json"));
  const { Client } = req("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = req("@modelcontextprotocol/sdk/client/stdio.js");
  const transport = new StdioClientTransport({
    command: join(work, "node_modules", ".bin", win ? "glimpse.cmd" : "glimpse"),
    args: ["mcp", "--no-browser", "--port", values.port],
    cwd: work,
    stderr: "pipe",
  });
  const client = new Client({ name: "glimpse-smoke", version: "0.0.0" });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    const expected = ["glimpse_open", "glimpse_wait_for_done", "glimpse_get_changes", "glimpse_status", "glimpse_update", "glimpse_close"];
    for (const t of [...expected, "glimpse_scene_schema", "glimpse_scene_validate"]) {
      assert(names.includes(t), `MCP tool ${t} is missing (got ${names.join(", ")})`);
    }
    ok(`tools: ${names.join(", ")}`);
    const server = client.getServerVersion();
    assert(server?.version === pkg.version, `MCP server reports version ${server?.version}, expected ${pkg.version}`);
    ok(`server ${server.name} ${server.version}`);
    const mcpProject = join(work, "donut-mcp");
    cpSync(example, mcpProject, { recursive: true });
    const opened = await client.callTool({ name: "glimpse_open", arguments: { dir: mcpProject } });
    const text = opened.content.map((c) => c.text ?? "").join("\n");
    const mcpUrl = /Glimpse is open at (http:\/\/\S+?) /.exec(text)?.[1];
    assert(mcpUrl, `glimpse_open didn't return a URL:\n${text}`);
    const mcpHome = await get(`${mcpUrl}/`);
    assert(mcpHome.status === 200 && mcpHome.body.includes('id="root"'), "MCP-started Glimpse doesn't serve the editor");
    ok(`glimpse_open → ${mcpUrl} serves the editor`);
    const closed = await client.callTool({ name: "glimpse_close", arguments: { dir: mcpProject } });
    assert(closed.content.map((c) => c.text ?? "").join("").includes("Closed"), "glimpse_close failed");
    ok("glimpse_close → Closed");
  } finally {
    await client.close();
  }
  console.log("\nglimpse-ui package smoke test passed.");
}

try {
  await main();
} catch (err) {
  console.error(`\nglimpse-ui package smoke test FAILED: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
} finally {
  for (const child of started) await stop(child);
  if (values.keep) console.log(`(kept ${work})`);
  else {
    try {
      rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (err) {
      console.warn(`(couldn't remove ${work}: ${err instanceof Error ? err.message : err})`);
    }
  }
}
