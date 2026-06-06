import { Hono } from 'hono';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { getProject } from '../db.js';
import { readFileFromGit } from '../git-utils.js';

const router = new Hono();

// Safe spec filename: alphanumerics/._- only, no path separators. Allows research-*.md.
const SAFE_FILENAME = /^[a-zA-Z0-9._-]+\.md$/;

function specDir(repoPath: string): string {
  return join(repoPath, '.spec');
}

/** Most-recent commit time touching this path (--all: orchestrator commits to
 *  worktree branches, not the default branch). */
function lastGitCommitAt(repoPath: string, relativePath: string): number | null {
  try {
    const output = execFileSync(
      'git',
      ['-C', repoPath, 'log', '--all', '-1', '--format=%ct', '--', relativePath],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    return output ? Number(output) * 1000 : null;
  } catch {
    return null;
  }
}

/** All .spec/*.md filenames committed to any branch. Orchestrator works in a
 *  worktree branch, never checked out to main, so readdirSync alone misses them. */
function listSpecFilesInGit(repoPath: string): string[] {
  try {
    const raw = execFileSync(
      'git',
      // --pretty= drops commit lines; --name-only lists files; --all spans branches
      ['-C', repoPath, 'log', '--all', '--pretty=', '--name-only', '--', '.spec/*.md'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const prefix = '.spec/';
    return [
      ...new Set(
        raw
          .split('\n')
          .filter((f) => f.startsWith(prefix) && f.endsWith('.md'))
          .map((f) => f.slice(prefix.length))
          .filter((f) => SAFE_FILENAME.test(f)),
      ),
    ];
  } catch {
    return [];
  }
}

// GET /api/projects/:id/specs — list all spec files
router.get('/api/projects/:id/specs', (c) => {
  const project = getProject(c.req.param('id'));
  if (!project) return c.json({ error: 'Not found' }, 404);

  // Merge working-tree (uncommitted) + git history (any branch).
  const dir = specDir(project.repo_path);
  const fsFiles = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith('.md') && SAFE_FILENAME.test(f))
    : [];
  const gitFiles = listSpecFilesInGit(project.repo_path);
  const allFiles = [...new Set([...fsFiles, ...gitFiles])].sort();

  const files = allFiles.map((f) => ({
    name: f,
    path: `.spec/${f}`,
    last_commit_at: lastGitCommitAt(project.repo_path, `.spec/${f}`),
  }));

  return c.json(files);
});

// GET /api/projects/:id/specs/:file — read a spec file
router.get('/api/projects/:id/specs/:file', (c) => {
  const project = getProject(c.req.param('id'));
  if (!project) return c.json({ error: 'Not found' }, 404);

  const filename = c.req.param('file');
  if (!SAFE_FILENAME.test(filename)) {
    return c.json({ error: 'Invalid filename' }, 400);
  }

  // Prefer the live working-tree file (uncommitted orchestrator edits).
  const filePath = join(specDir(project.repo_path), filename);
  if (existsSync(filePath)) {
    return c.text(readFileSync(filePath, 'utf8'));
  }

  // Fall back to most recent commit (any branch).
  const content = readFileFromGit(project.repo_path, `.spec/${filename}`);
  if (content === null) return c.json({ error: 'File not found' }, 404);
  return c.text(content);
});

// PUT /api/projects/:id/specs/:file — write a spec file (orchestrator calls this)
router.put('/api/projects/:id/specs/:file', async (c) => {
  const project = getProject(c.req.param('id'));
  if (!project) return c.json({ error: 'Not found' }, 404);

  const filename = c.req.param('file');
  if (!SAFE_FILENAME.test(filename)) {
    return c.json({ error: 'Invalid filename' }, 400);
  }

  const content = await c.req.text();
  const dir = specDir(project.repo_path);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), content, 'utf8');

  return c.json({ ok: true });
});

export default router;
