import { Hono } from 'hono';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { getProject } from '../db.js';

const router = new Hono();

/**
 * Allowable spec filenames: letters, digits, hyphens, underscores, dots — no path separators.
 * This replaces the old hardcoded ALLOWED_SPEC_FILES set so research-*.md files are also readable.
 */
const SAFE_FILENAME = /^[a-zA-Z0-9._-]+\.md$/;

function specDir(repoPath: string): string {
  return join(repoPath, '.spec');
}

/**
 * Timestamp of the most recent commit touching this path, searching across ALL branches.
 * The orchestrator commits to a sandbox branch worktree, not to the project's default branch,
 * so `--all` is required to find those commits.
 */
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

/**
 * List all .spec/*.md filenames that have ever been committed to any branch.
 * The orchestrator works in a Sandcastle worktree branch — the files are never
 * checked out into the project's main working tree, so readdirSync alone misses them.
 */
function listSpecFilesInGit(repoPath: string): string[] {
  try {
    const raw = execFileSync(
      'git',
      // --pretty= suppresses commit lines; --name-only lists touched files; --all spans every branch
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

/**
 * Read a spec file from the most recent commit that touched it across all branches.
 * Used as a fallback when the file is not in the main working tree.
 */
function readSpecFromGit(repoPath: string, filename: string): string | null {
  try {
    const hash = execFileSync(
      'git',
      ['-C', repoPath, 'log', '--all', '-1', '--format=%H', '--', `.spec/${filename}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (!hash) return null;
    return execFileSync('git', ['-C', repoPath, 'show', `${hash}:.spec/${filename}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

// GET /api/projects/:id/specs — list all spec files
router.get('/api/projects/:id/specs', (c) => {
  const project = getProject(c.req.param('id'));
  if (!project) return c.json({ error: 'Not found' }, 404);

  // Merge files from the working tree (uncommitted edits) and git history (committed to any branch).
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

  // Prefer the live working-tree file (captures uncommitted orchestrator edits).
  const filePath = join(specDir(project.repo_path), filename);
  if (existsSync(filePath)) {
    return c.text(readFileSync(filePath, 'utf8'));
  }

  // Fall back to the most recent git commit for this file across all branches.
  const content = readSpecFromGit(project.repo_path, filename);
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
