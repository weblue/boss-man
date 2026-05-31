import type {
  AgentEvent,
  BeadsTask,
  Project,
  Run,
  Session,
  SessionDetail,
  SpecFile,
  TranscriptEntry,
} from './types';

async function parseError(res: Response): Promise<string> {
  const text = await res.text().catch(() => res.statusText);
  if (!text) return res.statusText;
  try {
    const json = JSON.parse(text) as { error?: string };
    return json.error ?? text;
  } catch {
    return text;
  }
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status}: ${await parseError(res)}`);
  return res.json() as Promise<T>;
}

async function text(res: Response): Promise<string> {
  if (!res.ok) throw new Error(`${res.status}: ${await parseError(res)}`);
  return res.text();
}

export function eventUrl(path: string): string {
  return path;
}

export async function listProjects(): Promise<Project[]> {
  return json<Project[]>(await fetch('/api/projects'));
}

export async function getProject(id: string): Promise<Project> {
  return json<Project>(await fetch(`/api/projects/${encodeURIComponent(id)}`));
}

export async function createProject(payload: {
  name: string;
  description?: string;
  repoUrl?: string;
}): Promise<Project> {
  return json<Project>(
    await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  );
}

export async function listSessions(projectId: string): Promise<Session[]> {
  return json<Session[]>(await fetch(`/api/projects/${encodeURIComponent(projectId)}/sessions`));
}

export async function getSession(id: string): Promise<SessionDetail> {
  return json<SessionDetail>(await fetch(`/api/sessions/${encodeURIComponent(id)}`));
}

export async function getSessionTranscript(id: string): Promise<TranscriptEntry[]> {
  return json<TranscriptEntry[]>(await fetch(`/api/sessions/${encodeURIComponent(id)}/transcript`));
}

export async function startSession(projectId: string, payload: {
  message: string;
  model?: string;
  name?: string;
}): Promise<{
  session: Session;
  run: Run;
}> {
  return json<{ session: Session; run: Run }>(
    await fetch(`/api/projects/${encodeURIComponent(projectId)}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: payload.message,
        model: payload.model,
        name: payload.name,
        // agentProvider and claudeAuthProvider are determined by the server
        // based on the model profile selected at boot time (start.sh).
      }),
    }),
  );
}

export async function replyToSession(
  sessionId: string,
  message: string,
  options?: { model?: string },
): Promise<{
  session: Session;
  run: Run;
}> {
  return json<{ session: Session; run: Run }>(
    await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, ...(options?.model ? { model: options.model } : {}) }),
    }),
  );
}

export async function listRuns(projectId: string): Promise<Run[]> {
  return json<Run[]>(await fetch(`/api/projects/${encodeURIComponent(projectId)}/runs`));
}

export async function getRun(runId: string): Promise<Run> {
  return json<Run>(await fetch(`/api/runs/${encodeURIComponent(runId)}`));
}

export async function getRunEvents(runId: string): Promise<AgentEvent[]> {
  return json<AgentEvent[]>(await fetch(`/api/runs/${encodeURIComponent(runId)}/events/history`));
}

export async function cancelRun(runId: string): Promise<{ cancelled: boolean }> {
  return json<{ cancelled: boolean }>(
    await fetch(`/api/runs/${encodeURIComponent(runId)}`, { method: 'DELETE' }),
  );
}

export async function deleteSession(sessionId: string): Promise<{ deleted: boolean }> {
  return json<{ deleted: boolean }>(
    await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }),
  );
}

export async function listTasks(): Promise<BeadsTask[] | string> {
  const res = await fetch('/api/beads/tasks');
  if (!res.ok) throw new Error(`${res.status}: ${await parseError(res)}`);
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) return res.json() as Promise<BeadsTask[]>;
  return res.text();
}

export async function listModels(): Promise<string[]> {
  const res = await fetch('/api/models');
  if (!res.ok) return [];
  const data = await res.json() as { models: string[] };
  return data.models ?? [];
}

export async function listSpecs(projectId: string): Promise<SpecFile[]> {
  return json<SpecFile[]>(await fetch(`/api/projects/${encodeURIComponent(projectId)}/specs`));
}

export async function readSpec(projectId: string, file: string): Promise<string> {
  return text(await fetch(`/api/projects/${encodeURIComponent(projectId)}/specs/${encodeURIComponent(file)}`));
}
