# Boss Man Dashboard — Roadmap

## Done

- **P1** Infrastructure
- **P2** Orchestrator sessions
- **P3** UI: scaffold, project mgmt, chat, task board, run history, spec viewer
- **P4** Agent interaction UX
- **P5** Worker improvements
- **P6** Sandbox build & CI
- **P7** Multi-project
- **P8** Token efficiency / SDK
  - [x] #2 Session JSONL compaction between turns
  - [x] #1 Warm resumes across iterations — automatic in Docker mode via `captureSessions` + session bind mounts + Sandcastle 0.7.0
  - [x] #4 Persist cancelled-run session metadata — `getAbortMetadata()` on AbortError
  - [x] #5 Richer stream events — `result` + `sessionId` wired in runner.ts
- **P11** Auth/security

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

- [ ] Human review of `prompts/orchestrator.md` + `prompts/workers/*.md` — clarity, safety, guardrails, scope tightening so workers don't overreach. (Machine pass done 2026-06-10: token-economy rules + integration-first TDD merged in from llm-briefcase/agent-jacket; human sign-off still pending.)
- [ ] Trim per-project `CLAUDE.md` template — it loads into every worker/orchestrator turn (a per-turn token tax). Drop empty boilerplate sections (`Build & Test`, `Architecture Overview`, `Conventions` placeholders) and keep it under ~200 lines / lookup-table style.

### P8 — Token efficiency / SDK (remaining)

- [ ] **P8 #2 — Cache-prefix stability for orchestrator prompt** · **medium** (~2,800-token prefix re-paid per session)
  `buildFirstTurnPrompt()` concatenates static `orchestrator.md` with per-session message → no cache hit. Partial `[no SDK]`: memoize `loadOrchestratorPrompt()` (done). Full fix needs `ClaudeCodeOptions.systemPrompt` to move static instructions to a system turn. SDK-blocked.
- [ ] **P8 #3 — Worker prompts in user-turn not system** · **medium** (~750–1,200B boilerplate uncacheable)
  Same `systemPrompt` gap. No workaround yet. SDK-blocked.