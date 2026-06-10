import {
  run as sandcastleRun,
  claudeCode,
  codex,
  opencode,
  getAbortMetadata,
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
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { updateRun, getRun, closeTask, listRuns, isRunActive, type Run } from './db.js';
import { pushEvent, broadcastEphemeral, cleanupRunStream } from './streaming.js';
import { maybeFoldSession } from './orchestrator-context.js';
import {
  CLAUDE_CODE_AUTH_MODE,
  CLAUDE_CODE_OAUTH_TOKEN,
  type ClaudeAuthProvider,
  CONTAINER_ENV,
  LITELLM_MASTER_KEY,
  SANDBOX_IMAGE,
  claudeAuthContainerEnv,
  PROMPTS_DIR,
  defaultModelForRole,
  resolveClaudeAuthProvider,
  resolveClaudeCodeModel,
  resolveTier,
} from './config.js';

const execFileAsync = promisify(execFile);

/**
 * Auto-close a run's task on success. Safety net — orchestrator should call
 * task_complete but may forget (crash, compaction, orphaned turn).
 */
function autoCloseTask(runId: string): void {
  const run = getRun(runId);
  if (!run?.beads_task_id) return;
  try {
    closeTask(run.beads_task_id, run.project_id);
    console.log(`[runner] auto-closed task ${run.beads_task_id} for run ${runId}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[runner] task auto-close failed for ${run.beads_task_id}: ${msg}`);
  }
}

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
  role: string;
  agentProvider?: string;
  claudeAuthProvider?: string;
  effort?: string;
  taskId?: string;
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

// Mechanical roles do narrow, well-specified work (write failing tests, make
// tests pass, apply a scoped refactor) that rarely benefits from extended
// thinking. Cap their thinking budget to cut token spend. Only Claude Code reads
// MAX_THINKING_TOKENS; it's a harmless no-op for codex/opencode.
const MECHANICAL_ROLES = new Set(['implementer', 'refactor', 'test_generator']);
const MECHANICAL_THINKING_TOKENS = '8000';

function getSandbox(
  provider: string,
  claudeAuthProvider: ClaudeAuthProvider,
  projectId: string,
  extraEnv?: Record<string, string>,
) {
  if (provider === 'docker') {
    const credMounts = claudeCredentialMounts(claudeAuthProvider);

    // No host ~/.claude mount (litellm, or anthropic + OAuth token) → persist the
    // session cache to a per-project host dir so sessions survive restarts.
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
    // Codex ignores MAX_THINKING_TOKENS; its reasoning lever is model_reasoning_effort.
    // Mirror the mechanical-role thinking cap by defaulting those roles to low effort.
    let e = effort as 'low' | 'medium' | 'high' | 'xhigh' | undefined;
    if (!e && MECHANICAL_ROLES.has(role)) e = 'low';
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

function getChangedFiles(repoPath: string, commits: { sha: string }[]): string[] {
  if (commits.length === 0) return [];
  const firstSha = commits[0].sha;
  const lastSha = commits.at(-1)!.sha;
  try {
    const raw = execFileSync(
      'git',
      ['-C', repoPath, 'diff', '--name-only', `${firstSha}^`, lastSha],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return raw.split('\n').filter(Boolean);
  } catch {
    // First commit has no parent — use diff-tree instead.
    try {
      const raw = execFileSync(
        'git',
        ['-C', repoPath, 'diff-tree', '--no-commit-id', '-r', '--name-only', lastSha],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      );
      return raw.split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }
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

/** Ensure HEAD exists (required by Sandcastle's branchStrategy). Fresh projects
 *  are empty repos → create a baseline commit. */
export async function ensureRepoHasHead(repoPath: string): Promise<void> {
  try {
    await execFileAsync('git', ['-C', repoPath, 'rev-parse', '--verify', 'HEAD']);
    return;
  } catch {
    // HEAD doesn't exist — fall through to create the initial commit.
  }

  await execFileAsync(
    'git',
    ['-C', repoPath, 'commit', '--allow-empty', '-m', 'chore: initial project commit'],
    {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? 'Boss Man',
        GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? 'boss-man@localhost',
        GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? 'Boss Man',
        GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? 'boss-man@localhost',
      },
    },
  );
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

const ROLE_LABELS: Record<string, string> = {
  test_generator: 'test generator',
  implementer: 'implementer',
  reviewer: 'reviewer',
  security_reviewer: 'security reviewer',
  researcher: 'researcher',
  refactor: 'refactor',
};

/**
 * Liveness text for an orchestrator that's gone quiet. Its own stream is silent
 * while it blocks on `spawn-worker --wait`, so name the active worker runs in its
 * project — that turns dead air into "the pipeline is moving, here's on what".
 * Sibling-by-project (not session-linked) is deliberately loose: it needs no
 * schema/spawn-worker changes and over-inclusion is harmless for a hint.
 */
function orchestratorWaitingStatus(
  projectId: string,
  orchestratorRunId: string,
  elapsedS: number,
): string {
  const workers = listRuns(projectId).filter(
    (r) => r.id !== orchestratorRunId && r.role !== 'orchestrator' && isRunActive(r),
  );
  if (workers.length === 0) return `Orchestrator working… (${elapsedS}s)`;

  const describe = (r: Run): string => {
    const label = ROLE_LABELS[r.role] ?? r.role;
    const name = r.name ? ` "${r.name}"` : '';
    const since = r.started_at ? ` (${Math.round((Date.now() - r.started_at) / 1000)}s)` : '';
    return `${label}${name}${since}`;
  };

  if (workers.length === 1) return `Waiting on worker — ${describe(workers[0])}`;
  return `Waiting on ${workers.length} workers — ${workers.map(describe).join('; ')}`;
}

export async function startRun(options: StartRunOptions): Promise<void> {
  const abortController = new AbortController();
  activeRuns.set(options.id, abortController);

  updateRun(options.id, { status: 'running', started_at: Date.now() });

  const claudeAuthProvider = resolveClaudeAuthProvider(options.claudeAuthProvider);
  const resolvedModel = resolveTier(options.model) || defaultModelForRole(options.role);
  const fullPrompt = buildPrompt(options.prompt, options.role);

  // MCP URL: base from CONTAINER_ENV; sessionId = orchestrator session (empty for
  // workers). The MCP server scopes tools by this: orchestrator gets the full set,
  // workers get only the read-only task_prime (see toolsForRequest in routes/mcp.ts).
  const sessionId = options.orchestratorSessionId ?? '';
  // apiKey authenticates the container to the gated /mcp endpoint (non-loopback via host.docker.internal).
  const mcpUrl = `${CONTAINER_ENV.BOSS_MAN_API_URL}/mcp?sessionId=${sessionId}&projectId=${encodeURIComponent(options.projectId)}&apiKey=${encodeURIComponent(LITELLM_MASTER_KEY)}`;

  // Writes the agent-specific MCP config inside the container. printf format string
  // avoids quoting issues — all values baked in, no shell expansion.
  function buildMcpHookCommand(provider: string): string {
    if (provider === 'codex') {
      return `mkdir -p /workspace/.codex && printf '[mcp_servers.boss-man]\\nurl = "%s"\\n' ${JSON.stringify(mcpUrl)} > /workspace/.codex/config.toml`;
    }
    if (provider === 'opencode') {
      const json = JSON.stringify({ mcp: { 'boss-man': { type: 'remote', url: mcpUrl } } });
      return `mkdir -p /workspace && printf '%s' ${JSON.stringify(json)} > /workspace/opencode.json`;
    }
    // Default: claude-code — .mcp.json in workspace root
    const json = JSON.stringify({ mcpServers: { 'boss-man': { url: mcpUrl } } });
    return `mkdir -p /workspace && printf '%s' ${JSON.stringify(json)} > /workspace/.mcp.json`;
  }

  const mcpHookCommand = buildMcpHookCommand(options.agentProvider ?? 'claude-code');

  // Liveness signals: forward Sandcastle stream events to run subscribers, plus
  // emit lifecycle statuses and a periodic heartbeat for silent gaps.
  const runStartedAt = Date.now();
  let lastActivityAt = runStartedAt;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const emitStatus = (text: string) =>
    broadcastEphemeral(options.id, { type: 'status', text, timestamp: new Date().toISOString() });

  try {
    emitStatus('Preparing sandbox…');
    // Heartbeat: while no real event has arrived recently, report that the agent
    // is alive and how long it's been working — turns the silent gap into signal.
    heartbeat = setInterval(() => {
      if (Date.now() - lastActivityAt < 12_000) return;
      const elapsedS = Math.round((Date.now() - runStartedAt) / 1000);
      // Orchestrator silence almost always means it's blocked on a worker — name it.
      const text = options.role === 'orchestrator'
        ? orchestratorWaitingStatus(options.projectId, options.id, elapsedS)
        : `Agent working… (${elapsedS}s)`;
      emitStatus(text);
    }, 15_000);

    await ensureRepoHasHead(options.repoPath);

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
        ...(MECHANICAL_ROLES.has(options.role) ? { MAX_THINKING_TOKENS: MECHANICAL_THINKING_TOKENS } : {}),
      }),
      cwd: options.repoPath,
      prompt: fullPrompt,
      maxIterations: options.maxIterations,
      branchStrategy: { type: 'branch', branch: options.branch },
      signal: abortController.signal,
      completionSignal: '<task-complete/>',
      // Grace window after completion signal — prevents zombies where a spawned
      // child (MCP server, git, gh) holds stdout open after the agent exits.
      completionTimeoutSeconds: 90,
      hooks: {
        sandbox: {
          onSandboxReady: [
            // RTK bash hook: rewrites Bash calls (`git status` → `rtk git status`),
            // saving 60-90% of tokens on dev commands. --hook-only (no CLAUDE.md
            // write) · --auto-patch (non-interactive).
            { command: 'rtk init -g --hook-only --auto-patch 2>/dev/null || true', timeoutMs: 10_000 },
            // MCP config so the agent reaches the boss-man server.
            { command: mcpHookCommand, timeoutMs: 5_000 },
          ],
        },
      },
      logging: {
        type: 'file',
        path: join(LOGS_DIR, `${options.id}.log`),
        onAgentStreamEvent: (event: AgentStreamEvent) => {
          const timestamp = new Date().toISOString();
          lastActivityAt = Date.now();
          if (event.type === 'text') {
            pushEvent(options.id, { type: 'text', text: event.message, iteration: event.iteration, timestamp });
          } else if (event.type === 'toolCall') {
            pushEvent(options.id, { type: 'toolCall', toolName: event.name, text: event.formattedArgs, iteration: event.iteration, timestamp });
          } else if (event.type === 'result') {
            pushEvent(options.id, { type: 'result', text: event.result, iteration: event.iteration, timestamp });
          } else if (event.type === 'sessionId') {
            // Persist mid-run so cancellations can resume warm (P8 #4 safety net).
            updateRun(options.id, { last_session_id: event.sessionId });
          }
        },
      },
    });

    const usage = sumUsage(result.iterations);
    const lastSession = result.iterations.at(-1)?.sessionId ?? null;

    const changedFiles = getChangedFiles(options.repoPath, result.commits);

    updateRun(options.id, {
      status: 'completed',
      completed_at: Date.now(),
      total_input_tokens: usage.inputTokens,
      total_output_tokens: usage.outputTokens,
      total_cache_creation_tokens: usage.cacheCreationTokens,
      total_cache_read_tokens: usage.cacheReadTokens,
      last_session_id: lastSession,
      changed_files: changedFiles.length > 0 ? JSON.stringify(changedFiles) : null,
    });

    autoCloseTask(options.id);

    // Server-owned rolling context (Option B): fold older turns into the session's
    // rolling summary so the next seeded prompt stays bounded. Orchestrator turns
    // only; best-effort, never blocks completion.
    if (options.role === 'orchestrator' && options.orchestratorSessionId) {
      maybeFoldSession(options.orchestratorSessionId).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[runner] maybeFoldSession failed for ${options.orchestratorSessionId}: ${msg}`);
      });
    }

    pushEvent(options.id, { type: 'done', timestamp: new Date().toISOString() });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      const abortMeta = getAbortMetadata(err);
      const lastSession = abortMeta?.iterations.at(-1)?.sessionId ?? null;
      updateRun(options.id, {
        status: 'cancelled',
        completed_at: Date.now(),
        ...(lastSession ? { last_session_id: lastSession } : {}),
      });
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      const error = runFailureMessage(msg);
      updateRun(options.id, { status: 'failed', completed_at: Date.now(), error });
      pushEvent(options.id, { type: 'error', text: error, timestamp: new Date().toISOString() });
    }
  } finally {
    clearInterval(heartbeat);
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
