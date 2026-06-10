import { Hono } from 'hono';
import { v4 as uuidv4 } from 'uuid';
import {
  insertSession, getSession, listSessions, updateSession, deleteSession,
  insertRun, getRun, getProject, listSessionRuns, isRunActive,
  type OrchestratorSession,
} from '../db.js';
import { startRun } from '../runner.js';
import { getPersistedEvents, createRunEventStream } from '../streaming.js';
import { buildSeededPrompt, buildFirstTurnPrompt, maybeFoldSession } from '../orchestrator-context.js';
import {
  BOSS_MAN_AUTH_MODE,
  DEFAULT_AGENT_PROVIDER,
  DEFAULT_AGENT_MODEL,
  defaultModelForRole,
  type ClaudeAuthProvider,
} from '../config.js';

const router = new Hono();
const VALID_AGENT_PROVIDERS = new Set(['claude-code', 'codex', 'opencode']);

/** Per-session lock against double-submit races on /reply (concurrent → 409). */
const replyLocks = new Set<string>();

interface SessionRuntime {
  agentProvider: string;
  claudeAuthProvider: string;
  model: string;
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

  // Store the RAW user message in run.prompt (UI renders it as the user bubble).
  // The seeded prompt the agent actually receives is built separately below.
  const runId = makeRun(projectId, sessionId, body.message, branch, 'Orchestrator — turn 1', runtime);

  const session: OrchestratorSession = {
    id: sessionId,
    project_id: projectId,
    name: body.name ?? null,
    status: 'discovery',
    current_run_id: runId,
    created_at: Date.now(),
    rolling_summary: null,
    summary_through_run_id: null,
  };
  insertSession(session);

  // Server-owned context (Option B): seed a fresh session — no provider resume.
  const seededPrompt = buildFirstTurnPrompt(projectId, sessionId, body.message);

  startRun({
    id: runId,
    projectId,
    repoPath: project.repo_path,
    prompt: seededPrompt,
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

    const message = body.message as string;
    const branch = prevRun?.branch ?? `orchestrator/${session.id.slice(0, 8)}`;
    const runtime = runtimeFromBody(body, prevRun ? {
      agentProvider: prevRun.agent_provider,
      claudeAuthProvider: prevRun.claude_auth_provider,
      model: prevRun.model,
    } : undefined);

    // Store the RAW user message in run.prompt (rendered as the user bubble); the
    // seeded prompt the agent receives is reconstructed server-side below.
    const runId = makeRun(session.project_id, session.id, message, branch, 'Orchestrator — reply', runtime, 50);

    updateSession(session.id, { current_run_id: runId });

    // Server-owned rolling context (Option B): rebuild the whole conversation
    // (summary + prime context + verbatim tail + this message) and start a FRESH
    // session — no provider resume, so the replayed context can't snowball.
    const seededPrompt = buildSeededPrompt(session, message);

    startRun({
      id: runId,
      projectId: session.project_id,
      repoPath: project.repo_path,
      prompt: seededPrompt,
      model: runtime.model,
      sandboxProvider: 'docker',
      branch,
      maxIterations: 50,
      name: 'Orchestrator — reply',
      role: 'orchestrator',
      agentProvider: runtime.agentProvider,
      claudeAuthProvider: runtime.claudeAuthProvider,
      orchestratorSessionId: session.id,
    }).catch(console.error);

    return c.json({ session: getSession(session.id), run: getRun(runId) });
  } finally {
    replyLocks.delete(session.id);
  }
});

// POST /api/sessions/:id/compact — force an immediate server-side fold of older
// turns into the rolling summary. With server-owned context (Option B), folding is
// automatic after every orchestrator turn, so this is just a manual trigger kept
// for back-compat with the session_compact MCP tool. It does NOT start a new run.
router.post('/api/sessions/:id/compact', async (c) => {
  const session = getSession(c.req.param('id'));
  if (!session) return c.json({ error: 'Session not found' }, 404);
  await maybeFoldSession(session.id);
  return c.json({ session: getSession(session.id) });
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
