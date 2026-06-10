import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');

// BOSS_MAN_DB_PATH lets tests (and ephemeral runs) point at an isolated database
// file instead of the shared dev DB. Defaults to data/runs.db.
const DB_PATH = process.env.BOSS_MAN_DB_PATH ?? join(DATA_DIR, 'runs.db');
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS orchestrator_sessions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT,
    status TEXT NOT NULL DEFAULT 'discovery',
    current_run_id TEXT,
    created_at INTEGER NOT NULL,
    rolling_summary TEXT,
    summary_through_run_id TEXT,
    FOREIGN KEY (project_id) REFERENCES projects(id)
  );

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    repo_path TEXT NOT NULL,
    description TEXT,
    beads_db TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT,
    role TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    prompt TEXT NOT NULL,
    model TEXT NOT NULL,
    agent_provider TEXT NOT NULL DEFAULT 'claude-code',
    claude_auth_provider TEXT NOT NULL DEFAULT 'anthropic',
    orchestrator_session_id TEXT,
    sandbox_provider TEXT NOT NULL DEFAULT 'docker',
    branch TEXT NOT NULL,
    max_iterations INTEGER NOT NULL DEFAULT 10,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    completed_at INTEGER,
    error TEXT,
    total_input_tokens INTEGER NOT NULL DEFAULT 0,
    total_output_tokens INTEGER NOT NULL DEFAULT 0,
    total_cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    total_cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    last_session_id TEXT,
    langfuse_trace_id TEXT,
    beads_task_id TEXT,
    FOREIGN KEY (project_id) REFERENCES projects(id)
  );

  CREATE TABLE IF NOT EXISTS terminal_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    type TEXT NOT NULL,
    data TEXT NOT NULL,
    timestamp TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    claimed_by TEXT,
    created_at INTEGER NOT NULL,
    closed_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS task_deps (
    child_id TEXT NOT NULL,
    parent_id TEXT NOT NULL,
    PRIMARY KEY (child_id, parent_id)
  );

  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    note TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

// Snapshotted once at boot — migrations below must be idempotent; add new columns after existing ones only.
const runColumns = db.prepare<[], { name: string }>('PRAGMA table_info(runs)').all();
if (!runColumns.some((column) => column.name === 'claude_auth_provider')) {
  db.exec("ALTER TABLE runs ADD COLUMN claude_auth_provider TEXT NOT NULL DEFAULT 'anthropic'");
}
if (!runColumns.some((column) => column.name === 'orchestrator_session_id')) {
  db.exec('ALTER TABLE runs ADD COLUMN orchestrator_session_id TEXT');
}
if (!runColumns.some((column) => column.name === 'changed_files')) {
  db.exec('ALTER TABLE runs ADD COLUMN changed_files TEXT');
}

// orchestrator_sessions migrations — server-owned rolling context (Option B).
const sessionColumns = db.prepare<[], { name: string }>('PRAGMA table_info(orchestrator_sessions)').all();
if (!sessionColumns.some((column) => column.name === 'rolling_summary')) {
  db.exec('ALTER TABLE orchestrator_sessions ADD COLUMN rolling_summary TEXT');
}
if (!sessionColumns.some((column) => column.name === 'summary_through_run_id')) {
  db.exec('ALTER TABLE orchestrator_sessions ADD COLUMN summary_through_run_id TEXT');
}

// ── Projects ─────────────────────────────────────────────────────────────────

export interface Project {
  id: string;
  name: string;
  repo_path: string;
  description: string | null;
  beads_db: string | null;
  created_at: number;
}

const _insertProject = db.prepare(`
  INSERT INTO projects (id, name, repo_path, description, beads_db, created_at)
  VALUES (@id, @name, @repo_path, @description, @beads_db, @created_at)
`);
export function insertProject(p: Project) { _insertProject.run(p); }

const _getProject = db.prepare<[string], Project>('SELECT * FROM projects WHERE id = ?');
export function getProject(id: string): Project | undefined { return _getProject.get(id); }

const _getProjectByName = db.prepare<[string], Project>('SELECT * FROM projects WHERE name = ?');
export function getProjectByName(name: string): Project | undefined { return _getProjectByName.get(name); }

const _listProjects = db.prepare<[], Project>('SELECT * FROM projects ORDER BY created_at DESC');
export function listProjects(): Project[] { return _listProjects.all(); }

// ── Runs ──────────────────────────────────────────────────────────────────────

export interface Run {
  id: string;
  project_id: string;
  name: string | null;
  role: string;
  status: string;
  prompt: string;
  model: string;
  agent_provider: string;
  claude_auth_provider: string;
  orchestrator_session_id: string | null;
  sandbox_provider: string;
  branch: string;
  max_iterations: number;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  error: string | null;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_creation_tokens: number;
  total_cache_read_tokens: number;
  last_session_id: string | null;
  langfuse_trace_id: string | null;
  beads_task_id: string | null;
  changed_files: string | null;
}

const _insertRun = db.prepare(`
  INSERT INTO runs (
    id, project_id, name, role, status, prompt, model, agent_provider,
    claude_auth_provider, orchestrator_session_id, sandbox_provider, branch, max_iterations, created_at, started_at,
    completed_at, error, total_input_tokens, total_output_tokens,
    total_cache_creation_tokens, total_cache_read_tokens,
    last_session_id, langfuse_trace_id, beads_task_id
  ) VALUES (
    @id, @project_id, @name, @role, @status, @prompt, @model, @agent_provider,
    @claude_auth_provider, @orchestrator_session_id, @sandbox_provider, @branch, @max_iterations, @created_at, @started_at,
    @completed_at, @error, @total_input_tokens, @total_output_tokens,
    @total_cache_creation_tokens, @total_cache_read_tokens,
    @last_session_id, @langfuse_trace_id, @beads_task_id
  )
`);
export function insertRun(run: Run) { _insertRun.run(run); }

const _getRun = db.prepare<[string], Run>('SELECT * FROM runs WHERE id = ?');
export function getRun(id: string): Run | undefined { return _getRun.get(id); }

const _listRuns = db.prepare<[string], Run>(
  'SELECT * FROM runs WHERE project_id = ? ORDER BY created_at DESC'
);
export function listRuns(projectId: string): Run[] { return _listRuns.all(projectId); }

export function isRunActive(run: Run): boolean {
  return run.status === 'queued' || run.status === 'running';
}

const _listSessionRuns = db.prepare<[string], Run>(
  'SELECT * FROM runs WHERE orchestrator_session_id = ? ORDER BY created_at ASC'
);
export function listSessionRuns(sessionId: string): Run[] { return _listSessionRuns.all(sessionId); }

const _updateRun = db.prepare(`
  UPDATE runs SET
    status = COALESCE(@status, status),
    started_at = COALESCE(@started_at, started_at),
    completed_at = COALESCE(@completed_at, completed_at),
    error = COALESCE(@error, error),
    total_input_tokens = COALESCE(@total_input_tokens, total_input_tokens),
    total_output_tokens = COALESCE(@total_output_tokens, total_output_tokens),
    total_cache_creation_tokens = COALESCE(@total_cache_creation_tokens, total_cache_creation_tokens),
    total_cache_read_tokens = COALESCE(@total_cache_read_tokens, total_cache_read_tokens),
    last_session_id = COALESCE(@last_session_id, last_session_id),
    langfuse_trace_id = COALESCE(@langfuse_trace_id, langfuse_trace_id),
    changed_files = COALESCE(@changed_files, changed_files)
  WHERE id = @id
`);
// COALESCE: passing null preserves the value. Use clearRunError() to clear error explicitly.
const _clearRunError = db.prepare('UPDATE runs SET error = NULL WHERE id = ?');
export function clearRunError(id: string) { _clearRunError.run(id); }
export function updateRun(id: string, fields: Partial<Run>) {
  _updateRun.run({
    id,
    status: null,
    started_at: null,
    completed_at: null,
    error: null,
    total_input_tokens: null,
    total_output_tokens: null,
    total_cache_creation_tokens: null,
    total_cache_read_tokens: null,
    last_session_id: null,
    langfuse_trace_id: null,
    changed_files: null,
    ...fields,
  });
}

const _markInterruptedRuns = db.prepare(`
  UPDATE runs SET
    status = 'failed',
    completed_at = COALESCE(completed_at, @completed_at),
    error = COALESCE(error, @error)
  WHERE status IN ('queued', 'running')
`);
export function markInterruptedRuns() {
  _markInterruptedRuns.run({
    completed_at: Date.now(),
    error: 'Server restarted before this in-memory run completed. Start a new run to retry.',
  });
}

// ── Terminal events ────────────────────────────────────────────────────────────

export interface TerminalEvent {
  run_id: string;
  type: string;
  data: string;
  timestamp: string;
}

/** DB row — adds the autoincrement `id` used as the stable event sequence number. */
export interface StoredEvent extends TerminalEvent {
  id: number;
}

const _insertEvent = db.prepare(`
  INSERT INTO terminal_events (run_id, type, data, timestamp)
  VALUES (@run_id, @type, @data, @timestamp)
`);
/** Insert an event; returns its row id (= sequence number). */
export function insertEvent(event: TerminalEvent): number {
  const result = _insertEvent.run(event);
  return Number(result.lastInsertRowid);
}

const _listEvents = db.prepare<[string], StoredEvent>(
  'SELECT * FROM terminal_events WHERE run_id = ? ORDER BY id ASC'
);
export function listEvents(runId: string): StoredEvent[] {
  return _listEvents.all(runId);
}

// ── Orchestrator Sessions ─────────────────────────────────────────────────────

export interface OrchestratorSession {
  id: string;
  project_id: string;
  name: string | null;
  status: string;
  current_run_id: string | null;
  created_at: number;
  /** Server-owned rolling summary of folded (older) turns. Null until first fold. */
  rolling_summary: string | null;
  /** Run id of the newest turn already folded into rolling_summary. Null until first fold. */
  summary_through_run_id: string | null;
}

const _insertSession = db.prepare(`
  INSERT INTO orchestrator_sessions (id, project_id, name, status, current_run_id, created_at, rolling_summary, summary_through_run_id)
  VALUES (@id, @project_id, @name, @status, @current_run_id, @created_at, @rolling_summary, @summary_through_run_id)
`);
export function insertSession(s: OrchestratorSession) { _insertSession.run(s); }

const _getSession = db.prepare<[string], OrchestratorSession>(
  'SELECT * FROM orchestrator_sessions WHERE id = ?'
);
export function getSession(id: string): OrchestratorSession | undefined { return _getSession.get(id); }

const _listSessions = db.prepare<[string], OrchestratorSession>(
  'SELECT * FROM orchestrator_sessions WHERE project_id = ? ORDER BY created_at DESC'
);
export function listSessions(projectId: string): OrchestratorSession[] { return _listSessions.all(projectId); }

const _updateSession = db.prepare(`
  UPDATE orchestrator_sessions SET
    status = COALESCE(@status, status),
    name = COALESCE(@name, name),
    current_run_id = COALESCE(@current_run_id, current_run_id),
    rolling_summary = COALESCE(@rolling_summary, rolling_summary),
    summary_through_run_id = COALESCE(@summary_through_run_id, summary_through_run_id)
  WHERE id = @id
`);
export function updateSession(id: string, fields: Partial<OrchestratorSession>) {
  _updateSession.run({
    id,
    status: null,
    name: null,
    current_run_id: null,
    rolling_summary: null,
    summary_through_run_id: null,
    ...fields,
  });
}

// Hoisted so each statement compiles once.
const _deleteEventsForRun = db.prepare('DELETE FROM terminal_events WHERE run_id = ?');
const _deleteRunsForSession = db.prepare('DELETE FROM runs WHERE orchestrator_session_id = ?');
const _deleteSessionById = db.prepare('DELETE FROM orchestrator_sessions WHERE id = ?');

const _deleteSessionTransaction = db.transaction((sessionId: string) => {
  const sessionRuns = _listSessionRuns.all(sessionId);
  for (const run of sessionRuns) {
    _deleteEventsForRun.run(run.id);
  }
  _deleteRunsForSession.run(sessionId);
  _deleteSessionById.run(sessionId);
});
export function deleteSession(id: string): void {
  _deleteSessionTransaction(id);
}

// ── Tasks ─────────────────────────────────────────────────────────────────────

export interface Task {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: string; // open | in_progress | closed
  claimed_by: string | null;
  created_at: number;
  closed_at: number | null;
}

export interface Memory {
  id: number;
  project_id: string;
  note: string;
  created_at: number;
}

export function randomTaskId(): string {
  return 'task-' + randomBytes(4).toString('hex');
}

const _insertTask = db.prepare(`
  INSERT INTO tasks (id, project_id, title, description, status, created_at)
  VALUES (@id, @project_id, @title, @description, @status, @created_at)
`);
export function insertTask(t: Omit<Task, 'claimed_by' | 'closed_at'>): void {
  _insertTask.run(t);
}

const _getTask = db.prepare<[string], Task>('SELECT * FROM tasks WHERE id = ?');
export function getTask(id: string): Task | undefined { return _getTask.get(id); }

const _listAllTasks = db.prepare<[string], Task>(
  'SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at ASC',
);
export function listAllTasks(projectId: string): Task[] { return _listAllTasks.all(projectId); }

const _listUnblockedTasks = db.prepare<[string], Task>(`
  SELECT t.* FROM tasks t
  WHERE t.project_id = ? AND t.status IN ('open', 'in_progress')
    AND NOT EXISTS (
      SELECT 1 FROM task_deps d
      JOIN tasks p ON p.id = d.parent_id
      WHERE d.child_id = t.id AND p.status != 'closed'
    )
  ORDER BY t.created_at ASC
`);
export function listUnblockedTasks(projectId: string): Task[] {
  return _listUnblockedTasks.all(projectId);
}

const _insertDep = db.prepare(
  'INSERT OR IGNORE INTO task_deps (child_id, parent_id) VALUES (@child_id, @parent_id)',
);
export function addTaskDep(childId: string, parentId: string, projectId: string): void {
  const child = _getTask.get(childId);
  const parent = _getTask.get(parentId);
  if (!child || child.project_id !== projectId) return;
  if (!parent || parent.project_id !== projectId) return;
  _insertDep.run({ child_id: childId, parent_id: parentId });
}

const _getTaskParents = db.prepare<[string], { parent_id: string }>(
  'SELECT parent_id FROM task_deps WHERE child_id = ?',
);
export function getTaskParents(taskId: string): string[] {
  return _getTaskParents.all(taskId).map((r) => r.parent_id);
}

const _closeTask = db.prepare(
  "UPDATE tasks SET status = 'closed', closed_at = ? WHERE id = ? AND project_id = ?",
);
export function closeTask(id: string, projectId: string): void {
  _closeTask.run(Date.now(), id, projectId);
}

const _updateTask = db.prepare(
  'UPDATE tasks SET status = COALESCE(?, status), claimed_by = COALESCE(?, claimed_by) WHERE id = ? AND project_id = ?',
);
export function updateTask(id: string, opts: { status?: string; claim?: boolean }, projectId: string): void {
  const newStatus = opts.claim ? 'in_progress' : (opts.status ?? null);
  const claimedBy = opts.claim ? 'orchestrator' : null;
  _updateTask.run(newStatus, claimedBy, id, projectId);
}

// ── Memories ──────────────────────────────────────────────────────────────────

const _insertMemory = db.prepare(
  'INSERT INTO memories (project_id, note, created_at) VALUES (@project_id, @note, @created_at)',
);
export function insertMemory(projectId: string, note: string): void {
  _insertMemory.run({ project_id: projectId, note, created_at: Date.now() });
}

const _listMemories = db.prepare<[string], Memory>(
  'SELECT * FROM memories WHERE project_id = ? ORDER BY created_at ASC',
);
export function listMemories(projectId: string): Memory[] { return _listMemories.all(projectId); }

// ── Task context prime ────────────────────────────────────────────────────────

function sanitizeMd(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
}

export function generatePrimeContext(projectId: string): string {
  const tasks = listAllTasks(projectId);
  const mems = listMemories(projectId);

  if (tasks.length === 0 && mems.length === 0) {
    return '## Task State\n\nNo tasks or memories yet.\n';
  }

  const lines: string[] = ['## Task State\n'];

  const openTasks = tasks.filter((t) => t.status !== 'closed');
  if (openTasks.length > 0) {
    lines.push('### Open / In-Progress Tasks\n');
    lines.push('| ID | Title | Status | Blocked By |');
    lines.push('|----|-------|--------|------------|');
    for (const task of openTasks) {
      const parents = getTaskParents(task.id);
      const blockedBy = parents.length > 0 ? parents.join(', ') : '—';
      lines.push(`| ${task.id} | ${sanitizeMd(task.title)} | ${task.status} | ${blockedBy} |`);
    }
    lines.push('');
  }

  const closedTasks = tasks.filter((t) => t.status === 'closed');
  if (closedTasks.length > 0) {
    lines.push(`### Completed Tasks (${closedTasks.length})\n`);
    lines.push(closedTasks.map((t) => `- [x] ${t.id} — ${sanitizeMd(t.title)}`).join('\n'));
    lines.push('');
  }

  if (mems.length > 0) {
    lines.push('### Memories\n');
    for (const mem of mems) lines.push(`- ${sanitizeMd(mem.note)}`);
    lines.push('');
  }

  return lines.join('\n');
}

// ── Project deletion ───────────────────────────────────────────────────────────

const _deleteEventsByProject = db.prepare(
  'DELETE FROM terminal_events WHERE run_id IN (SELECT id FROM runs WHERE project_id = ?)',
);
const _deleteRunsByProject = db.prepare('DELETE FROM runs WHERE project_id = ?');
const _deleteSessionsByProject = db.prepare('DELETE FROM orchestrator_sessions WHERE project_id = ?');
const _deleteProjectById = db.prepare('DELETE FROM projects WHERE id = ?');
const _deleteTaskDepsByProject = db.prepare(
  'DELETE FROM task_deps WHERE child_id IN (SELECT id FROM tasks WHERE project_id = ?)',
);
const _deleteTasksByProject = db.prepare('DELETE FROM tasks WHERE project_id = ?');
const _deleteMemoriesByProject = db.prepare('DELETE FROM memories WHERE project_id = ?');

const _deleteProjectTransaction = db.transaction((projectId: string) => {
  _deleteEventsByProject.run(projectId);
  _deleteRunsByProject.run(projectId);
  _deleteSessionsByProject.run(projectId);
  _deleteTaskDepsByProject.run(projectId);
  _deleteTasksByProject.run(projectId);
  _deleteMemoriesByProject.run(projectId);
  _deleteProjectById.run(projectId);
});
export function deleteProject(id: string): void {
  _deleteProjectTransaction(id);
}
