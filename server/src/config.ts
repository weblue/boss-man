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
export const CLAUDE_CODE_AUTH_MODE =
  process.env.CLAUDE_CODE_AUTH_MODE ?? (process.env.ANTHROPIC_API_KEY ? 'litellm' : 'login');
export type ClaudeAuthProvider = 'anthropic' | 'litellm';

export function resolveClaudeAuthProvider(provider?: string | null): ClaudeAuthProvider {
  if (provider === 'litellm') return 'litellm';
  if (provider === 'anthropic') return 'anthropic';
  return CLAUDE_CODE_AUTH_MODE === 'litellm' ? 'litellm' : 'anthropic';
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

export const CLAUDE_CODE_MODEL_TIERS: Record<ModelTier, string> = {
  high: process.env.CLAUDE_CODE_HIGH_MODEL ?? 'opus',
  medium: process.env.CLAUDE_CODE_MEDIUM_MODEL ?? 'sonnet',
  low: process.env.CLAUDE_CODE_LOW_MODEL ?? 'sonnet',
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

const LITELLM_CONTAINER_ENV: Record<string, string> = {
  OPENAI_BASE_URL: `http://host.docker.internal:${LITELLM_PORT}/v1`,
  OPENAI_API_KEY: LITELLM_API_KEY,
};

export function claudeAuthContainerEnv(provider: ClaudeAuthProvider): Record<string, string> {
  if (provider === 'litellm') {
    return {
      ANTHROPIC_BASE_URL: `http://host.docker.internal:${LITELLM_PORT}`,
      ANTHROPIC_API_KEY: LITELLM_API_KEY,
    };
  }

  return CLAUDE_CODE_OAUTH_TOKEN
    ? { CLAUDE_CODE_OAUTH_TOKEN }
    : {};
}

export const CONTAINER_ENV: Record<string, string> = {
  ...LITELLM_CONTAINER_ENV,
  BOSS_MAN_API_URL: `http://host.docker.internal:${SERVER_PORT}`,
  CLAUDE_CODE_UNSAFE_SKIP_PERMISSIONS: '1',
};
