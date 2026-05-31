import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const PROJECTS_DIR = join(__dirname, '..', '..', 'projects');
export const PROMPTS_DIR = join(__dirname, '..', '..', 'prompts');

export const LITELLM_HOST = process.env.LITELLM_HOST ?? '127.0.0.1';
export const LITELLM_PORT = process.env.LITELLM_PORT ?? '4000';
export const LITELLM_MASTER_KEY =
  process.env.LITELLM_MASTER_KEY ?? 'sk-boss-man-master-key-change-me';
export const LITELLM_API_KEY =
  process.env.LITELLM_API_KEY ?? LITELLM_MASTER_KEY;
export const CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? '';

/**
 * Boot-time authentication mode set by start.sh.
 *
 * 'claude'  — All tiers use native Claude models. claude-code is locked as the
 *             agent and NO ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY are injected
 *             into the sandbox, so claude-code authenticates directly through
 *             the Claude subscription (~/.claude or CLAUDE_CODE_OAUTH_TOKEN).
 *
 * 'litellm' — All tiers route through the LiteLLM proxy (local models, OpenAI,
 *             etc.). Both ANTHROPIC_BASE_URL/KEY and OPENAI_BASE_URL/KEY are
 *             injected pointing at LiteLLM, so any harness (claude-code, codex,
 *             opencode, …) can route through the proxy. Agent is unrestricted.
 */
export const BOSS_MAN_AUTH_MODE: 'claude' | 'litellm' = (() => {
  const raw = process.env.BOSS_MAN_AUTH_MODE;
  if (raw && raw !== 'claude' && raw !== 'litellm') {
    console.warn(
      `[config] Unrecognized BOSS_MAN_AUTH_MODE="${raw}" — expected "claude" or "litellm". Falling back to "claude".`,
    );
  }
  return raw === 'litellm' ? 'litellm' : 'claude';
})();

// CLAUDE_CODE_AUTH_MODE drives credential mounting in runner.ts.
// Derived from BOSS_MAN_AUTH_MODE; can be overridden via .env if needed.
export const CLAUDE_CODE_AUTH_MODE: 'login' | 'litellm' =
  (process.env.CLAUDE_CODE_AUTH_MODE as 'login' | 'litellm' | undefined)
  ?? (BOSS_MAN_AUTH_MODE === 'litellm' ? 'litellm' : 'login');

export type ClaudeAuthProvider = 'anthropic' | 'litellm';

export function resolveClaudeAuthProvider(provider?: string | null): ClaudeAuthProvider {
  if (provider === 'litellm') return 'litellm';
  if (provider === 'anthropic') return 'anthropic';
  return BOSS_MAN_AUTH_MODE === 'litellm' ? 'litellm' : 'anthropic';
}

export const SERVER_PORT = parseInt(process.env.SERVER_PORT ?? '3001', 10);
export const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE ?? 'boss-man:sandbox';
export const DEFAULT_AGENT_PROVIDER = process.env.DEFAULT_AGENT_PROVIDER ?? 'claude-code';
export const DEFAULT_AGENT_MODEL = process.env.DEFAULT_AGENT_MODEL;

export const LANGFUSE_SECRET_KEY = process.env.LANGFUSE_SECRET_KEY ?? '';
export const LANGFUSE_PUBLIC_KEY = process.env.LANGFUSE_PUBLIC_KEY ?? '';
export const LANGFUSE_HOST = process.env.LANGFUSE_HOST ?? 'http://localhost:3000';

export const BEADS_STORE_HOST = process.env.BEADS_STORE_HOST ?? '127.0.0.1';
export const BEADS_STORE_PORT = process.env.BEADS_STORE_PORT ?? '3306';
export const BEADS_STORE_PASSWORD = process.env.BEADS_STORE_PASSWORD ?? '';

// Model tier → LiteLLM alias mapping
export const MODEL_TIERS = {
  high: 'boss-man/high',
  medium: 'boss-man/medium',
  low: 'boss-man/low',
} as const;

export type ModelTier = keyof typeof MODEL_TIERS;

// In Claude mode, these are the --model values passed to claude-code per tier.
// Exported from start.sh via CLAUDE_CODE_HIGH/MEDIUM/LOW_MODEL env vars.
export const CLAUDE_CODE_MODEL_TIERS: Record<ModelTier, string> = {
  high: process.env.CLAUDE_CODE_HIGH_MODEL ?? 'opus',
  medium: process.env.CLAUDE_CODE_MEDIUM_MODEL ?? 'sonnet',
  low: process.env.CLAUDE_CODE_LOW_MODEL ?? 'haiku',
};

export function resolveTier(modelOrTier: string): string {
  if (modelOrTier in MODEL_TIERS) {
    return MODEL_TIERS[modelOrTier as ModelTier];
  }
  return modelOrTier;
}

// Role → model tier mapping
export const ROLE_TIERS: Record<string, ModelTier> = {
  orchestrator: 'high',
  reviewer: 'high',
  security_reviewer: 'high',
  implementer: 'medium',
  test_generator: 'medium',
  researcher: 'medium',
  refactor: 'low',
};

export function defaultModelForRole(role: string): string {
  const tier = ROLE_TIERS[role] ?? 'medium';
  return MODEL_TIERS[tier];
}

export function resolveClaudeCodeModel(modelOrTier: string, role: string): string {
  const roleTier = ROLE_TIERS[role] ?? 'medium';
  const tierEntry = Object.entries(MODEL_TIERS).find(([, value]) => value === modelOrTier);
  const tier = (modelOrTier in MODEL_TIERS ? modelOrTier : tierEntry?.[0]) as ModelTier | undefined;
  return tier ? CLAUDE_CODE_MODEL_TIERS[tier] : CLAUDE_CODE_MODEL_TIERS[roleTier] ?? modelOrTier;
}

export function claudeAuthContainerEnv(provider: ClaudeAuthProvider): Record<string, string> {
  if (provider === 'litellm') {
    // LiteLLM mode: route all LLM calls through the proxy.
    // Both ANTHROPIC and OPENAI env vars are set to the same LiteLLM endpoint
    // so that any harness (claude-code, codex, opencode, pi, …) can find the
    // correct base URL regardless of its convention.
    return {
      ANTHROPIC_BASE_URL: `http://host.docker.internal:${LITELLM_PORT}`,
      ANTHROPIC_API_KEY: LITELLM_API_KEY,
      OPENAI_BASE_URL: `http://host.docker.internal:${LITELLM_PORT}/v1`,
      OPENAI_API_KEY: LITELLM_API_KEY,
      // TODO: add env vars for any additional harness (pi, etc.) when configured
    };
  }

  // Claude mode: do NOT set ANTHROPIC_BASE_URL or ANTHROPIC_API_KEY.
  // claude-code authenticates directly via ~/.claude or CLAUDE_CODE_OAUTH_TOKEN,
  // using the Claude subscription rather than API key billing.
  return CLAUDE_CODE_OAUTH_TOKEN ? { CLAUDE_CODE_OAUTH_TOKEN } : {};
}

// Base sandbox env — auth vars are added separately via claudeAuthContainerEnv.
export const CONTAINER_ENV: Record<string, string> = {
  BOSS_MAN_API_URL: `http://host.docker.internal:${SERVER_PORT}`,
  CLAUDE_CODE_UNSAFE_SKIP_PERMISSIONS: '1',
};
