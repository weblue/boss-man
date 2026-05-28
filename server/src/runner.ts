import {
  run as sandcastleRun,
  claudeCode,
  codex,
  opencode,
  type AgentProvider,
  type AgentStreamEvent,
  type IterationUsage,
} from '@ai-hero/sandcastle';
import { docker } from '@ai-hero/sandcastle/sandboxes/docker';
import { noSandbox } from '@ai-hero/sandcastle/sandboxes/no-sandbox';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { updateRun } from './db.js';
import { pushEvent, cleanupRunStream } from './streaming.js';
import {
  CONTAINER_ENV,
  SANDBOX_IMAGE,
  PROMPTS_DIR,
  defaultModelForRole,
  resolveTier,
} from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = join(__dirname, '..', '..', 'data', 'logs');
mkdirSync(LOGS_DIR, { recursive: true });

const activeRuns = new Map<string, AbortController>();

export interface StartRunOptions {
  id: string;
  projectId: string;
  repoPath: string;
  prompt: string;
  model: string;
  sandboxProvider: 'docker' | 'no-sandbox';
  branch: string;
  maxIterations: number;
  name?: string;
  resumeSessionId?: string;
  role: string;
  agentProvider?: string;
  effort?: string;
  beadsTaskId?: string;
}

const WORKER_PROMPT_FILES: Record<string, string> = {
  test_generator: 'test_generator.md',
  implementer: 'implementer.md',
  reviewer: 'reviewer.md',
  security_reviewer: 'security_reviewer.md',
  researcher: 'researcher.md',
  refactor: 'refactor.md',
};

function buildPrompt(prompt: string, role: string): string {
  const file = WORKER_PROMPT_FILES[role];
  if (!file) return prompt;
  const templatePath = join(PROMPTS_DIR, 'workers', file);
  if (!existsSync(templatePath)) return prompt;
  const template = readFileSync(templatePath, 'utf8').trimEnd();
  return template.replace(/\{\{USER_TASK\}\}/g, prompt);
}

function getSandbox(provider: string) {
  if (provider === 'docker') return docker({ env: CONTAINER_ENV, imageName: SANDBOX_IMAGE });
  return noSandbox();
}

function getAgentProvider(agentProvider: string, model: string, role: string, effort?: string): AgentProvider {
  const resolvedModel = resolveTier(model) || defaultModelForRole(role);
  const shortLivedRoles = new Set(['reviewer', 'security_reviewer', 'researcher', 'test_generator']);

  if (agentProvider === 'codex') {
    const e = effort as 'low' | 'medium' | 'high' | 'xhigh' | undefined;
    return codex(resolvedModel, { ...(e ? { effort: e } : {}) });
  }
  if (agentProvider === 'opencode') {
    return opencode(resolvedModel);
  }
  // Default: claude-code
  const e = effort as 'low' | 'medium' | 'high' | 'max' | undefined;
  return claudeCode(resolvedModel, {
    ...(e ? { effort: e } : {}),
    captureSessions: !shortLivedRoles.has(role),
  });
}

function sumUsage(iterations: readonly { usage?: IterationUsage }[]) {
  return iterations.reduce(
    (acc, iter) => {
      const u = iter.usage;
      if (!u) return acc;
      return {
        inputTokens: acc.inputTokens + (u.inputTokens ?? 0),
        outputTokens: acc.outputTokens + (u.outputTokens ?? 0),
        cacheCreationTokens: acc.cacheCreationTokens + (u.cacheCreationInputTokens ?? 0),
        cacheReadTokens: acc.cacheReadTokens + (u.cacheReadInputTokens ?? 0),
      };
    },
    { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
  );
}

export async function startRun(options: StartRunOptions): Promise<void> {
  const abortController = new AbortController();
  activeRuns.set(options.id, abortController);

  updateRun(options.id, { status: 'running', started_at: Date.now() });

  const resolvedModel = resolveTier(options.model) || defaultModelForRole(options.role);
  const fullPrompt = buildPrompt(options.prompt, options.role);

  try {
    const result = await sandcastleRun({
      agent: getAgentProvider(
        options.agentProvider ?? 'claude-code',
        resolvedModel,
        options.role,
        options.effort,
      ),
      sandbox: getSandbox(options.sandboxProvider),
      cwd: options.repoPath,
      prompt: fullPrompt,
      maxIterations: options.maxIterations,
      branchStrategy: { type: 'branch', branch: options.branch },
      resumeSession: options.resumeSessionId,
      signal: abortController.signal,
      completionSignal: '<task-complete/>',
      logging: {
        type: 'file',
        path: join(LOGS_DIR, `${options.id}.log`),
        onAgentStreamEvent: (event: AgentStreamEvent) => {
          const timestamp = new Date().toISOString();
          if (event.type === 'text') {
            pushEvent(options.id, { type: 'text', text: event.message, iteration: event.iteration, timestamp });
          } else if (event.type === 'toolCall') {
            pushEvent(options.id, { type: 'toolCall', toolName: event.name, text: event.formattedArgs, iteration: event.iteration, timestamp });
          }
        },
      },
    });

    const usage = sumUsage(result.iterations);
    const lastSession = result.iterations.at(-1)?.sessionId ?? null;

    updateRun(options.id, {
      status: 'completed',
      completed_at: Date.now(),
      total_input_tokens: usage.inputTokens,
      total_output_tokens: usage.outputTokens,
      total_cache_creation_tokens: usage.cacheCreationTokens,
      total_cache_read_tokens: usage.cacheReadTokens,
      last_session_id: lastSession,
    });

    pushEvent(options.id, { type: 'done', timestamp: new Date().toISOString() });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      updateRun(options.id, { status: 'cancelled', completed_at: Date.now() });
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      updateRun(options.id, { status: 'failed', completed_at: Date.now(), error: msg });
      pushEvent(options.id, { type: 'error', text: msg, timestamp: new Date().toISOString() });
    }
  } finally {
    activeRuns.delete(options.id);
    cleanupRunStream(options.id);
  }
}

export function cancelRun(id: string): boolean {
  const ctrl = activeRuns.get(id);
  if (!ctrl) return false;
  ctrl.abort();
  return true;
}
