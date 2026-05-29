import { Hono } from 'hono';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { getProject } from '../db.js';

const router = new Hono();

const ALLOWED_SPEC_FILES = new Set([
  'constitution.md', 'spec.md', 'plan.md', 'tasks.md', 'checkpoint.md',
]);

function specDir(repoPath: string): string {
  return join(repoPath, '.spec');
}

function lastGitCommitAt(repoPath: string, relativePath: string): number | null {
  try {
    const output = execFileSync('git', ['-C', repoPath, 'log', '-1', '--format=%ct', '--', relativePath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return output ? Number(output) * 1000 : null;
  } catch {
    return null;
  }
}

// GET /api/projects/:id/specs — list all spec files
router.get('/api/projects/:id/specs', (c) => {
  const project = getProject(c.req.param('id'));
  if (!project) return c.json({ error: 'Not found' }, 404);

  const dir = specDir(project.repo_path);
  if (!existsSync(dir)) return c.json([]);

  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const path = `.spec/${f}`;
      return {
        name: f,
        path,
        last_commit_at: lastGitCommitAt(project.repo_path, path),
      };
    });

  return c.json(files);
});

// GET /api/projects/:id/specs/:file — read a spec file
router.get('/api/projects/:id/specs/:file', (c) => {
  const project = getProject(c.req.param('id'));
  if (!project) return c.json({ error: 'Not found' }, 404);

  const filename = c.req.param('file');
  if (!ALLOWED_SPEC_FILES.has(filename)) {
    return c.json({ error: 'Not a recognized spec file' }, 400);
  }

  const filePath = join(specDir(project.repo_path), filename);
  if (!existsSync(filePath)) return c.json({ error: 'File not found' }, 404);

  return c.text(readFileSync(filePath, 'utf8'));
});

// PUT /api/projects/:id/specs/:file — write a spec file (orchestrator calls this)
router.put('/api/projects/:id/specs/:file', async (c) => {
  const project = getProject(c.req.param('id'));
  if (!project) return c.json({ error: 'Not found' }, 404);

  const filename = c.req.param('file');
  if (!ALLOWED_SPEC_FILES.has(filename)) {
    return c.json({ error: 'Not a recognized spec file' }, 400);
  }

  const content = await c.req.text();
  const dir = specDir(project.repo_path);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), content, 'utf8');

  return c.json({ ok: true });
});

export default router;
