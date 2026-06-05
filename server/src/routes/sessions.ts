import { Hono } from 'hono';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { v4 as uuidv4 } from 'uuid';
import {
  insertSession, getSession, listSessions, updateSession, deleteSession,
  insertRun, getRun, getProject, listSessionRuns,
  type OrchestratorSession,
} from '../db.js';
import { startRun } from '../runner.js';
import { validateResumeSession } from '../session-utils.js';
import { getPersistedEvents, subscribe, type AgentEvent } from '../streaming.js';
import {
  BOSS_MAN_AUTH_MODE,
  DEFAULT_AGENT_PROVIDER,
  DEFAULT_AGENT_MODEL,
  defaultModelForRole,
  PROMPTS_DIR,
  type ClaudeAuthProvider,
} from '../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const router = new Hono();
const VALID_AGENT_PROVIDERS = new Set(['claude-code', 'codex', 'opencode']);

/** Run statuses that will never emit another event — used to close SSE streams immediately. */
const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled']);

/** Per-session lock to prevent double-submit races on /reply.
 *  A concurrent request arriving while a reply is being processed gets a 409. */
const replyLocks = new Set<string>();

/**
 * If accumulated cache tokens for a session exceed this threshold, prepend a
 * summarization notice to the next reply prompt so the orchestrator writes a
 * compact checkpoint.md before continuing. This breaks the unbounded growth
 * of the Claude Code session JSONL that gets re-read in full on every reply turn.
 */
const SESSION_SUMMARIZE_THRESHOLD_TOKENS = 60_000;

function buildSummarizeNotice(tokenCount: number): string {
  const tokenK = Math.round(tokenCount / 1000);
  return (
    `[Context monitor: ~${tokenK}K tokens have accumulated in this session's history. ` +
    `Before addressing the message below, update /workspace/.spec/checkpoint.md ` +
    `(current phase, completed/pending tasks, key decisions) and commit it. ` +
    `See "Context monitor" in your system instructions.]\n\n---\n\n`
  );
}

interface SessionRuntime {
  agentProvider: string;
  claudeAuthProvider: string;
  model: string;
}

// Memoized at module load — the orchestrator prompt is static for the lifetime
// of the process and is called on every session start and compact turn.
const _orchestratorPrompt: string = (() => {
  const path = join(PROMPTS_DIR, 'orchestrator.md');
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf8').trimEnd();
})();

function loadOrchestratorPrompt(): string {
  return _orchestratorPrompt;
}

function buildFirstTurnPrompt(userMessage: string): string {
  const base = loadOrchestratorPrompt();
  return base
    ? `${base}\n\n---\n\n## User's Initial Request\n\n${userMessage}`
    : userMessage;
}

function runtimeFromBody(body: Record<string, unknown> | null, fallback?: SessionRuntime): SessionRuntime {
  const requestedProvider = typeof body?.agentProvider === 'string' ? body.agentProvider : undefined;
  const requestedModel = typeof body?.model === 'string' && body.model.trim() ? body.model.trim() : undefined;

  // Auth mode is determined at boot time (start.sh), not per-session:
  //   'claude'  → lock agent to claude-code; native subscription auth (no env overrides)
  //   'litellm' → agent is unrestricted; all calls route through LiteLLM proxy
  const claudeAuthProvider: ClaudeAuthProvider = BOSS_MAN_AUTH_MODE === 'litellm' ? 'litellm' : 'anthropic';
  const agentProvider = BOSS_MAN_AUTH_MODE === 'claude'
    ? 'claude-code'
    : (requestedProvider && VALID_AGENT_PROVIDERS.has(requestedProvider)
        ? requestedProvider
        : fallback?.agentProvider ?? DEFAULT_AGENT_PROVIDER);

  return {
    agentProvider,
    claudeAuthProvider,
    model: requestedModel ?? fallback?.model ?? DEFAULT_AGENT_MODEL ?? defaultModelForRole('orchestrator'),
  };
}

function makeRun(
  projectId: string,
  sessionId: string,
  prompt: string,
  branch: string,
  name: string,
  runtime: SessionRuntime,
  maxIterations = 50,
) {
  const id = uuidv4();
  insertRun({
    id,
    project_id: projectId,
    name,
    role: 'orchestrator',
    status: 'queued',
    prompt,
    model: runtime.model,
    agent_provider: runtime.agentProvider,
    claude_auth_provider: runtime.claudeAuthProvider,
    orchestrator_session_id: sessionId,
    sandbox_provider: 'docker',
    branch,
    max_iterations: maxIterations,
    created_at: Date.now(),
    started_at: null,
    completed_at: null,
    error: null,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cache_creation_tokens: 0,
    total_cache_read_tokens: 0,
    last_session_id: null,
    langfuse_trace_id: null,
    beads_task_id: null,
    changed_files: null,
  });
  return id;
}

// POST /api/projects/:projectId/sessions — start orchestrator session
router.post('/api/projects/:projectId/sessions', async (c) => {
  const projectId = c.req.param('projectId');
  const project = getProject(projectId);
  if (!project) return c.json({ error: 'Project not found' }, 404);

  const body = await c.req.json().catch(() => null);
  if (!body?.message) return c.json({ error: 'message is required' }, 400);

  const sessionId = uuidv4();
  const branch = `orchestrator/${sessionId.slice(0, 8)}`;
  const runtime = runtimeFromBody(body);

  // Build the full prompt (with orchestrator system prompt) before storing the run,
  // so the DB record reflects what the agent actually received.
  const fullPrompt = buildFirstTurnPrompt(body.message);
  const runId = makeRun(projectId, sessionId, fullPrompt, branch, 'Orchestrator — turn 1', runtime);

  const session: OrchestratorSession = {
    id: sessionId,
    project_id: projectId,
    name: body.name ?? null,
    status: 'discovery',
    current_run_id: runId,
    created_at: Date.now(),
  };
  insertSession(session);

  startRun({
    id: runId,
    projectId,
    repoPath: project.repo_path,
    prompt: fullPrompt,
    model: runtime.model,
    sandboxProvider: 'docker',
    branch,
    maxIterations: 50,
    name: 'Orchestrator — turn 1',
    role: 'orchestrator',
    agentProvider: runtime.agentProvider,
    claudeAuthProvider: runtime.claudeAuthProvider,
    orchestratorSessionId: sessionId,
  }).catch(console.error);

  return c.json({ session: getSession(sessionId), run: getRun(runId) }, 201);
});

// GET /api/projects/:projectId/sessions — list sessions
router.get('/api/projects/:projectId/sessions', (c) => {
  const projectId = c.req.param('projectId');
  if (!getProject(projectId)) return c.json({ error: 'Project not found' }, 404);
  return c.json(listSessions(projectId));
});

// GET /api/sessions/:id — get session with current run
router.get('/api/sessions/:id', (c) => {
  const session = getSession(c.req.param('id'));
  if (!session) return c.json({ error: 'Not found' }, 404);
  const currentRun = session.current_run_id ? getRun(session.current_run_id) : null;
  return c.json({ ...session, currentRun, runs: listSessionRuns(session.id) });
});

router.get('/api/sessions/:id/transcript', (c) => {
  const session = getSession(c.req.param('id'));
  if (!session) return c.json({ error: 'Not found' }, 404);
  const runs = listSessionRuns(session.id);
  return c.json(runs.map((run) => ({
    run,
    events: getPersistedEvents(run.id),
  })));
});

// PATCH /api/sessions/:id — update mutable session fields (status, name)
// Called by the orchestrator from inside the sandbox to report phase transitions.
router.patch('/api/sessions/:id', async (c) => {
  const session = getSession(c.req.param('id'));
  if (!session) return c.json({ error: 'Not found' }, 404);

  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: 'JSON body required' }, 400);

  const VALID_STATUSES = new Set(['discovery', 'planning', 'executing', 'complete']);
  const updates: Partial<OrchestratorSession> = {};

  if (typeof body.status === 'string') {
    if (!VALID_STATUSES.has(body.status)) {
      return c.json({ error: `Invalid status. Must be one of: ${[...VALID_STATUSES].join(', ')}` }, 400);
    }
    updates.status = body.status;
  }
  if (typeof body.name === 'string' && body.name.trim()) {
    updates.name = body.name.trim();
  }

  if (Object.keys(updates).length === 0) return c.json({ error: 'No valid fields to update' }, 400);

  updateSession(session.id, updates);
  return c.json(getSession(session.id));
});

// POST /api/sessions/:id/reply — resume orchestrator with user's answer
router.post('/api/sessions/:id/reply', async (c) => {
  const session = getSession(c.req.param('id'));
  if (!session) return c.json({ error: 'Session not found' }, 404);

  // Per-session lock: prevents two concurrent requests from both passing the
  // prevRun.status check and creating duplicate runs (double-submit race).
  if (replyLocks.has(session.id)) {
    return c.json({ error: 'A reply to this session is already being processed' }, 409);
  }
  replyLocks.add(session.id);

  try {
    const body = await c.req.json().catch(() => null);
    if (!body?.message) return c.json({ error: 'message is required' }, 400);

    const project = getProject(session.project_id);
    if (!project) return c.json({ error: 'Project not found' }, 404);

    const prevRun = session.current_run_id ? getRun(session.current_run_id) : null;
    if (prevRun && prevRun.status !== 'completed' && prevRun.status !== 'failed' && prevRun.status !== 'cancelled') {
      return c.json({ error: 'Current turn is still running' }, 409);
    }

    // Find the most recent Claude Code session ID captured by any run in this session.
    // We scan all runs (not just current_run_id) so a cancelled or failed turn doesn't
    // break resumption — we fall back to the last stable completed-iteration snapshot.
    const allSessionRuns = listSessionRuns(session.id);
    const lastRunWithSession = [...allSessionRuns].reverse().find((r) => r.last_session_id != null);
    const rawResumeSessionId = lastRunWithSession?.last_session_id ?? undefined;

    // Validate that the session file still exists before passing to sandcastle.
    // Stale IDs (from deleted data, migrated projects, or failed captures) become
    // graceful fresh starts rather than cryptic resume errors.
    const resumeSessionId = rawResumeSessionId
      ? (await validateResumeSession(
          rawResumeSessionId,
          session.project_id,
          lastRunWithSession!.agent_provider,
          lastRunWithSession!.claude_auth_provider,
        )) ?? undefined
      : undefined;

    // Context-length guard: if accumulated cache tokens across all runs in this session
    // exceed the threshold, prepend a notice instructing the orchestrator to write a
    // compact checkpoint.md before continuing. This interrupts the unbounded growth of
    // the session JSONL that Claude Code re-reads in full on every resume turn.
    const cumulativeTokens = allSessionRuns.reduce(
      (sum, r) => sum + r.total_cache_read_tokens + r.total_cache_creation_tokens,
      0,
    );
    const replyPrompt = cumulativeTokens > SESSION_SUMMARIZE_THRESHOLD_TOKENS
      ? `${buildSummarizeNotice(cumulativeTokens)}${body.message as string}`
      : body.message as string;

    const branch = prevRun?.branch ?? `orchestrator/${session.id.slice(0, 8)}`;
    const runtime = runtimeFromBody(body, prevRun ? {
      agentProvider: prevRun.agent_provider,
      claudeAuthProvider: prevRun.claude_auth_provider,
      model: prevRun.model,
    } : undefined);
    // resumeSession only supports maxIterations: 1 in Sandcastle
    const runId = makeRun(session.project_id, session.id, replyPrompt, branch, 'Orchestrator — reply', runtime, 1);

    updateSession(session.id, { current_run_id: runId });

    startRun({
      id: runId,
      projectId: session.project_id,
      repoPath: project.repo_path,
      prompt: replyPrompt,
      model: runtime.model,
      sandboxProvider: 'docker',
      branch,
      maxIterations: 1,
      name: 'Orchestrator — reply',
      role: 'orchestrator',
      agentProvider: runtime.agentProvider,
      claudeAuthProvider: runtime.claudeAuthProvider,
      resumeSessionId,
      orchestratorSessionId: session.id,
    }).catch(console.error);

    return c.json({ session: getSession(session.id), run: getRun(runId) });
  } finally {
    replyLocks.delete(session.id);
  }
});

/**
 * Read checkpoint.md from git across all branches (orchestrators commit to worktree branches).
 * Returns null when the file has never been committed.
 */
function readCheckpointFromGit(repoPath: string): string | null {
  try {
    const hash = execFileSync(
      'git',
      ['-C', repoPath, 'log', '--all', '-1', '--format=%H', '--', '.spec/checkpoint.md'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (!hash) return null;
    return execFileSync('git', ['-C', repoPath, 'show', `${hash}:.spec/checkpoint.md`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

/**
 * Build the compact-resume prompt: full orchestrator system prompt + checkpoint state.
 * The agent receives a fresh context (no conversation history) but knows exactly
 * where the previous run left off.
 */
function buildCompactPrompt(checkpointContent: string): string {
  const base = loadOrchestratorPrompt();
  const resume = [
    '---',
    '',
    '## Resuming from Compacted Context',
    '',
    'The previous orchestrator run accumulated too much context and was compacted to reduce',
    'token usage. You are starting with a completely fresh context window. Your tools, API,',
    'and workspace are all intact — only the conversation history was dropped.',
    '',
    '**Do not re-introduce yourself, re-ask questions already answered, or repeat completed',
    'work.** Read the checkpoint below and resume immediately from where the previous run',
    'left off.',
    '',
    '```',
    checkpointContent.trim(),
    '```',
    '',
    'Resume now.',
  ].join('\n');
  return base ? `${base}\n\n${resume}` : resume;
}

// POST /api/sessions/:id/compact — context compaction
// Called by the orchestrator when its context grows too large. Starts a brand-new
// orchestrator run (no resumeSessionId) seeded with checkpoint.md so the agent
// continues with a clean context window instead of an ever-growing session JSONL.
router.post('/api/sessions/:id/compact', async (c) => {
  const session = getSession(c.req.param('id'));
  if (!session) return c.json({ error: 'Session not found' }, 404);

  const project = getProject(session.project_id);
  if (!project) return c.json({ error: 'Project not found' }, 404);

  // Read the checkpoint the orchestrator should have committed before calling this.
  const checkpoint = readCheckpointFromGit(project.repo_path);
  if (!checkpoint) {
    return c.json({
      error: 'No checkpoint.md found in git. Commit .spec/checkpoint.md before compacting.',
    }, 422);
  }

  // Derive runtime from the previous run so model/provider are preserved.
  const prevRun = session.current_run_id ? getRun(session.current_run_id) : null;
  const runtime = runtimeFromBody(null, prevRun ? {
    agentProvider: prevRun.agent_provider,
    claudeAuthProvider: prevRun.claude_auth_provider,
    model: prevRun.model,
  } : undefined);

  // Re-use the same branch so the fresh run works in the same worktree.
  const branch = prevRun?.branch ?? `orchestrator/${session.id.slice(0, 8)}`;
  const fullPrompt = buildCompactPrompt(checkpoint);

  // maxIterations same as the initial start — compact runs need to complete the pipeline.
  const runId = makeRun(session.project_id, session.id, fullPrompt, branch, 'Orchestrator — compact', runtime, 50);

  // Point the session at the new run immediately; the old run will finish (exit 0) shortly.
  updateSession(session.id, { current_run_id: runId });

  // Start the new run WITHOUT resumeSessionId — this is the key: fresh context.
  startRun({
    id: runId,
    projectId: session.project_id,
    repoPath: project.repo_path,
    prompt: fullPrompt,
    model: runtime.model,
    sandboxProvider: 'docker',
    branch,
    maxIterations: 50,
    name: 'Orchestrator — compact',
    role: 'orchestrator',
    agentProvider: runtime.agentProvider,
    claudeAuthProvider: runtime.claudeAuthProvider,
    // resumeSessionId intentionally omitted — fresh context window
    orchestratorSessionId: session.id,
  }).catch(console.error);

  return c.json({ session: getSession(session.id), run: getRun(runId) }, 201);
});

// DELETE /api/sessions/:id — cascade-delete a session and all its runs/events
router.delete('/api/sessions/:id', (c) => {
  const session = getSession(c.req.param('id'));
  if (!session) return c.json({ error: 'Not found' }, 404);
  // Don't allow deleting sessions with an active run
  const currentRun = session.current_run_id ? getRun(session.current_run_id) : null;
  if (currentRun && (currentRun.status === 'queued' || currentRun.status === 'running')) {
    return c.json({ error: 'Cannot delete session with an active run. Cancel it first.' }, 409);
  }
  deleteSession(session.id);
  return c.json({ deleted: true });
});

// GET /api/sessions/:id/events — SSE stream for current run
router.get('/api/sessions/:id/events', (c) => {
  const session = getSession(c.req.param('id'));
  if (!session) return c.json({ error: 'Not found' }, 404);
  if (!session.current_run_id) return c.json({ error: 'No active run' }, 404);

  const runId = session.current_run_id;

  return new Response(
    new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        let closed = false;
        let unsub: (() => void) | undefined;
        let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

        const close = () => {
          if (closed) return;
          closed = true;
          clearInterval(heartbeatTimer);
          unsub?.();
          try { controller.close(); } catch { /* already closed */ }
        };

        const send = (event: AgentEvent) => {
          if (closed) return;
          try {
            controller.enqueue(enc.encode(`data: ${JSON.stringify(event)}\n\n`));
          } catch {
            close();
            return;
          }
          if (event.type === 'done' || event.type === 'error') close();
        };

        // Subscribe BEFORE replaying persisted events to avoid a race where a live
        // event arrives between getPersistedEvents() and subscribe(). The client
        // deduplicates overlapping events by seq, so the overlap is harmless.
        unsub = subscribe(runId, send);

        // Replay all persisted events so late-joining clients see the full history.
        for (const event of getPersistedEvents(runId)) {
          send(event);
          if (closed) return;
        }

        // If the run is already in a terminal state but no done/error event was
        // persisted (e.g. cancelled runs, runs interrupted by a server restart),
        // inject a synthetic terminal event and close.
        if (!closed) {
          const currentRun = getRun(runId);
          if (!currentRun || TERMINAL_RUN_STATUSES.has(currentRun.status)) {
            const termType = currentRun?.status === 'failed' ? 'error' : 'done';
            send({
              type: termType,
              text: currentRun?.error ?? undefined,
              timestamp: new Date().toISOString(),
            });
            return;
          }
        }

        // Heartbeat every 15 s to keep the connection alive through proxies and
        // load balancers that close idle SSE connections.
        heartbeatTimer = setInterval(() => {
          if (closed) return;
          try {
            controller.enqueue(enc.encode(': heartbeat\n\n'));
          } catch {
            close();
          }
        }, 15_000);

        c.req.raw.signal.addEventListener('abort', close);
      },
    }),
    {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    },
  );
});

export default router;
