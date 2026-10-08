// Render assets/icon.png (1024×1024) from the Glimpse mark (repo assets/mark.svg) with headless Chromium.
// electron-builder derives the macOS .icns, the Windows .ico and the Linux icons from this PNG.
// The mark fills the central 824×824 (macOS icon grid) on a transparent canvas.
//
//   node scripts/make-icon.mjs [path/to/playwright/index.mjs]
// Playwright isn't a dependency of the app; pass its module path or set PLAYWRIGHT_MODULE
// (default: a global install at /opt/node22/lib/node_modules/playwright). Re-run it when the mark changes,
// and commit assets/icon.png.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const markFile = join(desktopDir, "..", "..", "assets", "mark.svg");
const out = join(desktopDir, "assets", "icon.png");
const modulePath = process.argv[2] ?? process.env.PLAYWRIGHT_MODULE ?? "/opt/node22/lib/node_modules/playwright/index.mjs";

const { chromium } = await import(pathToFileURL(modulePath).href);
const svg = readFileSync(markFile, "utf8");
const SIZE = 1024;
const ART = 824;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE }, deviceScaleFactor: 1 });
  await page.setContent(
    `<!doctype html><html><head><style>
      html, body { margin: 0; width: ${SIZE}px; height: ${SIZE}px; background: transparent; }
      body { display: grid; place-items: center; }
      svg { width: ${ART}px; height: ${ART}px; display: block; filter: drop-shadow(0 12px 24px rgba(0, 0, 0, 0.35)); }
    </style></head><body>${svg}</body></html>`,
  );
  mkdirSync(dirname(out), { recursive: true });
  await page.screenshot({ path: out, omitBackground: true, clip: { x: 0, y: 0, width: SIZE, height: SIZE } });
  console.log(`wrote ${out}`);
} finally {
  await browser.close();
}
