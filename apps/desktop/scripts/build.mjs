// Build the desktop app into dist/ (and the Glimpse library into app/glimpse):
//   dist/main.mjs      main process (ESM)
//   dist/preload.cjs   launcher preload (sandboxed preloads must be CommonJS)
//   dist/launcher/     launcher page
import { copyFileSync, cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { prepare } from "./prepare.mjs";

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(desktopDir, "dist");

try {
  prepare();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

rmSync(dist, { recursive: true, force: true });

/** The Glimpse library is loaded from app/glimpse at runtime, not bundled again. */
const glimpseExternal = {
  name: "glimpse-external",
  setup(b) {
    b.onResolve({ filter: /(^|\/)app\/glimpse\// }, (args) => ({ path: args.path, external: true }));
  },
};

const common = { absWorkingDir: desktopDir, bundle: true, logLevel: "warning", sourcemap: "linked", sourcesContent: false };

await Promise.all([
  build({
    ...common,
    entryPoints: ["src/main.ts"],
    outfile: "dist/main.mjs",
    platform: "node",
    target: "node22",
    format: "esm",
    external: ["electron"],
    plugins: [glimpseExternal],
  }),
  build({
    ...common,
    entryPoints: ["src/preload.ts"],
    outfile: "dist/preload.cjs",
    platform: "node",
    target: "node22",
    format: "cjs",
    external: ["electron"],
  }),
  build({
    ...common,
    entryPoints: ["src/launcher/launcher.ts"],
    outfile: "dist/launcher/launcher.js",
    platform: "browser",
    target: "chrome130",
    format: "iife",
  }),
]);

mkdirSync(join(dist, "launcher"), { recursive: true });
cpSync(join(desktopDir, "src", "launcher", "index.html"), join(dist, "launcher", "index.html"));
cpSync(join(desktopDir, "src", "launcher", "launcher.css"), join(dist, "launcher", "launcher.css"));
copyFileSync(join(desktopDir, "..", "..", "assets", "mark.svg"), join(dist, "launcher", "mark.svg"));
console.log("glimpse-desktop: built dist/main.mjs, dist/preload.cjs, dist/launcher/ and app/glimpse/");
