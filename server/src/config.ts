import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const PROJECTS_DIR = join(__dirname, '..', '..', 'projects');
export const PROMPTS_DIR = join(__dirname, '..', '..', 'prompts');

export const LITELLM_HOST = process.env.LITELLM_HOST ?? '127.0.0.1';
export const LITELLM_PORT = process.env.LITELLM_PORT ?? '4000';
export const LITELLM_API_KEY =
  process.env.LITELLM_MASTER_KEY ?? 'sk-boss-man-master-key-change-me';

export const SERVER_PORT = parseInt(process.env.SERVER_PORT ?? '3001', 10);
export const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE ?? 'boss-man:sandbox';

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

export const CONTAINER_ENV: Record<string, string> = {
  ANTHROPIC_BASE_URL: `http://host.docker.internal:${LITELLM_PORT}`,
  ANTHROPIC_API_KEY: LITELLM_API_KEY,
  OPENAI_BASE_URL: `http://host.docker.internal:${LITELLM_PORT}/v1`,
  OPENAI_API_KEY: LITELLM_API_KEY,
  BOSS_MAN_API_URL: `http://host.docker.internal:${SERVER_PORT}`,
  CLAUDE_CODE_UNSAFE_SKIP_PERMISSIONS: '1',
};
