import { spawn } from "node:child_process";

/** Open a URL in the default browser on macOS, Windows or Linux. Never throws. */
export function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]]
    : // rundll32 avoids cmd.exe quoting pitfalls with "&" in URLs.
      process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
    : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true }).on("error", () => {}).unref();
  } catch {
    // No browser available (e.g. a headless server); callers also print the URL.
  }
}
