import { Hono } from 'hono';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { insertProject, listProjects, getProject, deleteProject, listRuns, isRunActive } from '../db.js';
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
    if (typeof repoUrl !== 'string' || repoUrl.startsWith('-')) {
      return c.json({ error: 'Invalid repoUrl' }, 400);
    }
    // `--` stops a repoUrl like `--upload-pack=...` from being parsed as a flag.
    execFileSync('git', ['clone', '--', repoUrl, repoPath], { stdio: 'inherit' });
  } else {
    execFileSync('git', ['init', repoPath], { stdio: 'inherit' });
  }

  await ensureRepoHasHead(repoPath);

  // prismo doctor runs on first orchestrator use, not here — it'd block on large repos.
  insertProject({
    id,
    name,
    repo_path: repoPath,
    description: description ?? null,
    beads_db: null,
    created_at: Date.now(),
  });

  return c.json(getProject(id), 201);
});

// POST /api/projects/:id/merge — merge a Sandcastle agent branch into main so the
// user can find the code (agent work lands on isolated branches).
router.post('/api/projects/:id/merge', async (c) => {
  const project = getProject(c.req.param('id'));
  if (!project) return c.json({ error: 'Not found' }, 404);

  const activeRun = listRuns(project.id).find(isRunActive);
  if (activeRun) {
    return c.json({ error: 'Cannot merge while a run is active. Cancel it first.' }, 409);
  }

  const body = await c.req.json().catch(() => null);
  const branch = typeof body?.branch === 'string' ? body.branch.trim() : '';
  if (!branch) return c.json({ error: 'branch is required' }, 400);
  // Reject anything outside git's ref charset (and leading `-`) — feeds execFile args.
  if (branch.startsWith('-') || !/^[A-Za-z0-9._/-]+$/.test(branch)) {
    return c.json({ error: 'Invalid branch name' }, 400);
  }

  // Only merge branches that exist in the repo.
  try {
    execFileSync('git', ['-C', project.repo_path, 'rev-parse', '--verify', branch], {
      stdio: 'ignore',
    });
  } catch {
    return c.json({ error: `Branch '${branch}' not found in this repository` }, 404);
  }

  // Stash uncommitted worktree changes so the merge applies cleanly; restored after.
  let stashed = false;
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', project.repo_path, 'stash', 'push', '-u', '-m', 'boss-man pre-merge'],
      { timeout: 10_000 },
    );
    stashed = !stdout.includes('No local changes to save');
  } catch {
    // Best-effort; proceed even if stash fails.
  }

  const popStash = async () => {
    if (!stashed) return;
    try {
      await execFileAsync('git', ['-C', project.repo_path, 'stash', 'pop'], { timeout: 10_000 });
    } catch {
      // Pop can conflict; leave the stash entry for manual recovery.
    }
  };

  let mergeOutput = '';
  try {
    const { stdout, stderr } = await execFileAsync(
      'git',
      ['-C', project.repo_path, 'merge', '--no-ff', '-m', `merge: ${branch} into main`, '--', branch],
      { timeout: 30_000 },
    );
    mergeOutput = (stdout + stderr).trim();
  } catch (err: unknown) {
    // Non-zero on conflicts or already-up-to-date.
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('Already up to date') && !msg.includes('already up to date')) {
      await popStash();
      return c.json({ error: msg }, 500);
    }
    mergeOutput = 'Already up to date.';
  }

  await popStash();
  return c.json({ merged: true, output: mergeOutput });
});

router.delete('/api/projects/:id', (c) => {
  const project = getProject(c.req.param('id'));
  if (!project) return c.json({ error: 'Not found' }, 404);

  const activeRun = listRuns(project.id).find(isRunActive);
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
