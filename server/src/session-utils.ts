import {
  findClaudeSessionOnHost,
  findCodexSessionOnHost,
  transferClaudeSession,
  transferCodexSession,
} from '@ai-hero/sandcastle';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { CLAUDE_CODE_AUTH_MODE, CLAUDE_CODE_OAUTH_TOKEN } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');
const SESSIONS_DIR = join(DATA_DIR, 'claude-sessions');

/**
 * Returns the host-side Claude projects directory for a given project,
 * accounting for whether the run uses the host ~/.claude (login mode) or a
 * per-project session store.
 */
function claudeProjectsDir(projectId: string, claudeAuthProvider: string): string {
  // Login mode mounts the host ~/.claude — sessions live in the default location.
  if (claudeAuthProvider === 'anthropic' && CLAUDE_CODE_AUTH_MODE === 'login' && !CLAUDE_CODE_OAUTH_TOKEN) {
    return join(homedir(), '.claude', 'projects');
  }
  return join(SESSIONS_DIR, projectId, 'projects');
}

/**
 * Verify a Claude Code session file exists for the given project.
 * Returns the sessionId if found, null if not (stale reference).
 */
export async function validateClaudeSession(
  sessionId: string,
  projectId: string,
  claudeAuthProvider: string,
): Promise<string | null> {
  const projectsDir = claudeProjectsDir(projectId, claudeAuthProvider);
  if (!existsSync(projectsDir)) return null;
  const lookup = await findClaudeSessionOnHost(sessionId, projectsDir);
  if (!lookup.path) {
    console.warn(`[session-utils] Claude session ${sessionId} not found in ${lookup.searchedRoot}`);
    return null;
  }
  return sessionId;
}

/**
 * Verify a Codex session file exists for the given project.
 * Returns the sessionId if found, null if not.
 */
export async function validateCodexSession(
  sessionId: string,
  projectId: string,
): Promise<string | null> {
  const sessionsDir = join(SESSIONS_DIR, projectId);
  if (!existsSync(sessionsDir)) return null;
  const lookup = await findCodexSessionOnHost(sessionId, sessionsDir);
  if (!lookup.path) {
    console.warn(`[session-utils] Codex session ${sessionId} not found in ${lookup.searchedRoot}`);
    return null;
  }
  return sessionId;
}

/**
 * Validate that the resume session file exists for the given agent provider.
 * Returns the sessionId if valid, null if the session file is missing so the
 * caller can start fresh rather than hitting a cryptic resume error.
 */
export async function validateResumeSession(
  sessionId: string,
  projectId: string,
  agentProvider: string,
  claudeAuthProvider: string,
): Promise<string | null> {
  if (agentProvider === 'codex') {
    return validateCodexSession(sessionId, projectId);
  }
  return validateClaudeSession(sessionId, projectId, claudeAuthProvider);
}

/**
 * Rewrite the cwd references in a Claude Code session JSONL when the project
 * repo path has changed. Finds the session by ID and updates the file in place.
 * Returns true if found and updated (or no rewrite needed), false if missing.
 */
export async function repairClaudeSessionCwd(
  sessionId: string,
  projectId: string,
  fromCwd: string,
  toCwd: string,
  claudeAuthProvider: string,
): Promise<boolean> {
  const projectsDir = claudeProjectsDir(projectId, claudeAuthProvider);
  const lookup = await findClaudeSessionOnHost(sessionId, projectsDir);
  if (!lookup.path) return false;
  const content = readFileSync(lookup.path, 'utf8');
  const repaired = transferClaudeSession(content, fromCwd, toCwd);
  if (repaired !== content) writeFileSync(lookup.path, repaired, 'utf8');
  return true;
}

/**
 * Rewrite the cwd references in a Codex session JSONL when the project
 * repo path has changed. Finds the session by ID and updates the file in place.
 */
export async function repairCodexSessionCwd(
  sessionId: string,
  projectId: string,
  fromCwd: string,
  toCwd: string,
): Promise<boolean> {
  const sessionsDir = join(SESSIONS_DIR, projectId);
  const lookup = await findCodexSessionOnHost(sessionId, sessionsDir);
  if (!lookup.path) return false;
  const content = readFileSync(lookup.path, 'utf8');
  const repaired = transferCodexSession(content, fromCwd, toCwd);
  if (repaired !== content) writeFileSync(lookup.path, repaired, 'utf8');
  return true;
}
