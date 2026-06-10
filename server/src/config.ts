import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const PROJECTS_DIR = join(__dirname, '..', '..', 'projects');
export const PROMPTS_DIR = join(__dirname, '..', '..', 'prompts');

export const LITELLM_HOST = process.env.LITELLM_HOST ?? '127.0.0.1';
export const LITELLM_PORT = process.env.LITELLM_PORT ?? '4000';
export const LITELLM_MASTER_KEY = process.env.LITELLM_MASTER_KEY ?? '';
export const LITELLM_API_KEY = process.env.LITELLM_API_KEY ?? LITELLM_MASTER_KEY;
export const CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? '';

/**
 * Boot-time auth mode (set by start.sh).
 * 'claude'  — agent locked to claude-code; no ANTHROPIC_BASE_URL/KEY injected →
 *             claude-code auths via subscription (~/.claude or OAuth token).
 * 'litellm' — all calls route through LiteLLM proxy; ANTHROPIC+OPENAI base/key
 *             injected → any harness can use the proxy. Agent unrestricted.
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

// Drives credential mounting in runner.ts. Derived from BOSS_MAN_AUTH_MODE; .env can override.
export const CLAUDE_CODE_AUTH_MODE: 'login' | 'litellm' =
  (process.env.CLAUDE_CODE_AUTH_MODE as 'login' | 'litellm' | undefined)
  ?? (BOSS_MAN_AUTH_MODE === 'litellm' ? 'litellm' : 'login');

export type ClaudeAuthProvider = 'anthropic' | 'litellm';

export function resolveClaudeAuthProvider(provider?: string | null): ClaudeAuthProvider {
  if (provider === 'litellm') return 'litellm';
  if (provider === 'anthropic') return 'anthropic';
  return BOSS_MAN_AUTH_MODE === 'litellm' ? 'litellm' : 'anthropic';
}

export const SERVER_PORT = parseInt(process.env.SERVER_PORT ?? '8771', 10);
// Optional external origin allowed through CORS (e.g. https://mediachung.us).
// Localhost is always allowed. Leave empty for localhost-only access.
export const BOSS_MAN_ALLOWED_ORIGIN = process.env.BOSS_MAN_ALLOWED_ORIGIN ?? '';
export const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE ?? 'boss-man:sandbox';
export const DEFAULT_AGENT_PROVIDER = process.env.DEFAULT_AGENT_PROVIDER ?? 'claude-code';
export const DEFAULT_AGENT_MODEL = process.env.DEFAULT_AGENT_MODEL;

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
  // Accept either a tier key ('high') or a LiteLLM tier alias ('boss-man/high').
  const roleTier = ROLE_TIERS[role] ?? 'medium';
  const reverseMatch = Object.entries(MODEL_TIERS).find(([, value]) => value === modelOrTier);
  const tier = (modelOrTier in MODEL_TIERS ? modelOrTier : reverseMatch?.[0]) as ModelTier | undefined;
  if (tier) return CLAUDE_CODE_MODEL_TIERS[tier];
  // Direct Claude model ids (e.g. 'claude-sonnet-4-6') pass through to claude-code.
  // Anything else (LiteLLM-only models like 'local-worker') can't run on
  // subscription auth — fall back to the role's tier.
  if (modelOrTier.startsWith('claude') || ['opus', 'sonnet', 'haiku'].includes(modelOrTier)) {
    return modelOrTier;
  }
  return CLAUDE_CODE_MODEL_TIERS[roleTier];
}

export function claudeAuthContainerEnv(provider: ClaudeAuthProvider): Record<string, string> {
  if (provider === 'litellm') {
    // Both ANTHROPIC + OPENAI vars point at LiteLLM so any harness finds its base URL.
    return {
      ANTHROPIC_BASE_URL: `http://host.docker.internal:${LITELLM_PORT}`,
      ANTHROPIC_API_KEY: LITELLM_API_KEY,
      OPENAI_BASE_URL: `http://host.docker.internal:${LITELLM_PORT}/v1`,
      OPENAI_API_KEY: LITELLM_API_KEY,
      // TODO: add vars for extra harnesses (pi, etc.) when configured
    };
  }

  // Claude mode: no base/key vars → claude-code uses subscription auth, not API billing.
  return CLAUDE_CODE_OAUTH_TOKEN ? { CLAUDE_CODE_OAUTH_TOKEN } : {};
}

// Base sandbox env — auth vars are added separately via claudeAuthContainerEnv.
export const CONTAINER_ENV: Record<string, string> = {
  BOSS_MAN_API_URL: `http://host.docker.internal:${SERVER_PORT}`,
  // Authenticates spawn-worker → /api/* through the non-loopback auth gate.
  // (On Docker Desktop container traffic arrives as loopback and is exempt,
  // but on Linux it arrives from the bridge network and needs the key.)
  BOSS_MAN_API_KEY: LITELLM_MASTER_KEY,
  CLAUDE_CODE_UNSAFE_SKIP_PERMISSIONS: '1',
};
