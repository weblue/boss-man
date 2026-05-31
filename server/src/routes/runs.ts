import { Hono } from 'hono';
import { v4 as uuidv4 } from 'uuid';
import { insertRun, getRun, listRuns, getProject } from '../db.js';
import { startRun, cancelRun } from '../runner.js';
import { getPersistedEvents, subscribe, type AgentEvent } from '../streaming.js';
import { DEFAULT_AGENT_PROVIDER, defaultModelForRole, resolveClaudeAuthProvider } from '../config.js';

const router = new Hono();

const VALID_ROLES = new Set([
  'orchestrator', 'test_generator', 'implementer',
  'reviewer', 'security_reviewer', 'researcher', 'refactor',
]);

const VALID_PROVIDERS = new Set(['claude-code', 'codex', 'opencode']);

/** Run statuses that will never emit another event — used to close SSE streams immediately. */
const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled']);

router.get('/api/projects/:projectId/runs', (c) => {
  return c.json(listRuns(c.req.param('projectId')));
});

router.get('/api/runs/:id', (c) => {
  const run = getRun(c.req.param('id'));
  if (!run) return c.json({ error: 'Not found' }, 404);
  return c.json(run);
});

router.get('/api/runs/:id/events/history', (c) => {
  const runId = c.req.param('id');
  const run = getRun(runId);
  if (!run) return c.json({ error: 'Not found' }, 404);
  return c.json(getPersistedEvents(runId));
});

router.post('/api/runs', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: 'Invalid JSON' }, 400);

  const {
    projectId, role, prompt, model, name,
    agentProvider, sandboxProvider, maxIterations,
    effort, beadsTaskId, resumeRunId, claudeAuthProvider,
  } = body;

  if (!projectId) return c.json({ error: 'projectId is required' }, 400);
  if (!role || !VALID_ROLES.has(role)) return c.json({ error: `Invalid role: ${role}` }, 400);
  if (!prompt) return c.json({ error: 'prompt is required' }, 400);
  if (agentProvider && !VALID_PROVIDERS.has(agentProvider)) {
    return c.json({ error: `Invalid agentProvider: ${agentProvider}` }, 400);
  }

  const project = getProject(projectId);
  if (!project) return c.json({ error: `Project not found: ${projectId}` }, 404);

  let resumeSessionId: string | undefined;
  if (resumeRunId) {
    const prev = getRun(resumeRunId);
    if (!prev) return c.json({ error: `Resume run not found: ${resumeRunId}` }, 404);
    resumeSessionId = prev.last_session_id ?? undefined;
  }

  const id = uuidv4();
  const branch = `agent/${id.slice(0, 8)}`;
  const resolvedModel = model ?? defaultModelForRole(role);
  const resolvedProvider = agentProvider ?? DEFAULT_AGENT_PROVIDER;
  const resolvedClaudeAuthProvider = resolveClaudeAuthProvider(claudeAuthProvider);

  insertRun({
    id,
    project_id: projectId,
    name: name ?? null,
    role,
    status: 'queued',
    prompt,
    model: resolvedModel,
    agent_provider: resolvedProvider,
    claude_auth_provider: resolvedClaudeAuthProvider,
    orchestrator_session_id: null,
    sandbox_provider: sandboxProvider ?? 'docker',
    branch,
    max_iterations: maxIterations ?? 10,
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
    beads_task_id: beadsTaskId ?? null,
    changed_files: null,
  });

  // Start async — don't await
  startRun({
    id,
    projectId,
    repoPath: project.repo_path,
    prompt,
    model: resolvedModel,
    sandboxProvider: sandboxProvider ?? 'docker',
    branch,
    maxIterations: maxIterations ?? 10,
    name,
    resumeSessionId,
    role,
    agentProvider: resolvedProvider,
    claudeAuthProvider: resolvedClaudeAuthProvider,
    effort,
    beadsTaskId,
  }).catch(console.error);

  return c.json(getRun(id), 201);
});

router.delete('/api/runs/:id', (c) => {
  const runId = c.req.param('id');
  const run = getRun(runId);
  if (!run) return c.json({ error: 'Not found' }, 404);
  const cancelled = cancelRun(runId);
  return c.json({ cancelled });
});

// SSE stream for live events
router.get('/api/runs/:id/events', (c) => {
  const runId = c.req.param('id');
  const run = getRun(runId);
  if (!run) return c.json({ error: 'Not found' }, 404);

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
        // persisted (e.g. cancelled runs, or runs interrupted by a server restart),
        // inject a synthetic terminal event and close the stream.
        if (!closed) {
          const currentRun = getRun(runId);
          if (currentRun && TERMINAL_RUN_STATUSES.has(currentRun.status)) {
            const termType = currentRun.status === 'failed' ? 'error' : 'done';
            send({
              type: termType,
              text: currentRun.error ?? undefined,
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
