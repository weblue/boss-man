import { execFileSync } from 'node:child_process';

/** Read a file from its most-recent commit across all branches. Returns null if never committed. */
export function readFileFromGit(repoPath: string, filePath: string): string | null {
  try {
    const hash = execFileSync(
      'git',
      ['-C', repoPath, 'log', '--all', '-1', '--format=%H', '--', filePath],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (!hash) return null;
    return execFileSync('git', ['-C', repoPath, 'show', `${hash}:${filePath}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}
