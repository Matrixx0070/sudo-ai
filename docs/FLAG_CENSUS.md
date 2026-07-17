# F81 — Feature-Flag Census & Activation Matrix

Generated 2026-07-17 (Wave A, `docs/CORE_ROADMAP.md`). A snapshot, not living
state — regenerate after flag changes (method below).

## Method

- **Presence:** every `SUDO_*` / `LLM_*` name occurring anywhere under `src/`
  (string literals + constants — catches indirect reads like `env['X']` and
  named-constant indirection; may also count doc-comment mentions).
- **Inferred default** (only for flags read directly as `process.env[...]`):
  `=='1'` → opt-in (default OFF) · `!='0'`/`=='0'` → default ON (kill via =0) ·
  `Number(...)` → numeric tunable · bare read → value/string · else mixed.
  Flags never read directly are marked *indirect* — classify by hand.
- **Prod state:** pm2 app `sudo-ai-v5` env (`ecosystem.config.cjs`,
  authoritative for the child) layered over `config/.env` (52 SUDO_/LLM_
  entries). Secret-like values redacted.

## Totals

- Distinct `SUDO_*` names in src: **590**; `LLM_*`: **9**
- Flags set in prod: **121**
- Opt-in (default OFF) flags NOT set in prod: **76**
- Ghost flags (set in prod, name absent from src): **6**

## Census findings (the ones that matter)

1. **Both daily budget caps are disabled in prod:** `SUDO_DAILY_BUDGET_USD=off`
   and `SUDO_DAILY_LLM_BUDGET_USD=off`. Wave A's activation discipline
   (per-run + per-day budgets, combined-invariant 10) currently has no
   enforcement substrate. Fix BEFORE further activations.
2. **The roadmap's "dormant" list was partly stale — prod already runs:**
   `SUDO_CONSCIOUSNESS_REFLECT=1`, `SUDO_SELF_VERIFY=1`, `SUDO_COMPLETION_VERIFY=1`,
   `SUDO_PREDICTOR_LOOP=1`, `SUDO_TODO_GATE=1`, `SUDO_GOAL_PLANNER=1`,
   `SUDO_AUTONOMY_V1=1`, `SUDO_TRACE_CAPTURE=1`, `SUDO_SCHEDULED_MESSAGES=1`,
   `SUDO_PLUGINS=1`, `SUDO_USER_HOOKS=1`, `SUDO_ADMIN_API=1`,
   `SUDO_WHATSAPP_ENABLE=1`, `SUDO_AUTO_APPROVE=1`. F82 (reflection) and F84
   (verify gates) are therefore **verify-the-adapters tasks, not flag flips** —
   F83 must confirm SleepCycle's real episodic/self-model/wisdom adapters are
   bound under REFLECT=1.
3. **Confirmed OFF in prod (deliberate or pending):** `SUDO_WORLD_STATE_GOALS=0`,
   `SUDO_SELF_EVAL_ADOPT=0` (no-autonomous-spend policy), `SUDO_FLYWHEEL_APPLY`
   unset (F86), `SUDO_SELF_BUILD_MODE` unset, `SUDO_STANDING_ORDERS` unset
   (F89 ships CRUD-only). `SUDO_GDRIVE=1` is in `.env` but NOT in the pm2 app
   env — verify the layering actually delivers it to the daemon.
4. **Posture notes:** `SUDO_AUTO_APPROVE=1` + `SUDO_USER_HOOKS=1` +
   `SUDO_ADMIN_API=1` + `SUDO_PLUGINS=1` are all host-code/privilege surfaces
   ON simultaneously; `SUDO_UPDATE_AUTO_APPLY=1` trusts npm `latest`;
   pm2-layer default model is `ollama/deepseek-v4-pro:cloud` while `.env` says
   `claude-oauth/...` — confirm which the daemon resolves.

## Ghost flags — VERIFIED: the SUDO_UPDATE_* env contract is unimplemented

All six ghosts are `SUDO_UPDATE_*`. Verified in code (cli.ts ~3503):
`AutoUpdateManager` is constructed with `DEFAULT_UPDATE_CONFIG` only — no
env→config mapping exists, despite `update-manager-types.ts` documenting
"1. Environment variables (SUDO_UPDATE_*)" as the top precedence. `.start()`
is also never called (periodic loop is a deferred slice; dashboard
manual-trigger only). Net: prod's `SUDO_UPDATE_AUTO_APPLY=1`,
`SUDO_UPDATE_CHANNEL=latest`, `SUDO_UPDATE_HEALTH_GATE=1`,
`SUDO_UPDATE_INTERVAL_MS`, `SUDO_UPDATE_MAX_VERSION`,
`SUDO_UPDATE_SKIP_VERSIONS` are ALL inert. Only `SUDO_UPDATE_DISABLE` is real.
→ small follow-up slice: implement the documented env mapping or delete the
contract comment + prod entries.


- `SUDO_UPDATE_AUTO_APPLY` = 1
- `SUDO_UPDATE_CHANNEL` = latest
- `SUDO_UPDATE_HEALTH_GATE` = 1
- `SUDO_UPDATE_INTERVAL_MS` = 1800000
- `SUDO_UPDATE_MAX_VERSION` = 
- `SUDO_UPDATE_SKIP_VERSIONS` = 

## Dormant opt-in `SUDO_*` flags (default OFF, unset in prod)

| Flag | Subsystem | Files |
|---|---|---|
| `SUDO_LOG_STDERR` | acp | 3 |
| `SUDO_COMPACTION_HIGH_STAKES` | agent | 1 |
| `SUDO_COMPLETION_VERIFY_RETRY` | agent | 1 |
| `SUDO_FEEDBACK_DISABLE` | agent | 1 |
| `SUDO_PARALLEL_TOOLS_DISABLE` | agent | 2 |
| `SUDO_SMART_ROUTE_CHEAP` | agent | 2 |
| `SUDO_TOOL_LEARNING_DISABLE` | agent | 3 |
| `SUDO_ADMIN_API_DANGER` | api | 1 |
| `SUDO_AI_ALLOW_ANON` | api | 1 |
| `SUDO_AI_TRUSTED_PROXY` | api | 1 |
| `SUDO_AUTH_ROTATION_DISABLE` | brain | 1 |
| `SUDO_BRAIN_OAUTH_STREAM_DISABLE` | brain | 1 |
| `SUDO_DEBUG_ERR_BODY` | brain | 1 |
| `SUDO_FAILOVER_BACKOFF_DISABLE` | brain | 1 |
| `SUDO_REASONING_LENS_DISABLE` | brain | 2 |
| `SUDO_SMART_ROUTE_DISABLE` | brain | 1 |
| `SUDO_EMAIL_POLL_DISABLE` | channels | 1 |
| `SUDO_EMAIL_WORKER_DISABLE` | channels | 1 |
| `SUDO_FLYWHEEL_LIVE_AB` | cli | 1 |
| `SUDO_NO_WIZARD` | cli | 1 |
| `SUDO_CLAUDE_CLI_TOKEN_REFRESH` | cli.ts | 1 |
| `SUDO_DEBATE_CHAMBER` | cli.ts | 1 |
| `SUDO_GDRIVE_FLIGHT_ALL` | cli.ts | 1 |
| `SUDO_GDRIVE_FLIGHT_RECORDER` | cli.ts | 1 |
| `SUDO_IMESSAGE_ENABLE` | cli.ts | 1 |
| `SUDO_OUTCOME_ADAPTERS_DISABLE` | cli.ts | 1 |
| `SUDO_SANDBOX_AUTOBUILD` | cli.ts | 1 |
| `SUDO_SECOND_OPINION` | cli.ts | 1 |
| `SUDO_SESSION_RECONCILE_APPLY` | cli.ts | 1 |
| `SUDO_DASHBOARD_DISABLE` | dashboard | 3 |
| `SUDO_DASHBOARD_INSECURE` | dashboard | 6 |
| `SUDO_DASHBOARD_LOG_RING_DISABLE` | dashboard | 3 |
| `SUDO_GATEWAY_UI_UNIFIED_AUTH` | dashboard | 1 |
| `SUDO_GROUP_MENTION_ONLY` | dashboard | 2 |
| `SUDO_FED_ERROR_INGEST_DISABLE` | federation | 1 |
| `SUDO_FED_KEY_FETCH_DISABLE` | federation | 1 |
| `SUDO_FED_TOKEN_POOL_DISABLE` | gateway | 2 |
| `SUDO_GATEWAY_RPC_V2` | gateway | 1 |
| `SUDO_GATEWAY_UI_ON_MAIN` | gateway | 3 |
| `SUDO_LEGACY_CHAT` | gateway | 1 |
| `SUDO_LEGACY_DASHBOARD` | gateway | 1 |
| `SUDO_MCP_ALLOW_SHELL` | gateway | 3 |
| `SUDO_NO_STATIC` | gateway | 1 |
| `SUDO_GITHUB_ISSUES_DISABLE` | health | 1 |
| `SUDO_SELFTEST_DISABLE` | health | 2 |
| `SUDO_FLYWHEEL_APPLY` | learning | 4 |
| `SUDO_CACHE_DUP_WATCH_DISABLE` | llm | 1 |
| `SUDO_CACHE_HIT_WATCH_DISABLE` | llm | 1 |
| `SUDO_LLM_BACKGROUND_HALT` | llm | 1 |
| `SUDO_LLM_RETRY_DISABLE` | llm | 1 |
| `SUDO_PROMPT_CACHE_DEBUG` | llm | 2 |
| `SUDO_VAULT_PROVIDER_KEYS` | llm | 1 |
| `SUDO_MSG_SCAN_STRICT` | memory | 1 |
| `SUDO_NOTEBOOKLM` | notebooklm | 4 |
| `SUDO_DATA_RETENTION_OPT_OUT` | privacy | 2 |
| `SUDO_ZDR` | privacy | 2 |
| `SUDO_SANDBOX_ALLOW_UNCONFINED` | sandbox | 1 |
| `SUDO_DUAL_VERIFY_DISABLE` | security | 1 |
| `SUDO_KEY_ROTATION_DISABLE` | security | 2 |
| `SUDO_SECURITY_AUDIT_DISABLE` | security | 2 |
| `SUDO_TOOL_FETCH_GUARD_DISABLE` | security | 1 |
| `SUDO_AUTODEPLOY_DISABLE` | self-build | 2 |
| `SUDO_AUTOFIX_DISABLE` | self-build | 2 |
| `SUDO_SELF_BUILD_DISABLE` | self-build | 1 |
| `SUDO_PERSIST_EPHEMERAL` | sessions | 4 |
| `SUDO_ARSENAL_V2_NO_REORDER` | tools | 1 |
| `SUDO_BROWSER_INSECURE` | tools | 2 |
| `SUDO_BUNDLED_SKILLS_DISABLE` | tools | 1 |
| `SUDO_ENABLE_LEGACY_META_TOOLS` | tools | 1 |
| `SUDO_EXEC_GATE_DISABLE` | tools | 1 |
| `SUDO_GDRIVE_USER_FILES` | tools | 1 |
| `SUDO_MCP_ALLOW_PRIVATE_HOSTS` | tools | 1 |
| `SUDO_MCP_DISABLE` | tools | 1 |
| `SUDO_MCP_REMOTE_DISABLE` | tools | 3 |
| `SUDO_SECCOMP_DISABLE` | tools | 1 |
| `SUDO_SKILL_INDEX_DISABLE` | tools | 1 |

## Full `SUDO_*` census

| Flag | Subsystem | Inferred default | Files | Prod |
|---|---|---|---|---|
| `SUDO_ACP_MODEL` | acp | value/string | 1 | — |
| `SUDO_ACP_PERSIST` | acp | default ON (kill via =0) | 1 | — |
| `SUDO_ACP_TOOLS` | acp | default ON (kill via =0) | 1 | — |
| `SUDO_ADMIN_` | cli.ts | indirect | 1 | — |
| `SUDO_ADMIN_API` | gateway | mixed | 4 | 1 |
| `SUDO_ADMIN_API_DANGER` | api | opt-in (default OFF) | 1 | — |
| `SUDO_ADMIN_POWERS` | dashboard | opt-in (default OFF) | 4 | 1 |
| `SUDO_AGENT_WINDOW_SIZE` | agent | numeric tunable | 1 | 200 |
| `SUDO_AI_ALLOW_ANON` | api | opt-in (default OFF) | 1 | — |
| `SUDO_AI_API_TOKEN` | api | value/string | 2 | — |
| `SUDO_AI_CORS_ORIGINS` | api | value/string | 4 | http://127.0.0.1:18900,http://localhost:18900 |
| `SUDO_AI_DASHBOARD_TOKEN` | api | value/string | 3 | <set:redacted> |
| `SUDO_AI_HOME` | shared | value/string | 11 | — |
| `SUDO_AI_PREFIX` | tools | indirect | 1 | — |
| `SUDO_AI_ROOT` | plugins | value/string | 2 | — |
| `SUDO_AI_TRUSTED_PROXY` | api | opt-in (default OFF) | 1 | — |
| `SUDO_AI_VAULT_KEY` | api | indirect | 1 | — |
| `SUDO_ALIASES` | llm | indirect | 2 | — |
| `SUDO_ARSENAL_V2_AUTO_REVERT` | tools | indirect | 2 | — |
| `SUDO_ARSENAL_V2_CASCADE` | tools | value/string | 2 | — |
| `SUDO_ARSENAL_V2_CORR_METHOD` | tools | value/string | 1 | — |
| `SUDO_ARSENAL_V2_CRITIC_MODEL` | tools | value/string | 2 | — |
| `SUDO_ARSENAL_V2_MAX_ATTEMPTS` | tools | value/string | 1 | — |
| `SUDO_ARSENAL_V2_MODEL` | tools | value/string | 2 | — |
| `SUDO_ARSENAL_V2_MODE_SIMILARITY` | tools | value/string | 2 | — |
| `SUDO_ARSENAL_V2_NO_DATA_SIMILARITY` | tools | default ON (kill via =1) | 1 | — |
| `SUDO_ARSENAL_V2_NO_REORDER` | tools | opt-in (default OFF) | 1 | — |
| `SUDO_ARSENAL_V2_SIM_SHRINKAGE_K` | tools | numeric tunable | 1 | — |
| `SUDO_ARSENAL_V2_SKIP_CRITIC` | tools | indirect | 1 | — |
| `SUDO_ARSENAL_V2_SKIP_TESTS` | tools | indirect | 1 | — |
| `SUDO_ARSENAL_V2_STATS_HALF_LIFE_MS` | tools | numeric tunable | 1 | — |
| `SUDO_ARSENAL_V2_STATS_SHRINKAGE_K` | tools | numeric tunable | 1 | — |
| `SUDO_ARSENAL_V2_STATS_WINDOW_MS` | tools | numeric tunable | 1 | — |
| `SUDO_ARSENAL_V2_TELEMETRY` | tools | indirect | 2 | — |
| `SUDO_ARSENAL_V2_TELEMETRY_MAX_BYTES` | tools | indirect | 1 | — |
| `SUDO_ARTIFACT_KEY_DIR` | security | value/string | 1 | — |
| `SUDO_ARTIFACT_SECRET` | security | value/string | 1 | — |
| `SUDO_ARTIFACT_SIGNER_ID` | security | value/string | 1 | — |
| `SUDO_AUDIT_CHAIN_URL` | tools | value/string | 1 | — |
| `SUDO_AUTH_ROTATION_DISABLE` | brain | opt-in (default OFF) | 1 | — |
| `SUDO_AUTODEPLOY_DISABLE` | self-build | opt-in (default OFF) | 2 | — |
| `SUDO_AUTOFIX_DISABLE` | self-build | opt-in (default OFF) | 2 | — |
| `SUDO_AUTOFIX_MAX_PER_HOUR` | self-build | numeric tunable | 2 | — |
| `SUDO_AUTOFIX_MIN_SEVERITY` | self-build | value/string | 2 | — |
| `SUDO_AUTONOMY_V1` | dashboard | opt-in (default OFF) | 4 | 1 |
| `SUDO_AUTONOMY_V1_INTERVAL_MS` | cli.ts | numeric tunable | 1 | — |
| `SUDO_AUTONOMY_V1_REWAKE_MS` | cli.ts | numeric tunable | 1 | — |
| `SUDO_AUTO_APPROVE` | agent | opt-in (default OFF) | 1 | 1 |
| `SUDO_AUTO_PLAN` | agent | opt-in (default OFF) | 2 | 1 |
| `SUDO_BASH_ALLOWLIST_FASTPATH` | agent | opt-in (default OFF) | 2 | 1 |
| `SUDO_BEST_OF_N_CANDIDATES` | agent | numeric tunable | 1 | — |
| `SUDO_BG_SHELL` | tools | opt-in (default OFF) | 4 | 1 |
| `SUDO_BG_SHELL_BUFFER_BYTES` | tools | indirect | 1 | — |
| `SUDO_BG_SHELL_CPU_SECONDS` | tools | value/string | 1 | — |
| `SUDO_BG_SHELL_MAX_CONCURRENT` | tools | indirect | 1 | — |
| `SUDO_BOT_NAME` | cli.ts | value/string | 1 | — |
| `SUDO_BRAIN_CODE_TREE_SEARCH` | agent | indirect | 2 | — |
| `SUDO_BRAIN_CODE_TS_MIN_COMPLEXITY` | agent | indirect | 1 | — |
| `SUDO_BRAIN_CONSENSUS_DISABLE` | brain | opt-in (default OFF) | 1 | 1 |
| `SUDO_BRAIN_DEBATE_BLUE` | brain | indirect | 1 | — |
| `SUDO_BRAIN_DEBATE_MAX_MS` | brain | indirect | 1 | 180000 |
| `SUDO_BRAIN_DEBATE_RED` | brain | indirect | 1 | — |
| `SUDO_BRAIN_DEBATE_TOOLPLAN` | brain | opt-in (default OFF) | 1 | 1 |
| `SUDO_BRAIN_DEBATE_VERIFIER` | brain | value/string | 3 | — |
| `SUDO_BRAIN_HIGH_STAKES_STRATEGY` | agent | indirect | 3 | debate |
| `SUDO_BRAIN_IDLE_BREAKER_COOLDOWN_MS` | brain | indirect | 1 | — |
| `SUDO_BRAIN_IDLE_BREAKER_MAX` | brain | indirect | 1 | — |
| `SUDO_BRAIN_LIVENESS` | cli.ts | default ON (kill via =0) | 1 | — |
| `SUDO_BRAIN_LIVENESS_INTERVAL_MS` | cli.ts | numeric tunable | 1 | 1800000 |
| `SUDO_BRAIN_OAUTH_STREAM_DISABLE` | brain | opt-in (default OFF) | 1 | — |
| `SUDO_BRAIN_RACE_DISABLE` | brain | indirect | 1 | 1 |
| `SUDO_BRAIN_TEAM_STRATEGY` | agent | value/string | 1 | — |
| `SUDO_BRAIN_TREE_BREADTH` | brain | indirect | 1 | 3 |
| `SUDO_BRAIN_TREE_MAX_MS` | brain | indirect | 1 | 420000 |
| `SUDO_BRIDGE_JWT_TTL_MS` | cli.ts | numeric tunable | 1 | 3600000 |
| `SUDO_BROWSER_ALLOW_HOSTS` | tools | value/string | 1 | — |
| `SUDO_BROWSER_INSECURE` | tools | opt-in (default OFF) | 2 | — |
| `SUDO_BROWSER_RECOVERY` | agent | indirect | 2 | — |
| `SUDO_BROWSER_RECOVERY_ESCALATE` | agent | indirect | 1 | — |
| `SUDO_BROWSER_REF_AUTOSNAPSHOT` | tools | default ON (kill via =0) | 1 | — |
| `SUDO_BROWSER_RETRY` | tools | default ON (kill via =0) | 1 | — |
| `SUDO_BROWSER_RETRY_ATTEMPTS` | tools | value/string | 1 | — |
| `SUDO_BROWSER_UNATTENDED` | tools | opt-in (default OFF) | 3 | 1 |
| `SUDO_BROWSER_VERIFY` | agent | indirect | 2 | 1 |
| `SUDO_BUNDLED_SKILLS_DISABLE` | tools | opt-in (default OFF) | 1 | — |
| `SUDO_CACHE_DUP_CHECK_INTERVAL_MS` | llm | indirect | 1 | — |
| `SUDO_CACHE_DUP_MIN_SAMPLE` | llm | indirect | 1 | — |
| `SUDO_CACHE_DUP_WARN_PCT` | llm | indirect | 1 | — |
| `SUDO_CACHE_DUP_WATCH_DISABLE` | llm | opt-in (default OFF) | 1 | — |
| `SUDO_CACHE_DUP_WINDOW_DAYS` | llm | indirect | 1 | — |
| `SUDO_CACHE_HIT_CHECK_INTERVAL_MS` | llm | indirect | 1 | — |
| `SUDO_CACHE_HIT_MIN_SAMPLE` | llm | indirect | 1 | — |
| `SUDO_CACHE_HIT_WARN_PCT` | llm | indirect | 1 | — |
| `SUDO_CACHE_HIT_WATCH_DISABLE` | llm | opt-in (default OFF) | 1 | — |
| `SUDO_CACHE_HIT_WINDOW_HOURS` | llm | indirect | 1 | — |
| `SUDO_CAPABILITIES` | embodiment | indirect | 1 | — |
| `SUDO_CAPABILITY_MANIFEST` | brain | default ON (kill via =0) | 2 | — |
| `SUDO_CDP_ENDPOINT` | tools | value/string | 1 | — |
| `SUDO_CHANNEL_COMMANDS` | dashboard | opt-in (default OFF) | 2 | 1 |
| `SUDO_CHAT_APPROVALS` | dashboard | opt-in (default OFF) | 2 | 1 |
| `SUDO_CHEAP_MODEL` | agent | value/string | 4 | — |
| `SUDO_CHUNK_CONTRADICT` | memory | opt-in (default OFF) | 5 | 1 |
| `SUDO_CHUNK_CONTRADICT_MAX_JUDGED` | memory | indirect | 1 | — |
| `SUDO_CHUNK_CONTRADICT_SIM` | memory | value/string | 1 | — |
| `SUDO_CLAUDE_CLI_TOKEN_REFRESH` | cli.ts | opt-in (default OFF) | 1 | — |
| `SUDO_CLAUDE_COMPAT` | plugins | opt-in (default OFF) | 2 | 1 |
| `SUDO_CLAUDE_OAUTH_CONNECTED` | llm | indirect | 1 | — |
| `SUDO_COGNITIVE_DEEP_EVERY_N` | consciousness | value/string | 1 | — |
| `SUDO_COGNITIVE_DEEP_TOKENS` | consciousness | value/string | 1 | — |
| `SUDO_COGNITIVE_MEDIUM_EVERY_N` | consciousness | value/string | 1 | — |
| `SUDO_COGNITIVE_MEDIUM_TOKENS` | consciousness | value/string | 1 | — |
| `SUDO_COGNITIVE_MICRO_INTERVAL_MS` | consciousness | value/string | 1 | 180000 |
| `SUDO_COGNITIVE_MICRO_TOKENS` | consciousness | value/string | 1 | — |
| `SUDO_COMMITMENTS` | cron | opt-in (default OFF) | 3 | 1 |
| `SUDO_COMMITMENTS_MAX_HORIZON_DAYS` | cron | indirect | 1 | — |
| `SUDO_COMMITMENTS_MAX_JOBS` | cron | indirect | 1 | — |
| `SUDO_COMMS_ADAPTER_IDEMPOTENCY` | comms | opt-in (default OFF) | 2 | 1 |
| `SUDO_COMMS_IDEMPOTENCY` | comms | opt-in (default OFF) | 3 | 1 |
| `SUDO_COMMS_IDEMPOTENCY_WINDOW_MS` | comms | numeric tunable | 1 | — |
| `SUDO_COMPACTION_HIGH_STAKES` | agent | opt-in (default OFF) | 1 | — |
| `SUDO_COMPACTION_TIMEOUT_MS` | agent | numeric tunable | 1 | — |
| `SUDO_COMPACT_DEDUPE_USERS` | agent | default ON (kill via =0) | 1 | — |
| `SUDO_COMPACT_ESCALATE` | agent | opt-in (default OFF) | 1 | 1 |
| `SUDO_COMPACT_PRESERVE_TAIL` | agent | default ON (kill via =0) | 1 | — |
| `SUDO_COMPACT_TAIL_COUNT` | agent | numeric tunable | 1 | — |
| `SUDO_COMPLETION_VERIFY` | agent | opt-in (default OFF) | 3 | 1 |
| `SUDO_COMPLETION_VERIFY_ALL` | agent | default ON (kill via =1) | 1 | — |
| `SUDO_COMPLETION_VERIFY_RETRY` | agent | opt-in (default OFF) | 1 | — |
| `SUDO_CONNECTOR_REGISTRY` | tools | indirect | 2 | — |
| `SUDO_CONNECTOR_REGISTRY_URL` | skills | indirect | 1 | — |
| `SUDO_CONSCIOUSNESS_GATE` | consciousness | value/string | 2 | — |
| `SUDO_CONSCIOUSNESS_MODEL` | consciousness | value/string | 1 | — |
| `SUDO_CONSCIOUSNESS_PROCEDURAL_LEARN` | consciousness | opt-in (default OFF) | 1 | 1 |
| `SUDO_CONSCIOUSNESS_REFLECT` | cli.ts | opt-in (default OFF) | 1 | 1 |
| `SUDO_CONSCIOUSNESS_SEMANTIC` | consciousness | opt-in (default OFF) | 1 | 1 |
| `SUDO_CONSCIOUSNESS_SOMATIC_MARKERS` | consciousness | opt-in (default OFF) | 1 | 1 |
| `SUDO_CONSCIOUSNESS_WORLD_MODEL` | consciousness | opt-in (default OFF) | 1 | 1 |
| `SUDO_CONSENSUS_EARLY_EXIT_DISABLE` | brain | default ON (kill via =1) | 1 | — |
| `SUDO_CONSENSUS_MIN_AGREEMENT` | brain | value/string | 2 | — |
| `SUDO_CONSENSUS_MIN_RESPONDERS` | brain | value/string | 1 | — |
| `SUDO_CONSENSUS_TIMEOUT_MS` | brain | value/string | 2 | — |
| `SUDO_CONTEXT_BUDGET` | agent | default ON (kill via =0) | 1 | — |
| `SUDO_COST_RATE_ALERT` | billing | opt-in (default OFF) | 2 | 1 |
| `SUDO_COST_RATE_ALERT_CEILING_USD_PER_HR` | billing | indirect | 1 | — |
| `SUDO_COST_RATE_ALERT_COOLDOWN_MS` | billing | indirect | 1 | — |
| `SUDO_COST_RATE_ALERT_DEVIATION_PCT` | billing | indirect | 1 | — |
| `SUDO_COST_RATE_ALERT_INTERVAL_MS` | billing | indirect | 1 | — |
| `SUDO_COST_RATE_ALERT_MIN_USD_PER_HR` | billing | indirect | 1 | — |
| `SUDO_COST_RATE_ALERT_WINDOW_MS` | billing | indirect | 1 | — |
| `SUDO_COST_RETENTION_DAYS` | billing | value/string | 1 | — |
| `SUDO_COST_TRACKING` | brain | default ON (kill via =0) | 1 | — |
| `SUDO_CRASH_SAFE` | agent | default ON (kill via =0) | 3 | 1 |
| `SUDO_CRED_VAULT_DIR` | security | value/string | 1 | — |
| `SUDO_CROSS` | cli | indirect | 1 | — |
| `SUDO_CROSS_CONTROL_DISABLE` | tools | indirect | 6 | — |
| `SUDO_CUSTOM_PROVIDERS` | llm | value/string | 3 | — |
| `SUDO_DAILY_BUDGET_USD` | skills | value/string | 6 | off |
| `SUDO_DAILY_LLM_BUDGET_USD` | self-build | numeric tunable | 3 | off |
| `SUDO_DASHBOARD_AUTH` | dashboard | value/string | 2 | — |
| `SUDO_DASHBOARD_BIND` | dashboard | value/string | 3 | — |
| `SUDO_DASHBOARD_DISABLE` | dashboard | opt-in (default OFF) | 3 | — |
| `SUDO_DASHBOARD_HOST` | gateway | indirect | 3 | — |
| `SUDO_DASHBOARD_HOSTS` | dashboard | value/string | 3 | — |
| `SUDO_DASHBOARD_INSECURE` | dashboard | opt-in (default OFF) | 6 | — |
| `SUDO_DASHBOARD_LOG_RING_` | dashboard | indirect | 1 | — |
| `SUDO_DASHBOARD_LOG_RING_DISABLE` | dashboard | opt-in (default OFF) | 3 | — |
| `SUDO_DASHBOARD_OAUTH_ALG` | dashboard | value/string | 2 | — |
| `SUDO_DASHBOARD_OAUTH_AUDIENCE` | dashboard | value/string | 2 | — |
| `SUDO_DASHBOARD_OAUTH_HMAC_SECRET` | dashboard | indirect | 2 | — |
| `SUDO_DASHBOARD_OAUTH_ISSUER` | dashboard | value/string | 2 | — |
| `SUDO_DASHBOARD_OAUTH_PUBLIC_KEY_PEM` | dashboard | indirect | 2 | — |
| `SUDO_DASHBOARD_OAUTH_REQUIRED_SCOPE` | dashboard | value/string | 2 | — |
| `SUDO_DASHBOARD_PORT` | desktop | numeric tunable | 5 | — |
| `SUDO_DASHBOARD_RESTART_NOEXIT` | dashboard | default ON (kill via =1) | 1 | — |
| `SUDO_DASHBOARD_TOKEN` | gateway | value/string | 4 | — |
| `SUDO_DATA_RETENTION_OPT_OUT` | privacy | opt-in (default OFF) | 2 | — |
| `SUDO_DEBATE_CHAMBER` | cli.ts | opt-in (default OFF) | 1 | — |
| `SUDO_DEBUG_ERR_BODY` | brain | opt-in (default OFF) | 1 | — |
| `SUDO_DEFAULT_MODEL` | shared | value/string | 1 | ollama/deepseek-v4-pro:cloud |
| `SUDO_DESKTOP_HEIGHT` | desktop | indirect | 1 | — |
| `SUDO_DESKTOP_WIDTH` | desktop | indirect | 1 | — |
| `SUDO_DIAGNOSTIC_PEERS` | workspace | indirect | 1 | — |
| `SUDO_DIRECTIVE_OWNERS` | commands | value/string | 2 | — |
| `SUDO_DNS_RESULT_ORDER` | cli.ts | value/string | 1 | — |
| `SUDO_DOCKER_BIN` | sandbox | value/string | 1 | — |
| `SUDO_DOCKER_EGRESS_NETWORK` | sandbox | value/string | 1 | — |
| `SUDO_DOCKER_IMAGE` | sandbox | value/string | 1 | — |
| `SUDO_DOCKER_READONLY` | sandbox | default ON (kill via =0) | 1 | — |
| `SUDO_DOCKER_USER` | sandbox | value/string | 1 | — |
| `SUDO_DOOM_LOOP_EXTRAS` | agent | opt-in (default OFF) | 2 | 1 |
| `SUDO_DOOM_LOOP_RO_THRESHOLD` | agent | numeric tunable | 1 | — |
| `SUDO_DOOM_LOOP_STALE_MS` | agent | value/string | 1 | — |
| `SUDO_DOOM_LOOP_THRESHOLD` | agent | numeric tunable | 1 | — |
| `SUDO_DREAM_INTERVAL_MS` | cli.ts | numeric tunable | 1 | — |
| `SUDO_DUAL_VERIFY_DISABLE` | security | opt-in (default OFF) | 1 | — |
| `SUDO_E2E` | eval | default ON (kill via =1) | 1 | — |
| `SUDO_EMAIL_POLL_DISABLE` | channels | opt-in (default OFF) | 1 | — |
| `SUDO_EMAIL_WORKER_DISABLE` | channels | opt-in (default OFF) | 1 | — |
| `SUDO_EMBED_BACKOFF` | memory | default ON (kill via =0) | 1 | — |
| `SUDO_EMBED_BACKOFF_BASE_MS` | memory | numeric tunable | 1 | — |
| `SUDO_EMBED_CIRCUIT` | memory | default ON (kill via =0) | 1 | — |
| `SUDO_EMBED_CIRCUIT_COOLDOWN_MS` | memory | numeric tunable | 1 | — |
| `SUDO_EMBED_CIRCUIT_THRESHOLD` | memory | numeric tunable | 1 | — |
| `SUDO_EMBED_QUERY_DEGRADE` | memory | default ON (kill via =0) | 1 | — |
| `SUDO_EMPTY_STOP_GUARD` | agent | default ON (kill via =0) | 1 | — |
| `SUDO_ENABLE_LEGACY_META_TOOLS` | tools | opt-in (default OFF) | 1 | — |
| `SUDO_ENABLE_PERSONA_TOOLS` | tools | mixed | 4 | — |
| `SUDO_EPISODIC_DEDUP` | consciousness | opt-in (default OFF) | 1 | 1 |
| `SUDO_EPISODIC_DEDUP_WINDOW_MS` | consciousness | numeric tunable | 1 | — |
| `SUDO_EPISODIC_RECALL` | consciousness | default ON (kill via =0) | 1 | — |
| `SUDO_ERROR_SANITIZE` | shared | default ON (kill via =0) | 1 | — |
| `SUDO_EVENT_ATTENTION` | cli.ts | default ON (kill via =0) | 1 | — |
| `SUDO_EXEC_BACKEND` | sandbox | value/string | 9 | — |
| `SUDO_EXEC_GATE_DISABLE` | tools | opt-in (default OFF) | 1 | — |
| `SUDO_EXEC_POLICY` | cli.ts | opt-in (default OFF) | 1 | 1 |
| `SUDO_EXEC_SAFE_RESTART` | agent | opt-in (default OFF) | 1 | 1 |
| `SUDO_FAILOVER_BACKOFF_CAP_MS` | brain | numeric tunable | 1 | — |
| `SUDO_FAILOVER_BACKOFF_DISABLE` | brain | opt-in (default OFF) | 1 | — |
| `SUDO_FAILOVER_MAX_ATTEMPTS` | brain | numeric tunable | 1 | — |
| `SUDO_FAILURE_LEARNER_DB` | learning | opt-in (default OFF) | 2 | 1 |
| `SUDO_FAILURE_PREVENTION_HINT` | agent | opt-in (default OFF) | 2 | 1 |
| `SUDO_FALLBACK_MODEL` | shared | value/string | 1 | ollama/qwen3.5:latest |
| `SUDO_FEDERATION_INBOUND_TOKENS` | federation | value/string | 2 | — |
| `SUDO_FEDERATION_PEERS` | federation | value/string | 1 | — |
| `SUDO_FEDERATION_URL` | tools | value/string | 1 | — |
| `SUDO_FED_ERROR_INGEST_DISABLE` | federation | opt-in (default OFF) | 1 | — |
| `SUDO_FED_ERROR_REPORT_DISABLE` | gateway | indirect | 1 | — |
| `SUDO_FED_FIX_NOTIFY_DISABLE` | gateway | indirect | 1 | — |
| `SUDO_FED_KEY_CACHE_TTL_MS` | federation | value/string | 1 | — |
| `SUDO_FED_KEY_FETCH_DISABLE` | federation | opt-in (default OFF) | 1 | — |
| `SUDO_FED_SIGN_DISABLE` | federation | default ON (kill via =1) | 1 | — |
| `SUDO_FED_STRICT_VERIFY` | gateway | opt-in (default OFF) | 1 | 1 |
| `SUDO_FED_TOKEN_POOL_DISABLE` | gateway | opt-in (default OFF) | 2 | — |
| `SUDO_FED_VERIFY_DISABLE` | gateway | default ON (kill via =1) | 1 | — |
| `SUDO_FEEDBACK_DISABLE` | agent | opt-in (default OFF) | 1 | — |
| `SUDO_FEEDBACK_TIER_COMPLEX_TURNS` | agent | indirect | 1 | — |
| `SUDO_FEEDBACK_TIER_FRICTION_CANCELLATIONS` | agent | indirect | 1 | — |
| `SUDO_FEEDBACK_TIER_SUSTAINED_TURNS` | agent | indirect | 1 | — |
| `SUDO_FLAT_SUB_PROVIDERS` | billing | indirect | 1 | — |
| `SUDO_FLEET_ADMISSION_DEFAULT` | fleet | indirect | 3 | — |
| `SUDO_FLEET_REGISTRAR_MODE` | dashboard | opt-in (default OFF) | 4 | 1 |
| `SUDO_FLEET_REGISTRAR_URL` | cli.ts | value/string | 1 | — |
| `SUDO_FLYWHEEL_APPLY` | learning | opt-in (default OFF) | 4 | — |
| `SUDO_FLYWHEEL_HARNESS_ACTIVE_DAYS` | learning | numeric tunable | 1 | — |
| `SUDO_FLYWHEEL_LIVE_AB` | cli | opt-in (default OFF) | 1 | — |
| `SUDO_FLYWHEEL_WORKFLOW_` | learning | indirect | 1 | — |
| `SUDO_FLYWHEEL_WORKFLOW_DAYS` | learning | indirect | 1 | — |
| `SUDO_FLYWHEEL_WORKFLOW_MAX_EVENTS` | learning | indirect | 2 | — |
| `SUDO_FLYWHEEL_WORKFLOW_MAX_SESSIONS` | learning | indirect | 1 | — |
| `SUDO_FOLD_SYSTEM_MESSAGES` | brain | indirect | 1 | 1 |
| `SUDO_FORK_CONTEXT` | agents | opt-in (default OFF) | 3 | 1 |
| `SUDO_FORK_MESSAGE_COUNT` | sessions | numeric tunable | 1 | 250 |
| `SUDO_FORK_SUMMARY_CHARS` | sessions | numeric tunable | 1 | — |
| `SUDO_FORK_THRESHOLD_CHARS` | sessions | numeric tunable | 1 | 600000 |
| `SUDO_GATEWAY_LOG` | agent | default ON (kill via =0) | 5 | — |
| `SUDO_GATEWAY_LOG_RETENTION_DAYS` | llm | value/string | 1 | — |
| `SUDO_GATEWAY_LOG_TEST` | llm | default ON (kill via =1) | 3 | — |
| `SUDO_GATEWAY_REQUEST_TIMEOUT_MS` | gateway | indirect | 1 | — |
| `SUDO_GATEWAY_RPC_V2` | gateway | opt-in (default OFF) | 1 | — |
| `SUDO_GATEWAY_UI_ON_MAIN` | gateway | opt-in (default OFF) | 3 | — |
| `SUDO_GATEWAY_UI_UNIFIED_AUTH` | dashboard | opt-in (default OFF) | 1 | — |
| `SUDO_GATEWAY_UNIFIED_AUTH` | gateway | default ON (kill via =0) | 2 | — |
| `SUDO_GDRIVE` | gdrive | opt-in (default OFF) | 9 | 1 |
| `SUDO_GDRIVE_ATLAS_CRON` | cli.ts | value/string | 1 | — |
| `SUDO_GDRIVE_AUTOHIBERNATE` | agent | mixed | 3 | — |
| `SUDO_GDRIVE_AUTOHIBERNATE_EVERY` | agent | numeric tunable | 1 | — |
| `SUDO_GDRIVE_BLACKBOARD_MS` | cli.ts | numeric tunable | 1 | — |
| `SUDO_GDRIVE_CHANGES_MS` | cli.ts | numeric tunable | 1 | — |
| `SUDO_GDRIVE_CHECKPOINT_MS` | gdrive | numeric tunable | 2 | — |
| `SUDO_GDRIVE_COMMENTS_MS` | cli.ts | numeric tunable | 1 | — |
| `SUDO_GDRIVE_CURIOSITY_BUDGET` | gdrive | numeric tunable | 1 | — |
| `SUDO_GDRIVE_CURIOSITY_CRON` | cli.ts | value/string | 1 | — |
| `SUDO_GDRIVE_DREAM_CRON` | cli.ts | value/string | 1 | — |
| `SUDO_GDRIVE_DRILL_MS` | cli.ts | numeric tunable | 1 | — |
| `SUDO_GDRIVE_FLIGHT_ALL` | cli.ts | opt-in (default OFF) | 1 | — |
| `SUDO_GDRIVE_FLIGHT_RECORDER` | cli.ts | opt-in (default OFF) | 1 | — |
| `SUDO_GDRIVE_FREEZE_AGE_DAYS` | gdrive | numeric tunable | 1 | — |
| `SUDO_GDRIVE_FREEZE_CRON` | cli.ts | value/string | 1 | — |
| `SUDO_GDRIVE_INBOX_MS` | gdrive | numeric tunable | 2 | — |
| `SUDO_GDRIVE_MIRROR_MS` | cli.ts | numeric tunable | 1 | — |
| `SUDO_GDRIVE_PANEL_MS` | cli.ts | numeric tunable | 1 | — |
| `SUDO_GDRIVE_REPORT_CRON` | cli.ts | value/string | 1 | — |
| `SUDO_GDRIVE_REVALIDATE_CRON` | cli.ts | value/string | 1 | — |
| `SUDO_GDRIVE_SEAL_OPMODEL_CRON` | cli.ts | value/string | 1 | — |
| `SUDO_GDRIVE_SELFDIFF_CRON` | cli.ts | value/string | 1 | — |
| `SUDO_GDRIVE_SNAPSHOT_CRON` | cli.ts | value/string | 1 | — |
| `SUDO_GDRIVE_USER_FILES` | tools | opt-in (default OFF) | 1 | — |
| `SUDO_GITHUB_CI_POLL_MS` | tools | numeric tunable | 1 | — |
| `SUDO_GITHUB_ISSUES_DISABLE` | health | opt-in (default OFF) | 1 | — |
| `SUDO_GITHUB_MERGE_POLL_MS` | tools | numeric tunable | 1 | — |
| `SUDO_GITHUB_PROTECTED_PATHS` | tools | value/string | 1 | — |
| `SUDO_GITHUB_TOOLS` | tools | value/string | 2 | 1 |
| `SUDO_GOAL_EVAL_MODEL` | outcomes | value/string | 1 | — |
| `SUDO_GOAL_PLANNER` | agent | opt-in (default OFF) | 1 | 1 |
| `SUDO_GOAL_PLANNER_SEMANTIC` | agent | opt-in (default OFF) | 1 | 1 |
| `SUDO_GOAL_PLANNER_SEMANTIC_MAX_PER_RUN` | agent | value/string | 2 | 3 |
| `SUDO_GROK_REFUSAL_DETECT_DISABLE` | brain | default ON (kill via =1) | 2 | — |
| `SUDO_GROUP_MENTION_ONLY` | dashboard | opt-in (default OFF) | 2 | — |
| `SUDO_HEALTH_ALERT_COOLDOWN_MS` | health | value/string | 1 | — |
| `SUDO_HEALTH_ALERT_DISABLE` | health | mixed | 1 | — |
| `SUDO_HEALTH_FORCE_FAIL` | health | value/string | 1 | — |
| `SUDO_HOOKS_FILE` | cli.ts | value/string | 1 | — |
| `SUDO_HOOK_AGENT` | hooks | indirect | 1 | — |
| `SUDO_HOOK_EVENT` | hooks | indirect | 3 | — |
| `SUDO_HOOK_FILE` | hooks | indirect | 1 | — |
| `SUDO_HOOK_SESSION` | hooks | indirect | 1 | — |
| `SUDO_HOOK_TASK` | hooks | indirect | 1 | — |
| `SUDO_HOOK_TOOL` | hooks | indirect | 3 | — |
| `SUDO_HYDRATE_MESSAGE_LIMIT` | sessions | numeric tunable | 1 | 500 |
| `SUDO_IDENTITY_PERSIST` | sessions | default ON (kill via =0) | 1 | — |
| `SUDO_IDE_BRIDGE_DISABLE` | ide | mixed | 3 | 0 |
| `SUDO_IMESSAGE_ENABLE` | cli.ts | opt-in (default OFF) | 1 | — |
| `SUDO_INJECTION_STRICT` | cli.ts | opt-in (default OFF) | 2 | 1 |
| `SUDO_INJECT_MEMORY_MAX` | workspace | indirect | 2 | — |
| `SUDO_INJECT_RECENT_MAX` | brain | indirect | 1 | — |
| `SUDO_INJECT_TODAY_MAX` | workspace | indirect | 2 | — |
| `SUDO_INSTANCE_ID` | dashboard | value/string | 2 | — |
| `SUDO_JSON_REPAIR` | tools | default ON (kill via =0) | 1 | — |
| `SUDO_KAIROS_ARSENAL_TRIGGER_DISABLE` | tools | default ON (kill via =1) | 4 | — |
| `SUDO_KEY_ROTATION_DB_PATH` | security | value/string | 2 | — |
| `SUDO_KEY_ROTATION_DISABLE` | security | opt-in (default OFF) | 2 | — |
| `SUDO_KEY_ROTATION_MIN_INTERVAL_MS` | security | value/string | 1 | — |
| `SUDO_KOKORO_DEVICE` | voice | value/string | 1 | — |
| `SUDO_KOKORO_DTYPE` | voice | value/string | 1 | — |
| `SUDO_KOKORO_MODEL` | voice | value/string | 1 | — |
| `SUDO_KOKORO_TTS` | voice | value/string | 2 | — |
| `SUDO_KOKORO_VOICE` | voice | value/string | 1 | — |
| `SUDO_LAZINESS_CADENCE` | agent | numeric tunable | 1 | — |
| `SUDO_LAZINESS_NUDGE` | agent | default ON (kill via =0) | 1 | — |
| `SUDO_LAZINESS_THRESHOLD` | agent | numeric tunable | 1 | — |
| `SUDO_LEGACY_CHAT` | gateway | opt-in (default OFF) | 1 | — |
| `SUDO_LEGACY_DASHBOARD` | gateway | opt-in (default OFF) | 1 | — |
| `SUDO_LLM_BACKGROUND_HALT` | llm | opt-in (default OFF) | 1 | — |
| `SUDO_LLM_BUDGETS` | llm | value/string | 1 | — |
| `SUDO_LLM_GLOBAL_BUDGET_USD` | llm | value/string | 1 | — |
| `SUDO_LLM_LANE_CAPS` | llm | value/string | 1 | — |
| `SUDO_LLM_RETRY_DISABLE` | llm | opt-in (default OFF) | 1 | — |
| `SUDO_LOCAL_EMBED` | memory | value/string | 2 | — |
| `SUDO_LOCAL_EMBED_DEVICE` | memory | value/string | 1 | — |
| `SUDO_LOCAL_EMBED_MODEL` | memory | value/string | 1 | — |
| `SUDO_LOG_STDERR` | acp | opt-in (default OFF) | 3 | — |
| `SUDO_LOOP_MAX_CONSECUTIVE_TOOL_ITERS` | agent | numeric tunable | 1 | 50 |
| `SUDO_LOOP_SIGNATURE_PERSIST` | cli.ts | default ON (kill via =0) | 1 | — |
| `SUDO_LOOP_SIGNATURE_SUPPRESS_HITS` | cli.ts | indirect | 1 | — |
| `SUDO_MAX_CONCURRENT_SPAWNS` | tools | numeric tunable | 1 | — |
| `SUDO_MAX_CONTEXT_TOKENS` | agent | numeric tunable | 1 | 200000 |
| `SUDO_MAX_SPAWNS_PER_SESSION` | tools | numeric tunable | 1 | — |
| `SUDO_MAX_SPAWN_DEPTH` | tools | numeric tunable | 1 | — |
| `SUDO_MAX_TOOL_RESULT_CHARS` | agent | value/string | 1 | — |
| `SUDO_MCP_ALLOW_PRIVATE_HOSTS` | tools | opt-in (default OFF) | 1 | — |
| `SUDO_MCP_ALLOW_SHELL` | gateway | opt-in (default OFF) | 3 | — |
| `SUDO_MCP_CONNECTORS` | tools | default ON (kill via =0) | 2 | — |
| `SUDO_MCP_DISABLE` | tools | opt-in (default OFF) | 1 | — |
| `SUDO_MCP_EXPOSE_TOOLS` | gateway | value/string | 3 | — |
| `SUDO_MCP_OAUTH_DISABLE` | tools | mixed | 2 | — |
| `SUDO_MCP_REMOTE_DISABLE` | tools | opt-in (default OFF) | 3 | — |
| `SUDO_MCP_SCHEMA_COERCE` | tools | default ON (kill via =0) | 1 | — |
| `SUDO_MCP_TOKEN` | gateway | value/string | 2 | — |
| `SUDO_MEMORY_CONSOLIDATE` | cli.ts | opt-in (default OFF) | 1 | 1 |
| `SUDO_MEMORY_SCAN_MODE` | memory | value/string | 1 | — |
| `SUDO_MEMORY_SUPERSEDE` | memory | opt-in (default OFF) | 2 | 1 |
| `SUDO_MODAL_` | sandbox | indirect | 1 | — |
| `SUDO_MODAL_APP` | sandbox | value/string | 1 | — |
| `SUDO_MODAL_BIN` | sandbox | value/string | 1 | — |
| `SUDO_MODAL_BLOCK_NETWORK` | sandbox | indirect | 1 | — |
| `SUDO_MODAL_COMMAND` | sandbox | indirect | 1 | — |
| `SUDO_MODAL_IMAGE` | sandbox | value/string | 1 | — |
| `SUDO_MODAL_MEMORY_MB` | sandbox | indirect | 1 | — |
| `SUDO_MODAL_TIMEOUT_S` | sandbox | indirect | 1 | — |
| `SUDO_MSG_COALESCE` | dashboard | default ON (kill via =0) | 2 | 1 |
| `SUDO_MSG_COALESCE_MS` | cli.ts | numeric tunable | 1 | — |
| `SUDO_MSG_SCAN_STRICT` | memory | opt-in (default OFF) | 1 | — |
| `SUDO_MYTHOS_LAYER` | brain | default ON (kill via =0) | 1 | — |
| `SUDO_NATIVE_TOOL_CORRECTION` | tools | indirect | 1 | — |
| `SUDO_NATIVE_TOOL_CORRECTION_FALLBACK` | tools | default ON (kill via =1) | 1 | 1 |
| `SUDO_NOTEBOOKLM` | notebooklm | opt-in (default OFF) | 4 | — |
| `SUDO_NOTEBOOKLM_ESTATE_CRON` | cli.ts | value/string | 1 | — |
| `SUDO_NOTEBOOKLM_EXPORT_CRON` | cli.ts | value/string | 1 | — |
| `SUDO_NOTEBOOKLM_PERDAY_TOKENS` | notebooklm | indirect | 1 | — |
| `SUDO_NOTEBOOKLM_PERRUN_TOKENS` | notebooklm | indirect | 1 | — |
| `SUDO_NOTEBOOKLM_RETURNS_MS` | cli.ts | numeric tunable | 1 | — |
| `SUDO_NOTEBOOKLM_RITUALS_CRON` | cli.ts | value/string | 1 | — |
| `SUDO_NOTEBOOKLM_ROLL_CHARS` | notebooklm | indirect | 1 | — |
| `SUDO_NOTEBOOKLM_SUCCESSION_MS` | cli.ts | numeric tunable | 1 | — |
| `SUDO_NOTEBOOKLM_VERIFY_CRON` | cli.ts | value/string | 1 | — |
| `SUDO_NO_STATIC` | gateway | opt-in (default OFF) | 1 | — |
| `SUDO_NO_WIZARD` | cli | opt-in (default OFF) | 1 | — |
| `SUDO_OAUTH_BODY_IDLE_TIMEOUT_MS` | llm | numeric tunable | 1 | — |
| `SUDO_OAUTH_HEADERS_TIMEOUT_MS` | llm | numeric tunable | 1 | — |
| `SUDO_OUTCOME_ADAPTERS_DISABLE` | cli.ts | opt-in (default OFF) | 1 | — |
| `SUDO_OUTCOME_GATING` | cli.ts | default ON (kill via =0) | 1 | — |
| `SUDO_PARALLEL_TOOLS_DISABLE` | agent | opt-in (default OFF) | 2 | — |
| `SUDO_PERSIST_EPHEMERAL` | sessions | opt-in (default OFF) | 4 | — |
| `SUDO_PLAN_MODE` | tools | opt-in (default OFF) | 3 | 1 |
| `SUDO_PLUGINS` | tools | opt-in (default OFF) | 4 | 1 |
| `SUDO_PLUGIN_REGISTRY` | skills | indirect | 2 | — |
| `SUDO_PLUGIN_REGISTRY_URL` | skills | indirect | 1 | — |
| `SUDO_PLUGIN_ROOT` | plugins | value/string | 2 | — |
| `SUDO_POLICY_AGG_WINDOW_DAYS` | learning | value/string | 2 | 30 |
| `SUDO_POLICY_DISABLE` | learning | mixed | 2 | — |
| `SUDO_POLICY_REFRESH_MS` | cli.ts | numeric tunable | 1 | 21600000 |
| `SUDO_POLL_STAGNATION_ABORT` | agent | indirect | 1 | — |
| `SUDO_POLL_STAGNATION_WARN` | agent | indirect | 1 | — |
| `SUDO_PRECOMPACTION_FLUSH` | cli.ts | default ON (kill via =0) | 1 | — |
| `SUDO_PRECOMPACTION_FLUSH_TIMEOUT_MS` | agent | numeric tunable | 1 | — |
| `SUDO_PREDICTOR_AUTO_RESOLVE` | prediction | default ON (kill via =1) | 1 | 1 |
| `SUDO_PREDICTOR_LOOP` | agent | opt-in (default OFF) | 4 | 1 |
| `SUDO_PREMIUM_MODEL` | config | value/string | 2 | — |
| `SUDO_PROMPT_CACHE` | brain | default ON (kill via =0) | 5 | 1 |
| `SUDO_PROMPT_CACHE_BREAKPOINTS_DISABLE` | brain | default ON (kill via =1) | 1 | — |
| `SUDO_PROMPT_CACHE_DEBUG` | llm | opt-in (default OFF) | 2 | — |
| `SUDO_PROMPT_CACHE_HISTORY` | llm | default ON (kill via =0) | 1 | — |
| `SUDO_PTC` | tools | opt-in (default OFF) | 2 | 1 |
| `SUDO_PTC_PYTHON` | tools | opt-in (default OFF) | 2 | 1 |
| `SUDO_PTC_PYTHON_BWRAP` | tools | default ON (kill via =0) | 1 | — |
| `SUDO_PUBLIC_BASE_URL` | gateway | value/string | 1 | http://127.0.0.1:18900 |
| `SUDO_PUBLIC_REGISTRY_BASE` | skills | value/string | 1 | — |
| `SUDO_RATE_LIMIT_` | channels | indirect | 1 | — |
| `SUDO_RATE_LIMIT_BURST` | channels | value/string | 1 | — |
| `SUDO_RATE_LIMIT_PERSIST` | channels | opt-in (default OFF) | 1 | 1 |
| `SUDO_RATE_LIMIT_PER_MIN` | channels | value/string | 1 | — |
| `SUDO_RATE_LIMIT_TELEGRAM_PER_MIN` | channels | indirect | 1 | — |
| `SUDO_REASONING_LENS_DISABLE` | brain | opt-in (default OFF) | 2 | — |
| `SUDO_REASONING_SUMMARY` | agent | opt-in (default OFF) | 2 | 1 |
| `SUDO_REASONING_TIER_DISABLE` | brain | default ON (kill via =1) | 1 | — |
| `SUDO_RECONCILE_NO_FILTER` | sessions | default ON (kill via =1) | 2 | — |
| `SUDO_REPAIR_FLYWHEEL` | cli.ts | default ON (kill via =0) | 1 | — |
| `SUDO_REPO_EXEC` | security | opt-in (default OFF) | 2 | 1 |
| `SUDO_REPO_EXEC_QUIET` | security | indirect | 1 | — |
| `SUDO_REPO_VISIBILITY` | privacy | value/string | 1 | — |
| `SUDO_RESPONSE_CACHE` | gateway | opt-in (default OFF) | 1 | 1 |
| `SUDO_RESTART_CMD` | tools | value/string | 3 | — |
| `SUDO_ROUTING_GUARD_RUNTIME` | cli.ts | default ON (kill via =0) | 1 | — |
| `SUDO_SANDBOX_ALLOW_UNCONFINED` | sandbox | opt-in (default OFF) | 1 | — |
| `SUDO_SANDBOX_AUTOBUILD` | cli.ts | opt-in (default OFF) | 1 | — |
| `SUDO_SANDBOX_DISABLE` | tools | mixed | 8 | — |
| `SUDO_SANDBOX_EGRESS_ALLOWLIST` | sandbox | value/string | 2 | — |
| `SUDO_SANDBOX_NETWORK` | sandbox | value/string | 2 | — |
| `SUDO_SANDBOX_TIER_ROUTING` | sandbox | default ON (kill via =0) | 2 | — |
| `SUDO_SCHEDULED_DIGEST_TIMEOUT_MS` | channels | numeric tunable | 1 | — |
| `SUDO_SCHEDULED_MESSAGES` | tools | opt-in (default OFF) | 3 | 1 |
| `SUDO_SCHEDULED_MSG_CONCURRENCY` | channels | numeric tunable | 1 | — |
| `SUDO_SCHEDULER_TZ` | cli.ts | value/string | 2 | — |
| `SUDO_SEAL_REQUIRED` | tools | opt-in (default OFF) | 1 | 1 |
| `SUDO_SEARCH_TIMEOUT_MS` | tools | numeric tunable | 1 | — |
| `SUDO_SEARCH_WAIT_UNTIL` | tools | value/string | 1 | — |
| `SUDO_SECCOMP_DISABLE` | tools | opt-in (default OFF) | 1 | — |
| `SUDO_SECOND_OPINION` | cli.ts | opt-in (default OFF) | 1 | — |
| `SUDO_SECRETS_ALLOW_EXEC` | secrets | mixed | 2 | — |
| `SUDO_SECRETS_REF` | gateway | default ON (kill via =0) | 3 | — |
| `SUDO_SECURITY_AUDIT_DISABLE` | security | opt-in (default OFF) | 2 | — |
| `SUDO_SECURITY_OSV_URL` | security | value/string | 1 | — |
| `SUDO_SECURITY_SCAN_INTERVAL_HOURS` | security | numeric tunable | 1 | — |
| `SUDO_SECURITY_SCAN_ON_STARTUP` | security | indirect | 1 | — |
| `SUDO_SELFBUILD_ALLOW_PROTECTED` | tools | mixed | 4 | — |
| `SUDO_SELFTEST_BROWSER` | health | default ON (kill via =0) | 1 | — |
| `SUDO_SELFTEST_CRON` | cli.ts | value/string | 1 | — |
| `SUDO_SELFTEST_DISABLE` | health | opt-in (default OFF) | 2 | — |
| `SUDO_SELF_BUILD_DISABLE` | self-build | opt-in (default OFF) | 1 | — |
| `SUDO_SELF_BUILD_MAX_GATE_ABORT_TICKS` | self-build | numeric tunable | 1 | — |
| `SUDO_SELF_BUILD_MAX_ITERATIONS` | self-build | numeric tunable | 1 | — |
| `SUDO_SELF_BUILD_MAX_NO_COMMIT_TICKS` | self-build | numeric tunable | 1 | — |
| `SUDO_SELF_BUILD_MIN_ALIGN_SCORE` | self-build | numeric tunable | 1 | — |
| `SUDO_SELF_BUILD_MODE` | self-build | mixed | 10 | — |
| `SUDO_SELF_BUILD_OPEN_PR` | self-build | value/string | 2 | — |
| `SUDO_SELF_EVAL_ADOPT` | eval | opt-in (default OFF) | 3 | 0 |
| `SUDO_SELF_VERIFY` | agent | opt-in (default OFF) | 3 | 1 |
| `SUDO_SEMANTIC_COMPACT` | cli.ts | opt-in (default OFF) | 1 | 1 |
| `SUDO_SEMANTIC_PLAN_TIMEOUT_MS` | autonomy | numeric tunable | 1 | — |
| `SUDO_SESSION_RECONCILE` | cli.ts | default ON (kill via =0) | 1 | — |
| `SUDO_SESSION_RECONCILE_APPLY` | cli.ts | opt-in (default OFF) | 1 | — |
| `SUDO_SHIP_COMPLETION_GUARD` | agent | default ON (kill via =0) | 1 | — |
| `SUDO_SIGNER_KEY_DIR` | security | value/string | 1 | — |
| `SUDO_SIGNING_DISABLE` | gateway | mixed | 3 | — |
| `SUDO_SKILLS_DIRS` | plugins | value/string | 5 | — |
| `SUDO_SKILL_ACTIVATION` | agent | indirect | 2 | — |
| `SUDO_SKILL_ACTIVATION_MAX` | agent | indirect | 2 | — |
| `SUDO_SKILL_AUTO_APPLY` | skills | default ON (kill via =1) | 1 | 1 |
| `SUDO_SKILL_EVAL_CONCURRENCY` | skills | value/string | 2 | — |
| `SUDO_SKILL_FORGE` | commands | default ON (kill via =1) | 1 | — |
| `SUDO_SKILL_FORGE_ASYNC` | learning | opt-in (default OFF) | 1 | 1 |
| `SUDO_SKILL_INDEX_DISABLE` | tools | opt-in (default OFF) | 1 | — |
| `SUDO_SKILL_PACKAGING` | tools | indirect | 2 | — |
| `SUDO_SKILL_PUBLISH_DIR` | tools | value/string | 1 | — |
| `SUDO_SKILL_REGISTRY` | tools | indirect | 4 | — |
| `SUDO_SKILL_REGISTRY_URL` | skills | indirect | 1 | — |
| `SUDO_SKILL_SEMANTIC_ASSIST` | skills | default ON (kill via =0) | 3 | — |
| `SUDO_SKILL_SEMANTIC_BUDGET_MS` | skills | indirect | 1 | — |
| `SUDO_SKILL_SEMANTIC_THRESHOLD` | skills | indirect | 1 | — |
| `SUDO_SKILL_WORKSHOP` | tools | opt-in (default OFF) | 8 | 1 |
| `SUDO_SKIP_DIAGNOSTIC_DAILY_LOG` | workspace | indirect | 2 | 1 |
| `SUDO_SLEEP_LOCKOUT_WINDOW` | consciousness | value/string | 2 | — |
| `SUDO_SLIM_HEARTBEAT` | brain | default ON (kill via =0) | 4 | — |
| `SUDO_SMART_ROUTE_CHEAP` | agent | opt-in (default OFF) | 2 | — |
| `SUDO_SMART_ROUTE_DISABLE` | brain | opt-in (default OFF) | 1 | — |
| `SUDO_SOMATIC_MAX_ROWS` | consciousness | numeric tunable | 2 | — |
| `SUDO_SOMATIC_RETENTION_DAYS` | consciousness | numeric tunable | 2 | — |
| `SUDO_SSH_` | sandbox | indirect | 1 | — |
| `SUDO_SSH_BIN` | sandbox | value/string | 1 | — |
| `SUDO_SSH_HOST` | sandbox | value/string | 1 | — |
| `SUDO_SSH_KEY` | sandbox | value/string | 1 | — |
| `SUDO_SSH_PORT` | sandbox | value/string | 1 | — |
| `SUDO_SSH_STRICT_HOST_KEY` | sandbox | value/string | 1 | — |
| `SUDO_SSH_USER` | sandbox | value/string | 1 | — |
| `SUDO_SSH_WORKDIR` | sandbox | value/string | 1 | — |
| `SUDO_SSRF_ALLOWED_HOSTS` | gateway | value/string | 1 | — |
| `SUDO_SSRF_DNS_PIN` | security | default ON (kill via =0) | 1 | — |
| `SUDO_SSRF_HOST_GATE` | gateway | default ON (kill via =0) | 2 | — |
| `SUDO_STREAM_CHANNELS` | cli.ts | default ON (kill via =0) | 1 | 1 |
| `SUDO_STRIP_EMPTY_TEXT` | llm | default ON (kill via =0) | 1 | — |
| `SUDO_STT_CLOUD` | voice | value/string | 5 | — |
| `SUDO_STUCK_DETECTOR` | agent | opt-in (default OFF) | 2 | 1 |
| `SUDO_STUCK_DETECTOR_ABORT_THRESHOLD` | agent | indirect | 1 | 5 |
| `SUDO_STUCK_DETECTOR_WARN_THRESHOLD` | agent | indirect | 1 | 3 |
| `SUDO_SWARM_RESCUE` | agent | indirect | 1 | 1 |
| `SUDO_SWARM_RESCUE_STRATEGY` | agent | indirect | 1 | — |
| `SUDO_TAINT_DISABLE` | cli.ts | default ON (kill via =1) | 1 | — |
| `SUDO_TASK_TRACKER` | agent | opt-in (default OFF) | 1 | 1 |
| `SUDO_TELEGRAM_DISABLE` | cli.ts | default ON (kill via =1) | 1 | — |
| `SUDO_TELEGRAM_VIA_GATEWAY` | channels | opt-in (default OFF) | 2 | 1 |
| `SUDO_TELEGRAM_VOICE_REPLY` | channels | default ON (kill via =0) | 1 | — |
| `SUDO_TENANCY_ALLOW_UNSAFE` | tenancy | default ON (kill via =1) | 1 | — |
| `SUDO_TEXTPROC` | tools | default ON (kill via =0) | 2 | — |
| `SUDO_TEXT_TOOLCALL_FALLBACK_DISABLE` | brain | default ON (kill via =1) | 1 | — |
| `SUDO_THINKING_BUDGET` | llm | value/string | 3 | — |
| `SUDO_THINKING_DISABLE` | llm | value/string | 3 | — |
| `SUDO_THINKING_MODEL_MAX` | brain | value/string | 6 | — |
| `SUDO_TODO_GATE` | agent | opt-in (default OFF) | 1 | 1 |
| `SUDO_TODO_GATE_MAX_RETRIES` | agent | numeric tunable | 1 | — |
| `SUDO_TOKEN` | api | indirect | 1 | — |
| `SUDO_TOOL_CONCURRENCY` | agent | numeric tunable | 2 | — |
| `SUDO_TOOL_EMPTY_RETRY_DISABLE` | brain | default ON (kill via =1) | 1 | — |
| `SUDO_TOOL_ERROR_HINTS` | agent | default ON (kill via =0) | 2 | — |
| `SUDO_TOOL_FETCH_GUARD_DISABLE` | security | opt-in (default OFF) | 1 | — |
| `SUDO_TOOL_LEARNING_DISABLE` | agent | opt-in (default OFF) | 3 | — |
| `SUDO_TOOL_OUTCOME_LEARNER` | cli.ts | opt-in (default OFF) | 1 | 1 |
| `SUDO_TOOL_SCHEMA_COMPAT` | brain | default ON (kill via =0) | 1 | — |
| `SUDO_TOOL_SYNTHESIZE_ENABLED` | tools | default ON (kill via =1) | 2 | — |
| `SUDO_TRACE_CAPTURE` | learning | opt-in (default OFF) | 6 | 1 |
| `SUDO_TRACE_CAPTURE_MAX_BYTES` | learning | numeric tunable | 1 | — |
| `SUDO_TRACE_LEARNING` | cli.ts | opt-in (default OFF) | 2 | 1 |
| `SUDO_TRACE_MAX_ROWS` | learning | numeric tunable | 2 | — |
| `SUDO_TRACE_POLICY` | cli.ts | opt-in (default OFF) | 1 | 1 |
| `SUDO_TRACE_RETENTION_DAYS` | learning | numeric tunable | 2 | — |
| `SUDO_TTS_CLOUD` | tools | value/string | 4 | — |
| `SUDO_TUI_POLL_MS` | tui | indirect | 1 | — |
| `SUDO_TUI_REQUEST_TIMEOUT_MS` | tui | indirect | 1 | — |
| `SUDO_TUI_TEST` | tools | indirect | 2 | — |
| `SUDO_TWO_TIER_COMPACT` | agent | default ON (kill via =0) | 2 | 1 |
| `SUDO_UNIVERSAL_NEGATIVE_GUARD` | agent | indirect | 2 | — |
| `SUDO_UPDATE_` | update | indirect | 1 | — |
| `SUDO_UPDATE_DISABLE` | update | opt-in (default OFF) | 4 | 0 |
| `SUDO_USER_HOOKS` | hooks | opt-in (default OFF) | 5 | 1 |
| `SUDO_VAULT_MASTER_KEY` | dashboard | value/string | 3 | — |
| `SUDO_VAULT_MASTER_KEY_PRESENT` | dashboard | indirect | 1 | — |
| `SUDO_VAULT_PASSPHRASE` | security | value/string | 2 | — |
| `SUDO_VAULT_PROVIDER_KEYS` | llm | opt-in (default OFF) | 1 | — |
| `SUDO_VECTOR_BACKFILL` | memory | opt-in (default OFF) | 2 | 1 |
| `SUDO_VERIFY_GATE` | agent | opt-in (default OFF) | 6 | 1 |
| `SUDO_VERIFY_GATE_BLOCK` | agent | indirect | 4 | — |
| `SUDO_VERIFY_GATE_CACHE` | agent | indirect | 1 | — |
| `SUDO_VERIFY_GATE_CACHE_MAX` | agent | indirect | 1 | — |
| `SUDO_VERIFY_GATE_CACHE_TTL_MS` | agent | indirect | 1 | — |
| `SUDO_VERIFY_GATE_CRITIC_BLOCK` | agent | indirect | 2 | — |
| `SUDO_VERIFY_GATE_CRITIC_BUDGET` | agent | indirect | 2 | — |
| `SUDO_VERIFY_GATE_CRITIC_FEEDBACK` | agent | indirect | 2 | — |
| `SUDO_VERIFY_GATE_MIN_SAMPLES` | agent | indirect | 1 | — |
| `SUDO_VERIFY_GATE_THRESHOLD` | agent | indirect | 1 | — |
| `SUDO_VETO_AUTO_TUNE` | gateway | opt-in (default OFF) | 2 | 1 |
| `SUDO_VSCODE_EXTENSION` | ide | indirect | 3 | — |
| `SUDO_WASM_SANDBOX` | sandbox | indirect | 2 | — |
| `SUDO_WEBHOOK_STRIPE_TOLERANCE_S` | gateway | numeric tunable | 1 | — |
| `SUDO_WEB_REPLY_BUFFER` | channels | default ON (kill via =0) | 1 | — |
| `SUDO_WEB_STREAM` | cli.ts | default ON (kill via =0) | 1 | — |
| `SUDO_WHATSAPP_ENABLE` | cli.ts | opt-in (default OFF) | 1 | 1 |
| `SUDO_WHISPER_DEVICE` | voice | value/string | 1 | — |
| `SUDO_WHISPER_DTYPE` | voice | value/string | 1 | — |
| `SUDO_WHISPER_MODEL` | voice | value/string | 1 | onnx-community/whisper-medium-ONNX |
| `SUDO_WHISPER_STT` | voice | value/string | 2 | — |
| `SUDO_WORKFLOWS` | tools | opt-in (default OFF) | 2 | 1 |
| `SUDO_WORKFLOWS_MAX_PARALLEL` | workflows | value/string | 4 | — |
| `SUDO_WORKFLOWS_QUEUE` | tools | opt-in (default OFF) | 4 | 1 |
| `SUDO_WORKFLOWS_QUEUE_CONCURRENT` | tools | value/string | 2 | — |
| `SUDO_WORKFLOWS_QUEUE_POLL_MS` | cli.ts | value/string | 1 | — |
| `SUDO_WORLD_STATE_GOALS` | autonomy | opt-in (default OFF) | 2 | 0 |
| `SUDO_WORLD_STATE_MONITOR` | cli.ts | default ON (kill via =0) | 1 | — |
| `SUDO_WRITE_CYCLE_ABORT` | agent | indirect | 1 | — |
| `SUDO_WRITE_CYCLE_WARN` | agent | indirect | 1 | — |
| `SUDO_WRITE_THROUGH_PERSIST` | sessions | indirect | 1 | — |
| `SUDO_ZDR` | privacy | opt-in (default OFF) | 2 | — |

## `LLM_*` census

| Flag | Subsystem | Inferred default | Files | Prod |
|---|---|---|---|---|
| `LLM_ALIAS_` | llm | indirect | 1 | — |
| `LLM_ALIAS_CHEAP` | llm | indirect | 1 | — |
| `LLM_ALIAS_FRONTIER` | llm | indirect | 1 | — |
| `LLM_ALIAS_JUDGE` | llm | indirect | 2 | — |
| `LLM_API_KEY` | llm | value/string | 2 | — |
| `LLM_BASE_URL` | llm | value/string | 2 | — |
| `LLM_DIRECT_FALLBACK` | llm | default ON (kill via =0) | 1 | — |
| `LLM_IR_CALLERS` | llm | value/string | 4 | health,consciousness |
| `LLM_SHADOW` | llm | opt-in (default OFF) | 3 | — |
