# Boss Man Dashboard — Implementation Roadmap

## Completed

### Phase 1 — Infrastructure

### Phase 2 — Orchestrator Sessions

### Phase 3 — UI (Discovery Chat + Dashboard)

#### 3a — Scaffold
#### 3b — Project Management
#### 3c — Discovery Chat tab
#### 3d — Task Board tab
#### 3e — Run History tab
#### 3f — Spec viewer tab

### Phase 4 — Agent Interaction UX

### Phase 5 — Worker Improvements

### Phase 6 — Sandbox Image Build & CI

### Phase 7 — Multi-Project



## TODO

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

### Phase 12 — Prompt Review

- [ ] **Human review of all agent prompts** — review `prompts/orchestrator.md` and all `prompts/workers/*.md` for quality, safety, and alignment with actual task patterns. Check for ambiguous instructions, missing guardrails, and opportunities to tighten scope so workers don't overreach.

---

### Phase 11 - auth/security

- [x] Session auth — `LITELLM_MASTER_KEY` gate on all `/api/*` routes; UI shows a login screen on first visit and on 401; EventSource uses `?apiKey=` query param (browsers can't set SSE headers)
- [x] **CORS** — restrict `Access-Control-Allow-Origin` to localhost origins only (already implemented in `server/src/index.ts`)

---

### Phase 8 — Token Efficiency & SDK Improvements

Items ordered by impact on token cost / project health. Most are blocked on upstream `@ai-hero/sandcastle` SDK capabilities; if we fork the dep these become actionable. Items marked **[no SDK needed]** are unblocked today.

---

#### #1 — Multi-iteration workers restart cold on every iteration
`[BLOCKED: SDK]` · **Token impact: critical** — proven 250K input tokens on a single 10-iteration implementer run

Each iteration re-reads the full codebase context from scratch.

**Root cause:** In `@ai-hero/sandcastle/dist/Orchestrator.js`:
```js
const iterationResumeSession = i === 1 ? options.resumeSession : undefined;
```
Resume is only applied on iteration 1. Iterations 2–N launch Claude Code fresh with the same original prompt and no memory of what the previous iteration did.

**Fix needed in SDK:** Pass the previous iteration's captured `sessionId` as `iterationResumeSession` for iterations 2+. Each `IterationResult` already has a `sessionId` field — the Orchestrator loop just needs to thread it forward.

**Workaround already applied:** Default `MAX_ITERATIONS` lowered from 10 → 3 in `scripts/spawn-worker`, and worker prompts instruct agents to stop and report blockers rather than spinning. This limits the blast radius but doesn't fix the cold-start per-iteration cost.

---

#### #2 — Session JSONL compaction between reply turns
`[BLOCKED: SDK]` (partial workaround in place) · **Token impact: high** — orchestrator accumulates 49K+ tokens of prior tool calls by turn 12

**What's implemented:** The server detects cumulative token growth > 60K and prepends a `[Context monitor]` notice asking the orchestrator to write `checkpoint.md`. This prompts the orchestrator to save state, but does NOT shorten the session JSONL that Claude Code replays on the next resume — the file just keeps growing.

**True fix:** Between reply turns, after the orchestrator writes `checkpoint.md`, clear the session JSONL and start the next turn as a new Claude Code session whose first message is the checkpoint content. This requires either:
  - (a) A Sandcastle API to truncate/replace the session file before a resume run, or
  - (b) A `startSession` option on `run()` that begins fresh but injects a synthetic prior-context message as the first user turn.

Neither exists today. The checkpoint write buys time but doesn't eliminate the growth.

---

#### #3 — Cache-prefix stability for orchestrator system prompt
`[BLOCKED: SDK]` · **Token impact: medium** — ~2,800-token static prefix re-paid on every new session

Anthropic's prompt cache cannot hit the stable `orchestrator.md` prefix because it's concatenated with the per-session user message inside `buildFirstTurnPrompt()`. Every new session pays full cache-creation cost for the static instructions.

**Partial fix available now (no SDK needed):** Memoize `loadOrchestratorPrompt()` at module load in `routes/sessions.ts` — currently it does `readFileSync` on every call. Low-value but trivial to land.

**Full fix blocked on SDK:** `ClaudeCodeOptions` (in `AgentProvider.d.ts`) currently only exposes `effort`, `env`, `captureSessions`, `sessionStorage` — no `systemPrompt` field. If added, move the static orchestrator instructions to the system turn so they cache independently of the variable user message.

---

#### #4 — Worker system prompts in user-turn instead of system param
`[BLOCKED: SDK]` · **Token impact: medium** — ~750–1,200 bytes of static role boilerplate cannot cache per worker call

All worker templates concatenate role boilerplate with the variable task description in a single user message. The static portion cannot cache as a stable prefix.

**Blocked on:** Same `ClaudeCodeOptions.systemPrompt` gap as #3. No workaround until the SDK exposes it.

---

#### #5 — Cancelled runs discard partial session IDs
`[BLOCKED: SDK]` · **Token impact: medium** — cancelled workers restart fully cold on retry, wasting all context from completed iterations

If a worker run is cancelled after N of M iterations complete, the captured session state from those iterations is lost.

**Fix needed in SDK:** Expose per-iteration session IDs via a callback (e.g. in `logging.onAgentStreamEvent` or a new `onIterationComplete` hook) so the server can call `updateRun(id, { last_session_id })` after each iteration rather than waiting for the final result. `IterationResult.sessionId` is already populated per-iteration in the result array — the SDK just doesn't expose it mid-run.

**Current workaround:** For orchestrator sessions, `routes/sessions.ts` scans all runs in the session for the last non-null `last_session_id` when building a reply, so partial progress survives across turns. Worker runs have no equivalent recovery path.

---

#### #7 — Structured agent event model
`[BLOCKED: SDK]` · **Impact: observability** — richer UI fidelity; no token savings

Expand persisted/SSE events beyond `text` and `toolCall` starts to include `assistant_text_delta`, `tool_call_started`, `tool_stdout`, `tool_stderr`, `tool_result`, `file_changed`, `diff_available`, `approval_requested`, `run_status_changed`, `error`, and `done`.

**Blocked on:** Sandcastle only emits `text` and `toolCall` events today. Full event taxonomy requires the SDK to surface the underlying Claude Code event stream.

---