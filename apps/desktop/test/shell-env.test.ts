import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loginShellEnv, parseShellEnv } from "../src/shell-env.js";

describe("parseShellEnv", () => {
  it("reads the environment between the markers, whatever the startup files print around it", () => {
    const env = { PATH: "/opt/homebrew/bin:/usr/bin", HOME: "/Users/me", ELECTRON_RUN_AS_NODE: "1", SHLVL: "2" };
    const out = `Welcome!\nMARKER${JSON.stringify(env)}MARKER\nbye`;
    assert.deepEqual(parseShellEnv(out, "MARKER"), { PATH: "/opt/homebrew/bin:/usr/bin", HOME: "/Users/me" });
  });

  it("gives null for output without the environment", () => {
    assert.equal(parseShellEnv("command not found", "MARKER"), null);
    assert.equal(parseShellEnv("MARKER{not json MARKER", "MARKER"), null);
  });
});

describe("loginShellEnv", { skip: process.platform === "win32" }, () => {
  it("reads PATH from a real shell", async () => {
    const env = await loginShellEnv();
    assert.ok(env?.PATH, "PATH");
    assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  });
});
