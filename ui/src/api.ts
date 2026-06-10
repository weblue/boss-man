import type {
  AgentEvent,
  Task,
  Project,
  Run,
  Session,
  SessionDetail,
  SpecFile,
  TranscriptEntry,
} from './types';

// ── API key management ───────────────────────────────────────────────────────

const API_KEY_STORAGE = 'boss-man.apiKey';

export function getApiKey(): string | null {
  return localStorage.getItem(API_KEY_STORAGE);
}

export function setApiKey(key: string): void {
  localStorage.setItem(API_KEY_STORAGE, key);
}

export function clearApiKey(): void {
  localStorage.removeItem(API_KEY_STORAGE);
}

/** Returns Authorization header object for standard fetch calls. */
function authHeaders(): Record<string, string> {
  const key = getApiKey();
  return key ? { Authorization: `Bearer ${key}` } : {};
}

/**
 * Appends ?apiKey=<key> to a URL for use with EventSource.
 * Browser EventSource cannot send custom headers, so the key must go in the
 * query string for SSE endpoints.
 */
export function sseUrl(path: string): string {
  const key = getApiKey();
  if (!key) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}apiKey=${encodeURIComponent(key)}`;
}

// ── Fetch helpers ────────────────────────────────────────────────────────────

async function parseError(res: Response): Promise<string> {
  const t = await res.text().catch(() => res.statusText);
  if (!t) return res.statusText;
  try {
    const body = JSON.parse(t) as { error?: string };
    return body.error ?? t;
  } catch {
    return t;
  }
}

/** Fires a window event so the AuthGate in App.tsx can react to a 401. */
function dispatchUnauthorized(): void {
  window.dispatchEvent(new Event('boss-man:unauthorized'));
}

async function json<T>(res: Response): Promise<T> {
  if (res.status === 401) dispatchUnauthorized();
  if (!res.ok) throw new Error(`${res.status}: ${await parseError(res)}`);
  return res.json() as Promise<T>;
}

async function text(res: Response): Promise<string> {
  if (res.status === 401) dispatchUnauthorized();
  if (!res.ok) throw new Error(`${res.status}: ${await parseError(res)}`);
  return res.text();
}

// ── API functions ────────────────────────────────────────────────────────────

export async function listProjects(): Promise<Project[]> {
  return json<Project[]>(await fetch('/api/projects', { headers: authHeaders() }));
}

export async function getProject(id: string): Promise<Project> {
  return json<Project>(await fetch(`/api/projects/${encodeURIComponent(id)}`, { headers: authHeaders() }));
}

export async function createProject(payload: {
  name: string;
  description?: string;
  repoUrl?: string;
}): Promise<Project> {
  return json<Project>(
    await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(payload),
    }),
  );
}

export async function deleteProject(projectId: string): Promise<{ deleted: boolean }> {
  return json<{ deleted: boolean }>(
    await fetch(`/api/projects/${encodeURIComponent(projectId)}`, {
      method: 'DELETE',
      headers: authHeaders(),
    }),
  );
}

export async function listSessions(projectId: string): Promise<Session[]> {
  return json<Session[]>(
    await fetch(`/api/projects/${encodeURIComponent(projectId)}/sessions`, { headers: authHeaders() }),
  );
}

export async function getSession(id: string): Promise<SessionDetail> {
  return json<SessionDetail>(
    await fetch(`/api/sessions/${encodeURIComponent(id)}`, { headers: authHeaders() }),
  );
}

export async function getSessionTranscript(id: string): Promise<TranscriptEntry[]> {
  return json<TranscriptEntry[]>(
    await fetch(`/api/sessions/${encodeURIComponent(id)}/transcript`, { headers: authHeaders() }),
  );
}

export async function startSession(
  projectId: string,
  payload: { message: string; model?: string; name?: string },
): Promise<{ session: Session; run: Run }> {
  return json<{ session: Session; run: Run }>(
    await fetch(`/api/projects/${encodeURIComponent(projectId)}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({
        message: payload.message,
        model: payload.model,
        name: payload.name,
      }),
    }),
  );
}

export async function replyToSession(
  sessionId: string,
  message: string,
  options?: { model?: string },
): Promise<{ session: Session; run: Run }> {
  return json<{ session: Session; run: Run }>(
    await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ message, ...(options?.model ? { model: options.model } : {}) }),
    }),
  );
}

export async function deleteSession(sessionId: string): Promise<{ deleted: boolean }> {
  return json<{ deleted: boolean }>(
    await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
      headers: authHeaders(),
    }),
  );
}

export async function patchSession(
  sessionId: string,
  updates: { status?: string; name?: string },
): Promise<Session> {
  return json<Session>(
    await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(updates),
    }),
  );
}

export async function compactSession(sessionId: string): Promise<{ session: Session }> {
  return json<{ session: Session }>(
    await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/compact`, {
      method: 'POST',
      headers: authHeaders(),
    }),
  );
}

export async function listRuns(projectId: string): Promise<Run[]> {
  return json<Run[]>(
    await fetch(`/api/projects/${encodeURIComponent(projectId)}/runs`, { headers: authHeaders() }),
  );
}

export async function getRun(runId: string): Promise<Run> {
  return json<Run>(await fetch(`/api/runs/${encodeURIComponent(runId)}`, { headers: authHeaders() }));
}

export async function getRunEvents(runId: string): Promise<AgentEvent[]> {
  return json<AgentEvent[]>(
    await fetch(`/api/runs/${encodeURIComponent(runId)}/events/history`, { headers: authHeaders() }),
  );
}

export async function cancelRun(runId: string): Promise<{ cancelled: boolean }> {
  return json<{ cancelled: boolean }>(
    await fetch(`/api/runs/${encodeURIComponent(runId)}`, {
      method: 'DELETE',
      headers: authHeaders(),
    }),
  );
}

export async function mergeToMain(
  projectId: string,
  branch: string,
): Promise<{ merged: boolean; output: string }> {
  return json<{ merged: boolean; output: string }>(
    await fetch(`/api/projects/${encodeURIComponent(projectId)}/merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ branch }),
    }),
  );
}

export async function listTasks(projectId: string): Promise<Task[]> {
  return json<Task[]>(
    await fetch(`/api/tasks?projectId=${encodeURIComponent(projectId)}`, { headers: authHeaders() }),
  );
}

export async function listModels(): Promise<string[]> {
  try {
    const data = await json<{ models: string[] }>(
      await fetch('/api/models', { headers: authHeaders() }),
    );
    return data.models ?? [];
  } catch {
    return [];
  }
}

export async function listSpecs(projectId: string): Promise<SpecFile[]> {
  return json<SpecFile[]>(
    await fetch(`/api/projects/${encodeURIComponent(projectId)}/specs`, { headers: authHeaders() }),
  );
}

export async function readSpec(projectId: string, file: string): Promise<string> {
  return text(
    await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/specs/${encodeURIComponent(file)}`,
      { headers: authHeaders() },
    ),
  );
}
