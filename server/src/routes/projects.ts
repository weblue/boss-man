import { Hono } from 'hono';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { insertProject, listProjects, getProject, deleteProject, listRuns } from '../db.js';
import { PROJECTS_DIR } from '../config.js';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ensureRepoHasHead } from '../runner.js';

const execFileAsync = promisify(execFile);

const router = new Hono();

router.get('/api/projects', (c) => {
  return c.json(listProjects());
});

router.get('/api/projects/:id', (c) => {
  const project = getProject(c.req.param('id'));
  if (!project) return c.json({ error: 'Not found' }, 404);
  return c.json(project);
});

router.post('/api/projects', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.name) return c.json({ error: 'name is required' }, 400);

  const { name, description, repoUrl } = body;
  const id = uuidv4();
  const repoPath = join(PROJECTS_DIR, name.replace(/[^a-zA-Z0-9-_]/g, '-'));

  if (existsSync(repoPath)) {
    return c.json({ error: `Directory already exists: ${repoPath}` }, 409);
  }

  mkdirSync(repoPath, { recursive: true });

  if (repoUrl) {
    execFileSync('git', ['clone', repoUrl, repoPath], { stdio: 'inherit' });
  } else {
    execFileSync('git', ['init', repoPath], { stdio: 'inherit' });
  }

  ensureRepoHasHead(repoPath);

  // Prismo doctor is run by the orchestrator on first use, not during project creation.
  // Running it here blocks the request and can stall on large repos.

  insertProject({
    id,
    name,
    repo_path: repoPath,
    description: description ?? null,
    beads_db: name,
    created_at: Date.now(),
  });

  return c.json(getProject(id), 201);
});

// POST /api/projects/:id/merge — merge a Sandcastle branch into main
// Sandcastle commits agent work to isolated branches; this brings it back to the
// project's main working tree so the user can find and use the code.
router.post('/api/projects/:id/merge', async (c) => {
  const project = getProject(c.req.param('id'));
  if (!project) return c.json({ error: 'Not found' }, 404);

  const body = await c.req.json().catch(() => null);
  const branch = typeof body?.branch === 'string' ? body.branch.trim() : '';
  if (!branch) return c.json({ error: 'branch is required' }, 400);

  // Safety: only allow merging branches that exist in the repo
  try {
    execFileSync('git', ['-C', project.repo_path, 'rev-parse', '--verify', branch], {
      stdio: 'ignore',
    });
  } catch {
    return c.json({ error: `Branch '${branch}' not found in this repository` }, 404);
  }

  try {
    const { stdout, stderr } = await execFileAsync(
      'git',
      ['-C', project.repo_path, 'merge', '--no-ff', branch, '-m', `merge: ${branch} into main`],
      { timeout: 30_000 },
    );
    return c.json({ merged: true, output: (stdout + stderr).trim() });
  } catch (err: unknown) {
    // git merge exits non-zero on conflicts or already-up-to-date; surface the message
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 500);
  }
});

router.delete('/api/projects/:id', (c) => {
  const project = getProject(c.req.param('id'));
  if (!project) return c.json({ error: 'Not found' }, 404);

  const activeRun = listRuns(project.id).find(
    (r) => r.status === 'queued' || r.status === 'running',
  );
  if (activeRun) {
    return c.json(
      { error: 'Cannot delete project with active runs. Cancel them first.' },
      409,
    );
  }

  deleteProject(project.id);
  return c.json({ deleted: true });
});

export default router;
