# Boss Man Dashboard

A local web dashboard for managing multi-agent Claude Code sessions against your own codebases. An **orchestrator** agent runs a structured discovery interview with you, then dispatches **worker** agents (implementer, reviewer, test-generator, etc.) to execute tasks — all tracked in a React UI with live event streaming.

---

## Architecture

```
Browser UI (Vite + React)
        │
        │ REST + SSE
        ▼
 API Server (Hono / Node)
        │
   ┌────┼────────────────────┐
   │    │                    │
   ▼    ▼                    ▼
 SQLite Beads (Dolt)    Sandcastle SDK
 runs.db  task graph    ──────────────
                        Docker sandbox
                        (Claude Code)
                              │
                         git worktree
                         (your repo)
```

**Key components:**

| Component | What it does |
|-----------|-------------|
| `server/` | Hono API server — projects, sessions, runs, SSE streaming, Beads proxy |
| `ui/` | React SPA — chat, task board (kanban), run history, spec viewer |
| `sandcastle/` | Docker image for the agent sandbox (Claude Code + `bd` + `spawn-worker`) |
| `prompts/` | Orchestrator and worker system prompts |
| Dolt | MySQL-compatible SQL server used as the Beads task-graph store |
| LiteLLM | Model proxy — provides `boss-man/high|medium|low` tier aliases |
| Langfuse | Optional LLM observability (traces, token costs) |

---

## Prerequisites

- **Node.js 22+** (use `nvm install 22`)
- **Docker + Docker Compose v2**
- **git**
- **[Beads CLI (`bd`)](https://github.com/gastownhall/beads)** — task graph
- API keys: `ANTHROPIC_API_KEY` (required), `OPENAI_API_KEY` (optional)

---

## Installation

```bash
./install.sh
```

This one-shot script:
1. Checks prerequisites
2. Generates `.env` with random secrets (copies `ANTHROPIC_API_KEY` from shell if set)
3. Runs `npm install` for all workspaces
4. Builds the agent sandbox Docker image (`boss-man:sandbox`)
5. Runs a smoke test on the sandbox image
6. Starts Dolt and initializes the Beads workspace

Edit `.env` after generation to set any keys that weren't auto-detected.

---

## Scripts

### `./start.sh`

Starts the full dashboard. Detects whether LiteLLM is already running at `:4000` (e.g. from a sibling project like ao-briefcase) and reuses it if so, otherwise starts the standalone Docker Compose stack.

**What it starts:**
- Docker services: Dolt (`:3306`), Langfuse (`:3002`), and LiteLLM (`:4000`) if not already running
- API server via `tsx watch` at `:3001`
- Vite dev server (UI) at `:5173`

Press `Ctrl+C` to stop everything cleanly.

### `./stop.sh`

Stops the dev servers (API + UI). Accepts optional flags:

```bash
./stop.sh                    # stop dev servers only
./stop.sh --clean-containers # also remove any stale sandbox containers
./stop.sh --infra            # also stop Docker Compose services (Dolt, LiteLLM, Langfuse)
```

### `./install.sh`

One-shot setup. Safe to re-run — skips already-completed steps (existing `.env`, installed `bd`, built sandbox image, initialized Beads workspace).

---

## Configuration

All configuration lives in `.env` (generated from `.env.example` by `install.sh`). Key variables:

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key (used by LiteLLM for Claude models) |
| `CLAUDE_CODE_OAUTH_TOKEN` | Optional — use Anthropic OAuth token instead of API key inside the sandbox |
| `LITELLM_MASTER_KEY` | LiteLLM admin key (auto-generated) |
| `LITELLM_API_KEY` | LiteLLM virtual key (auto-generated, same value as master) |
| `DOLT_ROOT_PASSWORD` | Dolt SQL server root password (auto-generated) |
| `BEADS_STORE_PASSWORD` | Password `bd` uses to connect to Dolt (same as `DOLT_ROOT_PASSWORD`) |
| `LANGFUSE_SECRET_KEY` / `LANGFUSE_PUBLIC_KEY` | Langfuse API keys (auto-generated) |
| `SANDBOX_IMAGE` | Docker image name for the agent sandbox (default: `boss-man:sandbox`) |
| `SERVER_PORT` | API server port (default: `3001`) |

### Model tiers

LiteLLM exposes three tier aliases used throughout the system:

| Tier | Model |
|------|-------|
| `boss-man/high` | Claude Opus (orchestrator, reviewer) |
| `boss-man/medium` | Claude Sonnet (implementer) |
| `boss-man/low` | Claude Haiku (simple workers) |

You can also pass any direct model ID (e.g. `claude-sonnet-4-6`) from the UI model selector.

---

## Agent Roles

### Orchestrator (`prompts/orchestrator.md`)

The orchestrator is a long-running Claude Code session that interviews you across 8 discovery topics before writing specs or dispatching workers:

1. Scope & deliverables
2. Stack & language
3. Testing strategy
4. Acceptance criteria
5. Non-functional requirements (perf, security, scale)
6. Protected territory (do-not-touch files/APIs)
7. Integration points (APIs, DBs, auth)
8. User workflow

Each topic ends with `<task-complete/>` to pause and wait for your reply. Only after all 8 are resolved does it proceed to planning and task creation.

### Workers (`prompts/workers/`)

Workers are short-lived single-iteration agents dispatched by the orchestrator via `spawn-worker`:

| Role | Prompt file |
|------|------------|
| `implementer` | `implementer.md` |
| `test_generator` | `test_generator.md` |
| `reviewer` | `reviewer.md` |
| `security_reviewer` | `security_reviewer.md` |
| `researcher` | `researcher.md` |

---

## How Sessions Work

1. **Start a session** — paste your initial spec into the Chat tab, choose a backend (Anthropic OAuth or LiteLLM) and model, click Start.
2. **Discovery** — the orchestrator asks one question per topic. Reply in the chat input and hit Enter.
3. **Each reply** is a new run that resumes the Claude Code session (`--resume <session-id>`), so full conversation context is preserved across turns.
4. **Mid-session model switching** — the model dropdown in the chat reply area is live: change it before any reply to switch models without losing context. If a run is active, click "cancel & switch" to abort it and prepare a reply with the new model.
5. **Session persistence** — Claude Code session files are stored on the host at `data/claude-sessions/<project-id>/` and bind-mounted into each container, so sessions survive server restarts.

---

## Directory Structure

```
boss-man-dashboard/
├── server/              # Hono API server (TypeScript)
│   └── src/
│       ├── index.ts     # Entry point, startup, markInterruptedRuns
│       ├── db.ts        # SQLite schema + queries
│       ├── runner.ts    # Sandcastle run orchestration
│       ├── streaming.ts # SSE event pub/sub + SQLite persistence
│       ├── config.ts    # Env var resolution, model/auth helpers
│       └── routes/      # sessions, runs, projects, beads, specs, models
├── ui/                  # Vite + React SPA (TypeScript)
│   └── src/
│       ├── App.tsx      # All UI components (single-file)
│       ├── api.ts       # Typed API client functions
│       └── types.ts     # Shared TypeScript types
├── sandcastle/
│   └── Dockerfile       # Agent sandbox image (Claude Code + bd + spawn-worker)
├── prompts/
│   ├── orchestrator.md  # 8-topic discovery system prompt
│   └── workers/         # Per-role worker prompts
├── scripts/
│   └── spawn-worker     # Shell script invoked by orchestrator to dispatch workers
├── data/                # Runtime data (gitignored)
│   ├── runs.db          # SQLite — projects, sessions, runs, events
│   ├── logs/            # Per-run raw log files
│   └── claude-sessions/ # Persisted Claude Code session caches (per project)
├── docker-compose.yml   # Dolt, Langfuse, standalone LiteLLM + Postgres
├── litellm-config.yaml  # Model aliases and routing config
├── callbacks.py         # LiteLLM callback for OpenAI Responses API compat
├── install.sh           # One-shot setup
├── start.sh             # Start all services
└── stop.sh              # Stop dev servers (optionally infra too)
```

---

## Sandbox Image

The sandbox is a Docker image that runs Claude Code in an isolated environment. Build it with:

```bash
# Run from the project root (not from sandcastle/)
docker build -t boss-man:sandbox -f sandcastle/Dockerfile .
```

`install.sh` does this automatically. The image includes:
- Claude Code CLI (`@anthropic-ai/claude-code`)
- Beads CLI (`bd`)
- PrismoDev (`getprismo`)
- `spawn-worker` script
- System-level git config (works for any user ID Sandcastle injects)

Sandcastle runs containers as the **host user's UID/GID**, mounts the git worktree at `/home/agent/workspace`, and symlinks `/workspace → /home/agent/workspace` for compatibility with any prompts that reference either path.

---

## Beads Task Tracking

[Beads](https://github.com/gastownhall/beads) is a structured task-graph CLI backed by Dolt. The orchestrator uses it to create, track, and complete tasks.

The API server exposes a Beads proxy at `/api/beads/*` so the orchestrator can manage tasks from inside the Docker sandbox via HTTP rather than needing direct Dolt access.

Ensure Dolt is running before the first session (`docker compose up -d dolt`). `install.sh` initializes the workspace automatically.
