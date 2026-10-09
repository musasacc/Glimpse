// The user's login-shell environment. An app started from Finder, the Dock or a desktop launcher gets the bare
// environment of launchd or the session (on macOS PATH=/usr/bin:/bin:/usr/sbin:/sbin), without what the shell's
// startup files add: Homebrew, pyenv, nvm, cargo, a venv. Commands Glimpse runs (meta.command such as
// "python app.py", glimpse_open's command) would then not be found, while they work from a terminal.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";

/** Variables of the probe itself, or of the shell process, that mustn't leak into the app. */
const SKIP = new Set(["ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ATTACH_CONSOLE", "SHLVL", "_", "PWD", "OLDPWD"]);

/** The JSON between two markers in a shell's output (startup files may print around it). */
export function parseShellEnv(output: string, marker: string): Record<string, string> | null {
  const start = output.indexOf(marker);
  const end = output.lastIndexOf(marker);
  if (start < 0 || end <= start) return null;
  try {
    const env = JSON.parse(output.slice(start + marker.length, end)) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) if (typeof v === "string" && !SKIP.has(k)) out[k] = v;
    return out;
  } catch {
    return null;
  }
}

/**
 * Run the user's shell as a login, interactive shell (it reads the profile and rc files) and read its environment,
 * printed by this very executable as Node (ELECTRON_RUN_AS_NODE). Null on Windows, on failure or after `timeoutMs`.
 */
export function loginShellEnv(timeoutMs = 5000): Promise<Record<string, string> | null> {
  if (process.platform === "win32") return Promise.resolve(null);
  const shell = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh");
  const marker = `__glimpse_env_${randomUUID()}__`;
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const command = `${quote(process.execPath)} -e ${quote(`process.stdout.write(${JSON.stringify(marker)} + JSON.stringify(process.env) + ${JSON.stringify(marker)})`)}`;
  return new Promise((resolve) => {
    const child = execFile(
      shell,
      ["-ilc", command],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ELECTRON_NO_ATTACH_CONSOLE: "1" }, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (_err, stdout) => resolve(parseShellEnv(String(stdout ?? ""), marker)),
    );
    // An rc file that asks something (`read`, an update prompt) gets end-of-input instead of waiting for the timeout.
    child.stdin?.end();
  });
}

/**
 * Adopt the login shell's environment, unless the app was started from a terminal (which already has it).
 * Resolves once done; never throws.
 */
export async function adoptLoginShellEnv(): Promise<void> {
  if (process.platform === "win32" || process.env.TERM) return;
  const env = await loginShellEnv().catch(() => null);
  if (env) for (const [k, v] of Object.entries(env)) process.env[k] = v;
}
