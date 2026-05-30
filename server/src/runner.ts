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
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { updateRun } from './db.js';
import { pushEvent, cleanupRunStream } from './streaming.js';
import {
  CLAUDE_CODE_AUTH_MODE,
  CLAUDE_CODE_OAUTH_TOKEN,
  type ClaudeAuthProvider,
  CONTAINER_ENV,
  SANDBOX_IMAGE,
  claudeAuthContainerEnv,
  PROMPTS_DIR,
  defaultModelForRole,
  resolveClaudeAuthProvider,
  resolveClaudeCodeModel,
  resolveTier,
} from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');
const LOGS_DIR = join(DATA_DIR, 'logs');
const SESSIONS_DIR = join(DATA_DIR, 'claude-sessions');
mkdirSync(LOGS_DIR, { recursive: true });
mkdirSync(SESSIONS_DIR, { recursive: true });

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
  claudeAuthProvider?: string;
  effort?: string;
  beadsTaskId?: string;
  /** Orchestrator session ID — injected as BOSS_MAN_SESSION_ID so the agent can PATCH its own status. */
  orchestratorSessionId?: string;
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

function claudeCredentialMounts(provider: ClaudeAuthProvider) {
  if (provider !== 'anthropic' || CLAUDE_CODE_AUTH_MODE !== 'login' || CLAUDE_CODE_OAUTH_TOKEN) return [];
  const home = homedir();
  return [
    { hostPath: join(home, '.claude'), sandboxPath: '/home/agent/.claude' },
    { hostPath: join(home, '.claude.json'), sandboxPath: '/home/agent/.claude.json' },
  ].filter((mount) => existsSync(mount.hostPath));
}

function getSandbox(
  provider: string,
  claudeAuthProvider: ClaudeAuthProvider,
  projectId: string,
  extraEnv?: Record<string, string>,
) {
  if (provider === 'docker') {
    const credMounts = claudeCredentialMounts(claudeAuthProvider);

    // When not mounting the host ~/.claude (litellm backend, or anthropic with an
    // explicit OAuth token), persist Claude Code's session cache to a per-project
    // host directory so conversation sessions survive container and server restarts.
    const sessionMounts: typeof credMounts = [];
    if (credMounts.length === 0) {
      const sessionDir = join(SESSIONS_DIR, projectId);
      mkdirSync(sessionDir, { recursive: true });
      sessionMounts.push({ hostPath: sessionDir, sandboxPath: '/home/agent/.claude' });
    }

    return docker({
      env: { ...CONTAINER_ENV, ...claudeAuthContainerEnv(claudeAuthProvider), ...extraEnv },
      imageName: SANDBOX_IMAGE,
      mounts: [...credMounts, ...sessionMounts],
    });
  }
  return noSandbox();
}

function getAgentProvider(
  agentProvider: string,
  model: string,
  role: string,
  effort: string | undefined,
  claudeAuthProvider: ClaudeAuthProvider,
): AgentProvider {
  const shortLivedRoles = new Set(['reviewer', 'security_reviewer', 'researcher', 'test_generator']);

  if (agentProvider === 'codex') {
    const resolvedModel = resolveTier(model) || defaultModelForRole(role);
    const e = effort as 'low' | 'medium' | 'high' | 'xhigh' | undefined;
    return codex(resolvedModel, { ...(e ? { effort: e } : {}) });
  }
  if (agentProvider === 'opencode') {
    const resolvedModel = resolveTier(model) || defaultModelForRole(role);
    return opencode(resolvedModel);
  }
  // Default: claude-code
  const resolvedModel = claudeAuthProvider === 'litellm'
    ? (resolveTier(model) || defaultModelForRole(role))
    : resolveClaudeCodeModel(model, role);
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

export function ensureRepoHasHead(repoPath: string): void {
  try {
    execFileSync('git', ['-C', repoPath, 'rev-parse', '--verify', 'HEAD'], { stdio: 'ignore' });
    return;
  } catch {
    // Sandcastle branchStrategy needs HEAD. Fresh dashboard-created projects
    // start as empty git repos, so create a harmless baseline commit.
  }

  execFileSync('git', ['-C', repoPath, 'commit', '--allow-empty', '-m', 'chore: initial project commit'], {
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? 'Boss Man',
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? 'boss-man@localhost',
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? 'Boss Man',
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? 'boss-man@localhost',
    },
  });
}

function runFailureMessage(message: string): string {
  if (message.includes('Image') && message.includes('not found locally')) {
    return [
      message,
      '',
      'Run marked failed because the sandbox Docker image is missing. Run ./install.sh to build it, then start a new session to retry.',
    ].join('\n');
  }

  return [
    message,
    '',
    'Run marked failed. Start a new session, or send another reply after the current session is no longer running, to retry.',
  ].join('\n');
}

export async function startRun(options: StartRunOptions): Promise<void> {
  const abortController = new AbortController();
  activeRuns.set(options.id, abortController);

  updateRun(options.id, { status: 'running', started_at: Date.now() });

  const claudeAuthProvider = resolveClaudeAuthProvider(options.claudeAuthProvider);
  const resolvedModel = resolveTier(options.model) || defaultModelForRole(options.role);
  const fullPrompt = buildPrompt(options.prompt, options.role);

  try {
    ensureRepoHasHead(options.repoPath);

    const result = await sandcastleRun({
      agent: getAgentProvider(
        options.agentProvider ?? 'claude-code',
        resolvedModel,
        options.role,
        options.effort,
        claudeAuthProvider,
      ),
      sandbox: getSandbox(options.sandboxProvider, claudeAuthProvider, options.projectId, {
        BOSS_MAN_PROJECT_ID: options.projectId,
        BOSS_MAN_CLAUDE_AUTH_PROVIDER: claudeAuthProvider,
        ...(options.orchestratorSessionId ? { BOSS_MAN_SESSION_ID: options.orchestratorSessionId } : {}),
      }),
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
      const error = runFailureMessage(msg);
      updateRun(options.id, { status: 'failed', completed_at: Date.now(), error });
      pushEvent(options.id, { type: 'error', text: error, timestamp: new Date().toISOString() });
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
