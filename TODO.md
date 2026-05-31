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
- [ ] **Structured agent event model**: expand persisted/SSE events beyond text and tool-call starts to include `assistant_text_delta`, `tool_call_started`, `tool_stdout`, `tool_stderr`, `tool_result`, `file_changed`, `diff_available`, `approval_requested`, `run_status_changed`, `error`, and `done`. *(blocked: Sandcastle only emits `text` and `toolCall` events)*
- [x] **Tool activity UI**: render expandable tool-call rows in Chat and Runs with command and args; click to expand full text.
- [x] **Diff/file-change surfacing**: detect changed files after each run via `git diff --name-only`; store in `runs.changed_files`; render file list in run detail panel.
- [ ] **Approval flow**: support agent approval requests as first-class UI events, with approve/deny actions routed through the API instead of requiring terminal access. *(blocked: SKIP_PERMISSIONS bypasses approval in sandbox)*
- [x] **Attach terminal debug action**: debug panel with `docker ps` and `docker exec` commands shown for active runs in the Runs tab.
- [x] **Transcript retention policy**: `DELETE /api/sessions/:id` cascade-deletes all runs and events; delete session button (with confirm) added to chat sidebar.
- [x] **Worker links in orchestrator transcript**: parse `spawn-worker --role` from Bash toolCall events; render linked chips to the matching worker run.

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

- [x] **Build sandbox image before first run** — `install.sh` builds `boss-man:sandbox` and runs a smoke test (checks `bd`, `claude`, `spawn-worker` are present and `/home/agent` is writable).
- [x] `Makefile` target: `make sandbox` — builds with `--build-arg BEADS_VERSION`; `make sandbox-push` for registry push. `make help` lists all targets.
- [x] Add `install.sh` step to build sandbox image on first run — `install.sh` step 6 runs `docker build --build-arg BEADS_VERSION=...`; `BEADS_VERSION` and `SANDBOX_IMAGE` can be overridden via env.
- [x] Document BEADS_VERSION arg in Dockerfile — `Makefile` shows `make sandbox BEADS_VERSION=X.Y.Z`; `BEADS_VERSION` env is also honoured in `install.sh` and `.github/workflows/sandbox.yml`.
- [x] GitHub Actions: build + push sandbox image on Dockerfile changes — `.github/workflows/sandbox.yml` triggers on `sandcastle/Dockerfile` or `scripts/spawn-worker` changes; builds on PRs (verification), pushes to `ghcr.io/<owner>/boss-man-sandbox` on merge to main; uses registry build cache.

---

### Phase 7 — Multi-Project & Auth

- [ ] Per-project Beads database (`beads_db` field already in projects table; wire `bd --database` flag)
- [ ] `GET /api/beads/tasks?db=projectName` — scoped task list per project
- [ ] Session auth (simple API key gate on all `/api/*` routes) for network exposure
- [ ] Project archiving / deletion
- [ ] **CORS** — restrict `Access-Control-Allow-Origin` to localhost origins only (security hardening; low priority for trusted-network deployments but required before any network exposure)

---

### Phase 8 — Token Efficiency (deferred items)

These items were identified during a token-waste audit. Each is blocked on an upstream `@ai-hero/sandcastle` SDK capability. If we fork the dep, these are the target changes.

---

#### [BLOCKED: SDK] #2 — Multi-iteration workers restart cold on every iteration

**Impact:** Proven 250K input tokens on a single 10-iteration implementer run. Each iteration re-reads the full codebase context from scratch.

**Root cause:** In `@ai-hero/sandcastle/dist/Orchestrator.js`:
```js
const iterationResumeSession = i === 1 ? options.resumeSession : undefined;
```
Resume is only applied on iteration 1. Iterations 2–N launch Claude Code fresh with the same original prompt and no memory of what the previous iteration did.

**Fix needed in SDK:** Pass the previous iteration's captured `sessionId` as `iterationResumeSession` for iterations 2+. Each `IterationResult` already has a `sessionId` field — the Orchestrator loop just needs to thread it forward.

**Workaround already applied:** Default `MAX_ITERATIONS` lowered from 10 → 3 in `scripts/spawn-worker`, and worker prompts instruct agents to stop and report blockers rather than spinning. This limits the blast radius but doesn't fix the cold-start per-iteration cost.

---

#### [BLOCKED: SDK] #1 (partial) — Session JSONL compaction between reply turns

**Impact:** Orchestrator session history grows unboundedly. By turn 12 the session re-reads 49K+ tokens of prior tool calls and outputs on every resume.

**What's implemented:** The server detects cumulative token growth > 60K and prepends a `[Context monitor]` notice asking the orchestrator to write `checkpoint.md`. This prompts the orchestrator to save state, but does NOT shorten the session JSONL that Claude Code replays on the next resume — the file just keeps growing.

**True fix:** Between reply turns, after the orchestrator writes `checkpoint.md`, clear the session JSONL and start the next turn as a new Claude Code session whose first message is the checkpoint content. This requires either:
  - (a) A Sandcastle API to truncate/replace the session file before a resume run, or
  - (b) A `startSession` option on `run()` that begins fresh but injects a synthetic prior-context message as the first user turn.

Neither exists today. The checkpoint write buys time but doesn't eliminate the growth.

---

#### [BLOCKED: SDK] #3 — Cache-prefix stability for orchestrator system prompt

**Impact:** Anthropic's prompt cache cannot hit the stable `orchestrator.md` prefix (~2,800 tokens) because it's concatenated with the per-session user message inside `buildFirstTurnPrompt()`. Every new session pays full cache-creation cost for the static instructions.

**Partial fix available now (no SDK needed):** Memoize `loadOrchestratorPrompt()` at module load in `routes/sessions.ts` — currently it does `readFileSync` on every call. Low-value but trivial.

**Full fix blocked on SDK:** `ClaudeCodeOptions` (in `AgentProvider.d.ts`) currently only exposes `effort`, `env`, `captureSessions`, `sessionStorage` — no `systemPrompt` field. If added, move the static orchestrator instructions to the system turn so they cache independently of the variable user message.

---

#### [BLOCKED: SDK] #4 — Worker system prompts in user-turn instead of system param

**Impact:** All worker templates concatenate role boilerplate (~750–1,200 bytes of static instructions) with the variable task description in a single user message. The static portion cannot cache as a stable prefix.

**Blocked on:** Same `ClaudeCodeOptions.systemPrompt` gap as #3. No workaround until the SDK exposes it.

---

#### [BLOCKED: SDK] #8 — Cancelled runs discard partial session IDs

**Impact:** If a worker run is cancelled after 5 of 10 iterations complete, the captured session state from those 5 iterations is lost. Any retry starts completely cold.

**Fix needed in SDK:** Expose per-iteration session IDs via a callback (e.g. in `logging.onAgentStreamEvent` or a new `onIterationComplete` hook) so the server can call `updateRun(id, { last_session_id })` after each iteration rather than waiting for the final result. `IterationResult.sessionId` is already populated per-iteration in the result array — the SDK just doesn't expose it mid-run.

**Current workaround:** For orchestrator sessions, `routes/sessions.ts` scans all runs in the session for the last non-null `last_session_id` when building a reply, so partial progress survives across turns. Worker runs have no equivalent recovery path.

---

### Phase 10 — LiteLLM Rules-Based Routing

Goal: replace static `boss-man/high|medium|low` tier aliases with intelligent rules-based routing so the right model is selected automatically based on context (token count, task type, cost budget, latency requirements).

- [ ] **Local worker tier** (`boss-man/local`): add a `local` entry to `MODEL_TIERS` in `config.ts` mapping to the existing `local-worker` LiteLLM alias (Ollama); expose as `--model local` in `spawn-worker` help; add a `local` row to the orchestrator model table (maps to the refactor/low-complexity role); document that `BOSS_MAN_AUTH_MODE=litellm` + Ollama running on host are prerequisites. Only useful in litellm mode.
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
