# Boss Man Dashboard — Implementation Roadmap

## Completed

### Phase 1 — Infrastructure
- [x] Docker Compose: Dolt, Langfuse (v2, port :3002), optional standalone LiteLLM + Postgres
- [x] `start.sh`: smart LiteLLM detection via `/health/liveliness`, reuses ao-briefcase if running
- [x] `stop.sh`, `install.sh`
- [x] LiteLLM config: `boss-man/high|medium|low` tier aliases + direct model IDs + local-worker (Ollama)
- [x] `callbacks.py`: OpenAI Responses compatibility, Ollama reasoning key stripping
- [x] `.env` / `.env.example` with all required credentials
- [x] Sandcastle sandbox image (`sandcastle/Dockerfile`) with Claude Code, bd, getprismo, spawn-worker
- [x] API server (Hono): projects, runs, beads proxy, specs, SSE event streaming
- [x] `spawn-worker` script for orchestrator → worker dispatch
- [x] Orchestrator system prompt (`prompts/orchestrator.md`)
- [x] Worker prompts: implementer, test_generator, reviewer, security_reviewer, researcher

### Phase 2 — Orchestrator Sessions (this PR)
- [x] `orchestrator_sessions` DB table
- [x] `POST /api/projects/:id/sessions` — start first orchestrator turn (Docker sandbox)
- [x] `GET /api/projects/:id/sessions` — list sessions
- [x] `GET /api/sessions/:id` — session state + current run
- [x] `POST /api/sessions/:id/reply` — resume orchestrator with user's answer (session resumption)
- [x] `GET /api/sessions/:id/events` — SSE proxy for current run events
- [x] `BOSS_MAN_PROJECT_ID` injected into sandbox env (enables `spawn-worker` inside orchestrator)
- [x] Orchestrator prompt: `<task-complete/>` after each discovery question

---

## Remaining

### Phase 3 — UI (Discovery Chat + Dashboard)

Build the React frontend in `ui/` workspace. Uncomment the `npm run dev --workspace=ui` line in `start.sh` when done.

#### 3a — Scaffold
- [x] Init Vite + React + TypeScript in `ui/` (`npm create vite@latest ui -- --template react-ts`)
- [x] Add to `package.json` workspaces
- [x] Install: `react-router-dom`, `@tanstack/react-query`, `tailwindcss`, `lucide-react`
- [x] Basic layout: sidebar (project list) + main content area

#### 3b — Project Management
- [x] Project list page (`GET /api/projects`)
- [x] New project form (name, description, optional repoUrl)
- [x] Project detail page with tab nav: Chat | Tasks | Runs | Spec
- [x] Assign each project a random accent color on creation (seeded from project ID so it's stable across reloads); use for sidebar indicator, tab header, and session avatars
- [x] Make the project color more prominent — use it as a full-width header bar or bold left-border stripe on the project detail page, not just a small dot/chip

#### 3c — Discovery Chat tab
- [x] `GET /api/projects/:id/sessions` — list sessions; "New Session" button
- [x] Chat UI: message thread showing orchestrator output (text events from SSE)
- [x] Input box: sends `POST /api/sessions/:id/reply` when orchestrator run completes
- [x] Session status indicator: `discovery | planning | executing | complete`
- [x] Auto-scroll, markdown rendering for orchestrator messages
- [x] "Start Session" flow: text area for initial spec → `POST /api/projects/:id/sessions`
- [x] Orchestrator backend toggle: Anthropic OAuth token vs LiteLLM Anthropic-compatible routing, both using `claude-code`
- [x] Persist/replay orchestrator transcript across tab switches using run events
- [x] Show a loading/thinking indicator in the chat while the current turn is running (pulsing dots or spinner tied to `run.status === 'running'`)
- [x] `Enter` submits the chat input; `Shift+Enter` inserts a newline
- [x] Model selector should be a dropdown (populated from `GET /api/models` proxied from LiteLLM) not a raw text input
- [x] Chat transcript must only show orchestrator turns (runs with `orchestrator_session_id` set); worker/sub-agent runs spawned by the orchestrator must not appear in the chat view — they belong in the Runs tab only
- [x] Runs tab: orchestrator turns grouped into one entry per session (shows turn count + cumulative tokens); worker runs remain individual entries by role
- [x] **Mid-session model switching**: model picker visible in reply area at all times; "cancel & switch" button when a run is active; model passed with every reply so it takes effect immediately; backend fixed to find the best available `last_session_id` across all session runs so context survives a cancelled turn

#### 3d — Task Board tab
- [x] `GET /api/beads/tasks` — render kanban or table by status (open / in-progress / done)
- [x] Show task description, blocked-by dependencies, assigned run ID
- [x] Link task to its run for log viewing

#### 3e — Run History tab
- [x] `GET /api/projects/:id/runs` — list runs grouped by role
- [x] Run detail: status badge, model, timing, token usage, SSE log viewer
- [x] Log viewer: stream `GET /api/runs/:id/events` for active runs; replay persisted events for completed ones

#### 3f — Spec viewer tab
- [x] `GET /api/projects/:id/specs` — list spec files (constitution.md, spec.md, plan.md, tasks.md)
- [x] Render markdown with syntax highlighting
- [x] Show last git commit timestamp for each file

---

### Phase 4 — Agent Interaction UX

Goal: the web UI should expose the full useful experience of a Docker-contained Claude Code agent without making tmux/container terminal state the source of truth. The core contract is an append-only structured event stream: containers execute the agent and emit events, the API persists and broadcasts those events, SQLite provides short-term replay, and tmux/docker exec remains a debug escape hatch.

- [ ] **Event stream contract**: define the canonical run/session event stream shape shared by Docker agents, the Hono API, SQLite persistence, SSE replay, and React rendering. Every user-visible agent action should be represented as an append-only event with stable IDs, timestamps, run/session IDs, type, payload, and optional parent event ID.
- [ ] **Structured agent event model**: expand persisted/SSE events beyond text and tool-call starts to include `assistant_text_delta`, `tool_call_started`, `tool_stdout`, `tool_stderr`, `tool_result`, `file_changed`, `diff_available`, `approval_requested`, `run_status_changed`, `error`, and `done`.
- [ ] **Tool activity UI**: render expandable tool-call rows in Chat and Runs with command, cwd, stdout/stderr, exit code, duration, and error state.
- [ ] **Diff/file-change surfacing**: detect changed files after each run and expose per-run diffs from the run detail and relevant chat turns.
- [ ] **Approval flow**: support agent approval requests as first-class UI events, with approve/deny actions routed through the API instead of requiring terminal access.
- [ ] **Attach terminal debug action**: add a clearly marked debug path for active containers, e.g. copy/open a `docker exec` or `tmux attach` command, without using terminal scrollback as transcript persistence.
- [ ] **Transcript retention policy**: keep SQLite transcripts short-term for replay across tab switches, refreshes, and reconnects; add cleanup controls for clearing sessions/runs/events without deleting projects/specs.
- [ ] **Worker links in orchestrator transcript**: when the orchestrator calls `spawn-worker`, render the created worker run as a linked event with status and logs.

---

### Phase 5 — Worker Improvements

- [x] **Refactor role prompt**: `prompts/workers/refactor.md` created
- [x] **Worker model tiers**: tier header added to all worker prompts; orchestrator has canonical role→model table
- [x] **Session status updates**: orchestrator `curl`s `PATCH /api/sessions/$BOSS_MAN_SESSION_ID` at Phase 1→planning, Phase 3→executing, Phase 4→complete
- [x] **`PATCH /api/sessions/:id`** endpoint: accepts `{ status, name }`; validates status values; used by orchestrator from inside sandbox
- [x] **`BOSS_MAN_SESSION_ID`** injected into sandbox env for all orchestrator runs (first turn and replies)
- [x] **Token budget display**: cumulative input/output/cache tokens shown per session in the chat view (computed from runs already in `sessionQuery.data`)
- [x] **prismo doctor on session start**: already present in orchestrator startup section (step 4)
- [ ] **Orchestrator tool restrictions** *(blocked)*: `ClaudeCodeOptions` in Sandcastle SDK does not expose `--allowedTools`; needs upstream support or a workaround. Prompt-level enforcement is the current mitigation.
- [ ] **Langfuse trace linking**: capture `x-langfuse-trace-id` response header from LiteLLM and store in `runs.langfuse_trace_id`. Surface in UI run detail. Complex — traces are created inside the sandbox by Claude Code's LiteLLM calls; no direct header access from the runner.
- [ ] **bd CLI verification**: operational task — confirm `bd config set store.host host.docker.internal` works inside sandbox; no code change needed, just a test run.

---

### Phase 6 — Sandbox Image Build & CI

- [ ] **Build sandbox image before first run** — `docker build -t boss-man:sandbox ./sandcastle` is required before the orchestrator or any worker can execute. Workers will fail with "image not found" until this is done. Add to `install.sh` and document prominently.
- [ ] `Makefile` target: `make sandbox` → `docker build -t boss-man:sandbox ./sandcastle`
- [ ] Add `install.sh` step to build sandbox image on first run
- [ ] Document BEADS_VERSION arg in Dockerfile (sync with host bd version)
- [ ] GitHub Actions: build + push sandbox image on Dockerfile changes

---

### Phase 7 — Multi-Project & Auth

- [ ] Per-project Beads database (`beads_db` field already in projects table; wire `bd --database` flag)
- [ ] `GET /api/beads/tasks?db=projectName` — scoped task list per project
- [ ] Session auth (simple API key gate on all `/api/*` routes) for network exposure
- [ ] Project archiving / deletion

---

### Phase 8 — LiteLLM Rules-Based Routing

Goal: replace static `boss-man/high|medium|low` tier aliases with intelligent rules-based routing so the right model is selected automatically based on context (token count, task type, cost budget, latency requirements).

- [ ] **Research routing strategies**: evaluate LiteLLM's `router_settings` options — `simple-shuffle`, `least-busy`, `latency-based`, `cost-based`, `usage-based` — and decide which fits the orchestrator/worker split best.
- [ ] **Define routing rules**: configure per-role rules in `litellm-config.yaml` (e.g. orchestrator always → Opus, reviewer → Opus, implementer/test_generator → Sonnet, refactor/formatter → Haiku).
- [ ] **Fallback chains**: set up model fallback sequences so if Opus is rate-limited it falls through to Sonnet automatically; surface the fallback in Langfuse traces.
- [ ] **Cost guardrails**: add `max_budget` and `budget_duration` per virtual key or routing group so runaway sessions don't drain the API budget.
- [ ] **Context-length routing**: route to Claude's larger context window automatically when prompt + history exceeds a threshold (e.g. >80k tokens → prefer long-context variant).
- [ ] **UI exposure**: show the resolved model (after routing) in the run detail alongside the requested tier, so it's clear which model actually ran.

---

## API Reference (current)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Liveness check |
| GET | `/api/projects` | List projects |
| POST | `/api/projects` | Create project |
| GET | `/api/projects/:id` | Get project |
| GET | `/api/projects/:id/runs` | List runs for project |
| GET | `/api/projects/:id/sessions` | List orchestrator sessions |
| POST | `/api/projects/:id/sessions` | Start orchestrator session |
| GET | `/api/sessions/:id` | Get session + current run |
| PATCH | `/api/sessions/:id` | Update session status or name (called by orchestrator) |
| POST | `/api/sessions/:id/reply` | Send user reply, resume orchestrator |
| GET | `/api/sessions/:id/events` | SSE stream for current run |
| POST | `/api/runs` | Enqueue worker run |
| GET | `/api/runs/:id` | Get run |
| DELETE | `/api/runs/:id` | Cancel run |
| GET | `/api/runs/:id/events` | SSE stream for run |
| GET | `/api/beads/prime` | Inject Beads context (for orchestrator startup) |
| POST | `/api/beads/create` | Create task |
| POST | `/api/beads/dep` | Add task dependency |
| POST | `/api/beads/complete` | Mark task complete |
| POST | `/api/beads/remember` | Store memory note |
| GET | `/api/beads/tasks` | List all tasks |
| GET | `/api/beads/unblocked` | List tasks with no blockers |
| POST | `/api/beads/update` | Update task status |
| GET | `/api/projects/:id/specs` | List spec files |
| GET | `/api/projects/:id/specs/:file` | Read spec file content |
| PUT | `/api/projects/:id/specs/:file` | Write spec file content |
