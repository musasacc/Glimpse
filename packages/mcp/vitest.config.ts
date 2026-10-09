import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// The servers these tests start must never run a real AI: no claude/codex CLI, no API key, settings of their own.
export default defineConfig({
  test: {
    env: {
      GLIMPSE_CONFIG_DIR: join(tmpdir(), `glimpse-test-config-${process.pid}`),
      GLIMPSE_AGENT_CLAUDE_BIN: join(tmpdir(), "glimpse-test-no-claude"),
      GLIMPSE_AGENT_CODEX_BIN: join(tmpdir(), "glimpse-test-no-codex"),
      ANTHROPIC_API_KEY: "",
    },
  },
});
