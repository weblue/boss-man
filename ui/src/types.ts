export interface Project {
  id: string;
  name: string;
  repo_path: string;
  description: string | null;
  beads_db: string | null;
  created_at: number;
}

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

export interface Session {
  id: string;
  project_id: string;
  name: string | null;
  status: string;
  current_run_id: string | null;
  created_at: number;
}

export interface SessionDetail extends Session {
  currentRun: Run | null;
  runs: Run[];
}

export interface AgentEvent {
  /** Stable autoincrement DB row id. Present on persisted events and live events after the server embeds it.
   *  Used for deduplication when persisted replay and live stream overlap. */
  seq?: number;
  type: 'text' | 'toolCall' | 'toolResult' | 'iteration' | 'usage' | 'status' | 'error' | 'done';
  text?: string;
  toolName?: string;
  iteration?: number;
  data?: unknown;
  timestamp: string;
}

export interface SpecFile {
  name: string;
  path: string;
  last_commit_at: number | null;
}

export interface Task {
  id: string;
  title: string;
  body: string;
  status: string;
  blocked_by: string | null;
  claimed_by: string | null;
}

export interface TranscriptEntry {
  run: Run;
  events: AgentEvent[];
}
