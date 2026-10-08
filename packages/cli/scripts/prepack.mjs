// npm pack / npm publish hooks for glimpse-ui.
//   prepack:  make sure dist/ is a complete build, and put the repo's LICENSE into the package.
//   postpack: (--cleanup) remove that LICENSE copy again.
import { copyFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const cliDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootLicense = join(cliDir, "..", "..", "LICENSE");
const license = join(cliDir, "LICENSE");

if (process.argv.includes("--cleanup")) {
  if (existsSync(license) && existsSync(rootLicense) && readFileSync(license, "utf8") === readFileSync(rootLicense, "utf8")) {
    rmSync(license);
  }
  process.exit(0);
}

const required = ["dist/index.js", "dist/lib.js", "dist/lib.d.ts", "dist/editor/index.html"];
const missing = required.filter((f) => !existsSync(join(cliDir, ...f.split("/"))));
if (missing.length) {
  console.error(
    `glimpse-ui: refusing to pack an incomplete build (missing ${missing.join(", ")}).\nRun \`pnpm install && pnpm build\` at the repo root first.`,
  );
  process.exit(1);
}
const bin = readFileSync(join(cliDir, "dist", "index.js"), "utf8");
if (/from\s*["']@glimpse\//.test(bin) || !bin.startsWith("#!")) {
  console.error("glimpse-ui: dist/index.js isn't the bundled CLI (run `pnpm build`, which uses scripts/bundle.mjs).");
  process.exit(1);
}
copyFileSync(rootLicense, license);
