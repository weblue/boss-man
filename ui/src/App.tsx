import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark.css';
import {
  Bot,
  Check,
  ChevronDown,
  Clock3,
  GitMerge,
  FileText,
  FolderGit2,
  History,
  KanbanSquare,
  Loader2,
  MessageSquare,
  Plus,
  RefreshCw,
  Search,
  Send,
  Square,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import {
  cancelRun,
  compactSession,
  createProject,
  deleteProject,
  deleteSession,
  mergeToMain,
  patchSession,
  getProject,
  getRun,
  getRunEvents,
  getSession,
  getSessionTranscript,
  listModels,
  listProjects,
  listRuns,
  listSessions,
  listSpecs,
  listTasks,
  readSpec,
  replyToSession,
  startSession,
} from './api';
import type { AgentEvent, BeadsTask, Project, Run, Session } from './types';

const TERMINAL_STATUSES = new Set(['completed', 'complete', 'failed', 'cancelled']);
const ACTIVE_STATUSES = new Set(['queued', 'running']);
const COLORS = ['#58a6ff', '#3fb950', '#d29922', '#f85149', '#a371f7', '#39c5cf', '#ff7b72'];
const DEFAULT_ORCHESTRATOR_MODEL = 'boss-man/high';

function isTerminal(status?: string | null): boolean {
  return !!status && TERMINAL_STATUSES.has(status);
}

function isActive(status?: string | null): boolean {
  return !!status && ACTIVE_STATUSES.has(status);
}

function accentFor(id: string): string {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return COLORS[hash % COLORS.length];
}

function formatDate(ms: number | null | undefined): string {
  if (!ms) return 'not started';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(ms));
}

function formatDuration(start: number | null, end: number | null): string {
  if (!start) return '0s';
  const seconds = Math.max(0, Math.floor(((end ?? Date.now()) - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function classNames(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}

function eventKey(event: AgentEvent): string {
  // Prefer the stable DB sequence number; fall back to content hash for events
  // that predate the seq field or arrive from a server that doesn't emit it.
  if (event.seq != null) return `seq:${event.seq}`;
  return `${event.timestamp}:${event.type}:${event.toolName ?? ''}:${event.text ?? ''}`;
}

function parseSpawnWorkerRole(text: string): string | null {
  const m = text.match(/--role\s+(\S+)/);
  return m ? m[1] : null;
}

function mergeEvents(persisted: AgentEvent[] = [], live: AgentEvent[] = []): AgentEvent[] {
  const seen = new Set<string>();
  return [...persisted, ...live].filter((event) => {
    const key = eventKey(event);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function useEventStream(path: string | null, onEvent: (event: AgentEvent) => void): void {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!path) return;
    const source = new EventSource(path);

    source.onmessage = (message) => {
      try {
        onEventRef.current(JSON.parse(message.data as string) as AgentEvent);
      } catch {
        // Ignore malformed stream frames.
      }
    };
    source.onerror = () => source.close();

    return () => source.close();
  }, [path]);
}

/** Maps a run role to a human-readable TDD lifecycle phase label */
const ROLE_PHASE: Record<string, string> = {
  orchestrator: '',          // use session.status instead
  researcher:        'researching',
  test_generator:    'writing tests',
  implementer:       'implementing',
  reviewer:          'reviewing',
  security_reviewer: 'security review',
  refactor:          'refactoring',
};

/**
 * Derives a display label for a session based on its active worker runs.
 * When a non-orchestrator worker is running, shows the TDD phase instead of
 * the generic session status so the user can see where in the pipeline things are.
 */
function sessionPhaseLabel(session: Session, projectRuns: Run[]): string {
  const sessionRuns = projectRuns.filter((r) => r.orchestrator_session_id === session.id);
  const active = sessionRuns.find((r) => r.status === 'queued' || r.status === 'running');
  if (active && active.role !== 'orchestrator') {
    return ROLE_PHASE[active.role] ?? active.role;
  }
  return session.status;
}

function StatusBadge({ status, pulse }: { status: string; pulse?: boolean }) {
  const color =
    status === 'running' || status === 'completed' || status === 'complete'
      ? 'text-green'
      : status === 'failed'
        ? 'text-red'
        : status === 'queued' || status === 'planning'
          ? 'text-orange'
          : status === 'researching' || status === 'writing tests' || status === 'implementing' ||
            status === 'reviewing' || status === 'security review' || status === 'refactoring'
            ? 'text-blue'
            : 'text-text-muted';

  const isPulsing = pulse ?? (status === 'running' || status === 'queued' ||
    status === 'researching' || status === 'writing tests' || status === 'implementing' ||
    status === 'reviewing' || status === 'security review' || status === 'refactoring');

  return (
    <span className="inline-flex items-center gap-1 text-xs">
      <span className={classNames(color, isPulsing && 'animate-pulse')}>•</span>
      <span className={color}>{status}</span>
    </span>
  );
}

function ThinkingIndicator() {
  return (
    <div className="flex items-center gap-1 pt-1">
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-text-muted [animation-delay:0ms]" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-text-muted [animation-delay:150ms]" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-text-muted [animation-delay:300ms]" />
    </div>
  );
}

function Sidebar({ projects }: { projects: Project[] }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [repoUrl, setRepoUrl] = useState('');

  const createMutation = useMutation({
    mutationFn: createProject,
    onSuccess: (project) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      setCreating(false);
      setName('');
      setDescription('');
      setRepoUrl('');
      navigate(`/projects/${project.id}/chat`);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (projectId: string) => deleteProject(projectId),
    onSuccess: (_, projectId) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      if (window.location.pathname.includes(projectId)) navigate('/');
    },
  });

  const filteredProjects = projects.filter((project) => {
    const value = `${project.name} ${project.description ?? ''} ${project.repo_path}`.toLowerCase();
    return value.includes(query.trim().toLowerCase());
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    createMutation.mutate({
      name: name.trim(),
      description: description.trim() || undefined,
      repoUrl: repoUrl.trim() || undefined,
    });
  };

  return (
    <aside className="flex h-full w-[320px] shrink-0 flex-col border-r border-border bg-surface">
      <div className="flex items-center justify-between border-b border-border px-3 py-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
          <Bot size={17} />
          <span>boss-man</span>
        </div>
        <button className="icon-button" title="New project" onClick={() => setCreating(true)}>
          <Plus size={15} />
        </button>
      </div>

      <div className="border-b border-border p-3">
        <div className="relative">
          <Search className="absolute left-2 top-2.5 text-text-muted" size={14} />
          <input
            className="field pl-8"
            placeholder="Search projects..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      </div>

      {creating && (
        <form className="border-b border-border bg-base p-3" onSubmit={submit}>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold text-text-primary">New project</span>
            <button className="icon-button h-7 w-7" type="button" title="Close" onClick={() => setCreating(false)}>
              <X size={14} />
            </button>
          </div>
          <div className="flex flex-col gap-2">
            <input className="field" placeholder="Name" value={name} onChange={(event) => setName(event.target.value)} />
            <textarea
              className="field min-h-20 resize-none"
              placeholder="Description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
            <input className="field" placeholder="Repo URL" value={repoUrl} onChange={(event) => setRepoUrl(event.target.value)} />
            {createMutation.error && (
              <span className="text-xs text-red">{createMutation.error.message}</span>
            )}
            <button
              className="inline-flex h-8 items-center justify-center gap-2 rounded border border-blue/60 bg-blue/10 px-3 text-xs text-blue transition-colors hover:bg-blue/20 disabled:opacity-50"
              disabled={createMutation.isPending}
            >
              {createMutation.isPending ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
              Create
            </button>
          </div>
        </form>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="border-b border-border bg-elevated/30 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-text-muted">
          Projects
        </div>
        {filteredProjects.length === 0 ? (
          <div className="px-3 py-4 text-xs text-text-muted">No projects.</div>
        ) : (
          filteredProjects.map((project) => (
            <NavLink
              key={project.id}
              to={`/projects/${project.id}/chat`}
              className={({ isActive }) =>
                classNames(
                  'group block border-b border-border border-l-2 px-3 py-3 transition-colors hover:bg-elevated/50',
                  isActive ? 'bg-elevated' : 'border-l-transparent',
                )
              }
              style={({ isActive }) => ({
                borderLeftColor: isActive ? accentFor(project.id) : 'transparent',
              })}
            >
              <div className="flex items-center gap-2">
                <FolderGit2 size={15} className="shrink-0 text-text-muted" />
                <span className="min-w-0 flex-1 truncate text-xs font-semibold text-text-primary">{project.name}</span>
                <button
                  className="icon-button h-6 w-6 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
                  title="Delete project"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (window.confirm(`Delete "${project.name}" and all its sessions, runs, and events? The repo on disk is kept. This cannot be undone.`)) {
                      deleteMutation.mutate(project.id);
                    }
                  }}
                >
                  <Trash2 size={12} />
                </button>
              </div>
              <div className="mt-1 truncate text-xs text-text-muted">{project.description ?? project.repo_path}</div>
            </NavLink>
          ))
        )}
      </div>
    </aside>
  );
}

function Home({ projects }: { projects: Project[] }) {
  if (projects[0]) return <Navigate to={`/projects/${projects[0].id}/chat`} replace />;
  return (
    <div className="flex flex-1 items-center justify-center text-xs text-text-muted">
      Create a project to start.
    </div>
  );
}

function ProjectRoute() {
  const { projectId, tab = 'chat' } = useParams();
  if (!projectId) return <Navigate to="/" replace />;

  const projectQuery = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => getProject(projectId),
  });

  if (projectQuery.isLoading) {
    return (
      <main className="flex flex-1 items-center justify-center text-text-muted">
        <Loader2 className="animate-spin" size={18} />
      </main>
    );
  }

  if (projectQuery.error || !projectQuery.data) {
    return <main className="flex flex-1 items-center justify-center text-xs text-red">Project unavailable.</main>;
  }

  const project = projectQuery.data;
  const tabs = [
    { id: 'chat', label: 'Chat', icon: MessageSquare },
    { id: 'tasks', label: 'Tasks', icon: KanbanSquare },
    { id: 'runs', label: 'Runs', icon: History },
    { id: 'spec', label: 'Spec', icon: FileText },
  ];

  const accent = accentFor(project.id);

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <header className="shrink-0 border-b border-border bg-surface">
        {/* Full-width accent bar — project identity stripe */}
        <div className="h-1 w-full" style={{ backgroundColor: accent }} />
        <div className="flex items-center gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-text-primary">{project.name}</div>
            <div className="truncate text-xs text-text-muted">{project.repo_path}</div>
          </div>
        </div>
        <nav className="flex px-2">
          {tabs.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.id}
                to={`/projects/${project.id}/${item.id}`}
                className={({ isActive }) => classNames('tab', isActive && 'tab-active')}
                style={({ isActive }) => isActive ? { borderBottomColor: accent } : undefined}
              >
                <Icon size={14} />
                {item.label}
              </NavLink>
            );
          })}
        </nav>
      </header>

      <section className="min-h-0 flex-1 overflow-hidden">
        {tab === 'chat' && <ChatTab project={project} />}
        {tab === 'tasks' && <TasksTab project={project} />}
        {tab === 'runs' && <RunsTab project={project} />}
        {tab === 'spec' && <SpecTab project={project} />}
        {!['chat', 'tasks', 'runs', 'spec'].includes(tab) && <Navigate to={`/projects/${project.id}/chat`} replace />}
      </section>
    </main>
  );
}

function ChatTab({ project }: { project: Project }) {
  const queryClient = useQueryClient();
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [newSessionDraft, setNewSessionDraft] = useState('');
  const [orchestratorModel, setOrchestratorModel] = useState(() => {
    return window.localStorage.getItem('boss-man.orchestratorModel') ?? DEFAULT_ORCHESTRATOR_MODEL;
  });
  const [eventsByRun, setEventsByRun] = useState<Record<string, AgentEvent[]>>({});
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  const modelsQuery = useQuery({
    queryKey: ['models'],
    queryFn: listModels,
    staleTime: 60_000,
  });
  const availableModels = modelsQuery.data ?? [];
  // Always show tier aliases at the top; deduplicate in case LiteLLM also returns them.
  const TIER_MODELS = ['boss-man/high', 'boss-man/medium', 'boss-man/low'];
  const allModels = [...TIER_MODELS, ...availableModels.filter(m => !TIER_MODELS.includes(m))];

  const sessionsQuery = useQuery({
    queryKey: ['sessions', project.id],
    queryFn: () => listSessions(project.id),
    refetchInterval: 5000,
  });

  useEffect(() => {
    if (!selectedSessionId && sessionsQuery.data?.[0]) setSelectedSessionId(sessionsQuery.data[0].id);
  }, [selectedSessionId, sessionsQuery.data]);

  const sessionQuery = useQuery({
    queryKey: ['session', selectedSessionId],
    queryFn: () => getSession(selectedSessionId!),
    enabled: !!selectedSessionId,
    refetchInterval: (query) => (isActive(query.state.data?.currentRun?.status) ? 2000 : false),
  });

  const currentRun = sessionQuery.data?.currentRun ?? null;
  const currentRunId = currentRun?.id ?? null;
  const streamPath = selectedSessionId && currentRun && isActive(currentRun.status)
    ? `/api/sessions/${selectedSessionId}/events`
    : null;

  const transcriptQuery = useQuery({
    queryKey: ['session-transcript', selectedSessionId],
    queryFn: () => getSessionTranscript(selectedSessionId!),
    enabled: !!selectedSessionId,
  });

  const allRunsQuery = useQuery({
    queryKey: ['runs', project.id],
    queryFn: () => listRuns(project.id),
    // Poll every 5s so the TDD phase badge updates as workers spin up/down.
    refetchInterval: 5000,
  });

  const deleteMutation = useMutation({
    mutationFn: (sessionId: string) => deleteSession(sessionId),
    onSuccess: (_, sessionId) => {
      if (selectedSessionId === sessionId) setSelectedSessionId(null);
      queryClient.invalidateQueries({ queryKey: ['sessions', project.id] });
      queryClient.invalidateQueries({ queryKey: ['runs', project.id] });
    },
  });

  const setStatusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => patchSession(id, { status }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sessions', project.id] });
      queryClient.invalidateQueries({ queryKey: ['session', selectedSessionId] });
    },
  });

  const compactMutation = useMutation({
    mutationFn: (sessionId: string) => compactSession(sessionId),
    onSuccess: (result) => {
      setSelectedSessionId(result.session.id);
      queryClient.invalidateQueries({ queryKey: ['sessions', project.id] });
      queryClient.invalidateQueries({ queryKey: ['session', result.session.id] });
      queryClient.invalidateQueries({ queryKey: ['runs', project.id] });
    },
  });

  useEventStream(streamPath, (event) => {
    if (!currentRunId) return;
    setEventsByRun((prev) => ({
      ...prev,
      [currentRunId]: [...(prev[currentRunId] ?? []), event],
    }));
    if (event.type === 'done' || event.type === 'error') {
      queryClient.invalidateQueries({ queryKey: ['session', selectedSessionId] });
      queryClient.invalidateQueries({ queryKey: ['session-transcript', selectedSessionId] });
      queryClient.invalidateQueries({ queryKey: ['sessions', project.id] });
      queryClient.invalidateQueries({ queryKey: ['runs', project.id] });
    }
  });

  useEffect(() => {
    scrollerRef.current?.scrollTo({ top: scrollerRef.current.scrollHeight });
  }, [currentRunId, eventsByRun, transcriptQuery.data]);

  const startMutation = useMutation({
    mutationFn: (payload: { message: string; model: string }) => startSession(project.id, payload),
    onSuccess: (result) => {
      setSelectedSessionId(result.session.id);
      setNewSessionDraft('');
      queryClient.invalidateQueries({ queryKey: ['sessions', project.id] });
      queryClient.invalidateQueries({ queryKey: ['session-transcript', result.session.id] });
      queryClient.invalidateQueries({ queryKey: ['runs', project.id] });
    },
  });

  const cancelCurrentMutation = useMutation({
    mutationFn: () => cancelRun(currentRunId!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['session', selectedSessionId] });
      queryClient.invalidateQueries({ queryKey: ['sessions', project.id] });
      queryClient.invalidateQueries({ queryKey: ['runs', project.id] });
    },
  });

  const replyMutation = useMutation({
    mutationFn: ({ message, model }: { message: string; model: string }) =>
      replyToSession(selectedSessionId!, message, { model }),
    onSuccess: (result) => {
      setSelectedSessionId(result.session.id);
      setDraft('');
      queryClient.invalidateQueries({ queryKey: ['session', selectedSessionId] });
      queryClient.invalidateQueries({ queryKey: ['session-transcript', selectedSessionId] });
      queryClient.invalidateQueries({ queryKey: ['sessions', project.id] });
      queryClient.invalidateQueries({ queryKey: ['runs', project.id] });
    },
  });

  // Only allow reply when the run completed cleanly or was cancelled by the user.
  // Failed runs are excluded: the user sees an error notice and must acknowledge
  // it before sending a new message (which will start fresh or resume from the
  // last successful turn depending on available session state).
  const canReply = !!selectedSessionId && !!currentRun &&
    (currentRun.status === 'completed' || currentRun.status === 'cancelled');
  const transcript = transcriptQuery.data ?? (sessionQuery.data?.runs ?? []).map((run) => ({ run, events: [] }));

  const submitNewSession = (event: FormEvent) => {
    event.preventDefault();
    if (!newSessionDraft.trim()) return;
    startMutation.mutate({
      message: newSessionDraft.trim(),
      model: orchestratorModel.trim() || DEFAULT_ORCHESTRATOR_MODEL,
    });
  };

  const updateModel = (model: string) => {
    setOrchestratorModel(model);
    window.localStorage.setItem('boss-man.orchestratorModel', model);
  };

  const submitReply = (event: FormEvent) => {
    event.preventDefault();
    if (!draft.trim() || !canReply) return;
    replyMutation.mutate({ message: draft.trim(), model: orchestratorModel });
  };

  const handleReplyKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!draft.trim() || !canReply) return;
      replyMutation.mutate({ message: draft.trim(), model: orchestratorModel });
    }
  };

  return (
    <div className="flex h-full overflow-hidden">
      <div className="flex w-[300px] shrink-0 flex-col border-r border-border bg-base">
        <div className="border-b border-border px-3 py-2 text-[10px] font-semibold uppercase tracking-widest text-text-muted">
          Sessions
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {(sessionsQuery.data ?? []).map((session) => (
            <button
              key={session.id}
              className={classNames(
                'group w-full border-b border-border border-l-2 px-3 py-3 text-left transition-colors hover:bg-elevated/50',
                selectedSessionId === session.id && 'bg-elevated',
              )}
              style={{ borderLeftColor: selectedSessionId === session.id ? accentFor(project.id) : 'transparent' }}
              onClick={() => setSelectedSessionId(session.id)}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-xs font-semibold text-text-primary">{session.name ?? `Session ${session.id.slice(0, 8)}`}</span>
                <div className="flex shrink-0 items-center gap-1">
                  <StatusBadge status={sessionPhaseLabel(session, allRunsQuery.data ?? [])} />
                  {session.status !== 'complete' && (
                    <button
                      className="shrink-0 rounded p-0.5 text-text-muted opacity-0 transition-opacity hover:text-blue group-hover:opacity-100"
                      title="Compact context — starts fresh run seeded from checkpoint.md"
                      disabled={compactMutation.isPending}
                      onClick={(e) => {
                        e.stopPropagation();
                        compactMutation.mutate(session.id);
                      }}
                    >
                      <RefreshCw size={12} />
                    </button>
                  )}
                  {session.status !== 'complete' && (
                    <button
                      className="shrink-0 rounded p-0.5 text-text-muted opacity-0 transition-opacity hover:text-green group-hover:opacity-100"
                      title="Mark complete"
                      onClick={(e) => {
                        e.stopPropagation();
                        setStatusMutation.mutate({ id: session.id, status: 'complete' });
                      }}
                    >
                      <Check size={12} />
                    </button>
                  )}
                  <button
                    className="shrink-0 rounded p-0.5 text-text-muted opacity-0 transition-opacity hover:text-red group-hover:opacity-100"
                    title="Delete session"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (window.confirm('Delete this session and all its runs? This cannot be undone.')) {
                        deleteMutation.mutate(session.id);
                      }
                    }}
                  >
                    <X size={12} />
                  </button>
                </div>
              </div>
              <div className="mt-1 text-xs text-text-muted">{formatDate(session.created_at)}</div>
            </button>
          ))}
          {sessionsQuery.data?.length === 0 && <div className="px-3 py-4 text-xs text-text-muted">No sessions.</div>}
        </div>
        <form className="border-t border-border p-3" onSubmit={submitNewSession}>
          <select
            className="field mb-2"
            value={orchestratorModel}
            disabled={startMutation.isPending}
            onChange={(e) => updateModel(e.target.value)}
          >
            {allModels.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
          <textarea
            className="field min-h-24 resize-none"
            placeholder="Initial spec..."
            value={newSessionDraft}
            onChange={(event) => setNewSessionDraft(event.target.value)}
          />
          {startMutation.error && <div className="mt-2 text-xs text-red">{startMutation.error.message}</div>}
          <button
            className="mt-2 inline-flex h-8 w-full items-center justify-center gap-2 rounded border border-blue/60 bg-blue/10 px-3 text-xs text-blue transition-colors hover:bg-blue/20 disabled:opacity-50"
            disabled={startMutation.isPending}
          >
            {startMutation.isPending ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
            Start
          </button>
        </form>
      </div>

      <div className="flex min-w-0 flex-1 flex-col bg-base">
        {/* Token budget bar — shown whenever a session is selected and has run data */}
        {sessionQuery.data && sessionQuery.data.runs.length > 0 && (() => {
          const runs = sessionQuery.data.runs;
          const totals = runs.reduce(
            (acc, r) => ({
              input: acc.input + r.total_input_tokens,
              output: acc.output + r.total_output_tokens,
              cacheNew: acc.cacheNew + r.total_cache_creation_tokens,
              cacheRead: acc.cacheRead + r.total_cache_read_tokens,
            }),
            { input: 0, output: 0, cacheNew: 0, cacheRead: 0 },
          );
          const fmt = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
          return (
            <div className="grid shrink-0 grid-cols-4 gap-px border-b border-border bg-border">
              {([
                ['input', totals.input],
                ['output', totals.output],
                ['cache new', totals.cacheNew],
                ['cache read', totals.cacheRead],
              ] as [string, number][]).map(([label, value]) => (
                <div key={label} className="bg-surface px-3 py-2">
                  <div className="text-[10px] uppercase tracking-widest text-text-muted">{label}</div>
                  <div className="mt-0.5 text-xs text-text-primary">{fmt(value)}</div>
                </div>
              ))}
            </div>
          );
        })()}
        <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {!selectedSessionId ? (
            <div className="text-xs text-text-muted">Select or start a session.</div>
          ) : sessionQuery.isLoading ? (
            <Loader2 className="animate-spin text-text-muted" size={18} />
          ) : currentRun ? (
            <div className="mx-auto flex max-w-4xl flex-col gap-4">
              {transcript.map(({ run, events }) => {
                const runEvents = mergeEvents(events, eventsByRun[run.id]);
                const assistantText = runEvents
                  .filter((event) => event.type === 'text' && event.text)
                  .map((event) => event.text)
                  .join('')
                  // Replace the completion signal with a visual separator so it
                  // doesn't appear as a raw XML tag in the rendered markdown.
                  .replace(/<task-complete\/>/g, '\n\n---');
                const toolEvents = runEvents.filter((event) => event.type === 'toolCall');
                const running = isActive(run.status);

                return (
                  <div key={run.id} className="flex flex-col gap-4">
                    <div className="flex justify-end">
                      <div className="max-w-[760px] rounded border border-border bg-elevated px-4 py-3">
                        <div className="mb-2 text-[10px] uppercase tracking-widest text-text-muted">You</div>
                        <ReactMarkdown className="markdown" rehypePlugins={[rehypeHighlight]}>{run.prompt}</ReactMarkdown>
                      </div>
                    </div>
                    <div className="flex justify-start">
                      <div className="max-w-[820px] rounded border border-border bg-surface px-4 py-3">
                        <div className="mb-2 flex items-center justify-between gap-3">
                          <span className="truncate text-[10px] uppercase tracking-widest text-text-muted">
                            Orchestrator · {run.agent_provider} · {run.claude_auth_provider} · {run.model}
                          </span>
                          <StatusBadge status={run.status} />
                        </div>
                        {assistantText ? (
                          <ReactMarkdown className="markdown" rehypePlugins={[rehypeHighlight]}>{assistantText}</ReactMarkdown>
                        ) : run.error ? (
                          <div className="text-xs text-red">{run.error}</div>
                        ) : (
                          <div className="flex items-center gap-2 text-xs text-text-muted">
                            {running && <Loader2 size={14} className="animate-spin" />}
                            Waiting for output.
                          </div>
                        )}
                        {toolEvents.length > 0 && (
                          <div className="mt-3 border-t border-border pt-3">
                            {toolEvents.slice(-6).map((event, index) => (
                              <div key={`${event.timestamp}-${index}`}>
                                <button
                                  className="flex w-full items-start gap-1.5 text-left text-xs text-text-muted hover:text-text-primary"
                                  onClick={() => setExpandedTools(prev => {
                                    const next = new Set(prev);
                                    const k = eventKey(event);
                                    next.has(k) ? next.delete(k) : next.add(k);
                                    return next;
                                  })}
                                >
                                  <span className="mt-0.5 shrink-0 font-mono text-blue">$</span>
                                  <span className="flex-1 truncate font-mono">{event.toolName}</span>
                                  <ChevronDown size={11} className={classNames('mt-0.5 shrink-0 transition-transform', expandedTools.has(eventKey(event)) && 'rotate-180')} />
                                </button>
                                {expandedTools.has(eventKey(event)) && event.text && (
                                  <pre className="mt-1 overflow-x-auto rounded bg-base px-2 py-1 text-[10px] leading-4 text-text-muted">
                                    {event.text}
                                  </pre>
                                )}
                              </div>
                            ))}
                            {(() => {
                              const allRuns = allRunsQuery.data ?? [];
                              const spawnEvents = toolEvents.filter(
                                (event) => event.toolName === 'Bash' && event.text?.includes('spawn-worker'),
                              );
                              const workerRuns = spawnEvents.flatMap((event) => {
                                const role = parseSpawnWorkerRole(event.text ?? '');
                                if (!role) return [];
                                const eventTime = Date.parse(event.timestamp);
                                return allRuns.filter(
                                  (wr) =>
                                    wr.project_id === project.id &&
                                    wr.role === role &&
                                    wr.orchestrator_session_id === null &&
                                    wr.created_at >= eventTime - 10_000,
                                );
                              });
                              if (workerRuns.length === 0) return null;
                              return (
                                <div className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3">
                                  {workerRuns.map((wr) => (
                                    <Link
                                      key={wr.id}
                                      to={`/projects/${project.id}/runs?run=${wr.id}`}
                                      className="inline-flex items-center gap-1.5 rounded border border-border bg-elevated px-2 py-1 text-xs text-text-muted transition-colors hover:text-text-primary"
                                    >
                                      <Terminal size={11} />
                                      <span>{wr.role}</span>
                                      <StatusBadge status={wr.status} />
                                    </Link>
                                  ))}
                                </div>
                              );
                            })()}
                          </div>
                        )}
                        {running && <ThinkingIndicator />}
                      </div>
                    </div>
                  </div>
                );
              })}
              {transcript.length === 0 && (
                <div className="text-xs text-text-muted">No transcript events yet.</div>
              )}
            </div>
          ) : (
            <div className="text-xs text-text-muted">No current run.</div>
          )}
        </div>

        <div className="shrink-0 border-t border-border bg-surface">
          {/* Model picker + cancel-and-switch row */}
          <div className="flex items-center gap-2 border-b border-border/50 px-3 py-1.5">
            <span className="shrink-0 text-[10px] uppercase tracking-widest text-text-muted">model</span>
            <select
              className="field h-6 min-w-0 flex-1 py-0 text-xs"
              value={orchestratorModel}
              onChange={(e) => updateModel(e.target.value)}
            >
              {allModels.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
            {selectedSessionId && currentRun && isActive(currentRun.status) && (
              <button
                className="inline-flex shrink-0 items-center gap-1 rounded border border-red/40 bg-red/10 px-2 py-0.5 text-[10px] text-red transition-colors hover:bg-red/20 disabled:opacity-50"
                title="Cancel the current run — your next reply will resume with the selected model"
                disabled={cancelCurrentMutation.isPending}
                onClick={() => cancelCurrentMutation.mutate()}
              >
                <Square size={9} />
                cancel &amp; switch
              </button>
            )}
          </div>
          {/* Failed-run notice — shown instead of the reply form when the last run errored */}
          {currentRun?.status === 'failed' && (
            <div className="border-b border-red/20 bg-red/5 px-3 py-2">
              <p className="mb-1 text-xs font-medium text-red">Run failed</p>
              <p className="text-[11px] text-text-muted leading-relaxed">
                {currentRun.error ?? 'The run ended with an error.'}
              </p>
              <button
                className="mt-2 rounded border border-red/30 bg-red/10 px-2 py-0.5 text-[10px] text-red hover:bg-red/20"
                onClick={() => replyMutation.mutate({ message: draft.trim() || 'Please retry.', model: orchestratorModel })}
                disabled={replyMutation.isPending}
              >
                Retry
              </button>
            </div>
          )}
          {/* Reply input */}
          <form className="flex gap-2 p-3" onSubmit={submitReply}>
            <textarea
              className="field min-h-12 resize-none"
              placeholder={canReply ? 'Reply… (Enter to send, Shift+Enter for newline)' : currentRun?.status === 'failed' ? 'Run failed — use Retry above or fix the error first.' : 'Waiting for the current turn...'}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={handleReplyKeyDown}
              disabled={!canReply || replyMutation.isPending}
            />
            <button className="icon-button h-12 w-12" title="Send reply" disabled={!canReply || replyMutation.isPending}>
              {replyMutation.isPending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

function taskValue(task: BeadsTask, keys: string[]): string {
  for (const key of keys) {
    const value = task[key];
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
    if (Array.isArray(value)) {
      return value.map((item) => {
        if (typeof item === 'string' || typeof item === 'number') return String(item);
        // Beads dependency objects: { depends_on_id, issue_id, type, ... }
        if (item && typeof item === 'object') {
          const obj = item as Record<string, unknown>;
          return String(obj.depends_on_id ?? obj.issue_id ?? obj.id ?? '?');
        }
        return '?';
      }).filter(Boolean).join(', ');
    }
  }
  return '';
}

function taskGroup(task: BeadsTask): 'open' | 'in-progress' | 'done' {
  const status = taskValue(task, ['status', 'state']).toLowerCase();
  if (['done', 'closed', 'complete', 'completed'].includes(status)) return 'done';
  if (['in-progress', 'in_progress', 'running', 'claimed', 'started'].includes(status)) return 'in-progress';
  return 'open';
}

function TasksTab({ project }: { project: Project }) {
  const tasksQuery = useQuery({
    queryKey: ['tasks', project.id],
    queryFn: () => listTasks(project.id),
    refetchInterval: 10000,
  });

  const runsQuery = useQuery({
    queryKey: ['runs', project.id],
    queryFn: () => listRuns(project.id),
    refetchInterval: 10000,
  });

  // Index runs by beads_task_id for O(1) lookup on task cards
  const runsByTaskId = useMemo(() => {
    const index = new Map<string, Run[]>();
    for (const run of runsQuery.data ?? []) {
      if (run.beads_task_id) {
        index.set(run.beads_task_id, [...(index.get(run.beads_task_id) ?? []), run]);
      }
    }
    return index;
  }, [runsQuery.data]);

  const grouped = useMemo(() => {
    const groups: Record<'open' | 'in-progress' | 'done', BeadsTask[]> = {
      open: [],
      'in-progress': [],
      done: [],
    };
    for (const task of tasksQuery.data ?? []) groups[taskGroup(task)].push(task);
    return groups;
  }, [tasksQuery.data]);

  if (tasksQuery.isLoading) return <div className="p-4 text-text-muted"><Loader2 className="animate-spin" size={18} /></div>;
  if (tasksQuery.error) return <div className="p-4 text-xs text-red">{tasksQuery.error.message}</div>;

  return (
    <div className="grid h-full grid-cols-3 gap-px bg-border">
      {(['open', 'in-progress', 'done'] as const).map((status) => (
        <section key={status} className="min-w-0 overflow-y-auto bg-base">
          <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-surface px-3 py-2">
            <span className="text-xs font-semibold uppercase tracking-widest text-text-muted">{status}</span>
            <span className="text-xs text-text-muted">{grouped[status].length}</span>
          </div>
          <div className="p-3">
            {grouped[status].map((task, index) => {
              const id = taskValue(task, ['id', 'task_id', 'bead_id']) || `task-${index}`;
              const title = taskValue(task, ['title', 'description', 'name', 'summary']) || id;
              const body = taskValue(task, ['body', 'details', 'notes']);
              const blockers = taskValue(task, ['blocked_by', 'blockedBy', 'dependencies']);
              const runId = taskValue(task, ['run_id', 'assigned_run_id', 'runId']);
              const linkedRuns = runsByTaskId.get(id) ?? [];
              // Most recent run first
              const latestRun = linkedRuns.at(-1);
              const hasFailedRun = linkedRuns.some((r) => r.status === 'failed');
              const hasActiveRun = linkedRuns.some((r) => r.status === 'running' || r.status === 'queued');
              return (
                <article key={id} className="group mb-3 rounded border border-border bg-surface p-3">
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="truncate text-xs font-semibold text-text-primary">{title}</span>
                    <span className="shrink-0 text-[10px] text-text-muted">{id}</span>
                  </div>
                  {body && <div className="line-clamp-3 text-xs leading-5 text-text-muted">{body}</div>}
                  {(blockers || latestRun || runId) && (
                    <div className="mt-3 space-y-1 border-t border-border pt-2 text-[10px] text-text-muted">
                      {blockers && <div>blocked by: {blockers}</div>}
                      {latestRun && (
                        <Link
                          className={classNames(
                            'inline-flex max-w-full items-center gap-1 hover:underline',
                            hasActiveRun ? 'text-orange' : hasFailedRun ? 'text-red' : 'text-blue',
                          )}
                          title={`Latest run: ${latestRun.status}`}
                          to={`/projects/${project.id}/runs?run=${encodeURIComponent(latestRun.id)}`}
                        >
                          <Terminal size={11} className="shrink-0" />
                          <span className="truncate">
                            {hasActiveRun ? 'running' : hasFailedRun ? 'stalled' : 'completed'} — {latestRun.name ?? latestRun.role}
                          </span>
                        </Link>
                      )}
                      {!latestRun && runId && (
                        <Link
                          className="inline-flex max-w-full items-center gap-1 text-blue hover:underline"
                          title="Open run logs"
                          to={`/projects/${project.id}/runs?run=${encodeURIComponent(runId)}`}
                        >
                          <Terminal size={11} className="shrink-0" />
                          <span className="truncate">run: {runId}</span>
                        </Link>
                      )}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

function RunsTab({ project }: { project: Project }) {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedRunId = searchParams.get('run');

  // Two selection modes: a worker run, or an orchestrator session group
  const [selectedRunId, setSelectedRunId] = useState<string | null>(() => requestedRunId);
  const [selectedOrcSessionId, setSelectedOrcSessionId] = useState<string | null>(null);
  const [eventsByRun, setEventsByRun] = useState<Record<string, AgentEvent[]>>({});
  const [showDebug, setShowDebug] = useState(false);
  const [expandedRunTools, setExpandedRunTools] = useState<Set<string>>(new Set());

  const runsQuery = useQuery({
    queryKey: ['runs', project.id],
    queryFn: () => listRuns(project.id),
    refetchInterval: 5000,
  });

  // Group runs: orchestrator turns → one entry per session; everything else → by role
  const { orcSessions, workerRunsByRole } = useMemo(() => {
    const sessionMap = new Map<string, Run[]>();
    const roleMap = new Map<string, Run[]>();
    for (const run of runsQuery.data ?? []) {
      if (run.role === 'orchestrator' && run.orchestrator_session_id) {
        const sid = run.orchestrator_session_id;
        sessionMap.set(sid, [...(sessionMap.get(sid) ?? []), run]);
      } else {
        roleMap.set(run.role, [...(roleMap.get(run.role) ?? []), run]);
      }
    }
    return { orcSessions: sessionMap, workerRunsByRole: roleMap };
  }, [runsQuery.data]);

  useEffect(() => {
    if (requestedRunId && requestedRunId !== selectedRunId) {
      setSelectedRunId(requestedRunId);
      setSelectedOrcSessionId(null);
    }
  }, [requestedRunId, selectedRunId]);

  // Auto-select first available item
  useEffect(() => {
    if (!selectedRunId && !selectedOrcSessionId) {
      const firstSession = orcSessions.keys().next().value as string | undefined;
      if (firstSession) {
        setSelectedOrcSessionId(firstSession);
      } else {
        const firstWorkerRun = workerRunsByRole.values().next().value as Run[] | undefined;
        if (firstWorkerRun?.[0]) setSelectedRunId(firstWorkerRun[0].id);
      }
    }
  }, [selectedRunId, selectedOrcSessionId, orcSessions, workerRunsByRole]);

  const selectRun = (runId: string) => {
    setSelectedRunId(runId);
    setSelectedOrcSessionId(null);
    setSearchParams({ run: runId });
  };

  const selectOrcSession = (sessionId: string) => {
    setSelectedOrcSessionId(sessionId);
    setSelectedRunId(null);
    setSearchParams({});
  };

  // Worker run detail
  const runQuery = useQuery({
    queryKey: ['run', selectedRunId],
    queryFn: () => getRun(selectedRunId!),
    enabled: !!selectedRunId,
    refetchInterval: (q) => (isActive(q.state.data?.status) ? 2000 : false),
  });
  const runEventsQuery = useQuery({
    queryKey: ['run-events', selectedRunId],
    queryFn: () => getRunEvents(selectedRunId!),
    enabled: !!selectedRunId,
  });
  const selectedRun = runQuery.data ?? runsQuery.data?.find((r) => r.id === selectedRunId) ?? null;

  // Orchestrator session detail
  const orcTurns = orcSessions.get(selectedOrcSessionId ?? '') ?? [];
  const latestOrcTurn = orcTurns.at(-1) ?? null;
  const orcTranscriptQuery = useQuery({
    queryKey: ['session-transcript', selectedOrcSessionId],
    queryFn: () => getSessionTranscript(selectedOrcSessionId!),
    enabled: !!selectedOrcSessionId,
    refetchInterval: isActive(latestOrcTurn?.status) ? 3000 : false,
  });

  // Stream active worker run events
  useEventStream(selectedRun && isActive(selectedRun.status) ? `/api/runs/${selectedRun.id}/events` : null, (event) => {
    if (!selectedRun) return;
    setEventsByRun((prev) => ({ ...prev, [selectedRun.id]: [...(prev[selectedRun.id] ?? []), event] }));
    if (event.type === 'done' || event.type === 'error') {
      queryClient.invalidateQueries({ queryKey: ['runs', project.id] });
      queryClient.invalidateQueries({ queryKey: ['run', selectedRun.id] });
      queryClient.invalidateQueries({ queryKey: ['run-events', selectedRun.id] });
    }
  });

  // Stream active orchestrator session events (latest turn)
  useEventStream(
    selectedOrcSessionId && isActive(latestOrcTurn?.status) ? `/api/sessions/${selectedOrcSessionId}/events` : null,
    (event) => {
      if (!latestOrcTurn) return;
      setEventsByRun((prev) => ({ ...prev, [latestOrcTurn.id]: [...(prev[latestOrcTurn.id] ?? []), event] }));
      if (event.type === 'done' || event.type === 'error') {
        queryClient.invalidateQueries({ queryKey: ['runs', project.id] });
        queryClient.invalidateQueries({ queryKey: ['session-transcript', selectedOrcSessionId] });
      }
    },
  );

  const stopMutation = useMutation({
    mutationFn: cancelRun,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['runs', project.id] });
      if (selectedRunId) queryClient.invalidateQueries({ queryKey: ['run', selectedRunId] });
    },
  });

  const [mergeOutput, setMergeOutput] = useState<string | null>(null);
  const mergeMutation = useMutation({
    mutationFn: (branch: string) => mergeToMain(project.id, branch),
    onSuccess: (result) => setMergeOutput(result.output),
    onError: (err) => setMergeOutput(err instanceof Error ? err.message : String(err)),
  });

  const logEvents = selectedRun ? mergeEvents(runEventsQuery.data, eventsByRun[selectedRun.id]) : [];

  const orcAllEvents = useMemo(() => {
    const entries = orcTranscriptQuery.data ?? [];
    return entries.flatMap(({ run, events }) => mergeEvents(events, eventsByRun[run.id]));
  }, [orcTranscriptQuery.data, eventsByRun]);

  const orcTotals = useMemo(() => orcTurns.reduce(
    (acc, r) => ({
      input: acc.input + r.total_input_tokens,
      output: acc.output + r.total_output_tokens,
      cacheNew: acc.cacheNew + r.total_cache_creation_tokens,
      cacheRead: acc.cacheRead + r.total_cache_read_tokens,
    }),
    { input: 0, output: 0, cacheNew: 0, cacheRead: 0 },
  ), [orcTurns]);

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left panel */}
      <div className="w-[360px] shrink-0 overflow-y-auto border-r border-border bg-base">
        {orcSessions.size === 0 && workerRunsByRole.size === 0 && (
          <div className="p-4 text-xs text-text-muted">No runs.</div>
        )}

        {/* Orchestrator sessions — one entry per session */}
        {orcSessions.size > 0 && (
          <div>
            <div className="border-b border-border bg-elevated/30 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-text-muted">
              orchestrator
            </div>
            {Array.from(orcSessions.entries()).map(([sessionId, turns]) => {
              const latest = turns.at(-1)!;
              const n = turns.length;
              return (
                <button
                  key={sessionId}
                  className={classNames(
                    'w-full border-b border-border border-l-2 px-3 py-3 text-left transition-colors hover:bg-elevated/50',
                    selectedOrcSessionId === sessionId && 'bg-elevated',
                  )}
                  style={{ borderLeftColor: selectedOrcSessionId === sessionId ? accentFor(project.id) : 'transparent' }}
                  onClick={() => selectOrcSession(sessionId)}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs font-semibold text-text-primary">
                      Session {sessionId.slice(0, 8)}
                    </span>
                    <StatusBadge status={latest.status} />
                  </div>
                  <div className="mt-1 text-xs text-text-muted">
                    {n} turn{n !== 1 ? 's' : ''} · {latest.model}
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {/* Worker runs grouped by role */}
        {Array.from(workerRunsByRole.entries()).map(([role, runs]) => (
          <div key={role}>
            <div className="border-b border-border bg-elevated/30 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-text-muted">
              {role}
            </div>
            {runs.map((run) => (
              <button
                key={run.id}
                className={classNames(
                  'w-full border-b border-border border-l-2 px-3 py-3 text-left transition-colors hover:bg-elevated/50',
                  selectedRunId === run.id && 'bg-elevated',
                )}
                style={{ borderLeftColor: selectedRunId === run.id ? accentFor(run.id) : 'transparent' }}
                onClick={() => selectRun(run.id)}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-xs font-semibold text-text-primary">{run.name ?? run.id.slice(0, 8)}</span>
                  <StatusBadge status={run.status} />
                </div>
                <div className="mt-1 truncate text-xs text-text-muted">{run.model}</div>
              </button>
            ))}
          </div>
        ))}
      </div>

      {/* Right panel */}
      <div className="flex min-w-0 flex-1 flex-col bg-base">
        {selectedOrcSessionId && orcTurns.length > 0 ? (
          <>
            <div className="flex shrink-0 items-center gap-3 border-b border-border bg-surface px-4 py-3">
              <Bot size={16} className="text-text-muted" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-text-primary">
                  Orchestrator · session {selectedOrcSessionId.slice(0, 8)}
                </div>
                <div className="truncate text-xs text-text-muted">
                  {orcTurns.length} turn{orcTurns.length !== 1 ? 's' : ''} · {latestOrcTurn?.model}
                  {orcTurns[0]?.started_at
                    ? ` · ${formatDuration(orcTurns[0].started_at, latestOrcTurn?.completed_at ?? null)}`
                    : ''}
                </div>
              </div>
              <StatusBadge status={latestOrcTurn?.status ?? 'unknown'} />
              {latestOrcTurn && isActive(latestOrcTurn.status) && (
                <button
                  className="icon-button"
                  title="Cancel current turn"
                  disabled={stopMutation.isPending}
                  onClick={() => stopMutation.mutate(latestOrcTurn.id)}
                >
                  <Square size={14} />
                </button>
              )}
            </div>
            <div className="grid shrink-0 grid-cols-4 gap-px border-b border-border bg-border">
              {([
                ['input', orcTotals.input],
                ['output', orcTotals.output],
                ['cache new', orcTotals.cacheNew],
                ['cache read', orcTotals.cacheRead],
              ] as [string, number][]).map(([label, value]) => (
                <div key={label} className="bg-surface px-4 py-3">
                  <div className="text-[10px] uppercase tracking-widest text-text-muted">{label}</div>
                  <div className="mt-1 text-sm text-text-primary">{value.toLocaleString()}</div>
                </div>
              ))}
            </div>
            <pre className="min-h-0 flex-1 overflow-auto bg-base p-4 text-xs leading-5 text-text-primary">
              {orcAllEvents.length > 0
                ? orcAllEvents
                    .map((event) => {
                      const prefix = event.type === 'toolCall' ? `$ ${event.toolName}` : event.type;
                      return `[${formatDate(Date.parse(event.timestamp))}] ${prefix}: ${event.text ?? ''}`;
                    })
                    .join('\n')
                : orcTranscriptQuery.isLoading
                  ? 'Loading…'
                  : 'No events captured.'}
            </pre>
          </>
        ) : selectedRun ? (
          <>
            <div className="flex shrink-0 items-center gap-3 border-b border-border bg-surface px-4 py-3">
              <Terminal size={16} className="text-text-muted" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-text-primary">{selectedRun.name ?? selectedRun.id}</div>
                <div className="truncate text-xs text-text-muted">
                  {selectedRun.role} · {selectedRun.agent_provider} · {selectedRun.claude_auth_provider} · {formatDuration(selectedRun.started_at, selectedRun.completed_at)}
                </div>
              </div>
              <StatusBadge status={selectedRun.status} />
              {isActive(selectedRun.status) && (
                <>
                  <button
                    className="icon-button"
                    title="Show debug command"
                    onClick={() => setShowDebug(v => !v)}
                  >
                    <Terminal size={14} />
                  </button>
                  <button
                    className="icon-button"
                    title="Cancel run"
                    disabled={stopMutation.isPending}
                    onClick={() => stopMutation.mutate(selectedRun.id)}
                  >
                    <Square size={14} />
                  </button>
                </>
              )}
              {selectedRun.status === 'completed' && selectedRun.branch && (
                <button
                  className="icon-button"
                  title={`Merge ${selectedRun.branch} into main`}
                  disabled={mergeMutation.isPending}
                  onClick={() => { setMergeOutput(null); mergeMutation.mutate(selectedRun.branch); }}
                >
                  {mergeMutation.isPending ? <Loader2 size={14} className="animate-spin" /> : <GitMerge size={14} />}
                </button>
              )}
            </div>
            {mergeOutput && (
              <div className="shrink-0 border-b border-border bg-elevated/50 px-4 py-3 text-xs">
                <div className="mb-1 font-semibold text-text-muted">
                  {mergeMutation.isError ? '✗ Merge failed' : '✓ Merged to main'}
                </div>
                <pre className="overflow-x-auto whitespace-pre-wrap text-text-muted">{mergeOutput}</pre>
              </div>
            )}
            {showDebug && isActive(selectedRun.status) && (
              <div className="shrink-0 border-b border-border bg-elevated/50 px-4 py-3 text-xs">
                <div className="mb-1 text-text-muted">List sandbox containers:</div>
                <code className="block select-all rounded bg-base px-2 py-1 text-text-primary">
                  {'docker ps --filter "ancestor=boss-man:sandbox" --format "table {{.ID}}\\t{{.Names}}\\t{{.Status}}"'}
                </code>
                <div className="mt-2 text-text-muted">Then attach:</div>
                <code className="block select-all rounded bg-base px-2 py-1 text-text-primary">
                  docker exec -it &lt;container_id&gt; bash
                </code>
              </div>
            )}
            <div className="grid shrink-0 grid-cols-4 gap-px border-b border-border bg-border">
              {[
                ['input', selectedRun.total_input_tokens],
                ['output', selectedRun.total_output_tokens],
                ['cache new', selectedRun.total_cache_creation_tokens],
                ['cache read', selectedRun.total_cache_read_tokens],
              ].map(([label, value]) => (
                <div key={label} className="bg-surface px-4 py-3">
                  <div className="text-[10px] uppercase tracking-widest text-text-muted">{label}</div>
                  <div className="mt-1 text-sm text-text-primary">{Number(value).toLocaleString()}</div>
                </div>
              ))}
            </div>
            <div className="min-h-0 flex-1 overflow-auto bg-base p-4 text-xs leading-5 text-text-primary">
              {logEvents.length > 0
                ? logEvents.map((event) => {
                    const k = eventKey(event);
                    if (event.type === 'toolCall') {
                      return (
                        <div key={k} className="mb-1">
                          <button
                            className="flex w-full items-start gap-1.5 text-left text-xs text-text-muted hover:text-text-primary"
                            onClick={() => setExpandedRunTools(prev => {
                              const next = new Set(prev);
                              next.has(k) ? next.delete(k) : next.add(k);
                              return next;
                            })}
                          >
                            <span className="mt-0.5 shrink-0 font-mono text-blue">$</span>
                            <span className="flex-1 truncate font-mono">{event.toolName}</span>
                            <ChevronDown size={11} className={classNames('mt-0.5 shrink-0 transition-transform', expandedRunTools.has(k) && 'rotate-180')} />
                          </button>
                          {expandedRunTools.has(k) && event.text && (
                            <pre className="mt-1 overflow-x-auto rounded bg-elevated px-2 py-1 text-[10px] leading-4 text-text-muted">
                              {event.text}
                            </pre>
                          )}
                        </div>
                      );
                    }
                    const prefix = event.type;
                    return (
                      <div key={k} className="mb-0.5 text-text-muted">
                        [{formatDate(Date.parse(event.timestamp))}] {prefix}: {event.text ?? ''}
                      </div>
                    );
                  })
                : <div className="text-text-muted">{selectedRun.error ?? 'No live events captured for this run.'}</div>}
              {/* Always surface the error when present, even if partial events were captured */}
              {selectedRun.error && selectedRun.status === 'failed' && logEvents.length > 0 && (
                <div className="mt-2 rounded border border-red/20 bg-red/5 px-2 py-1.5 text-[11px] text-red">
                  <span className="font-medium">Run failed: </span>{selectedRun.error}
                </div>
              )}
            </div>
            {selectedRun.changed_files && (() => {
              let files: string[];
              try {
                files = JSON.parse(selectedRun.changed_files) as string[];
              } catch {
                return null;
              }
              if (!Array.isArray(files)) return null;
              if (files.length === 0) return null;
              return (
                <div className="shrink-0 border-t border-border">
                  <div className="border-b border-border bg-elevated/30 px-4 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-text-muted">
                    Changed files ({files.length})
                  </div>
                  <div className="max-h-40 overflow-y-auto">
                    {files.map((f) => (
                      <div key={f} className="flex items-center gap-2 border-b border-border/50 px-4 py-1.5 text-xs text-text-muted">
                        <FileText size={11} className="shrink-0" />
                        <span className="min-w-0 flex-1 truncate font-mono">{f}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-xs text-text-muted">Select a run.</div>
        )}
      </div>
    </div>
  );
}

function SpecTab({ project }: { project: Project }) {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const specsQuery = useQuery({
    queryKey: ['specs', project.id],
    queryFn: () => listSpecs(project.id),
    // Poll periodically so newly committed spec files appear without a manual reload.
    refetchInterval: 30_000,
  });

  useEffect(() => {
    if (!selectedFile && specsQuery.data?.[0]) setSelectedFile(specsQuery.data[0].name);
  }, [selectedFile, specsQuery.data]);

  const contentQuery = useQuery({
    queryKey: ['spec', project.id, selectedFile],
    queryFn: () => readSpec(project.id, selectedFile!),
    enabled: !!selectedFile,
  });

  return (
    <div className="flex h-full overflow-hidden bg-base">
      <div className="w-[260px] shrink-0 overflow-y-auto border-r border-border">
        <div className="border-b border-border bg-elevated/30 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-text-muted">
          Files
        </div>
        {specsQuery.data?.length === 0 && <div className="p-4 text-xs text-text-muted">No spec files.</div>}
        {(specsQuery.data ?? []).map((file) => (
          <button
            key={file.name}
            className={classNames(
              'flex w-full items-center gap-2 border-b border-border px-3 py-3 text-left text-xs transition-colors hover:bg-elevated/50',
              selectedFile === file.name ? 'bg-elevated text-text-primary' : 'text-text-muted',
            )}
            onClick={() => setSelectedFile(file.name)}
          >
            <FileText size={14} className="shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="block truncate">{file.name}</span>
              <span className="mt-1 block truncate text-[10px] text-text-muted">
                {file.last_commit_at ? `last commit ${formatDate(file.last_commit_at)}` : 'no committed changes'}
              </span>
            </span>
          </button>
        ))}
      </div>
      <article className="min-w-0 flex-1 overflow-auto p-6">
        {contentQuery.isLoading ? (
          <Loader2 className="animate-spin text-text-muted" size={18} />
        ) : contentQuery.error ? (
          <div className="text-xs text-red">{contentQuery.error.message}</div>
        ) : contentQuery.data ? (
          <ReactMarkdown className="markdown" rehypePlugins={[rehypeHighlight]}>{contentQuery.data}</ReactMarkdown>
        ) : (
          <div className="text-xs text-text-muted">Select a file.</div>
        )}
      </article>
    </div>
  );
}

export default function App() {
  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: listProjects,
    refetchInterval: 10000,
  });

  return (
    <div className="flex h-screen overflow-hidden bg-base font-mono">
      <Sidebar projects={projectsQuery.data ?? []} />
      {projectsQuery.isLoading ? (
        <main className="flex flex-1 items-center justify-center text-text-muted">
          <Loader2 className="animate-spin" size={18} />
        </main>
      ) : projectsQuery.error ? (
        <main className="flex flex-1 items-center justify-center text-xs text-red">{projectsQuery.error.message}</main>
      ) : (
        <Routes>
          <Route path="/" element={<Home projects={projectsQuery.data ?? []} />} />
          <Route path="/projects/:projectId" element={<Navigate to="chat" replace />} />
          <Route path="/projects/:projectId/:tab" element={<ProjectRoute />} />
        </Routes>
      )}
    </div>
  );
}
