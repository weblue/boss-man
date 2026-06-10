/**
 * Unit tests for the server-owned rolling context (Option B).
 *
 * Runs against an isolated SQLite file (BOSS_MAN_DB_PATH) created in a temp dir,
 * so it never touches the dev database. The litellm summarizer call is stubbed by
 * overriding global.fetch — no network, deterministic summaries.
 */
import test, { before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Must be set BEFORE importing db.js (it opens the DB at module load).
const tmpDir = mkdtempSync(join(tmpdir(), 'bossman-test-'));
process.env.BOSS_MAN_DB_PATH = join(tmpDir, 'test.db');

// Dynamic imports so the env var is in place first.
type DbModule = typeof import('../src/db.js');
type CtxModule = typeof import('../src/orchestrator-context.js');
let db: DbModule;
let ctx: CtxModule;

let runSeq = 0;
const PROJECT_ID = 'proj-test';

function makeProject() {
  db.insertProject({
    id: PROJECT_ID,
    name: 'test-project',
    repo_path: '/tmp/nope',
    description: null,
    beads_db: null,
    created_at: Date.now(),
  });
}

function makeSession(id: string) {
  db.insertSession({
    id,
    project_id: PROJECT_ID,
    name: null,
    status: 'discovery',
    current_run_id: null,
    created_at: Date.now(),
    rolling_summary: null,
    summary_through_run_id: null,
  });
}

/** Insert a completed orchestrator run with the given user prompt + assistant text. */
function addTurn(sessionId: string, userMsg: string, assistantText: string): string {
  const id = `run-${++runSeq}`;
  db.insertRun({
    id,
    project_id: PROJECT_ID,
    name: 'turn',
    role: 'orchestrator',
    status: 'completed',
    prompt: userMsg,
    model: 'boss-man/high',
    agent_provider: 'claude-code',
    claude_auth_provider: 'anthropic',
    orchestrator_session_id: sessionId,
    sandbox_provider: 'docker',
    branch: 'b',
    max_iterations: 50,
    created_at: Date.now() + runSeq, // monotonic ordering
    started_at: Date.now(),
    completed_at: Date.now(),
    error: null,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cache_creation_tokens: 0,
    total_cache_read_tokens: 0,
    last_session_id: null,
    langfuse_trace_id: null,
    beads_task_id: null,
    changed_files: null,
  });
  db.insertEvent({
    run_id: id,
    type: 'text',
    data: JSON.stringify({ type: 'text', text: assistantText, timestamp: new Date().toISOString() }),
    timestamp: new Date().toISOString(),
  });
  return id;
}

before(async () => {
  db = await import('../src/db.js');
  ctx = await import('../src/orchestrator-context.js');
  makeProject();
});

beforeEach(() => {
  // Fresh fetch stub each test; restore in mock.reset via node test runner.
  mock.restoreAll();
});

test('estimateTokens approximates chars/4', () => {
  assert.equal(ctx.estimateTokens(''), 0);
  assert.equal(ctx.estimateTokens('abcd'), 1);
  assert.equal(ctx.estimateTokens('a'.repeat(400)), 100);
});

test('buildSeededPrompt — first turn has no history/summary sections', () => {
  const sid = 'sess-first';
  makeSession(sid);
  const session = db.getSession(sid)!;
  const prompt = ctx.buildSeededPrompt(session, 'hello world');

  assert.match(prompt, /## New Message\n\nhello world/);
  assert.match(prompt, /## Task State/); // prime context always included
  assert.doesNotMatch(prompt, /## Recent Conversation/);
  assert.doesNotMatch(prompt, /## Summary of Earlier Conversation/);
});

test('buildSeededPrompt — includes verbatim recent turns in order', () => {
  const sid = 'sess-history';
  makeSession(sid);
  addTurn(sid, 'first user msg', 'first assistant reply');
  addTurn(sid, 'second user msg', 'second assistant reply');

  const session = db.getSession(sid)!;
  const prompt = ctx.buildSeededPrompt(session, 'third message');

  assert.match(prompt, /## Recent Conversation \(verbatim\)/);
  assert.match(prompt, /first user msg/);
  assert.match(prompt, /first assistant reply/);
  assert.match(prompt, /second assistant reply/);
  assert.match(prompt, /## New Message\n\nthird message/);
  // Order: first turn appears before second turn.
  assert.ok(prompt.indexOf('first user msg') < prompt.indexOf('second user msg'));
});

test('buildSeededPrompt — folded turns excluded, summary included', () => {
  const sid = 'sess-folded';
  makeSession(sid);
  const r1 = addTurn(sid, 'old user msg', 'old assistant reply');
  addTurn(sid, 'recent user msg', 'recent assistant reply');
  // Mark r1 as folded into a rolling summary.
  db.updateSession(sid, { rolling_summary: 'PRIOR SUMMARY TEXT', summary_through_run_id: r1 });

  const session = db.getSession(sid)!;
  const prompt = ctx.buildSeededPrompt(session, 'next message');

  assert.match(prompt, /## Summary of Earlier Conversation\n\nPRIOR SUMMARY TEXT/);
  assert.doesNotMatch(prompt, /old user msg/); // folded → not verbatim
  assert.match(prompt, /recent user msg/); // still in verbatim tail
});

test('maybeFoldSession — folds oldest turns over budget, keeps a verbatim floor', async () => {
  const sid = 'sess-fold';
  makeSession(sid);
  // 4 turns, each ~5000 tokens (20000 chars) → ~20000 token tail, budget 12000.
  const big = 'x'.repeat(20_000);
  addTurn(sid, 'u1', big);
  addTurn(sid, 'u2', big);
  addTurn(sid, 'u3', big);
  addTurn(sid, 'u4', big);

  const fetchMock = mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: 'ROLLED-UP SUMMARY' } }] }),
    text: async () => '',
  }) as unknown as Response);

  await ctx.maybeFoldSession(sid);

  const session = db.getSession(sid)!;
  assert.equal(session.rolling_summary, 'ROLLED-UP SUMMARY');
  assert.ok(session.summary_through_run_id, 'summary_through_run_id should be set');

  // Folded down to fit budget but kept >= 1 verbatim turn.
  const runs = db.listSessionRuns(sid);
  const foldedIdx = runs.findIndex((r) => r.id === session.summary_through_run_id);
  const verbatimRemaining = runs.length - (foldedIdx + 1);
  assert.ok(verbatimRemaining >= 1, 'at least one verbatim turn must remain');
  assert.ok(verbatimRemaining < runs.length, 'at least one turn must have been folded');
  // Two oldest folded (20000 → fold 2 → ~10000 <= 12000).
  assert.equal(fetchMock.mock.callCount(), 2);
});

test('maybeFoldSession — no-op when tail is under budget', async () => {
  const sid = 'sess-nofold';
  makeSession(sid);
  addTurn(sid, 'u1', 'short reply');
  addTurn(sid, 'u2', 'short reply');

  const fetchMock = mock.method(globalThis, 'fetch', async () => {
    throw new Error('summarizer should not be called under budget');
  });

  await ctx.maybeFoldSession(sid);

  const session = db.getSession(sid)!;
  assert.equal(session.rolling_summary, null);
  assert.equal(session.summary_through_run_id, null);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('cleanup temp db', () => {
  rmSync(tmpDir, { recursive: true, force: true });
});
