// Build the publishable glimpse-ui package into dist/:
//
//   dist/index.js     the `glimpse` command (src/index.ts)
//   dist/lib.js       the library entry, `import … from "glimpse-ui"` (src/lib.ts)
//   dist/lib.d.ts     its types
//   dist/editor/      the built editor UI
//
// Every @glimpse/* workspace package is inlined; every other package stays an import, so it must be one of
// glimpse-ui's own "dependencies" (only those get installed for users). This script collects the runtime
// dependencies of every bundled workspace package (transitively) and fails if glimpse-ui doesn't list them.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { copyEditor } from "./copy-editor.mjs";

const require = createRequire(import.meta.url);
const cliDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootDir = resolve(cliDir, "..", "..");
const distDir = join(cliDir, "dist");
const pkg = readJson(join(cliDir, "package.json"));
const rel = (p) => relative(rootDir, p).split(sep).join("/");

const workspace = workspacePackages();
const builtins = new Set(builtinModules);
const isBuiltin = (spec) => spec.startsWith("node:") || builtins.has(spec) || builtins.has(packageName(spec));

rmSync(distDir, { recursive: true, force: true });

const result = await build({
  absWorkingDir: cliDir,
  entryPoints: { index: "src/index.ts", lib: "src/lib.ts" },
  outdir: "dist",
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  // Shared code (server, MCP, core) goes into one chunk instead of being duplicated per entry.
  // Chunks stay next to the entries so `import.meta.url`-relative paths (dist/editor) work from either.
  splitting: true,
  chunkNames: "chunk-[hash]",
  sourcemap: "linked",
  sourcesContent: false,
  metafile: true,
  logLevel: "warning",
  define: { __GLIMPSE_VERSION__: JSON.stringify(pkg.version) },
  plugins: [
    {
      name: "glimpse-workspace-inline",
      setup(b) {
        b.onResolve({ filter: /^[^./]/ }, (args) => {
          if (args.kind === "entry-point" || isAbsolute(args.path)) return undefined;
          if (isBuiltin(args.path)) return { path: args.path, external: true };
          if (workspace.has(packageName(args.path))) return undefined; // inline: esbuild resolves it through node_modules
          return { path: args.path, external: true };
        });
      },
    },
  ],
});

// The `glimpse` bin must start with the shebang and be executable.
const binFile = join(distDir, "index.js");
const bin = readFileSync(binFile, "utf8");
if (!bin.startsWith("#!")) writeFileSync(binFile, `#!/usr/bin/env node\n${bin}`);
chmodSync(binFile, 0o755);

checkDependencies(result.metafile);
checkVersion();
writeTypes();
const editor = copyEditor();

const size = (f) => `${(readFileSync(join(distDir, f)).length / 1024).toFixed(0)} kB`;
const files = readdirSync(distDir).filter((f) => f.endsWith(".js"));
console.log(`glimpse-ui ${pkg.version}: ${files.map((f) => `dist/${f} (${size(f)})`).join(", ")}, dist/lib.d.ts${editor ? ", dist/editor/" : ""}`);

// ── Dependency check ─────────────────────────────────────────────────────────

function checkDependencies(metafile) {
  /** Workspace packages whose code ended up in the bundle. */
  const bundled = new Set();
  /** Third-party packages the bundle imports at runtime → where from. */
  const imported = new Map();
  for (const [input, info] of Object.entries(metafile.inputs)) {
    const owner = ownerOf(resolve(cliDir, input));
    if (owner && owner !== pkg.name) bundled.add(owner);
    for (const imp of info.imports) {
      if (!imp.external || isBuiltin(imp.path)) continue;
      const name = packageName(imp.path);
      if (!imported.has(name)) imported.set(name, new Set());
      imported.get(name).add(owner ?? input);
    }
  }

  /** Runtime dependencies declared by the bundled workspace packages, following workspace deps transitively. */
  const required = new Map(); // name → [{ range, from }]
  const seen = new Set();
  const visit = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    const ws = workspace.get(name);
    for (const [dep, range] of Object.entries(runtimeDeps(ws.pkg))) {
      if (workspace.has(dep) || range.startsWith("workspace:")) {
        if (workspace.has(dep)) visit(dep);
        continue;
      }
      if (!required.has(dep)) required.set(dep, []);
      required.get(dep).push({ range, from: name });
    }
  };
  for (const name of bundled) visit(name);
  // Imported but not declared by the importing workspace package: still needed at runtime.
  for (const [name, from] of imported) {
    if (!required.has(name)) required.set(name, [...from].map((f) => ({ range: undefined, from: f })));
  }

  const own = pkg.dependencies ?? {};
  const errors = [];
  for (const [dep, range] of Object.entries(own)) {
    if (workspace.has(dep) || String(range).startsWith("workspace:")) {
      errors.push(`"${dep}" is a workspace package: it is inlined into dist/, so list it in "devDependencies", not "dependencies".`);
    }
  }
  const missing = [];
  for (const [dep, sources] of [...required].sort(([a], [b]) => a.localeCompare(b))) {
    const ranges = [...new Set(sources.map((s) => s.range).filter(Boolean))];
    const from = [...new Set(sources.map((s) => s.from))].join(", ");
    if (!(dep in own)) {
      missing.push(`    "${dep}": "${ranges[0] ?? "<version>"}",   (from ${from})`);
    } else if (ranges.length && !ranges.includes(own[dep])) {
      errors.push(`"${dep}" is "${own[dep]}" in glimpse-ui but ${from} declares ${ranges.map((r) => `"${r}"`).join(" / ")}; use the same range.`);
    }
  }
  if (missing.length) {
    errors.push(
      [
        "These runtime dependencies of the bundled workspace packages are missing from glimpse-ui's \"dependencies\".",
        "Only glimpse-ui's own dependencies are installed for users, so the published package would crash without them.",
        `Add them to ${rel(join(cliDir, "package.json"))}:`,
        ...missing,
      ].join("\n"),
    );
  }
  for (const dep of Object.keys(own)) {
    if (!required.has(dep) && !workspace.has(dep)) {
      console.warn(`glimpse-ui: dependency "${dep}" isn't used by anything in the bundle; consider removing it.`);
    }
  }
  if (errors.length) {
    rmSync(distDir, { recursive: true, force: true });
    console.error(`\nglimpse-ui bundle: dependency check failed\n\n${errors.map((e) => `  - ${e.replace(/\n/g, "\n    ")}`).join("\n\n")}\n`);
    process.exit(1);
  }
}

// ── Version ──────────────────────────────────────────────────────────────────

/** Load the built CLI once (catches a bundle that can't start) and make sure `--version` matches package.json. */
function checkVersion() {
  let printed;
  try {
    printed = execFileSync(process.execPath, [binFile, "--version"], { encoding: "utf8" }).trim();
  } catch (err) {
    rmSync(distDir, { recursive: true, force: true });
    console.error(`\nglimpse-ui bundle: dist/index.js doesn't start:\n${err instanceof Error ? err.message : err}\n`);
    process.exit(1);
  }
  if (printed !== pkg.version) {
    rmSync(distDir, { recursive: true, force: true });
    console.error(
      `\nglimpse-ui bundle: \`glimpse --version\` prints "${printed}" but packages/cli/package.json is "${pkg.version}".\n` +
        "Update the version string in packages/cli/src/index.ts (or print VERSION from ./lib.js there).\n",
    );
    process.exit(1);
  }
}

// ── Types ────────────────────────────────────────────────────────────────────

function writeTypes() {
  const { generateDtsBundle } = require("dts-bundle-generator");
  const [dts] = generateDtsBundle(
    [
      {
        filePath: join(cliDir, "src", "lib.ts"),
        libraries: { inlinedLibraries: [...workspace.keys()] },
        output: { noBanner: true },
      },
    ],
    { preferredConfigPath: join(cliDir, "tsconfig.json") },
  );
  writeFileSync(join(distDir, "lib.d.ts"), dts);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** "@scope/name/sub/path.js" → "@scope/name"; "name/sub" → "name". */
function packageName(spec) {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function runtimeDeps(p) {
  return { ...p.peerDependencies, ...p.optionalDependencies, ...p.dependencies };
}

/** The workspace package a file belongs to, if any. */
function ownerOf(file) {
  let best;
  for (const [name, ws] of workspace) {
    if (file.startsWith(ws.dir + sep) && (!best || ws.dir.length > workspace.get(best).dir.length)) best = name;
  }
  return best;
}

/** name → { dir, pkg } for every package matched by pnpm-workspace.yaml's `packages:` globs ("dir/*" or "dir"). */
function workspacePackages() {
  const lines = readFileSync(join(rootDir, "pnpm-workspace.yaml"), "utf8").split(/\r?\n/);
  const patterns = [];
  const start = lines.findIndex((l) => /^packages\s*:/.test(l));
  for (const line of start < 0 ? [] : lines.slice(start + 1)) {
    const m = /^\s+-\s*["']?([^"'#\s]+)["']?\s*(#.*)?$/.exec(line);
    if (m) patterns.push(m[1]);
    else if (/^\S/.test(line)) break;
  }
  if (!patterns.length) throw new Error("glimpse-ui bundle: no `packages:` globs found in pnpm-workspace.yaml");

  const dirs = [];
  for (const pattern of patterns.filter((p) => !p.startsWith("!"))) {
    const clean = pattern.replace(/\/\*\*?$/, "");
    const base = join(rootDir, ...clean.split("/"));
    if (clean === pattern) dirs.push(base);
    else if (existsSync(base)) for (const d of readdirSync(base, { withFileTypes: true })) if (d.isDirectory()) dirs.push(join(base, d.name));
  }
  const map = new Map();
  for (const dir of dirs) {
    const file = join(dir, "package.json");
    if (!existsSync(file)) continue;
    const p = readJson(file);
    if (p.name) map.set(p.name, { dir, pkg: p });
  }
  return map;
}
