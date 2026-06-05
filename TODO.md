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

### Phase 5 — Worker Improvements

### Phase 6 — Sandbox Image Build & CI

### Phase 7 — Multi-Project



## TODO

### Phase 4 — Agent Interaction UX

Goal: the web UI should expose the full useful experience of a Docker-contained Claude Code (or other) agent without making tmux/container terminal state the source of truth. The core contract is an append-only structured event stream: containers execute the agent and emit events, the API persists and broadcasts those events, SQLite provides short-term replay, and tmux/docker exec remains a debug escape hatch.

- ~~**Event stream contract**~~ — dropped; the stream already works in practice (seq, replay, heartbeat, dedup). Writing a formal spec for a project you own adds no value.
- [ ] **Structured agent event model**: expand persisted/SSE events beyond text and tool-call starts to include `assistant_text_delta`, `tool_call_started`, `tool_stdout`, `tool_stderr`, `tool_result`, `file_changed`, `diff_available`, `approval_requested`, `run_status_changed`, `error`, and `done`. *(blocked: Sandcastle only emits `text` and `toolCall` events)*
- [x] **Tool activity UI**: render expandable tool-call rows in Chat and Runs with command and args; click to expand full text.
- [x] **Diff/file-change surfacing**: detect changed files after each run via `git diff --name-only`; store in `runs.changed_files`; render file list in run detail panel.
- [x] **Attach terminal debug action**: debug panel with `docker ps` and `docker exec` commands shown for active runs in the Runs tab.
- [x] **Transcript retention policy**: `DELETE /api/sessions/:id` cascade-deletes all runs and events; delete session button (with confirm) added to chat sidebar.
- [x] **Worker links in orchestrator transcript**: parse `spawn-worker --role` from Bash toolCall events; render linked chips to the matching worker run.

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


### Phase 11 - auth/security

- [ ] Session auth (simple API key gate on all `/api/*` routes) for network exposure
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

#### [BLOCKED: SDK] #5 — Orchestrator tool restrictions

**Impact:** The orchestrator can call any tool, including ones it should never touch (file edits outside `.spec/`, running builds directly). Prompt-level enforcement is the current mitigation but is not enforced.

**Fix needed in SDK:** `ClaudeCodeOptions` needs to expose `--allowedTools` / `--disallowedTools` so the server can restrict the orchestrator to `Bash`, `Read`, and specific write paths at launch time.

---

#### [BLOCKED: SDK] #8 — Cancelled runs discard partial session IDs

**Impact:** If a worker run is cancelled after 5 of 10 iterations complete, the captured session state from those 5 iterations is lost. Any retry starts completely cold.

**Fix needed in SDK:** Expose per-iteration session IDs via a callback (e.g. in `logging.onAgentStreamEvent` or a new `onIterationComplete` hook) so the server can call `updateRun(id, { last_session_id })` after each iteration rather than waiting for the final result. `IterationResult.sessionId` is already populated per-iteration in the result array — the SDK just doesn't expose it mid-run.

**Current workaround:** For orchestrator sessions, `routes/sessions.ts` scans all runs in the session for the last non-null `last_session_id` when building a reply, so partial progress survives across turns. Worker runs have no equivalent recovery path.

---