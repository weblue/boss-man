import { Hono } from 'hono';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { insertProject, listProjects, getProject } from '../db.js';
import { PROJECTS_DIR } from '../config.js';
import { execSync } from 'node:child_process';

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
    execSync(`git clone ${repoUrl} ${repoPath}`, { stdio: 'inherit' });
  } else {
    execSync(`git init ${repoPath}`, { stdio: 'inherit' });
  }

  // Initialize prismo for token efficiency — generate .claudeignore + context summaries
  try {
    execSync(`npx getprismo doctor --quiet`, { cwd: repoPath, stdio: 'pipe', timeout: 30_000 });
  } catch {
    // prismo doctor is best-effort; don't fail project creation if it errors
  }

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

export default router;
