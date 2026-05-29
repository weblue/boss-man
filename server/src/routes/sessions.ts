import { Hono } from 'hono';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { v4 as uuidv4 } from 'uuid';
import {
  insertSession, getSession, listSessions, updateSession,
  insertRun, getRun, getProject, listSessionRuns,
  type OrchestratorSession,
} from '../db.js';
import { startRun } from '../runner.js';
import { getPersistedEvents, subscribe, type AgentEvent } from '../streaming.js';
import {
  DEFAULT_AGENT_PROVIDER,
  DEFAULT_AGENT_MODEL,
  defaultModelForRole,
  PROMPTS_DIR,
  resolveClaudeAuthProvider,
} from '../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const router = new Hono();
const VALID_AGENT_PROVIDERS = new Set(['claude-code', 'codex', 'opencode']);

interface SessionRuntime {
  agentProvider: string;
  claudeAuthProvider: string;
  model: string;
}

function loadOrchestratorPrompt(): string {
  const path = join(PROMPTS_DIR, 'orchestrator.md');
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf8').trimEnd();
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

  return {
    agentProvider: requestedProvider && VALID_AGENT_PROVIDERS.has(requestedProvider)
      ? requestedProvider
      : fallback?.agentProvider ?? DEFAULT_AGENT_PROVIDER,
    claudeAuthProvider: resolveClaudeAuthProvider(
      typeof body?.claudeAuthProvider === 'string' ? body.claudeAuthProvider : fallback?.claudeAuthProvider,
    ),
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
  const runId = makeRun(projectId, sessionId, body.message, branch, 'Orchestrator — turn 1', runtime);

  const session: OrchestratorSession = {
    id: sessionId,
    project_id: projectId,
    name: body.name ?? null,
    status: 'discovery',
    current_run_id: runId,
    created_at: Date.now(),
  };
  insertSession(session);

  const fullPrompt = buildFirstTurnPrompt(body.message);
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

// POST /api/sessions/:id/reply — resume orchestrator with user's answer
router.post('/api/sessions/:id/reply', async (c) => {
  const session = getSession(c.req.param('id'));
  if (!session) return c.json({ error: 'Session not found' }, 404);

  const body = await c.req.json().catch(() => null);
  if (!body?.message) return c.json({ error: 'message is required' }, 400);

  const project = getProject(session.project_id);
  if (!project) return c.json({ error: 'Project not found' }, 404);

  const prevRun = session.current_run_id ? getRun(session.current_run_id) : null;
  if (prevRun && prevRun.status !== 'completed' && prevRun.status !== 'failed' && prevRun.status !== 'cancelled') {
    return c.json({ error: 'Current turn is still running' }, 409);
  }

  const resumeSessionId = prevRun?.last_session_id ?? undefined;
  const branch = prevRun?.branch ?? `orchestrator/${session.id.slice(0, 8)}`;
  const runtime = runtimeFromBody(body, prevRun ? {
    agentProvider: prevRun.agent_provider,
    claudeAuthProvider: prevRun.claude_auth_provider,
    model: prevRun.model,
  } : undefined);
  // resumeSession only supports maxIterations: 1 in Sandcastle
  const runId = makeRun(session.project_id, session.id, body.message, branch, 'Orchestrator — reply', runtime, 1);

  updateSession(session.id, { current_run_id: runId });

  startRun({
    id: runId,
    projectId: session.project_id,
    repoPath: project.repo_path,
    prompt: body.message,
    model: runtime.model,
    sandboxProvider: 'docker',
    branch,
    maxIterations: 1,
    name: 'Orchestrator — reply',
    role: 'orchestrator',
    agentProvider: runtime.agentProvider,
    claudeAuthProvider: runtime.claudeAuthProvider,
    resumeSessionId,
  }).catch(console.error);

  return c.json({ session: getSession(session.id), run: getRun(runId) });
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
        const send = (event: AgentEvent) => {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(event)}\n\n`));
          if (event.type === 'done' || event.type === 'error') controller.close();
        };
        const unsub = subscribe(runId, send);
        c.req.raw.signal.addEventListener('abort', () => {
          unsub();
          controller.close();
        });
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
