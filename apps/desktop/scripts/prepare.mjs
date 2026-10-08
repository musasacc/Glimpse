// Copy the bundled glimpse-ui (packages/cli/dist: the library, the CLI and the built editor) into app/glimpse,
// which ships inside the desktop app; and check that this package's "dependencies" carry glimpse-ui's runtime
// dependencies, because the bundle imports them from the app's node_modules.
//
//   node scripts/prepare.mjs             fail if packages/cli isn't built
//   node scripts/prepare.mjs --if-built  just warn (used as the npm "prepare" hook, so `npm ci` works before `pnpm build`)
import { cpSync, existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliDir = resolve(desktopDir, "..", "..", "packages", "cli");

export function prepare({ ifBuilt = false } = {}) {
  const from = join(cliDir, "dist");
  const to = join(desktopDir, "app", "glimpse");
  const needed = ["lib.js", "lib.d.ts", join("editor", "index.html")];
  const missing = needed.filter((f) => !existsSync(join(from, f)));
  if (missing.length) {
    const msg = `glimpse-desktop: packages/cli isn't built (missing dist/${missing.join(", dist/")}). Run \`pnpm install && pnpm build\` at the repo root first.`;
    if (ifBuilt) {
      console.warn(msg);
      return false;
    }
    throw new Error(msg);
  }

  checkDependencies();
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true });
  // The bundle is ESM; say so right next to it, whatever ends up in the packaged app's package.json.
  writeFileSync(join(to, "package.json"), `${JSON.stringify({ type: "module", private: true }, null, 2)}\n`);
  return true;
}

function checkDependencies() {
  const cli = JSON.parse(readFileSync(join(cliDir, "package.json"), "utf8"));
  const desktop = JSON.parse(readFileSync(join(desktopDir, "package.json"), "utf8"));
  const problems = [];
  // Optional ones (node-pty, a native module the bundle loads only if it's there) stay optional here too.
  for (const field of ["dependencies", "optionalDependencies"]) {
    const own = desktop[field] ?? {};
    for (const [dep, range] of Object.entries(cli[field] ?? {})) {
      if (!(dep in own)) problems.push(`    ${field}: "${dep}": "${range}",   (missing)`);
      else if (own[dep] !== range) problems.push(`    ${field}: "${dep}": "${range}",   (is "${own[dep]}")`);
    }
  }
  if (problems.length) {
    throw new Error(
      [
        "glimpse-desktop: apps/desktop/package.json \"dependencies\" and \"optionalDependencies\" must match glimpse-ui's",
        "(packages/cli/package.json), because the bundled Glimpse library imports them at runtime. Set these, then run",
        "`npm install` in apps/desktop:",
        ...problems,
      ].join("\n"),
    );
  }
}

function isMain() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  try {
    prepare({ ifBuilt: process.argv.includes("--if-built") });
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
