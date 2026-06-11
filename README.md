# Boss Man Dashboard

Local control plane for multi-agent AI development. You describe the goal; an orchestrator (Opus) interviews you until the spec is unambiguous, commits it, decomposes it into a task graph, and drives sandboxed workers through a test-first pipeline. Every token, tool call, and file change visible live.

![Orchestrator session](docs/screenshots/chat.png)

## Pipeline

1. **Discovery** — one question per turn, 8 topics. No spec until all resolved.
2. **Spec** — `constitution.md` / `spec.md` / `plan.md` / `tasks.md` committed to `.spec/`. You approve before anything is built.
3. **Execution** — per task: red integration tests → green implementation. Unit tests only to pin regressions. Orchestrator coordinates, never codes.
4. **Review gate** — Opus reviewer checks everything against the spec. Merge to main from the UI.

![Spec tab](docs/screenshots/spec.png)
*Committed spec artifacts, rendered from any branch.*

Model behind each tier is picked at boot — `./start.sh` menu, or pin `BOSS_MAN_AUTH_MODE` + `BOSS_MAN_PROFILE_HIGH/MED/LOW` in `.env` and skip it with `-y`.

| Tier | Roles | Default |
|------|-------|---------|
| `boss-man/high` | orchestrator, reviewers | Opus |
| `boss-man/medium` | implementer, test_generator, researcher | Sonnet |
| `boss-man/low` | refactor | Haiku |

## Under the hood

- **Server-owned context.** Orchestrator turns never resume a provider session (history replays in full, costs snowball). Each turn is rebuilt: prompt + rolling summary + task state + recent turns verbatim. Bounded forever, any session length.
- **Sandboxed.** Docker container + isolated git worktree branch per run. Your checkout changes only when you merge.
- **Token discipline.** RTK filters command output in every sandbox (60–90% savings); workers get context manifests instead of re-exploring the codebase; mechanical roles run capped thinking budgets; per-run token accounting in the UI.
- **Task graph in SQLite, via MCP.** Dependencies gate dispatch, memories persist across sessions, same store drives the UI board. No external tracker.

![Task board](docs/screenshots/tasks.png)
*Red tests in progress, implementation blocked behind them.*

- **Live observability.** SSE streaming; when the orchestrator blocks on a worker, the UI names which one and for how long. Changed files tracked per run. Langfuse traces in litellm mode.
- **Recovery.** Checkpoints to `.spec/checkpoint.md`; interrupted sessions resume.
- **Two auth modes.** `claude` — subscription auth, no API billing. `litellm` — proxy mode: local Ollama, OpenAI models, Codex/opencode harnesses.

## Setup

Needs Node 22+, Docker + Compose v2, git, and a Claude subscription (`claude` CLI logged in) or `ANTHROPIC_API_KEY`.

```bash
./install.sh   # .env + deps + sandbox image
./start.sh     # pick auth mode + model per tier; -y to skip menu
```

UI at **http://localhost:8770** — log in with `LITELLM_MASTER_KEY` from `.env`.
`./stop.sh` stops dev servers (`--infra` for LiteLLM/Langfuse too).

## Use

1. **+** new project — empty or clone a repo URL.
2. Paste your idea, pick a model, **Start**.
3. Answer the interview; confirm the spec summary.
4. Watch: Tasks fills and drains, Runs streams worker activity, Spec shows artifacts.
5. Review gate passes → merge from the Runs tab.

Mid-session: switch models (cancel & switch if a turn is active), force compaction (↻), cancel any run.

![Run detail](docs/screenshots/runs.png)
*One worker run: each command, what it cost, what it changed.*

## Config

All in `.env` (generated). Worth knowing:

| Var | Purpose |
|-----|---------|
| `BOSS_MAN_AUTH_MODE` | `claude` or `litellm` default for `-y` |
| `OPENAI_API_KEY` | enables gpt-4o tiers in litellm mode |
| `BOSS_MAN_LOCAL_MODEL` | Ollama model for `local-worker` |
| `SERVER_PORT` / `UI_PORT` | defaults 8771 / 8770 |

Direct model IDs work via the API: claude mode passes `claude-*` through; litellm mode needs the model registered in `litellm-config.yaml`.

## Layout

```
server/src/        Hono API — runner, SSE, rolling context, SQLite, routes/
ui/src/            React SPA — chat, tasks, runs, spec
prompts/           orchestrator.md + workers/*.md
scripts/spawn-worker   orchestrator → worker dispatch
sandcastle/Dockerfile  sandbox image (rebuild after changing scripts/)
data/              runtime (gitignored): runs.db, logs/, claude-sessions/
```
