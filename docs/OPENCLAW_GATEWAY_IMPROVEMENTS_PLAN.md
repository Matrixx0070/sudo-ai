# OpenClaw → SUDO AI Gateway Improvements — Full Implementation Spec

**Date:** 2026-07-18 (detailed spec v2; v1 summary superseded)
**Source analysis:** direct read of OpenClaw monorepo (github.com/openclaw/openclaw, commit `faf3dbd`, v2026.7.2, clone at `/tmp/openclaw-analysis`) vs full map of the SUDO AI gateway. Items GW-1…GW-15, each with problem, evidence, design, implementation steps, tests, and effort (S ≈ ≤1 day, M ≈ 2-4 days, L ≈ 1-2 weeks).

**Global constraints for the implementer (non-negotiable):**
- All CLAUDE.md invariants hold: no hot-path Drive/NotebookLM imports, memory-API-only mutation, quarantine for external content, fail-closed gates, budgets on background jobs.
- No deploys, no restarts of the live daemon, no edits to the live prod env/config files. Code + tests + docs only, on a feature branch, delivered as PR(s).
- Where an item changes a security-relevant *default*, the old behavior must remain reachable via an explicit, posture-registered override flag, and the change must be listed in the PR description under "default changes."
- Every new recurring/background mechanism declares per-run + per-day budgets (invariant #10).
- Reuse existing modules; never fork parallel plumbing. Match surrounding code style.

---

## P0 — enforcement gaps

### GW-1. Turn on budget enforcement (persistent spend, prod-ready caps) — **S**

**Problem.** SUDO built a full budget substrate (per-lane caps, USD budgets, degrade-not-block for user priority) but prod runs with `SUDO_DAILY_BUDGET_USD=off` and `SUDO_DAILY_LLM_BUDGET_USD=off`, and `src/llm/policy.ts` tracks spend in an in-memory day-keyed Map that resets on every restart and never consults history. CORE_ROADMAP flags this "fix FIRST" (FLAG_CENSUS finding #1); invariant #10 requires budgets on all background jobs.

**Design.**
1. Persist day-spend: on boot, derive today's spend from existing `llm_calls` rows in `data/gateway.db` (`src/llm/logging.ts` already writes cost-relevant fields; add a cost column if missing, backfilled as NULL-tolerant). Policy reads the boot-derived number into its Map, then increments in-memory as today; write-through is NOT needed per-call (gateway.db rows are the source of truth; re-derive on restart).
2. Keep the asymmetry exactly as designed: `user` priority over-budget → `degrade` (via `degradeAlias`), never block; `background` over-budget → fail-closed skip.
3. Choose safe default caps but ship them **default-off with a loud boot warning** ("budget enforcement OFF — set SUDO_DAILY_LLM_BUDGET_USD") rather than silently activating spend limits on prod — the operator flips the env. Add the recommended values to `FLAG_CENSUS.md` and `.env.example`.
4. Budget exhaustion → graceful halt + alert row on the Telemetry tab (invariant #10 shape), reuse existing alerting seam used by other budget-exhaustion paths (gdrive budgets).

**Steps.** (a) Add `deriveDaySpendUSD(db, dayKey)` in `src/llm/logging.ts`; (b) call from policy init; (c) ensure per-call cost estimation exists for xai/anthropic families (token counts × price table — a minimal static price map in `src/llm/limits.ts` is acceptable, marked estimate); (d) boot warning + posture note when both caps off; (e) telemetry alert on exhaustion.

**Tests.** Unit: boot-derivation from a seeded gateway.db; restart-survival (spend survives simulated restart); user-lane degrade vs background-skip at cap; estimation fallback when cost is NULL. Extend `tests/` alongside existing policy tests.

### GW-2. Fix the failover cost cliff (chained fallback, cooldowns, strictness) — **S**

**Problem.** Prod failover lands on `grok-4.5`, which caches nothing → ~10× cost (STATUS.md known issue). Failover is also silent — no operator notice on sustained degradation.

**Design (from OpenClaw's two-stage model, adapted).**
1. In `src/llm/aliases.ts`, make failover a *chain*, not a single alternate: primary → `grok-4-fast` → (only then) `grok-4.5`, per alias tier. Chain order is data (an array per alias), not code.
2. Per-target cooldowns: a failing target enters cooldown (existing circuit-breaker state in `policy.ts` can carry this; if the breaker is route-keyed, reuse it — do not build a second breaker).
3. Strict explicit selection: when a caller pins a concrete model (not an alias), never silently fall back — surface the provider error. Aliases opt into the chain; pins don't.
4. Bounded degradation notice: on sustained failover (>30s or >3 consecutive chain hops), emit ONE status notice through the existing telemetry/alert seam, not per-call spam.

**Steps.** (a) chain data structure + resolution in `aliases.ts`; (b) wire chain walk into `transport.ts` retry path; (c) pin-strictness check where alias resolution happens; (d) single-notice throttle (in-memory, per-route, 30-min re-arm).

**Tests.** Chain walks in order; grok-4.5 only reached after grok-4-fast fails; pinned model never falls back; notice fires once under sustained failure; cooldown honored.

### GW-3. Retire fail-open escape hatches (auth kill-switch, SecurityGuard strict, Kairos switch) — **S**

Three independent sub-items; each is small and each is a real hole.

**3a. `SUDO_GATEWAY_UNIFIED_AUTH=0`.** Evidence: `src/core/gateway/auth.ts:76-78,195-215` — the kill-switch restores legacy "open when secret unset" on every surface. #759 has been deployed and stable. Design: delete the legacy branch entirely. If a rollback story is still wanted, the flag may remain recognized but its only effect is: legacy semantics for **loopback-direct requests only**; any proxied/non-loopback request is still denied. Log a posture-banner entry when set. Update `docs/gateway-unified.md`.

**3b. SecurityGuard strict by default.** Evidence: guard init failure currently logs "running without…" and continues (roadmap L66); F104 added `SUDO_SECURITY_STRICT=1` opt-in. Design: flip the default — init failure is fatal unless `SUDO_SECURITY_STRICT=0` is explicitly set (which registers in the posture banner as a weakening flag). Grep all callers of guard init to confirm no test/dev path depends on lenient init; vitest paths may set the escape flag in test setup.

**3c. Kairos kill-switch + posture registration.** Evidence: F121 — always-on 5-min daemon can `execSync` + `systemctl restart` with no off-switch. Design: gate the entire daemon behind `SUDO_KAIROS` (default: current behavior preserved, i.e. ON, to avoid a surprise behavior change on deploy — but `SUDO_KAIROS=0` must fully disable it); register "Kairos restart authority active" in `posture.ts`; every restart action writes an audit row (reuse `security.log` audit seam) BEFORE executing; add a dry-run env `SUDO_KAIROS_DRY_RUN=1` for testing.

**Tests.** 3a: proxied request denied even with flag=0; loopback legacy path works. 3b: failed init throws by default; escape flag restores old behavior + posture entry. 3c: flag=0 → no timer scheduled; audit row precedes exec (assert with injected exec stub).

### GW-4. Finish the single-listener story (retire port 18910, one admin namespace) — **M**

**Problem.** F101 tail: `src/core/dashboard/dashboard-server.ts` still opens a second port (18910) with its own auth stack, and admin routes are split between `/api/admin/*` (opt-in `SUDO_ADMIN_API`, `src/core/api/admin-router.ts`) and `/v1/admin/*` (gateway `admin-routes.ts`). OpenClaw serves Control UI, canvas, A2UI, and all APIs from one port behind one auth resolver — no drift surface.

**Design.**
1. Make `SUDO_GATEWAY_UI_ON_MAIN=1` the default; dashboard content is served from the 18900 listener via the existing route-owner mechanism. `SUDO_DASHBOARD_PORT` becomes a deprecated no-op that logs a migration warning (keep one release; delete later).
2. Namespace reconciliation: `/v1/admin/*` is canonical. `/api/admin/*` handlers get mounted under `/v1/admin/*` as well; the `/api/admin/*` prefix stays as a thin 308 redirect (or alias) for one release, logged as deprecated. All admin surfaces authenticate through `auth.ts` scopes (`operator.admin`) — delete any bespoke Bearer check in `admin-router.ts:134-147` in favor of the unified resolver.
3. Update `docs/HTTP_SURFACES.md` (it declares 18900 canonical post-F101 — finish the claim).

**Steps.** (a) flip default + deprecation warning; (b) mount dashboard route-owner on main listener (pattern already exists for `web`); (c) alias admin namespaces; (d) unify auth; (e) docs. **Careful:** the admin UI is the INLINE `dashboard-html.ts` (the SPA is dead/shadowed — see project memory); do not resurrect the SPA.

**Tests.** Route-owner attach test for dashboard on main; `/api/admin/x` → `/v1/admin/x` parity; auth: no-credential proxied request → 401 on every admin route; extend `tests/gdrive/hot-path.test.ts` untouched (no new hot-path imports).

---

## P1 — borrowed mechanisms

### GW-5. Mid-run steering + per-session queue modes — **L**

**Problem.** A message arriving mid-turn today waits for the whole ReACT turn to finish (per-peer serialization in `MessageRouter`'s `KeyedAsyncQueue`). OpenClaw's queue semantics are the best in this space: mode `steer` injects new user input after the current tool call completes and before the next LLM call; `followup` queues a new turn; `collect` coalesces during a quiet window; `interrupt` aborts. Defaults: steer, `debounceMs:500`, cap 20 queued, overflow policy "summarize".

**Design.**
1. **Steer buffer:** a per-session in-memory buffer owned by the agent loop. `src/core/agent/loop-injections.ts` is the existing injection seam — add a check at the top of each ReACT iteration (post-tool-exec, pre-model-call): drain the steer buffer and append the messages as user-role input with a `[mid-run]` marker before building the next model request.
2. **Router integration:** `src/core/channels/router.ts` — when a message arrives for a session with an active run: consult the session's queue mode. `steer` → push to steer buffer + fire typing indicator immediately; `followup` → current behavior (queue next turn); `collect` → hold in the existing `message-coalescer.ts` with a quiet-window timer, then follow-up as one turn; `interrupt` → signal the loop's existing abort seam, then start a new turn with the message.
3. **Config:** per-channel default mode + per-session override (`data/` persisted map, small JSON via existing config store). Global default `steer`. Cap: 20 buffered steer messages; overflow → coalesce oldest into a single summarized line (reuse coalescer), never silently drop.
4. **Safety:** steer content from untrusted channels keeps its trust tier — steering must not upgrade an untrusted turn to owner; the trust-tier of the *run* is min(run, steered message). If a steer message would DOWNGRADE an owner run (untrusted content steering into an owner turn), route it to `followup` instead — never mix tiers mid-run.
5. Do NOT debounce/steer control commands (registered-command intercept fires immediately) or media messages (attachment metadata must not detach — OpenClaw learned this; media → followup).

**Steps.** (a) steer buffer module + loop drain point; (b) router mode dispatch; (c) coalescer wiring for collect; (d) interrupt via existing abort; (e) trust-tier guard; (f) config + persistence; (g) docs page.

**Tests.** Steered message appears in next model request of same run (mock LLM transport, assert message array); media → followup; command → immediate; tier-mixing guard; overflow summarize; interrupt aborts and re-runs. This is the flagship item — budget test time accordingly.

### GW-6. Pairing codes for unknown senders — **M**

**Problem.** Non-allowlisted Telegram senders are silently dropped (`telegram.ts:1009,1047`). Correct default, terrible recoverability: adding a legit contact requires config surgery. OpenClaw: unknown sender on a `pairing`-policy channel gets an 8-char code (no ambiguous chars), 1-hour expiry, max 3 pending per channel account, and the triggering message is NOT processed until approved.

**Design.**
1. Generalize into `src/core/channels/access-policy.ts`: per-channel `dmPolicy: 'allowlist' | 'pairing' | 'open'` (default `allowlist` = today's behavior; `open` requires an explicit `'*'` wildcard in config to be effective — copy OpenClaw's guard).
2. `pairing` mode: unknown sender → generate code from unambiguous alphabet (no 0/O/1/I/l), store `{channel, accountId, peerId, code, expiresAt, firstMessagePreview(128 chars, quarantine-scanned)}` in a small SQLite table or JSON store under `data/`; reply to the sender with the code + "ask the owner to approve"; cap 3 pending per channel (further requests → silent drop + rate-limited log).
3. Approval surfaces: (a) owner DM command `/pair approve <code>` via the registered-command intercept; (b) admin UI list + approve/deny on the existing dashboard (`/v1/admin/pairing`). Approve → peer appended to the channel allowlist store (runtime + persisted), pending entry deleted, sender notified. The original message is **not** replayed automatically (it arrived pre-trust); sender is invited to resend.
4. The pairing-code reply path must be exempt from the agent loop entirely — pure adapter-level response, zero LLM involvement (prompt-injection surface stays closed).

**Steps.** (a) policy enum + store; (b) Telegram wiring (first), interface kept channel-generic; (c) owner command + admin route; (d) posture note when any channel is `open`; (e) docs.

**Tests.** Unknown sender gets code exactly once per expiry window; 4th pending dropped; expiry honored; approve → next message flows; message-not-processed-before-approval asserted (no agent turn scheduled); `open` without `'*'` behaves as allowlist.

### GW-7. `sudo security audit` CLI with contextual severity and `--fix` — **M**

**Problem.** `posture.ts` surfaces 11 weakening flags in a boot banner and does nothing else. FLAG_CENSUS.md was a one-shot manual audit (590 flags, 6 ghosts). OpenClaw ships `openclaw security audit --deep --fix`: structured checkIds, severity computed from context (tool blast radius × inbound access), narrow auto-fixes.

**Design.**
1. New CLI subcommand (wire into `src/cli.ts` command table): `sudo-ai security-audit [--json] [--fix]`.
2. Check catalog (each check = `{id, severity(ctx), evidence, fix?}`), initial set:
   - `posture.*`: one check per posture flag, severity contextual — e.g. `SUDO_SANDBOX_DISABLE` is CRITICAL if any untrusted inbound channel (webhooks/email/pairing/open DM) is enabled, else MEDIUM.
   - `flags.ghost`: env `SUDO_*` names not found in src (reuse/port the FLAG_CENSUS scan as code).
   - `flags.contradiction`: known-bad combos (see GW-10 list — share the table).
   - `secrets.env-not-ref`: prod creds present as raw env where a `_REF` seam exists (SecretRef migration check).
   - `net.listeners`: unexpected listening ports beyond 18900 (+18910 until GW-4 lands).
   - `auth.unset`: no GATEWAY_TOKEN configured while non-loopback exposure detected.
   - `budget.off`: GW-1's caps off → HIGH.
3. `--fix` only for narrow, reversible remediations (write `.env` suggestions to a patch file rather than editing live env; the ONLY direct fixes allowed are file-permission tightening, e.g. 0600 on token/cred files). Everything else prints the exact remediation command.
4. Output: human table + `--json`; exit code 1 if any HIGH+, 2 if CRITICAL (CI-friendly). Register a standing order (F89, CRUD exists) to run daily and post to Telemetry — with per-run budget declared (pure-local checks, zero LLM calls).

**Tests.** Each check with a synthetic env/config fixture; contextual severity flips; `--fix` never touches anything outside its whitelist; JSON schema stable.

### GW-8. Idempotency keys + backpressure + preauth budgets on WS/RPC — **M**

**Problem.** SUDO's `/ws` JSON-RPC (`ws-server.ts`) has token auth and per-method scopes but: no idempotency on side-effecting methods (duplicate-turn class — session fork loop #445-#447 was this shape), no advertised payload/buffer policy, no preauth flood control. OpenClaw's numbers: preauth frames ≤64KiB, ≤32 unauthenticated connections/IP, close after 10 unauthorized frames, auth attempts 10/min + 5-min lockout, control-plane writes 30/min/device+IP, 50MiB send-buffer cap with slow-consumer close, distinct close codes (1008 policy, 1013 suspending, 4001 auth-rotated).

**Design.**
1. **Idempotency:** `rpc-schema.ts` gains optional `idempotencyKey`; REQUIRED (schema-enforced) for mutating methods (`sessions.send`, admin mutations, any method that schedules an agent turn). Server keeps a TTL map (5 min / 1000 entries, OpenClaw's dedupe numbers) of key→result; replay returns the cached result, never re-executes.
2. **Backpressure contract:** on successful auth, server sends a `hello` payload including `{maxPayload, maxBufferedBytes}`. Enforce: preauth frame cap 64KiB (before auth completes), post-auth cap generous (existing behavior), `socket.bufferedAmount > maxBufferedBytes` → close as slow consumer with a metadata-only log (never log frame bodies).
3. **Preauth budgets:** per-IP unauthenticated connection cap (32), unauthorized-frame counter (close at 10), auth-attempt limiter (10/min, 5-min lockout) — one small in-memory sliding-window module shared with webhook auth (`webhook-routes.ts` already does constant-time compare; give it the same limiter).
4. **Close codes:** adopt 1008/1013/4001 semantics; 4001 on GATEWAY_TOKEN rotation so clients re-auth cleanly.

**Tests.** Duplicate idempotencyKey → single execution + identical result; missing key on mutating method → schema error; 11th unauthorized frame → close; lockout after 10 bad tokens; oversized preauth frame → 1009-style close; hello advertises policy.

### GW-9. Verified restart handoff — **M**

**Problem.** SUDO restarts (updater merge→pull+restart→publish flow, Kairos) are fire-and-forget; ops memory shows probes must wait 80s+ post-restart to avoid false failures, and there is no proof-of-successor before the old process is gone. OpenClaw: restart sentinel — successor writes readiness, predecessor confirms handoff, external-supervisor mode for systemd ownership.

**Design.**
1. Sentinel file protocol under `data/restart/`: initiator writes `intent.json` `{reason, initiator, ts, gitSha}` BEFORE triggering restart. On boot, the new process completes init (gateway listening + SecurityGuard up + channels started), then writes `ready.json` `{bootTs, gitSha, port}` and deletes `intent.json`.
2. Watchdog: the restart *initiator* (updater script / Kairos) polls for `ready.json` with timeout (default 120s). Timeout → alert (telemetry + owner Telegram via existing scheduled-messages seam) with the intent context; if the initiator is Kairos, a failed handoff puts Kairos into cooldown (no restart retries for 1h) — no restart loops.
3. Boot-side: if `intent.json` exists at startup, log "resuming from intended restart (reason)"; if the process starts with a *stale* intent (>10 min), flag it in the posture/telemetry as a possibly-failed handoff.
4. Systemd remains the process supervisor (external-supervisor mode is our default already); the sentinel adds verification, not lifecycle ownership.

**Steps.** (a) sentinel module `src/core/health/restart-sentinel.ts`; (b) boot wiring in `cli.ts` after channels-up; (c) updater script integration; (d) Kairos integration (depends on GW-3c landing first); (e) alert path.

**Tests.** Intent→ready lifecycle; stale-intent flag; watchdog timeout alert (mocked clock); Kairos cooldown after failed handoff.

### GW-10. Config-ambiguity rejection + flag lint at boot — **S**

**Problem.** 590 `SUDO_*` flags, 6 ghosts set in prod that no code reads, and contradictory combos boot silently. OpenClaw refuses to boot on ambiguous auth config.

**Design.**
1. Build-time flag manifest: a script (`scripts/gen-flag-manifest.ts`, run in CI + committed output `src/core/config/flag-manifest.json`) greps src for `SUDO_[A-Z0-9_]+` and records the known set. Boot: any env `SUDO_*` not in the manifest → prominent WARN "ghost flag (no code reads this)". Warn, don't die — operators set flags ahead of deploys.
2. Contradiction table (shared with GW-7's `flags.contradiction` check), initial entries — each REFUSES BOOT unless `SUDO_ALLOW_CONTRADICTORY_CONFIG=1` (itself posture-registered):
   - `SUDO_GATEWAY_UNIFIED_AUTH=0` while `GATEWAY_TOKEN` set (until GW-3a deletes the branch)
   - `SUDO_SANDBOX_DISABLE=1` while any of {WEBHOOKS_ENABLED, EMAIL_IMAP creds, WHATSAPP enable, dmPolicy open/pairing} active
   - `SUDO_SECRETS_REF=1` while a `_REF` var points to a nonexistent file
   - `WEB_CHAT_ENABLED=true` without `WEB_CHAT_TOKEN` on non-loopback bind
3. Auth ambiguity: if both GATEWAY_TOKEN and GATEWAY_SECRET set with different values and no explicit precedence flag, WARN with the documented precedence (don't refuse — both map to admin today; just make precedence explicit in docs).

**Tests.** Manifest generation catches a planted flag; ghost warn fires; each contradiction row refuses boot; override flag allows + posture-registers.

### GW-15. Durable outbound delivery queue — **M**

**Problem.** The #751 incident (empty-reply → Telegram 400s → total silence) and IMAP starvation show outbound is SUDO's fragile half. `channel-outbox.ts` queues offline messages but has no ack/claim semantics and no distinction between "failed before the platform saw it" (safe to retry) and "platform may have sent it" (retry = duplicate message to a human).

**Design (OpenClaw's `delivery-queue` model, scoped down).**
1. SQLite table (in the existing channels DB or a new `data/outbox.db`): `deliveries(id, channel, account, peer, payloadRef, state, attempt, lastError, claimedBy, claimedAt, createdAt)`. States: `pending → claimed → dispatched → acked | failed-presend | failed-postsend | unknown`.
2. Send path: enqueue → claim (single-claimant; a claim older than 60s without progress is reclaimable) → mark `dispatched` immediately BEFORE the platform call → on success `acked`; on error, classify: connection/4xx-before-send → `failed-presend` (retryable with backoff, max 5 attempts); error after bytes hit the platform or ambiguous timeout → `unknown` (NOT auto-retried; surfaced on telemetry for the reconciler).
3. Boot recovery: drain `pending` + reclaim stale `claimed`; `unknown` entries older than 24h → alert + drop (never silent).
4. Media payloads referenced by path (spooled to `data/outbox-media/` until acked) so a crash can't orphan an attachment mid-send.
5. Wire Telegram first (it has throttling + the incident history), keep the interface generic; the `normalizeReplyText` guard from #751 stays — this is the layer *below* it.

**Tests.** Crash-mid-send simulation (kill between dispatched and ack → boot reclaims, does NOT double-send when state=dispatched/unknown); presend failure retries with backoff; 5-attempt cap; media spool cleanup on ack.

---

## P2 — strategic / larger

### GW-11. Session lanes + global concurrency lanes for agent runs — **L**

**Problem.** `policy.ts` priority lanes govern *LLM calls*; nothing caps concurrent *agent runs*. Background work (dream engine, cognitive stream, standing orders, cron) each self-throttle ad hoc. OpenClaw: per-session lane guarantees one active run per session; named global lanes cap parallelism by class (`main` 4, `subagent` 8, unconfigured 1).

**Design.**
1. New module `src/core/agent/run-lanes.ts`: `acquireRunSlot(sessionKey, lane)` → releases on run end. Per-session mutex (one active run per session — the steer buffer from GW-5 handles mid-run arrivals) + global counting semaphores per lane: `user` (default 4), `subagent` (4), `background` (2), `cron` (1). Env-tunable `SUDO_RUN_LANES="user=4,background=2,…"`.
2. Admission point: wherever agent turns are scheduled (gateway-turn-handler, router dispatch, cron/standing-orders/heartbeat runners, sessions.send pipeline) — acquire before the turn starts; background lanes queue FIFO with a cap (default 50, overflow → drop oldest + telemetry count); user lane never drops, only queues.
3. Retire per-feature throttles that become redundant (cognitive-stream cadence stays — it's about LLM burn, not run concurrency).
4. Suspension hook: a `drainAndSuspend()` for restarts (pairs with GW-9): stop admitting, wait for active runs (timeout 60s), then hand off.

**Tests.** One-run-per-session enforced; lane caps honored under fan-out; user queues never drop; overflow accounting; drain semantics.

### GW-12. CI architecture ratchets — **S**

**Problem.** `loop.ts` hit 183KB before F103 intervened manually; 179 stub markers; wire-or-delete debt recurs. OpenClaw prevents this mechanically: max-lines ratchet, import-cycle bans, dead-code (knip), duplicate-code (jscpd).

**Design.** Add to CI (and `pnpm` scripts) — all RATCHETS, seeded at current values so day one is green:
1. `scripts/check-max-lines.ts`: per-file line counts vs committed baseline `scripts/max-lines-baseline.json`; any file GROWING past its baseline+10% fails; shrinking auto-tightens the baseline (script rewrites it, committed with the PR).
2. `madge --circular src/` (or `dpdm`) — fail on NEW cycles vs a committed allowlist of existing ones.
3. `knip` for dead exports — report-only for the first release (the 179 stubs will scream), then enforce on the delta.
4. Extend the existing hot-path test pattern (`tests/gdrive/hot-path.test.ts`) into a generic import-ban table: agent/llm/memory/brain must not import gdrive/notebooklm (existing), channels must not import llm transport directly, etc.

**Tests.** The checks ARE tests; verify each fails on a planted violation in a fixture.

### GW-13. Scenario e2e journeys in Docker — **L** (incremental; MVP = first journey)

**Problem.** 176+ unit/integration tests but whole categories at 0 (meta/, channels/web — Wave H), and the worst prod bugs were journey-shaped (#751 silence, IMAP starvation, session fork loop). OpenClaw runs ~80 Docker e2e scenarios including upgrade-survivor and corrupt-plugin journeys.

**Design.** A `tests/journeys/` harness: docker-compose file that boots the daemon with a mock LLM transport (`LLM_BASE_URL` pointed at a local stub server serving canned IR responses — the IR layer makes this clean) and mock channel endpoints. Three journeys, in order:
1. **restart-survivor** (pairs with GW-9): boot → send message → restart mid-idle → sentinel handoff verified → queued message delivered post-restart.
2. **telegram-failover**: inbound update (mocked Bot API server) → primary LLM route 500s → chain fails over (GW-2) → reply delivered → outbox acked (GW-15).
3. **webhook-untrusted-sandbox**: signed webhook → untrusted turn → assert Docker-tier sandbox chosen and egress-allowlist enforced (assert via sandbox audit log, not by escaping).
Each journey asserts on observable artifacts (gateway.db rows, outbox states, audit logs) — not internals. CI: nightly, not per-PR (runtime).

**Tests.** The journeys are the tests. MVP acceptance = journey 1 green in CI.

### GW-14. Deliberate non-adoption record — **S** (docs only)

Write `docs/OPENCLAW_NON_ADOPTION.md` recording, with one-paragraph rationale each, what SUDO will NOT copy from OpenClaw and why: sandbox-off default; agent-holds-operator-authority (`security="full"`); cross-agent OAuth token read-through; 45-channel/157-extension surface sprawl; multi-tenant-in-one-process hosting; ACP pluggable agent runtimes (orthogonal to single-brain architecture); device-node pairing (no companion apps today). Purpose: stop future sessions from re-proposing these; link from CORE_ROADMAP.

---

## Sequencing & delivery

Work in this order (each item = one PR unless trivially separable; GW-3's three sub-items may share one PR):

1. **Wave 1 (P0 risk-close):** GW-1, GW-2, GW-3, GW-10, GW-12 (cheap, add early so later waves inherit the ratchets), GW-14 (trivial).
2. **Wave 2 (protocol + ops):** GW-8, GW-15, GW-7, GW-4.
3. **Wave 3 (UX/architecture):** GW-9, GW-6, GW-5, GW-11.
4. **Wave 4:** GW-13 journey 1, then 2-3.

Dependencies: GW-9 needs GW-3c; GW-5 and GW-11 interlock (one-run-per-session assumes steering exists for mid-run arrivals — land GW-5 first or land GW-11's session-mutex with followup-only semantics and upgrade); GW-13 journeys 1-2 need GW-9/GW-2/GW-15.

Definition of done per item: code + tests green (`pnpm build` + targeted vitest), docs updated, no new posture-weakening defaults, PR description lists any default changes, and the item's own test list from this spec is implemented.
