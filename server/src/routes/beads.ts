/**
 * Beads-compatible task/memory API, backed by SQLite (runs.db).
 * Replaces the old bd CLI/Dolt proxy; same URL surface for existing callers.
 */
import { Hono } from 'hono';
import {
  addTaskDep,
  closeTask,
  generatePrimeContext,
  getTaskParents,
  insertMemory,
  insertTask,
  listAllTasks,
  listUnblockedTasks,
  randomTaskId,
  updateTask,
} from '../db.js';

const router = new Hono();

// GET /api/beads/prime — AI-optimised context dump for agent startup
router.get('/api/beads/prime', (c) => {
  const projectId = c.req.query('projectId') ?? '';
  if (!projectId) return c.text('projectId query param is required', 400);
  return c.text(generatePrimeContext(projectId));
});

// POST /api/beads/create — create a new task
router.post('/api/beads/create', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.description) return c.json({ error: 'description is required' }, 400);
  const projectId: string = body.projectId ?? '';
  if (!projectId) return c.json({ error: 'projectId is required' }, 400);
  const id = randomTaskId();
  insertTask({
    id,
    project_id: projectId,
    title: body.description as string,
    description: (body.details as string | undefined) ?? null,
    status: 'open',
    created_at: Date.now(),
  });
  return c.json({ id, output: `task_id: ${id}\nCreated task ${id}: ${body.description}` });
});

// POST /api/beads/dep — add a dependency between tasks
router.post('/api/beads/dep', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.child || !body?.parent) return c.json({ error: 'child and parent are required' }, 400);
  const projectId: string = body.projectId ?? '';
  if (!projectId) return c.json({ error: 'projectId is required' }, 400);
  addTaskDep(body.child as string, body.parent as string, projectId);
  return c.json({ output: `Dependency added: ${body.child} blocked by ${body.parent}` });
});

// POST /api/beads/complete — mark a task complete (closed)
router.post('/api/beads/complete', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.id) return c.json({ error: 'id is required' }, 400);
  const projectId: string = body.projectId ?? '';
  if (!projectId) return c.json({ error: 'projectId is required' }, 400);
  closeTask(body.id as string, projectId);
  return c.json({ output: `Closed task ${body.id}` });
});

// POST /api/beads/remember — store a persistent memory note
router.post('/api/beads/remember', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.note) return c.json({ error: 'note is required' }, 400);
  const projectId: string = body.projectId ?? '';
  if (!projectId) return c.json({ error: 'projectId is required' }, 400);
  insertMemory(projectId, body.note as string);
  return c.json({ output: `Memory stored: ${body.note}` });
});

// GET /api/beads/tasks — list all tasks for a project (used by UI task board)
router.get('/api/beads/tasks', (c) => {
  const projectId = c.req.query('projectId') ?? '';
  if (!projectId) return c.json({ error: 'projectId query param is required' }, 400);

  const tasks = listAllTasks(projectId);
  const result = tasks.map((t) => {
    const parents = getTaskParents(t.id);
    return {
      id: t.id,
      title: t.title,
      body: t.description ?? '',
      status: t.status,
      blocked_by: parents.length > 0 ? parents.join(', ') : null,
      claimed_by: t.claimed_by,
    };
  });
  return c.json(result);
});

// GET /api/beads/unblocked — tasks with no unresolved blockers
router.get('/api/beads/unblocked', (c) => {
  const projectId = c.req.query('projectId') ?? '';
  if (!projectId) return c.json({ error: 'projectId query param is required' }, 400);
  return c.json(listUnblockedTasks(projectId));
});

// POST /api/beads/update — update task status / claim
router.post('/api/beads/update', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.id) return c.json({ error: 'id is required' }, 400);
  const projectId: string = body.projectId ?? '';
  if (!projectId) return c.json({ error: 'projectId is required' }, 400);
  updateTask(body.id as string, {
    status: typeof body.status === 'string' ? body.status : undefined,
    claim: body.claim === true,
  }, projectId);
  return c.json({ output: `Updated task ${body.id}` });
});

export default router;
