/**
 * Sandcastle SDK entry point for batch / automated runs.
 * Used by the server runner when spinning up sandboxed worker agents.
 * Interactive orchestrator sessions are managed separately via Docker exec + tmux.
 *
 * Usage: npx tsx sandcastle/main.mts (not called directly — server runner imports this config)
 */

import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

const LITELLM_PORT = process.env.LITELLM_PORT ?? "4000";
const LITELLM_API_KEY =
  process.env.LITELLM_MASTER_KEY ?? "sk-boss-man-master-key-change-me";

export const SANDBOX_IMAGE =
  process.env.SANDBOX_IMAGE ?? "boss-man:sandbox";

export const CONTAINER_ENV: Record<string, string> = {
  // Claude Code routes through LiteLLM for all model access
  ANTHROPIC_BASE_URL: `http://host.docker.internal:${LITELLM_PORT}`,
  ANTHROPIC_API_KEY: LITELLM_API_KEY,
  // OpenAI-compatible endpoint for tools that need it
  OPENAI_BASE_URL: `http://host.docker.internal:${LITELLM_PORT}/v1`,
  OPENAI_API_KEY: LITELLM_API_KEY,
  // Beads: API server callback URL (orchestrator calls the host server for bd ops)
  BOSS_MAN_API_URL: `http://host.docker.internal:${process.env.SERVER_PORT ?? "3001"}`,
  // Skip interactive permission prompts
  CLAUDE_CODE_UNSAFE_SKIP_PERMISSIONS: "1",
};

export const dockerSandbox = docker({
  env: CONTAINER_ENV,
  imageName: SANDBOX_IMAGE,
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
