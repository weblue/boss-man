# Boss Man Dashboard — Roadmap

## Done

- **P1** Infrastructure
- **P2** Orchestrator sessions
- **P3** UI: scaffold, project mgmt, chat, task board, run history, spec viewer
- **P4** Agent interaction UX
- **P5** Worker improvements
- **P6** Sandbox build & CI
- **P7** Multi-project
- **P11** Auth/security:
  - [x] `LITELLM_MASTER_KEY` gate on `/api/*`; login screen on first visit + 401; EventSource uses `?apiKey=`
  - [x] CORS restricted to localhost origins

## TODO

### P10 — LiteLLM rules-based routing

Replace static tier aliases with rules-based routing (token count, task type, cost, latency).

- [ ] **Local tier** (`boss-man/local`): add to `MODEL_TIERS` → `local-worker` alias (Ollama); expose `--model local` in spawn-worker; add to orchestrator model table; doc prereqs (litellm mode + Ollama). litellm-mode only.
- [ ] **Routing strategy**: eval LiteLLM `router_settings` (simple-shuffle, least-busy, latency/cost/usage-based); pick for orchestrator/worker split.
- [ ] **Rules**: per-role in `litellm-config.yaml` (orchestrator/reviewer → Opus, implementer/test_gen → Sonnet, refactor → Haiku).
- [ ] **Fallback chains**: Opus rate-limited → Sonnet; surface in Langfuse.
- [ ] **Cost guardrails**: `max_budget` + `budget_duration` per key/group.
- [ ] **Context-length routing**: >80k tokens → long-context variant.
- [ ] **UI**: show resolved model (post-routing) in run detail alongside requested tier.

### P12 — Prompt review

- [ ] Human review of `prompts/orchestrator.md` + `prompts/workers/*.md` — clarity, safety, guardrails, scope tightening so workers don't overreach.

### P8 — Token efficiency / SDK

Ordered by impact. Most blocked on `@ai-hero/sandcastle`; actionable if we fork. `[no SDK]` = unblocked now.

**#1 Workers restart cold each iteration** `[SDK]` · **critical** (250K input tokens on one 10-iter run)
Sandcastle applies resume only on iteration 1 (`iterationResumeSession = i===1 ? resumeSession : undefined`); iters 2–N relaunch fresh. Fix: thread each iteration's captured `sessionId` forward (`IterationResult.sessionId` exists). Workaround: `MAX_ITERATIONS` 10→3, prompts tell agents to stop+report blockers.

**#2 Session JSONL compaction between turns** `[SDK]` (partial) · **high** (49K+ tokens by turn 12)
Server detects >60K cumulative tokens, prepends `[Context monitor]` notice → orchestrator writes `checkpoint.md`. But JSONL still grows (Claude Code replays it on resume). True fix: after checkpoint, clear JSONL + start fresh session seeded with checkpoint. Needs SDK to (a) truncate/replace session file pre-resume, or (b) `startSession` option injecting synthetic prior-context as first turn. Neither exists.

**#3 Cache-prefix stability for orchestrator prompt** `[SDK]` · **medium** (~2,800-token prefix re-paid per session)
`buildFirstTurnPrompt()` concatenates static `orchestrator.md` with per-session message → no cache hit. Partial `[no SDK]`: memoize `loadOrchestratorPrompt()` (done — was readFileSync per call). Full fix: needs `ClaudeCodeOptions.systemPrompt` to move static instructions to system turn.

**#4 Worker prompts in user-turn not system** `[SDK]` · **medium** (~750–1,200B boilerplate uncacheable)
Same `systemPrompt` gap as #3. No workaround.

**#5 Cancelled runs discard partial session IDs** `[SDK]` · **medium** (retries restart cold)
Cancel after N/M iters loses captured state. Fix: SDK exposes per-iteration sessionId via callback (`onIterationComplete`) so server can `updateRun` mid-run. Workaround: orchestrator sessions scan all runs for last non-null `last_session_id`; workers have none.

**#7 Structured agent event model** `[SDK]` · observability only
Expand events beyond `text`/`toolCall` (assistant_text_delta, tool_started/stdout/stderr/result, file_changed, diff_available, approval_requested, run_status_changed, error, done). Blocked: Sandcastle only emits `text`/`toolCall`.
