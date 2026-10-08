// Unit tests for the parts of the desktop app that don't need Electron (recent projects, server lifecycle).
// Compiles test/*.test.ts with esbuild into .test-dist/ and runs them with node's built-in test runner.
import { spawnSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { prepare } from "./prepare.mjs";

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(desktopDir, ".test-dist");

try {
  prepare(); // the lifecycle test runs the real Glimpse library from app/glimpse
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

const tests = readdirSync(join(desktopDir, "test")).filter((f) => f.endsWith(".test.ts"));
rmSync(out, { recursive: true, force: true });
await build({
  absWorkingDir: desktopDir,
  entryPoints: tests.map((f) => `test/${f}`),
  outdir: ".test-dist",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  logLevel: "warning",
  plugins: [
    {
      name: "glimpse-external",
      setup(b) {
        b.onResolve({ filter: /(^|\/)app\/glimpse\// }, (args) => ({ path: args.path, external: true }));
      },
    },
  ],
});

const files = tests.map((f) => join(out, f.replace(/\.ts$/, ".mjs")));
const res = spawnSync(process.execPath, ["--test", "--test-reporter=spec", ...files], { stdio: "inherit", cwd: desktopDir });
process.exit(res.status ?? 1);
