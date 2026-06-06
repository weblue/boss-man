import { Hono } from 'hono';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileFromGit } from '../git-utils.js';
import { v4 as uuidv4 } from 'uuid';
import {
  insertSession, getSession, listSessions, updateSession, deleteSession,
  insertRun, getRun, getProject, listSessionRuns, isRunActive,
  type OrchestratorSession,
} from '../db.js';
import { startRun } from '../runner.js';
import { validateResumeSession } from '../session-utils.js';
import { getPersistedEvents, createRunEventStream } from '../streaming.js';
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

/** Per-session lock against double-submit races on /reply (concurrent → 409). */
const replyLocks = new Set<string>();

/** Above this, prepend a notice telling the orchestrator to write checkpoint.md
 *  before continuing — curbs unbounded session-JSONL growth re-read each turn. */
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

const ORCHESTRATOR_PROMPT: string = (() => {
  const path = join(PROMPTS_DIR, 'orchestrator.md');
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf8').trimEnd();
})();

function buildFirstTurnPrompt(userMessage: string): string {
  return ORCHESTRATOR_PROMPT
    ? `${ORCHESTRATOR_PROMPT}\n\n---\n\n## User's Initial Request\n\n${userMessage}`
    : userMessage;
}

function runtimeFromBody(body: Record<string, unknown> | null, fallback?: SessionRuntime): SessionRuntime {
  const requestedProvider = typeof body?.agentProvider === 'string' ? body.agentProvider : undefined;
  const requestedModel = typeof body?.model === 'string' && body.model.trim() ? body.model.trim() : undefined;

  // Auth mode is boot-time (start.sh), not per-session: 'claude' → lock to
  // claude-code + subscription auth; 'litellm' → unrestricted, route via proxy.
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

  // Build full prompt before storing, so the DB row matches what the agent received.
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

  // Lock: stops two concurrent requests both passing the status check → dup runs.
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
    if (prevRun && isRunActive(prevRun)) {
      return c.json({ error: 'Current turn is still running' }, 409);
    }

    // Scan all runs (not just current) for the latest captured session ID, so a
    // cancelled/failed turn falls back to the last stable snapshot.
    const allSessionRuns = listSessionRuns(session.id);
    const lastRunWithSession = [...allSessionRuns].reverse().find((r) => r.last_session_id != null);
    const rawResumeSessionId = lastRunWithSession?.last_session_id ?? undefined;

    // Validate the file exists first — stale IDs become fresh starts, not resume errors.
    const resumeSessionId = rawResumeSessionId
      ? (await validateResumeSession(
          rawResumeSessionId,
          session.project_id,
          lastRunWithSession!.agent_provider,
          lastRunWithSession!.claude_auth_provider,
        )) ?? undefined
      : undefined;

    // Context guard: over threshold → notice telling orchestrator to checkpoint first.
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

/** Compact-resume prompt: orchestrator system prompt + checkpoint. Fresh context,
 *  but the agent knows where the previous run left off. */
function buildCompactPrompt(checkpointContent: string): string {
  const base = ORCHESTRATOR_PROMPT;
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

// POST /api/sessions/:id/compact — orchestrator calls when context grows too large.
// Starts a fresh run (no resumeSessionId) seeded with checkpoint.md → clean context.
router.post('/api/sessions/:id/compact', async (c) => {
  const session = getSession(c.req.param('id'));
  if (!session) return c.json({ error: 'Session not found' }, 404);

  const project = getProject(session.project_id);
  if (!project) return c.json({ error: 'Project not found' }, 404);

  const checkpoint = readFileFromGit(project.repo_path, '.spec/checkpoint.md');
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

  // Same branch → same worktree.
  const branch = prevRun?.branch ?? `orchestrator/${session.id.slice(0, 8)}`;
  const fullPrompt = buildCompactPrompt(checkpoint);

  // 50 iterations like initial start — compact runs complete the full pipeline.
  const runId = makeRun(session.project_id, session.id, fullPrompt, branch, 'Orchestrator — compact', runtime, 50);

  // Point session at new run now; old run exits 0 shortly.
  updateSession(session.id, { current_run_id: runId });

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
  if (currentRun && isRunActive(currentRun)) {
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
  return createRunEventStream(session.current_run_id, c.req.raw.signal);
});

export default router;
