/**
 * Beads API proxy — the orchestrator (running inside Docker) calls these endpoints
 * to perform bd operations on the host. The host has the bd CLI installed;
 * Dolt runs in Docker on port 3306.
 */
import { Hono } from 'hono';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const router = new Hono();

async function bd(...args: string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync('bd', args, { timeout: 15_000 });
  return (stdout + stderr).trim();
}

// GET /api/beads/prime — inject context into agent session
router.get('/api/beads/prime', async (c) => {
  const projectDb = c.req.query('db');
  const env = projectDb ? { ...process.env, BD_DATABASE: projectDb } : undefined;
  try {
    const { stdout } = await execFileAsync('bd', ['prime'], { timeout: 15_000, env });
    return c.text(stdout);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 500);
  }
});

// POST /api/beads/create — create a new task
router.post('/api/beads/create', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.description) return c.json({ error: 'description is required' }, 400);

  try {
    const args = ['create', body.description];
    if (body.details) args.push('--body', body.details);
    if (body.db) args.push('--database', body.db);
    const output = await bd(...args);
    // Extract the task ID from bd output (bd-XXXX format)
    const match = output.match(/bd-[a-f0-9]+/);
    return c.json({ id: match?.[0] ?? null, output });
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// POST /api/beads/dep — add a dependency between tasks
router.post('/api/beads/dep', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.child || !body?.parent) {
    return c.json({ error: 'child and parent are required' }, 400);
  }
  try {
    const output = await bd('dep', 'add', body.child, body.parent);
    return c.json({ output });
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// POST /api/beads/complete — mark a task complete
router.post('/api/beads/complete', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.id) return c.json({ error: 'id is required' }, 400);
  try {
    const output = await bd('close', body.id);
    return c.json({ output });
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// POST /api/beads/remember — store a persistent memory
router.post('/api/beads/remember', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.note) return c.json({ error: 'note is required' }, 400);
  try {
    const output = await bd('remember', body.note);
    return c.json({ output });
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// GET /api/beads/tasks — list all tasks (for UI task board)
router.get('/api/beads/tasks', async (c) => {
  try {
    const output = await bd('show', '--json');
    return c.json(JSON.parse(output));
  } catch {
    // Fall back to plain text if --json not supported
    try {
      const output = await bd('show');
      return c.text(output);
    } catch (err2: unknown) {
      return c.json({ error: err2 instanceof Error ? err2.message : String(err2) }, 500);
    }
  }
});

// GET /api/beads/unblocked — tasks that have no unresolved blockers
router.get('/api/beads/unblocked', async (c) => {
  try {
    const output = await bd('ready');
    return c.text(output);
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// POST /api/beads/update — update task status
router.post('/api/beads/update', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.id) return c.json({ error: 'id is required' }, 400);
  try {
    const args = ['update', body.id];
    if (body.claim) args.push('--claim');
    if (body.status) args.push('--status', body.status);
    const output = await bd(...args);
    return c.json({ output });
  } catch (err: unknown) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

export default router;
