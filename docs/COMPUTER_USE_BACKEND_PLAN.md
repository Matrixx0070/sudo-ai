# Computer Use Backend — Research Findings, Future-State Architecture, Implementation Plan

**Date:** 2026-08-17 · **Status:** ALL PHASES 0–5 IMPLEMENTED + LIVE-PROVEN ON LINUX/X11 (branch `feat/computer-use-backend`)
**Method:** 105-agent deep-research workflow (fan-out search → fetch → 3-vote adversarial claim verification; 22 confirmed / 3 refuted claims) + 3 targeted gap-fill research passes + full codebase capability map of `/root/sudo-ai-v4`. Vendor docs verified live 2026-08-17.

---

## Implementation Status (2026-08-17)

Built in `src/core/tools/builtin/computer-use/` (engine in `core/`, agent tools at the top level), 6 commits, 64 dedicated tests green, esbuild + max-lines + flag-manifest all pass.

| Phase | Delivered | Live proof (real execution) |
|---|---|---|
| 0 Consolidate | Single `computer.*` family (screenshot/perceive/click/type/key/scroll/window/session/run_plan) on the `IComputerUse`/`IComputerDriver` path; old `computer.use` retired; authority + approval-matrix + `SUDO_COMPUTER_USE_DISABLE` kill-switch; argv `--` hardening | 112KB PNG from `:10`, 7 windows, gated-mode click refused |
| 1 Perception + verified executor | `PerceptionService` (screenshot+AT-SPI2+windows, sha256 diff, zoom), `GroundingResolver`, `ActionExecutor` (expectation-verified, 5-rung recovery ladder), ephemeral Xvfb `SessionManager`, `ActionJournal` | Isolated `:106`: AX live (8 GTK elements), 3-step loop ok, ladder→escalate, journal written |
| 2 Long-horizon + skills | `computer.session` + `computer.run_plan`, durable resumable `PlanRunStore`, `SkillStore` (induce/reuse), owner-DM-guarded `ViewportStreamer` | `:105`: durable run→done, resume, skill induced + reused (`usedSkill=true`) |
| 3 Hybrid + speed | Structured AT-SPI action path (no pixel click), speculative `runBatch` (checkpoint-verify + abort), snapshot cache | `:103`: File menu via AX action (`structured=true`); batch **67% faster** (1828→604ms) |
| 4 Driver boundary | `IComputerDriver` + `createDriver`/`detectPlatform`; **LinuxX11Driver** (reference), **LinuxWaylandDriver** (grim/ydotool/wlrctl/AT-SPI), **WindowsDriver** (PowerShell/System.Drawing/SendInput/UIA), **MacDriver** (screencapture/osascript/AXAPI skeleton); core runs unchanged through any driver | `:108`: full stack through X11 driver (perceive+verified+structured+batch), no regression; MockDriver contract test drives the executor end-to-end |
| 5 Advanced | PRM `scoreTrajectory`, `runBestOfN` (multi-session fan-out + judge), `PlanRunStore.checkpoint/restore`, MCP export (existing loopback), AppleScript-escape hardening | 3 REAL parallel sessions (`:102/:112/:122`) scored+judged, 2767ms wall |

### Honest scope limits (NOT live-proven here)
- **Windows / Wayland / macOS drivers** are complete implementations against the documented platform APIs but were NOT executed on this X11 host (no Windows VM / Wayland compositor / Mac). They pass capability-contract tests; they need real hardware to live-prove. The core is proven platform-agnostic via the MockDriver contract test.
- **Environment forking** is execution-state checkpoint/rollback (`PlanRunStore`), NOT pixel-level live-GUI forking (that needs TClone-class infrastructure).
- **Vision grounder** is a wired hook (`VisionGrounder`) with AX/coords as the live path; a real grounder-model call is the next increment.

### macOS TCC flow (for when a Mac host is available)
The Mac driver needs two TCC grants attached to the process that runs sudo-ai: **Accessibility** (input synthesis + AXAPI) and **Screen Recording** (screencapture/ScreenCaptureKit). Grants attach to the responsible bundle id, so AX/capture calls must run in-process (not via a helper with a different bundle id). Pointer control needs a CGEvent helper or `cliclick` (declared unsupported until added). First run prompts for both grants; re-approval nags recur on OS upgrades.

### MCP export
No new code: the existing MCP loopback (`gateway/mcp-server.ts`) exposes read-only tools by default, so `computer.perceive` and `computer.screenshot` are reachable out of the box; the mutating `computer.*` tools are opt-in via `SUDO_MCP_EXPOSE_TOOLS`.

---

## Part I — Research Findings

### 1. Where computer-use agents are today (Aug 2026)

- **The universal architecture** is a screenshot-in / coordinate-action-out loop: the model emits pixel-coordinate UI actions (click/type/scroll/zoom), a **client-side harness** executes them, screenshots feed back. All three frontier vendors (Anthropic `computer_20251124` with zoom; OpenAI batched `actions[]` in mainline GPT-5.x after deprecating CUA; Google computer use native in Gemini 3.5 Flash after shutting Project Mariner 2026-05-04) ship **only the model — the harness, input injection, sandboxing, and OS abstraction are the integrator's problem**. [verified 3-0 against live vendor docs]
- **Short-horizon GUI control is near-solved**: OSWorld-Verified (1.0) leaders are at **85–86%** (Qwen3.8 Max 86.1%, Claude Mythos/Fable 5 ~85%, Opus 4.8 83.4%) — above the 72.4% human reference. Online-Mind2Web is saturated (Browser Use Cloud 97.0%).
- **Long-horizon work is wide open**: OSWorld 2.0 (released 2026-06-26, stable 2026-08-08; 108 real workflows, ~318 tool calls/task, median 1.6h human time) drops the best system (Claude Opus 4.8, max thinking, batched calls) to **20.6% binary / 54.8% partial**, collapsing to ~0% on tasks >163 min. XLANG's own failure analysis: the bottleneck is **not GUI control — it's constraint tracking, mid-task requirement changes, and hidden-state recovery**.
- **Grounding trend** (ScreenSpot-Pro, professional hi-res UIs, updated 2026-08-13): SeeClick 1.1% → Aria-UI 11.3% → UI-TARS-1.5 61.6% → 2026 specialist grounders 70–83%. **Zoom-in / agentic inference adds +3–10 points** — validating region-zoom pipelines (Anthropic's `zoom` action).
- **Perception is going hybrid**: accessibility trees (AT-SPI2/UIA/AXAPI) + DOM/CDP + screenshots, not any single modality. DOM/AX-driven browser agents are ~12–17 points more reliable and 10–20× cheaper on ordinary tasks; vision wins on canvas/anti-bot. Production consensus: **AX/DOM for ~90% of steps, vision fallback**. Browser Use and Stagehand v3 both **dropped Playwright for raw CDP** in 2026.
- **Security posture converged**: sandbox isolation, HITL confirmation for high-impact actions, on-screen content treated as untrusted prompt-injection surface, Anthropic runs **default-on injection classifiers on screenshots**.

### 2. What the leading systems can do

| System | Capability (verified) |
|---|---|
| Claude (computer_20251124) | GA computer use; zoom action for hi-DPI regions; leads OSWorld-2 (20.6%) via long thinking + batched tool calls; ~244K output tokens/task |
| OpenAI GPT-5.4/5.5/5.6 | CUA folded into mainline; batched `actions[]`; **code-execution harness** — model trained to mix scripts with GUI actions; 75–78.7% OSWorld-V (self-reported) |
| Gemini 3.5/3.6 Flash | Native computer use, one action vocabulary across browser/desktop/mobile; best latency tier (~225s at 70%+ OM2W); 83% OSWorld-V |
| Microsoft UFO²/³ "AgentOS" | HostAgent → per-app AppAgents; **hybrid GUI+API action layer** (UIA/Win32/COM first, clicks fallback); speculative multi-action batches validated against live UIA; Picture-in-Picture isolated desktop; Copilot Studio computer use **GA 2026-05-13** |
| Agent S3 (Simular) | Flattened hierarchy + **Behavior Best-of-N**: N parallel rollouts → behavior narratives → judge picks; 65.6%→69.9% OSWorld |
| UI-TARS-2 (ByteDance) | Native multi-turn RL + data flywheel + hybrid GUI/filesystem/terminal env + rollout sandbox platform; open crown since passed to Qwen/Holo3 |
| Browser Use / Stagehand | CDP-direct hybrid DOM+vision; 97% OM2W (system-level) |

### 3. Major architectural limitations of today's systems

1. **Long-horizon state**: context compression drift, untyped memory, constraint loss across hundreds of steps → the 20.6% OSWorld-2 ceiling.
2. **Hidden-state blindness**: no world model of what changed off-screen; recovery after environment shifts is the top failure class.
3. **Grounding-induced loops**: one OSWorld analysis found **66% of steps wasted in loops caused by grounding errors**; doom-loop detection is bolt-on, not architectural.
4. **Latency**: agents take **2.7–4.3× more steps than humans** (OSWorld-Human); late steps ~3× slower than early ones (context growth); planner/judge calls dominate.
5. **Silent failure**: unflagged degradation is the core production risk (arXiv 2606.08162); most harnesses have no expectation-vs-observation check per action.
6. **Rollback is fake**: "return to last subgoal" rather than state restore (exception: TClone's live GUI environment forking).
7. **Harness fragmentation**: every integrator rebuilds screenshot/injection/lifecycle; benchmark scores are heavily harness-dependent and often self-reported.
8. **Platform permission mazes**: Wayland portals/PipeWire, macOS TCC, Windows UIPI — most stacks ignore them and stay X11-only.

### 4. What "one year ahead" means (composite of every leader's edge, aimed at OSWorld-2-class failure modes)

1. **Durable typed mission state, segmented execution** — fresh context per segment fed from a state ledger, not one long transcript (this is what beats the 500-step collapse; nobody ships it well yet).
2. **API-first, GUI-fallback hybrid action layer** (UFO² + OpenAI code-harness direction): try native API/CLI/DOM/AX pattern invocation, click pixels only when there's no structured path.
3. **Verification as the default serving mode**: per-action expectation-vs-observation diffs, trajectory critics, process-reward-style judging of parallel rollouts (Agent S3 bBoN moving from eval trick to runtime).
4. **Executable skill memory**: verified, runnable macros induced from successful trajectories (AWM/Voyager-for-GUIs lineage) — not raw screenshot replay, which fails (arXiv 2606.14106).
5. **Two-tier model routing**: small/fast grounder + zoom pipeline for perception; big planner only at segment boundaries and recoveries.
6. **Speculative batched actions** validated against live accessibility state before commit.
7. **Background operation without stealing the user's session** (the 2026 differentiator: overlay cursors, ephemeral virtual desktops, PiP, `CGEventPostToPid`, PostMessage+WGC).
8. **Injection defense + HITL gating built-in**: screenshot content is untrusted input; consequential actions confirm; credentials never transit the model.
9. **Environment forking readiness** for cheap best-of-N and true rollback.

**SUDO AI's unfair advantage:** items 1, 3, and the gating in 8 already exist as production subsystems (missions/objectives, verify-gates/stuck-detector/doom-loop, execution-authority/approval-matrix). The field's hardest gap — long-horizon durable state — is the thing SUDO AI already does. The backend's job is to bolt world-class perception/action onto that spine.

---

## Part II — Future-State Architecture

### 5–6. Implement now vs design-in

**Implement now (Phases 0–3):** consolidation onto one abstraction; Linux hybrid perception (screenshot + AT-SPI2 + CDP) with zoom; verified action executor (act → observe → diff → verify → recovery ladder); ephemeral virtual-desktop sessions (Xvfb) so agent work stops colliding with Frank's :10 desktop; mission-integrated long-horizon driving; skill/macro memory; two-tier routing + action batching.

**Design into the architecture now, build later (Phases 4–5):** Windows (UIA driver) and macOS (AXAPI/CGEvent/TCC) adapters behind the same driver interface; Wayland (portal/libei) driver; environment forking + best-of-N with judge; PRM-guided search; multi-VM fan-out; MCP-exported computer-use surface; RL-environment/replay export for future training.

### 7. Backend architecture

```
┌────────────────────────── SUDO AI agent (unchanged) ──────────────────────────┐
│  loop.ts · missions/objectives · verify-gates · execution-authority · brain   │
└──────────────┬────────────────────────────────────────────────────────────────┘
               │ ToolDefinitions (computer.* family)  +  mission driver
┌──────────────▼──────────────── Computer Use Core ─────────────────────────────┐
│ PerceptionService   — fused Snapshot{screenshot, ax-tree, dom?, ocr?, windows}│
│                       + GroundingResolver (target→coords: AX/DOM first,       │
│                       vision+zoom fallback) + snapshot cache/diff              │
│ ActionExecutor      — typed ActionPlan (batch), per-action expectation,       │
│                       post-act observation diff, retry ladder                  │
│ SessionManager      — desktops as sessions: attach(:10 owner desktop, guarded)│
│                       | ephemeral Xvfb desktop | remote/VM (future fork)      │
│ SkillStore          — verified executable macros + app knowledge (memory API) │
│ Journal/Telemetry   — every action + screenshot hash + verdict; WS tee;       │
│                       owner-DM viewport streaming                              │
└──────────────┬────────────────────────────────────────────────────────────────┘
               │ IComputerDriver (per-platform)
┌──────────────▼────────────────────────────────────────────────────────────────┐
│ LinuxX11Driver (XTest/xdotool, scrot/maim, AT-SPI2, EWMH/wmctrl)   [Phase 1] │
│ CdpBrowserDriver (existing browser stack, raw CDP, DOM+AX)         [Phase 1] │
│ LinuxWaylandDriver (RemoteDesktop portal + libei, ScreenCast/PipeWire,        │
│                     ydotool fallback)                              [Phase 4] │
│ WindowsDriver (UIA patterns → PostMessage → SendInput; WGC capture;           │
│                DPI/UIPI handling)                                  [Phase 4] │
│ MacDriver (AXAPI, CGEventPostToPid, ScreenCaptureKit, TCC broker)  [Phase 5] │
└───────────────────────────────────────────────────────────────────────────────┘
```

Key contracts:
- **`Snapshot`** — one typed observation: screenshot (+ region zooms), flattened AX elements with stable indices, DOM/AX for browser targets, focused window, timestamp, content hash. Cheap to diff.
- **`ActionPlan`** — batch of typed actions, each with `target` (element ref | coords | text), `expectation` (predicate on next Snapshot), `risk` (feeds execution-authority), `reversible` flag. Executor commits batch items until an expectation fails.
- **`IComputerDriver`** — `capture()`, `axTree()`, `inject(action)`, `windows()`, `sessionLifecycle()`. Everything above the driver line is platform-independent.
- **Recovery ladder** (in order): re-ground same target → zoom + re-ground → re-plan step → restart subgoal → mission escalation (classified, via existing objective machinery) → owner hand-off with viewport frame.

### 8. Integration with SUDO AI (no agent rewrite)

The codebase already contains the seams; this is consolidation, not construction:

1. **Consolidate** the two existing partial implementations (`src/core/tools/builtin/browser/computer-use*.ts` registered xdotool tool; unregistered `src/core/tools/builtin/computer-use/cross-platform/` `IComputerUse` factory) onto the cross-platform abstraction — per doctrine, no third parallel path.
2. **Register** via `src/core/tools/builtin/computer-use/index.ts` exporting `registerComputerUseTools(registry)`; add `computer` to `ToolCategory` (`src/core/tools/types.ts:19`); loader auto-discovers.
3. **Authority**: every mutating action calls `authorize({surface:'agent-tool', ownerVerified: ctx.isOwner, …})` (`security/execution-authority.ts`); GOD MODE/containment semantics inherited unchanged; `computer.*` tiers registered in `autonomy/approval-matrix.ts`; kill-switch env flag in the flag manifest.
4. **Perception loopback**: screenshots → `browser/vision.ts` Brain image blocks (already exists); screenshots out → `ToolResult.data` + `MediaAttachment{type:'image'}`; live feed → the `browser-viewport.ts` owner-DM-guarded photo-bubble pattern, copied exactly (frames only to OWNER in DM).
5. **Long-horizon**: computer-use workflows run as `meta.mission` / objectives segments; act→observe→verify wired through `verify-gate*.ts`, `stuck-detector.ts`, `doom-loop.ts`; outcomes feed `tool-outcome-learner`.
6. **Sandbox**: bwrap policy variant that binds `/tmp/.X11-unix` + `DISPLAY` for GUI sessions (pattern already sketched in `cross-platform/linux.ts`); ephemeral Xvfb desktops keep agent GUI work off Frank's :10; the existing window guard protects :10 when attached.
7. **Skills**: macro induction/retrieval through the existing memory API (`src/core/memory/`), not a new store.

### 9. Per-OS implementation

- **Linux (first-class, this host):** X11 path — XTest via xdotool (apps accept XTest as legitimate; XSendEvent fallback only), scrot/maim capture, AT-SPI2 tree over D-Bus (flip `org.a11y.Status` at startup so Chromium et al. build trees retroactively), EWMH window mgmt. Ephemeral Xvfb desktops per session. Wayland (Phase 4): RemoteDesktop portal + libei for input, ScreenCast/PipeWire capture, ydotool/uinput as coordinate-blind fallback; compositor-aware window registry (GNOME extension / KWin scripting / hyprctl). Reference: `agent-sh/computer-use-linux`.
- **Windows (Phase 4):** UIA patterns (Invoke/Toggle/Value…) → PostMessage for background delivery (Chromium ignores it — fall through) → SendInput last resort; UIA tree walks with cache requests (Chrome/Electron cost); Windows.Graphics.Capture (works occluded); crop DWM shadow bounds; per-monitor DPI contexts; UIPI blocks elevated windows. UFO²'s hybrid GUI+API layer is the design template.
- **macOS (Phase 5):** AXUIElement tree (element-level ≈10× faster than screenshot loops), CGEvent injection (`CGEventPostToPid` for background, no focus steal), ScreenCaptureKit capture; TCC broker — Accessibility + Screen Recording grants attach to the bundle ID, so all AX/capture calls route in-process; lume-style Virtualization.framework VMs for disposable desktops.
- **Unification:** the industry pattern (trycua Computer Server, E2B, UFO²) is an in-VM/host daemon exposing a uniform control plane; our `IComputerDriver` is that boundary, in-process first, daemon-able later.

### 10. The closed loop

```
SEGMENT START (mission state → fresh context)
 → PERCEIVE   Snapshot (AX+DOM+screenshot; zoom on demand; diff vs cache)
 → GROUND     target → element ref (AX/DOM) else vision+zoom → coords
 → PLAN       ActionPlan batch w/ per-action expectations + risk tags
 → GATE       execution-authority + approval matrix (confirm consequential)
 → ACT        inject batch, stop at first failed expectation
 → VERIFY     observation diff vs expectation; verify-gate/critic on subgoal
 → RECOVER    ladder: reground → zoom → replan → subgoal restart → escalate
 → PERSIST    journal + mission-state update + skill induction on success
 → repeat / SEGMENT END (criteria check via objective store)
```

### 11. Engineering qualities from day one

- **Reliability:** per-action expectations (no silent failure); typed retry ladder; stuck/doom-loop detectors already in repo; criteria-driven completion via objectives.
- **Observability:** append-only action journal (action, screenshot hash, verdict, latency); WS tee to Control UI; owner viewport streaming; doctor checks (session leaks, display health).
- **Testing:** unit (drivers mocked); **replay tests** from recorded journals; live E2E via the real Telegram→bot lane on :10 (mandatory per directives — never ask Frank to verify); a 10–20-task OSWorld-style local benchmark subset as regression gate.
- **Security:** owner-only by default (channel owner matrix), fail-closed for cron/webhook/MCP; screenshots treated as untrusted input — injection heuristics before feeding to Brain; credentials via takeover/manual mode, never through the model; ephemeral desktops sandboxed (bwrap + X socket bind); every mutating action through `authorize()`; kill-switch flag.
- **Performance:** AX-first stepping (10–20× cheaper than vision); snapshot cache + diffing; batched actions; small-grounder/big-planner routing; zoom instead of full-res re-screenshot.
- **Extensibility:** all platform variance below `IComputerDriver`; skills/macros as data; optional MCP export of the tool family later.

### 12. Phased roadmap

| Phase | Scope | Depends on | Acceptance criteria |
|---|---|---|---|
| **0. Consolidate** (1 slice) | Merge `browser/computer-use*` + `cross-platform/` onto `IComputerUse`; register `computer.*` tools; authority/approval/flag wiring; kill-switch | — | Loader registers family; old paths deleted; suite green; live: DM "take a screenshot" round-trips via Telegram |
| **1. Linux perception+action v1** (2–3 slices) | Snapshot (screenshot+AT-SPI2+window), GroundingResolver w/ zoom, ActionExecutor w/ expectations + retry ladder, ephemeral Xvfb sessions, journal | 0 | Live-proven: multi-step GUI task (open app → fill form → verify) on an ephemeral desktop, zero owner-desktop interference; every action journaled with verdict; grounding fallback demonstrably fires |
| **2. Long-horizon integration** (2 slices) | Mission/objective driving, verify-gate/critic wiring, skill induction + retrieval via memory API, owner viewport streaming | 1 | A 50+-step real workflow completes across a restart (state survives); induced skill reused on 2nd run with measurably fewer steps; frames stream to owner DM only |
| **3. Hybrid action + speed** (2 slices) | API/CLI/CDP-first routing with GUI fallback; action batching; snapshot cache/diff; small-grounder routing hook | 1 | ≥50% of steps on a mixed task resolved without vision round-trip; wall-clock ↓ ≥30% vs Phase 1 baseline on same task; batch aborts correctly on failed expectation (test-proven) |
| **4. Windows + Wayland drivers** (3 slices) | `WindowsDriver` (UIA→PostMessage→SendInput, WGC), `LinuxWaylandDriver` (portal+libei) | 1 | Same Phase-1 acceptance task passes on a Windows VM and a Wayland session via unchanged core; conformance test suite per driver |
| **5. Advanced** (as demanded) | macOS driver; env forking + best-of-N w/ judge; PRM-style step scoring; multi-session fan-out; MCP export | 2,3 | Best-of-N measurably lifts success on a hard task set; forked-session rollback restores state; macOS TCC flow documented + live-proven |

Slices follow the standing style: bounded, default-OFF flag-gated, PR-per-slice, adversarial review on risky changes, live-proven through the real Telegram lane before "done".

---

## Sources (principal)

Vendor: Anthropic computer-use tool docs · OpenAI computer-use guide · Google Gemini computer-use announcements (all fetched 2026-08-17). Benchmarks: osworld-v2.xlang.ai · benchlm.ai (OSWorld-Verified) · gui-agent.github.io grounding leaderboard · steel.dev leaderboards · epoch.ai. Papers: OSWorld-2 (2606.29537) · UI-TARS-2 (2509.02544) · Agent S2/S3 (2504.00906, 2510.02250) · UFO² (2504.14603) · OSWorld-Human (2506.16042) · GUI-Shepherd (2509.23738) · WebDreamer (2411.06559) · TClone (2605.17320) · AWM (OpenReview NTAhi2JEEE) · GUI-agent survey (2412.13501). Practitioner: cua.ai Linux/Windows internals · agent-sh/computer-use-linux · trycua/cua · e2b-dev/desktop · Operator system card · fazm.ai macOS notes.

**Confidence notes:** OSWorld-2 20.6% and OSWorld-V 85–86% figures are leaderboard/aggregator-sourced (partly self-reported); three claims were refuted in verification and are excluded (Gemini desktop-scope limitation; exact ScreenSpot-Pro top-3; specific frontier-chat-model grounding scores). WindowsAgentArena is stale (no 2026 leaderboard). UNVERIFIED single-source: macOS 26 CGEvent keyboard block.
