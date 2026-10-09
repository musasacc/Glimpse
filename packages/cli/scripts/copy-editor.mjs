// Bundle the built editor UI next to the CLI so `npx glimpse` is self-contained.
// Used by bundle.mjs; also runnable on its own: `node scripts/copy-editor.mjs`.
import { cpSync, existsSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Copy packages/editor/dist to packages/cli/dist/editor. Returns false (with a warning) when the editor isn't built. */
export function copyEditor() {
  const from = join(here, "..", "..", "editor", "dist");
  const to = join(here, "..", "dist", "editor");
  if (!existsSync(from)) {
    console.warn("glimpse: editor not built yet (run `pnpm --filter @glimpse/editor build`); skipping copy");
    return false;
  }
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true });
  return true;
}

if (isMain()) copyEditor();

function isMain() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
