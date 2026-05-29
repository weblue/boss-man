/**
 * Sandcastle SDK entry point for batch / automated runs.
 * Used by the server runner when spinning up sandboxed worker agents.
 * Interactive orchestrator sessions are managed separately via Docker exec + tmux.
 *
 * Usage: npx tsx sandcastle/main.mts (not called directly — server runner imports this config)
 */

import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LITELLM_PORT = process.env.LITELLM_PORT ?? "4000";
const LITELLM_MASTER_KEY =
  process.env.LITELLM_MASTER_KEY ?? "sk-boss-man-master-key-change-me";
const LITELLM_API_KEY =
  process.env.LITELLM_API_KEY ?? LITELLM_MASTER_KEY;
const CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "";
const CLAUDE_CODE_AUTH_MODE =
  process.env.CLAUDE_CODE_AUTH_MODE ?? (process.env.ANTHROPIC_API_KEY ? "litellm" : "login");
const CLAUDE_AUTH_PROVIDER =
  process.env.BOSS_MAN_CLAUDE_AUTH_PROVIDER ??
  (CLAUDE_CODE_AUTH_MODE === "litellm" ? "litellm" : "anthropic");

export const SANDBOX_IMAGE =
  process.env.SANDBOX_IMAGE ?? "boss-man:sandbox";

export const CONTAINER_ENV: Record<string, string> = {
  // OpenAI-compatible endpoint for tools that need it
  OPENAI_BASE_URL: `http://host.docker.internal:${LITELLM_PORT}/v1`,
  OPENAI_API_KEY: LITELLM_API_KEY,
  ...(CLAUDE_AUTH_PROVIDER === "litellm"
    ? {
        ANTHROPIC_BASE_URL: `http://host.docker.internal:${LITELLM_PORT}`,
        ANTHROPIC_API_KEY: LITELLM_API_KEY,
      }
    : CLAUDE_CODE_OAUTH_TOKEN
      ? { CLAUDE_CODE_OAUTH_TOKEN }
      : {}),
  // Beads: API server callback URL (orchestrator calls the host server for bd ops)
  BOSS_MAN_API_URL: `http://host.docker.internal:${process.env.SERVER_PORT ?? "3001"}`,
  // Skip interactive permission prompts
  CLAUDE_CODE_UNSAFE_SKIP_PERMISSIONS: "1",
};

function claudeCredentialMounts() {
  if (CLAUDE_AUTH_PROVIDER !== "anthropic" || CLAUDE_CODE_AUTH_MODE !== "login" || CLAUDE_CODE_OAUTH_TOKEN) return [];
  const home = homedir();
  return [
    { hostPath: join(home, ".claude"), sandboxPath: "/home/agent/.claude" },
    { hostPath: join(home, ".claude.json"), sandboxPath: "/home/agent/.claude.json" },
  ].filter((mount) => existsSync(mount.hostPath));
}

export const dockerSandbox = docker({
  env: CONTAINER_ENV,
  imageName: SANDBOX_IMAGE,
  mounts: claudeCredentialMounts(),
});

// Hooks run inside each sandbox before the agent starts
export const sandboxHooks = {
  sandbox: {
    onSandboxReady: [
      // Run prismo doctor on project init to generate .claudeignore and context summaries
      { command: "npx getprismo doctor --quiet 2>/dev/null || true" },
      { command: "npm install 2>/dev/null || true" },
    ],
  },
};
