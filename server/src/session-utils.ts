import {
  findClaudeSessionOnHost,
  findCodexSessionOnHost,
} from '@ai-hero/sandcastle';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { CLAUDE_CODE_AUTH_MODE, CLAUDE_CODE_OAUTH_TOKEN } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');
const SESSIONS_DIR = join(DATA_DIR, 'claude-sessions');

/** Host Claude projects dir: host ~/.claude (login mode) or per-project store. */
function claudeProjectsDir(projectId: string, claudeAuthProvider: string): string {
  // Login mode mounts host ~/.claude — default location.
  if (claudeAuthProvider === 'anthropic' && CLAUDE_CODE_AUTH_MODE === 'login' && !CLAUDE_CODE_OAUTH_TOKEN) {
    return join(homedir(), '.claude', 'projects');
  }
  return join(SESSIONS_DIR, projectId, 'projects');
}

/** Verify Claude session file exists. Returns sessionId or null (stale). */
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

/** Verify Codex session file exists. Returns sessionId or null. */
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

/** Validate resume session by provider. null if missing so caller starts fresh. */
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

