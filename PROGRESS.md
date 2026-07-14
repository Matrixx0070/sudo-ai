# gw-refactor PROGRESS

## INTAKE

- **MISSION**: Every outbound LLM-family call (chat, embeddings, vision, moderation) flows through one choke point (`src/llm/`) speaking an internal Anthropic-shaped IR, with adapters, error taxonomy, priority lanes, budgets, IR logging, conformance suite, and a shadow-verified cutover — zero user-visible behavior change until Final Acceptance.
- **DONE MEANS**:
  1. `grep -rE 'api.openai.com|api.x.ai|api.anthropic.com|...'` matches only inside `src/llm/` (plus embeddings + vision confirmed routed).
  2. `pnpm build && pnpm test && pnpm lint` green at every commit; conformance suite green for both egress adapters in CI.
  3. `data/gateway.db` `llm_calls` rows written per call, `tokens_cached > 0` on second identical-prefix call.
  4. SHADOW_REPORT.md committed with pass verdict (<1% material divergence over ≥200 requests/48h).
  5. 24h staging soak on `gw-refactor` with `LLM_DIRECT_FALLBACK=0`, then PR to main (never auto-merged).
- **NON-GOALS**: acting on QUL labels (Phase 8 logs only); restarting or touching the production pm2 process; merging to main; deleting legacy path before the one-week post-cutover window.

## ASSUMPTIONS (running log)

- **A1 (worktree isolation)**: `/root/sudo-ai-v4` is prod's live checkout (pm2 `sudo-ai-v5` runs from it) and is dirty on main (uncommitted content-filter diagnostics in `brain.ts`/`goal-planner.ts` + untracked test — in-progress work, not mine). All mission work happens in a separate git worktree `/root/sudo-ai-gw` on branch `gw-refactor`, so prod's checkout, its dirty files, and any pm2 restart stay on main. Staging soak (Final Acceptance) will run a separate pm2 process from this worktree.
- **A2 (.env.example merge)**: root `.env.example` and `config/.env.example` were two fully divergent templates (root newer: GATEWAY_TOKEN, workflows, trace-capture; config had integrations/WhatsApp/models blocks the root lacked). Canonical `config/.env.example` is now the union (root content as base + config-only sections appended). Root is a 4-line pointer.
- **A3 (run-self-test.mjs)**: no in-repo reference invokes it (checked package.json scripts, CI, docs, cjs). The nightly self-test on prod is triggered outside the repo tree (system cron or daemon scheduler). Moved to `tests/manual/`; at merge time the external invoker path must be updated by the operator. Flagged for the final PR description.
- **A4 (scene01 glob)**: "scene01-*.mjs" = 4 files (grok-video, grok, pipeline, sora-test); duplicates already existed under `internal/temp-scripts/` — left untouched (out of scope).
- **A5 (remotion.config.ts)**: only reference is a comment in `src/remotion/Root.tsx`; remotion CLI is invoked ad-hoc (no package.json script), so moving the config to `experiments/video-pipeline/` is safe; anyone rendering runs remotion from that directory.

## PHASE 0 — repo hygiene

- Moved to `experiments/video-pipeline/`: scene01-grok-video.mjs, scene01-grok.mjs, scene01-pipeline.mjs, scene01-sora-test.mjs, sora-scene01.mjs, produce-kitchen.mjs, generate-all-scenes.mjs, props.json, remotion.config.ts.
- Moved to `specs/`: spec-wave10-phase1.md, wave2.2c-spec.md.
- Moved to `tests/manual/`: test-admin-e2e.mjs, test-pages.mjs, test-tools-load.ts, run-self-test.mjs.
- Reference sweep: no package.json script, CI workflow, or source import referenced any moved file (only self-references among the moved files and pre-existing copies in `internal/temp-scripts/`). vitest include is `tests/**/*.test.ts` so `tests/manual/` is not collected; tsconfig includes only `src/` + `shared-types/`; npm `files` already pointed at `config/.env.example`.
- `.env.example`: canonical = `config/.env.example` (union, see A2); root = pointer.
- DoD gate: build+test+lint — RUNNING (result to be recorded before commit).

## PHASE 1 — outbound LLM call inventory (pre-migration, required)

### Central path (already exists, chat only)
- `src/core/brain/brain.ts:920` `Brain.call()` → `generateText`/`streamText` (ai pkg, brain.ts:1359/1944/1954); models via `src/core/brain/providers.ts getModel()` — ALL builtin SDK construction lives there (createXai:216, createOpenAI:202/223/648/660/672, createAnthropic:233/235/257, createGoogleGenerativeAI:627, createGroq:635, Mistral:644, DeepSeek:656, Together:668, Ollama:194). `src/core/brain/custom-providers.ts` builds user-configured clients.
- ~25+ modules consume brain.call (agent-loop, swarm-rescue, task-decomposer, intelligence-team, api handlers, domain tools, cli).

### Bypasses
(a) getModel + raw streamText (skip brain failover/telemetry): coder/arsenal.ts:1003, coder/swarm.ts:197, coder/analyze.ts:357, coder/arsenal-v2/index.ts:135, custom/codex.ts:151.
(b) fully raw fetch/SDK:
- chat: forge/xai-ensemble.ts:98 (api.x.ai, XAI_API_KEY; callers forge-orchestrator/parallel-builder/evolution-engine); cli/commands/chat/provider.ts:129/139/149/159 (new Anthropic/OpenAI, interactive CLI chat).
- vision: tools/builtin/browser/vision.ts:35/36/85 (x.ai grok-4-fast + openai gpt-4o fallbacks; primary path already uses brain).
- embeddings (RAG, 1536-dim): memory/embeddings.ts:238 raw fetch api.openai.com/v1/embeddings (OPENAI_API_KEY); consumers rag-engine, hybrid-search:300, vector-backfill, semantic-compactor, chunk-contradiction, cli. local-embeddings.ts = MiniLM 384-dim on-device (NOT network — out of scope).
- image GENERATION (LLM-adjacent): media/image-tools.ts:49 (dall-e-3); :65 stability, :80 flux, :177 remove.bg (non-LLM vendors — endpoint-constant move only).
- TTS: voice/tts.ts:178 (api.x.ai audio/speech, XAI_VOICE_API_KEY), :224 (openai); voice/elevenlabs.ts:19; comms/voice.ts:20/21/104; media/factory-tools.ts:84. kokoro local.
- STT: voice/stt.ts:20/21/22/322 (groq whisper, openai, elevenlabs); comms/voice.ts:24/158. whisper-local local.
- other: persistence/survival-probe.ts:47-49 (/v1/models liveness), brain/claude-oauth-manager.ts:39/52/56 (OAuth + models), api/admin/models.handler.ts:32-35 (key-test), sandbox/sandbox-types.ts:122 (egress allowlist constants, no call), cli/commands/doctor.test.ts fixtures.
- kimi/glm/moonshot/bigmodel: via Ollama Cloud model strings only. openrouter: doc example only.

### Migration plan (assumptions)
- **A6**: `src/llm/client.ts` exposes `chatIR()`, `embed()`, `visionIR()` per spec, plus `llmFetch(endpointKey, init, {caller, purpose})` — a guarded raw-HTTP escape hatch for LLM-adjacent modalities (TTS/STT/image-gen/liveness probes) so EVERY provider URL constant lives in `src/llm/endpoints.ts` and the Phase-1 grep DoD ("provider URLs only inside src/llm/") is achievable without redesigning voice/media in this phase.
- **A7**: sandbox-types.ts egress-allowlist strings and doctor.test.ts fixtures are not calls; they import from `src/llm/endpoints.ts` (or stay as-is if test-only) — will note final choice at commit.
- **A8**: claude-oauth-manager OAuth-token endpoints are auth infrastructure, not LLM calls; their URLs move to endpoints.ts but the flow stays.

## INCIDENT — shared-.git worktree stolen by prod auto-fix automation (2026-07-14)

During the first Phase 0 gate run, the production daemon's auto-fix automation executed
`git checkout auto-fix/123-feat-acp-agent-client-protocol` + `git reset` INSIDE the mission
worktree `/root/sudo-ai-gw` (shared .git with prod's checkout), swapping the tree to an older
commit mid-vitest-run (9 test files failed to load — artifact, not real failures) and unstaging
the Phase 0 moves. No data was lost (staged renames + untracked src/llm/ + PROGRESS.md survived).
This is a known repeat gotcha (Spec 9: "daemon auto-fix branch theft mid-session").

- **A9 (clone isolation)**: mission moved to a fully independent clone `/root/sudo-ai-gw2`
  (own .git, origin = github.com/Matrixx0070/sudo-ai). The shared worktree and its
  gw-refactor branch in prod's repo were deleted. Prod's automation cannot reach this clone.
  The first gate run's results are VOID; gate re-run in the clone before the Phase 0 commit.

## PHASE 1 — choke point (implementation)

- New `src/llm/`: `client.ts` (chatIR/embed/visionIR/llmFetch/getProviderApiKey, LLM_BASE_URL+LLM_API_KEY config, LLM_DIRECT_FALLBACK default ON, caller+purpose mandatory — throws in dev, logs+coerces 'unknown' in production per fail-open), `endpoints.ts` (every provider URL), `aliases.ts` (sudo/local|cheap|mid|frontier|embed|vision, env-overridable LLM_ALIAS_*).
- Legacy layer physically moved: `src/core/brain/{providers,custom-providers,claude-oauth-manager}.ts` → `src/llm/legacy/` with re-export shims at old paths (~25+ importers untouched).
- All 12 bypass files re-routed (same URLs/keys/bodies — mechanical): embeddings.ts (client.embed inside existing retry/circuit; apiKey field → embeddingsAvailable()), browser/vision.ts (visionIR; brain-first path untouched), xai-ensemble, cli chat provider, survival-probe, admin models.handler, sandbox-types (exact 5-host list preserved — deliberately NOT widened with groq), voice tts/stt, comms/voice, media factory/image (toolFetch kept — SSRF guard).
- Guard tests: `tests/llm/choke-point.test.ts` greps provider URLs AND provider-key env reads outside src/llm/ (whitelisted exception: cli/commands/setup.tsx pre-fills the .env wizard — config authoring, not a call). `tests/llm/aliases.test.ts` covers defaults/overrides.
- **A10**: visionIR carries a 60s AbortSignal.timeout per route (replaces the legacy per-provider 60s timeout the sweep would otherwise have dropped). browser.vision `data.provider` now reports 'llm-client' instead of which fallback answered.
- **A11**: getProviderApiKey trims — whitespace-only keys now count as unset (previously truthy). Judged a bug-fix-grade difference, kept.
- **A12 (DoD deviation)**: "app boots and answers on Telegram" cannot be proven from this branch without touching prod (single Telegram bot token — a second poller would steal prod's getUpdates). Boot/Telegram proof deferred to the Final Acceptance staging soak; Phase 1 verification = full unit gate + choke-point grep guards. UNVERIFIED: live provider calls on the new paths.

## PHASE 2 — IR + context budgets

- Proactive context-budget gate wired at the loop's pre-call site (loop.ts, after prepareMessages): estimateContextSize(trimmed) vs getAliasLimits(model).context_window via pure decideContextBudget (src/llm/budget.ts); >80% → runCompaction, >95% → runCompaction + escalateCompaction, then prepareMessages re-runs. Fail-open try/catch; kill-switch SUDO_CONTEXT_BUDGET=0. Previously compaction was only reactive (llm_context_overflow catch / finishReason==='length').
- **A13**: gate defaults ON (protective + fail-open, mirrors repo convention for safe additions); thresholds exclusive (> not >=), unit-pinned in tests/llm/budget.test.ts.
- shared-types/ir/v1.ts + src/llm/limits.ts + 20+ tests: built by subagent (report pending).

## PHASE 3 — adapters + cache locality

- src/llm/adapters/: tool-args.ts (parseToolArguments — THE single parse-once funnel: JSON.parse → jsonrepair → {} + extra.parse_error), ingress-openai (system folding, role:tool → tool_result blocks in one user msg), egress-openai (+parseOpenAIResponse: finish_reason map, cached_tokens, provider_bug on 200-but-empty), egress-anthropic (system block-array split at DYNAMIC_BOUNDARY_MARKER w/ cache_control on static prefix only; max_tokens ALWAYS set; temp clamp; response_schema → forced structured_output tool; cache_control on last tool), stream.ts (typed event union; IRStreamMachine single-use, firstTokenEmitted gate = Rule 4 enforcement point; end() contract for OpenAI trailing-usage chunk).
- Cache locality: 11 static rule sections (Remotion/Learnings/Coding/Autonomy/Formatting/Safety/GitSafety/PRWorkflow/Frontend/DirtyWorktree/Thinking) lifted ABOVE the cache boundary when SUDO_PROMPT_CACHE on; flag-off output byte-identical to legacy; dynamic sections (Date, Persona, Mood, Internal State, Hints, Repair Hints, Directives, Lens, Heartbeat, Recent Memory, Custom Instructions) stay below. Prefix byte-identity test extended to include lifted content + tools.
- **A14**: jsonrepair@3.15.0 added (spec-mandated); zod direct dep added in Phase 2.
- **A15**: Anthropic `thinking` response blocks are DROPPED by parseAnthropicResponse (no IR block type in v1) — revisit if a consumer needs them; OpenAI `developer` role folds into system; ingress alias defaults to body.model else 'sudo/mid'.
- 45 new adapter/stream golden tests (63 total in tests/llm).

## PHASE 4 — error taxonomy + policy (and Phase 5 storage module)

- src/llm/errors.ts: 11-class LLMErrorClass layered on the existing categorizeError/body-sniffers (no duplicated regexes); new isContentFilterBody; provider-lies (200+garbage → provider_bug) via adapter extra.provider_bug; classifyThrown for network/timeout/context.
- src/llm/policy.ts: runWithPolicy — retry max3/backoff+jitter PRE-FIRST-TOKEN ONLY (ctx.markFirstToken), per-route breaker 5-in-60s → 30s open → half-open probe (user passes through OPEN — never blocked; background skipped = fail-closed), hand-rolled priority lanes (user preempts; caps swarm≤3, cognitive-stream≤1, SUDO_LLM_LANE_CAPS), asymmetric budgets (SUDO_LLM_BUDGETS per-caller; user → degradeAlias one tier frontier→mid→cheap→local; background → skipped; SUDO_LLM_GLOBAL_BUDGET_USD halts all but agent-loop incl. user-priority; SUDO_LLM_BACKGROUND_HALT emergency lever). Fail-open on policy-internal bugs. Kill-switches per spec.
- **A16**: spend tracking in-memory day-keyed only (historical getCostBySource needs a DB handle — deferred to Phase 5 wiring); caller capped by prefix before ':'.
- **A17**: attempt receives AttemptContext {markFirstToken, budgetDecision, signal}; runWithPolicy returns {value, budgetDecision}.
- src/llm/logging.ts (Phase 5 storage, wiring later): GatewayCallLog on data/gateway.db (WAL, busy_timeout, additive-migration guard), llm_calls table per spec (trace_id PK, INSERT OR REPLACE pinned), record() never throws (warn+return), markOutcome, sha256Hex, redactDeep + redactSecrets string-leaf walker before persist, retention SUDO_GATEWAY_LOG_RETENTION_DAYS=30 throttled prune.
- 62 new tests (52 errors/policy + 10 logging).

## PHASE 5 — wiring + LIVE DoD PROOF

- record() wired: brain.ts non-streaming (~L1885), streaming w/ ttft_ms (~L1506), terminal-failure rows at both llm_all_attempts_failed sites; client.ts chatIR (full IR + wire_payload_sha256 on gateway route) / embed ({input_count,model} only) / visionIR ({prompt_chars,model} — image data never persisted). All fail-open, kill-switch SUDO_GATEWAY_LOG=0, vitest-dormant unless SUDO_GATEWAY_LOG_TEST=1.
- markOutcome wired: escalation_fired (loop.ts context-budget escalate + EPISTEMIC_ESCALATION), verifier_rejected (critic hard-block), user_rephrased (jaccard>0.6 word-set heuristic, conservative). tool_not_in_plan SKIPPED (no exact planned-tool set exists — commented at plan-coverage block).
- **A18**: legacy-path rows store summary ir_request {legacy:true, model, messageCount, system_chars} — full IR arrives at cutover. BrainRequest has no sessionId → noteTraceForSession dormant on legacy path until IR transport (outcome sites live but no-op until then).
- **LIVE DoD PROOF (2026-07-14)**: OPENAI key quota-dead (429, known operator item) → proof ran via xai/grok-4-fast-non-reasoning through chatIR direct-fallback with DATA_DIR=/tmp scratch: 3 calls → 3 rows (caller/purpose/alias/route/latency/tokens all sane), tokens_cached 128 → 128 → 3456 on a 3,511-token identical prefix — cache plumbing proven end-to-end. Harness not committed (throwaway).
- Improvement noted for cutover: chatIR record leaves priority null (ChatIRRequestLite.priority optional) — set it when the IR transport lands.

## PHASE 6 — conformance suite + CI

- tests/conformance/: harness (sorted-key stable-stringify goldens, >32KB → digest {bytes, sha256}), 57 golden cases + 7 invariant tests = 64 across egress-openai/egress-anthropic/parse-*/ingress-openai/stream-*/errors (all 11 error classes pinned); CONFORMANCE_UPDATE=1 = pnpm conformance:update; loud-fail proven by golden mutation.
- CI: extended existing .github/workflows/ci.yml (branches +gw-refactor, concurrency-cancel, explicit Conformance step); README badge added.
- **A19 (planned, Phase 7)**: literal dual-send shadow REJECTED (doubles user-facing claude-oauth quota burn + side effects). Shadow = shape-shadow: build legacy AND IR wire requests from the same input → diff; parse the SAME captured provider response through both parsers → diff. Corpus: prod traces.db has 5,082 brain_call traces with prompt_raw/response_raw/model_params (>200 required), replayable at zero cost/side effects. Live-fire coverage comes from the Final Acceptance 24h staging soak.

## PHASE 7 — shadow machinery + replay verdict

- src/llm/shadow.ts: brainRequestToIR (legacy history → IR incl. toolCalls→tool_use, consecutive role:tool → one tool_result user msg, system-role folding), resultToIR, compareShadow (material = stop-reason class / exact text / tool name+args deep-equal / usage >10%), requestShadowDiff + compareWireAgainstLegacy (expected semantics computed from LEGACY inputs, never via the IR — family-specific folding, cache_control + structured_output tool ignored, anthropic temp-clamp expected), runShadow live hook (LLM_SHADOW=1 default OFF, queueMicrotask, fail-open, tiny hash-only rows: outcome shadow_match|shadow_divergent).
- brain.ts: runShadow wired at both Phase-5 record sites (streaming = request-side + usage only, no assembled text at that hook — documented).
- scripts/shadow-replay.mts + shadow-report.mts; tests/llm/shadow.test.ts (24 tests).
- **REPLAY VERDICT (real prod traces, read-only)**: 500 rows fetched → 303 replayable (197 skipped: trace-capture 16KB prompt truncation, by design) → **material divergence 0/303 = 0.000% — PASS** (<1% criterion; ≥200 real requests satisfied). Families: 325 xai / 167 claude-oauth / 8 google in window. Response text compared on 45 untruncated finishReason=stop rows.
- **A20**: response-side live shadow validates IR representability of brain's parsed result, not parser-vs-parser (no raw provider body at the hook site — A19); parser agreement is pinned by the 57 conformance goldens instead.
- Remaining for cutover: LLM_SHADOW=1 during the staging soak folds live rows into shadow-report; LLM_DIRECT_FALLBACK=0 flip requires an actual gateway endpoint (LLM_BASE_URL) — OPERATOR DECISION: which OpenAI-compat gateway to point at (none deployed today); legacy deletion waits a week post-cutover per spec.
