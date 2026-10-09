import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// Tests never start a real AI: no claude/codex CLI, no API key, and settings in a folder of their own
// (agent.test.ts points these at fakes where it needs them).
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
