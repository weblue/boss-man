/**
 * Server-owned rolling context for orchestrator sessions (Option B).
 *
 * Instead of resuming the agent's provider-side session (whose JSONL grows every
 * turn and is replayed in full on each resume — the root cause of escalating
 * token usage), the server reconstructs the conversation itself on every turn:
 *
 *   ORCHESTRATOR_PROMPT
 *   + rolling_summary           (older turns, folded by a cheap low-tier model)
 *   + generatePrimeContext()    (authoritative task/memory state from the DB)
 *   + verbatim recent turns     (kept under a token budget, oldest-first folding)
 *   + the new user message
 *
 * Each orchestrator run is therefore a FRESH seeded session — no provider resume.
 * This is provider-agnostic (works for claude-code, codex, opencode) because the
 * context lives in our prompt, not in any provider's session store.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  getSession,
  listSessionRuns,
  updateSession,
  getRun,
  generatePrimeContext,
  type OrchestratorSession,
  type Run,
} from './db.js';
import { getPersistedEvents } from './streaming.js';
import {
  PROMPTS_DIR,
  LITELLM_HOST,
  LITELLM_PORT,
  LITELLM_API_KEY,
  MODEL_TIERS,
} from './config.js';

/** Verbatim recent turns are kept under this many estimated tokens. When the tail
 *  exceeds it, the oldest turn is folded into the rolling summary. */
const RECENT_TURNS_TOKEN_BUDGET = 12_000;

/** Always keep at least this many verbatim turns for continuity, regardless of budget. */
const MIN_VERBATIM_TURNS = 1;

/** Cheap heuristic — ~4 chars per token. Good enough for budgeting decisions. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export const ORCHESTRATOR_PROMPT: string = (() => {
  const path = join(PROMPTS_DIR, 'orchestrator.md');
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf8').trimEnd();
})();

interface Turn {
  runId: string;
  user: string;
  assistant: string;
}

/** Completed orchestrator runs for a session, oldest-first — the conversation history. */
function sessionHistory(sessionId: string): Run[] {
  return listSessionRuns(sessionId).filter(
    (r) => r.role === 'orchestrator' && r.status === 'completed',
  );
}

/** Reconstruct one turn: the user's message (run.prompt, stored raw) + the
 *  orchestrator's reply (concatenated persisted text events). */
function reconstructTurn(run: Run): Turn {
  const assistant = getPersistedEvents(run.id)
    .filter((e) => e.type === 'text' && e.text)
    .map((e) => e.text!.trim())
    .filter(Boolean)
    .join('\n\n');
  return { runId: run.id, user: run.prompt, assistant };
}

function formatTurn(turn: Turn): string {
  const reply = turn.assistant || '(no textual output)';
  return `### User\n${turn.user}\n\n### Orchestrator\n${reply}`;
}

/** Split history into already-folded turns and the verbatim tail, based on the
 *  newest run id already folded into the rolling summary. */
function splitFolded(
  runs: Run[],
  summaryThroughRunId: string | null,
): { tail: Run[] } {
  if (!summaryThroughRunId) return { tail: runs };
  const idx = runs.findIndex((r) => r.id === summaryThroughRunId);
  if (idx === -1) return { tail: runs }; // stale pointer (e.g. run deleted) → replay all
  return { tail: runs.slice(idx + 1) };
}

/**
 * Build the full seeded prompt for the orchestrator's next turn. This replaces
 * provider session resume — the returned string is the entire context the agent
 * receives.
 */
export function buildSeededPrompt(session: OrchestratorSession, newMessage: string): string {
  const runs = sessionHistory(session.id);
  const { tail } = splitFolded(runs, session.summary_through_run_id);

  const sections: string[] = [];
  if (ORCHESTRATOR_PROMPT) sections.push(ORCHESTRATOR_PROMPT);

  if (session.rolling_summary && session.rolling_summary.trim()) {
    sections.push(
      `## Summary of Earlier Conversation\n\n${session.rolling_summary.trim()}`,
    );
  }

  sections.push(generatePrimeContext(session.project_id));

  if (tail.length > 0) {
    const turns = tail.map((r) => formatTurn(reconstructTurn(r))).join('\n\n');
    sections.push(`## Recent Conversation (verbatim)\n\n${turns}`);
  }

  sections.push(`## New Message\n\n${newMessage}`);

  return sections.join('\n\n---\n\n');
}

/** Convenience for the very first turn of a session (no history yet). */
export function buildFirstTurnPrompt(projectId: string, sessionId: string, userMessage: string): string {
  const session = getSession(sessionId);
  if (session) return buildSeededPrompt(session, userMessage);
  // Session row not yet inserted — fall back to a minimal seed.
  const sections: string[] = [];
  if (ORCHESTRATOR_PROMPT) sections.push(ORCHESTRATOR_PROMPT);
  sections.push(generatePrimeContext(projectId));
  sections.push(`## New Message\n\n${userMessage}`);
  return sections.join('\n\n---\n\n');
}

/**
 * Fold the oldest verbatim turns into the rolling summary until the tail fits the
 * token budget. Token-budgeted, oldest-first, with a floor of MIN_VERBATIM_TURNS
 * for continuity. Called after each orchestrator turn completes. Best-effort: any
 * failure (e.g. summarizer unreachable) leaves state untouched so the next turn
 * simply replays more verbatim history.
 */
export async function maybeFoldSession(sessionId: string): Promise<void> {
  const session = getSession(sessionId);
  if (!session) return;

  const runs = sessionHistory(sessionId);
  let tail = splitFolded(runs, session.summary_through_run_id).tail;
  if (tail.length <= MIN_VERBATIM_TURNS) return;

  const turnTokens = (run: Run) => estimateTokens(formatTurn(reconstructTurn(run)));
  let tailTokens = tail.reduce((acc, r) => acc + turnTokens(r), 0);
  if (tailTokens <= RECENT_TURNS_TOKEN_BUDGET) return;

  let summary = session.rolling_summary;
  let through = session.summary_through_run_id;
  let changed = false;

  while (tail.length > MIN_VERBATIM_TURNS && tailTokens > RECENT_TURNS_TOKEN_BUDGET) {
    const oldest = tail[0];
    try {
      summary = await summarize(summary, reconstructTurn(oldest));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[orchestrator-context] fold failed for session ${sessionId}: ${msg}`);
      break; // leave state as-is; retry on next turn
    }
    tailTokens -= turnTokens(oldest);
    through = oldest.id;
    tail = tail.slice(1);
    changed = true;
  }

  if (changed) {
    updateSession(sessionId, { rolling_summary: summary, summary_through_run_id: through });
    console.log(
      `[orchestrator-context] folded session ${sessionId} through run ${through} (${tail.length} verbatim turns left)`,
    );
  }
}

const SUMMARIZER_SYSTEM = [
  'You maintain a running summary of an AI coding-orchestration session.',
  'The orchestrator drives a TDD pipeline: discovery Q&A, spec writing, task',
  'registration, and dispatching worker agents. Given the existing summary and one',
  'new conversation turn, produce an updated summary that a fresh orchestrator could',
  'read to resume seamlessly.',
  '',
  'Preserve, concisely: decisions made, discovery answers, spec/plan/task state,',
  'commitments to the user, open questions, and any blockers. Drop pleasantries and',
  'redundant restatement. Output ONLY the updated summary prose — no preamble.',
].join('\n');

/** Fold one turn into the running summary via the low-tier model through litellm. */
async function summarize(prevSummary: string | null, turn: Turn): Promise<string> {
  const user = [
    'Existing summary:',
    prevSummary?.trim() || '(none yet — this is the first folded turn)',
    '',
    'New turn to fold in:',
    '### User',
    turn.user,
    '',
    '### Orchestrator',
    turn.assistant || '(no textual output)',
    '',
    'Produce the updated summary.',
  ].join('\n');

  const res = await fetch(`http://${LITELLM_HOST}:${LITELLM_PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${LITELLM_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL_TIERS.low,
      messages: [
        { role: 'system', content: SUMMARIZER_SYSTEM },
        { role: 'user', content: user },
      ],
      temperature: 0.2,
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`summarizer HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = json.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('summarizer returned empty content');
  return content;
}
