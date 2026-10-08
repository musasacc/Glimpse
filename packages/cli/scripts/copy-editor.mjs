// Bundle the built editor UI next to the CLI so `npx glimpse` is self-contained.
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const from = join(here, "..", "..", "editor", "dist");
const to = join(here, "..", "dist", "editor");
if (!existsSync(from)) {
  console.warn("glimpse: editor not built yet (run `pnpm --filter @glimpse/editor build`); skipping copy");
  process.exit(0);
}
rmSync(to, { recursive: true, force: true });
cpSync(from, to, { recursive: true });
