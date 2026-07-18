# OpenClaw Control UI — Deep Crawl Report

Date: 2026-07-18 · Gateway: http://127.0.0.1:18789 (sandbox install, HOME=/tmp/openclaw-home) · Version: 2026.7.1-2 · Chrome via CDP :9222.
83 screenshots in this directory (`deep-NN-*.png`). Every claim below was exercised live in this session.

---

## 1. /chat (deep-01 … deep-12)

| Control | Result |
|---|---|
| Suggestion chips ("What can you do?" etc.) | Only shown on empty sessions. Clicked "What can you do?" in a fresh session → model turn ran, reply rendered with inline "Reasoning:" prefix (deep-12). Session was auto-titled "Understanding Assistant Abilities". |
| Chat settings gear | Popover with: Refresh, Auto-scroll mode (Near bottom), Thinking toggle, Tools toggle, Commentary toggle, History (Show cron sessions), Send shortcut (Enter / ⌘-Ctrl+Enter), and a full Voice section (voice picker: Alloy/Ash/Ballad/Coral/Echo/Sage/Shimmer/Verse/Marin/Cedar; model; sensitivity; microphone picker — "No additional microphones found"), plus "More in Settings" (deep-02). |
| Model/thinking chip | Popover: Provider list has only **Xai** with one model `grok-4.3`; Reasoning slider (Default Low), Speed group Default/Fast/Standard/Auto, footer Use default model / Discard / Save (deep-03). Discarded — no persist. |
| Split view | "Open split view" duplicates the chat into two panes, each with a Pane session combobox + Split down / Split right / Close pane (deep-04). Close pane returns to single view. |
| Session workspace panel | Expand button on the right opens a file browser of `/tmp/openclaw-home/.openclaw/workspace`: summary chips (0 changed / 0 read / 0 artifacts / 9 shown), searchbox, per-file Preview + Copy path (AGENTS.md, BOOTSTRAP.md, HEARTBEAT.md, IDENTITY.md, SOUL.md, TOOLS.md, USER.md, openclaw-workspace-state.json, .git) (deep-05). Collapse works. |
| Attachment button | Opens a 3-item menu: Take photo / Photo / File (deep-06). Escaped without selecting. |
| Voice input | Clicking mic shows an inline error: **`Error: Realtime voice provider "openai" is not configured`** with a Dismiss button (deep-07). Fails gracefully; no crash. |
| "/" command menu | Typing "/" opens a "Slash commands" listbox with ~44 commands (deep-08): /stop /reset /new /compact /name /clear /think /model /verbose /fast /reasoning /models /help /status /crestodian /export-session /export-trajectory /tools /skill /learn /goal /diagnostics /login /tasks /context /btw /tts /usage /canvas /clawhub /diagram_maker /gemini /gh_issues /github /healthcheck /meme_maker /node_connect /node_inspect_debugger /notion /python_debugpy /session_logs /skill_creator /spike /taskflow /taskflow_inbox_triage /tmux /video_frames /weather /pair /dreaming /phone /voice /subagents /agents /steer. |
| New chat in worktree | **Surprising: appears to be a no-op for worktrees.** Clicking the button did not change the URL or create a worktree session; the subsequent "hi" message went into the plain dashboard session created by "New session" (deep-11), and /settings/worktrees later showed **"No managed worktrees."** The reply ("Hey.") arrived normally. |
| Session pin | Pin button moves the session into a new "Pinned" sidebar group with an Unpin button (deep-09). Unpin restores. |
| Session menu | Actions for Main Session: Pin session, Mark as unread, Rename…, Fork, Move to group, **Archive session (disabled)**, **Delete… (disabled)** — main session is protected from archive/delete (deep-10). |
| New session button | Immediately creates + navigates to a fresh `agent:main:dashboard:<uuid>` session (no dialog). |

## 2. /overview (deep-13 … deep-16)

- **Stat tiles** (all navigate): Cost → /usage, Sessions → /sessions, Skills (53/53) → /skills, Cron (0 jobs) → /cron. Verified each click landed on the right page.
- **Connect card**: token and password reveal toggles both work — deep-14 shows the gateway token revealed in plaintext; re-hidden afterwards. "Connect" button re-runs the connection (deep-16). Refresh button works.
- **Event Log / Gateway Logs expanders**: both expand (deep-15, full-page). Gateway Logs renders raw structured-JSON log lines (subsystem gateway/ws req/res entries) — readable but noisy.
- **New session**: sidebar button (same behavior as on /chat).
- Transient quirk: an overlay with "Try again / Keep waiting" buttons appeared briefly during slow health-check loads, then disappeared on its own (seen twice; not reproducible on demand).

## 3. /activity (deep-17, deep-18)

- Page is "Browser-local tool activity summaries" and was **empty** (0 of 0) — WS tool events from other clients don't populate it.
- Exercised: Search box (typed "exec"), Tool combobox (only "All tools"), status checkboxes Running/Done/Error (toggled Running off/on), Auto-follow checkbox.
- **Expand all / Collapse all / Clear are disabled** while the list is empty, so they could not be exercised — expected behavior, noted as such.

## 4. /instances (deep-19, deep-20)

- Lists two presence beacons: gateway `srv1474168` (IP 187.77.146.214, linux 6.8.0-90-generic, 2026.7.1-2) and `openclaw-control-ui` (webchat dev, operator, 5 scopes).
- **Toggle host visibility** hides host/IP details (deep-20); toggled back. **Refresh** works.

## 5. /sessions (deep-21 … deep-26)

- Table of 4-5 sessions with filter textbox, Updated-within (60 min), Limit (50), source checkboxes (Global/Unknown/Archived only), Group by (None/Custom groups/Channel/Kind/Agent/Date), sortable column headers, per-page selector (10/25/50/100), Previous/Next.
- **Session details** (inline expander) opened for `agent:main:main` (deep-22) and bench50 (deep-23): shows Label + Thinking/Fast/Verbose/Reasoning overrides, key, kind, tokens (22389/1000000), compaction count, checkpoints, model `grok-4.3`/xai, session ID, active-run/archived/pinned flags.
- **Fork on agent:main:explicit:bench50**: instantly created and navigated to a new session `agent:main:dashboard:4da70881…` containing the full copied history ("Showing last 30 messages (70 hidden)") (deep-24). Note the fork lands in a *dashboard*-kind session, not explicit.
- **Mark as unread** on the fork row: applied (unread badge) (deep-25).
- **Group by Kind** exercised (deep-26), reset to None. Column-header sort clicked.
- **Archive** on the fork copy: removed the row immediately **with no confirmation dialog** (4 rows remain). Main Session's archive button is disabled (protected) — Main Session untouched.
- **Previous/Next pagination**: both disabled at 1-4 of 4 rows (single page) — could not be exercised further.

## 6. /usage (deep-27 … deep-31)

- Exercised: **Cost** view toggle, **30d / 90d / All** ranges, **Historical lineage** vs Current instance, **By Type** vs Total chart mode, sort combobox (Cost/Errors/Messages/Recent/Tokens), **Descending↔Ascending** toggle, Time zone (Local/UTC) present, Refresh, Pin, per-session **Copy** buttons.
- **"July 18" day bar drill-in**: the day is a pressed-toggle bar (`aria-pressed`) — clicking selects/filters that day (deep-30). Tip text confirms: "use filters or click bars to refine days."
- **Filter (client-side)** button was disabled (no filter selection active) — could not exercise.
- Minor oddity: some header stat tooltips show "?" for Messages/Tool calls/Errors totals; calendar summary shows implausible tiny "$0.000041 / day" for the Jan-Jul window alongside $0.86 Today (per-day averaging over the whole window, arguably confusing).

## 7. /cron (deep-32 … deep-40)

- Header stats (Enabled: Yes, Jobs, Next wake), New Job, Refresh, Jobs list with Filters (Enabled/Disabled; At/Every/Cron; OK/Error/Skipped/Unknown; sort Next run/Recently updated/Name; Asc/Desc), Run history section with its own filters.
- **New Job wizard** (3 steps What/When/How, deep-33/34/35): prompt textarea + optional name; schedule presets (Every morning 8:00 / Every evening 18:00 / Hourly / Weekdays / Weekly / Run once) + Advanced; How step = Model picker + delivery radios (Notify me / Silent / Independent session).
- Created **test-noop** ("NOOP test", daily 8:00 → `Cron 0 8 * * *`, Silent) (deep-36).
- **Run**: executed immediately; job status OK; Run history gained 1 entry "· OK" (deep-37). The run also appears on /tasks as a completed Cron task.
- **More actions menu**: Run if due / Disable / Clone / History / Remove (deep-38). **Disable** worked (badge "disabled", menu flips to Enable, deep-39). **Remove** deleted the job instantly — **no confirmation dialog** (deep-40); list back to "No scheduled jobs yet."

## 8. /tasks (deep-41)

- "Background tasks: subagents, cron runs, CLI." Active: 0. Recent: 1 — the test-noop cron run (Completed · Cron · "NOOP test"). Refresh exercised (shows "Refreshing…" disabled state while loading).

## 9. /agents (deep-42 … deep-51)

- Header: agent combobox (single entry "main (default)"), **Copy ID** (clicked, copies agent id), Default (disabled), Refresh.
- Tabs: Overview / **Files 7** / Tools / Skills / Channels / Cron Jobs.
- **Files tab shows 7 buttons, not 8**: AGENTS, SOUL, TOOLS, IDENTITY, USER, HEARTBEAT, MEMORY(missing). **BOOTSTRAP has no button** even though BOOTSTRAP.md exists in the workspace (visible in the /chat workspace panel) — the expected 8th file is absent from this UI.
- Opened every file: AGENTS (full default content), SOUL, TOOLS, IDENTITY, USER, HEARTBEAT — each opens path + Preview/Reset/Save editor (deep-44).
- **MEMORY missing behavior**: opens an empty editor with note "This file is missing. Saving will create it in the agent workspace." (deep-46).
- **SOUL.md edit round-trip**: appended `<!-- webui edit test -->`, Save → verified **on disk** (`tail` showed the marker). Removed the line, Save → *first save click didn't persist* (raced with the pending save; file still had the marker), second Save click persisted; verified on disk marker count = 0. Minor bug: Save clicked while a save is in flight is silently dropped.
- **Tools tab** (deep-47): profile `coding`, 29/42 enabled, source global default; Enable All / Disable All / Reload Config / Save; Quick Presets Minimal/Coding/Messaging/Full/Inherit; live tool list for `agent:main:main`.
- **Skills tab** (deep-48): per-agent skill list. **Channels tab** (deep-49): Channels count 0 (no channels configured). **Cron Jobs tab** (deep-50): agent-scoped cron list. **Overview tab** (deep-51): Agent Context — workspace path, Primary Model xai/grok-4.3, runtime auto, Identity Name "Assistant", skills filter "all skills", plus Core Files quick-open buttons.

## 10. /skills (deep-52 … deep-58)

- Readiness filters all exercised: **All 53 / Ready 21 / Needs Setup 32 / Disabled 0** (deep-52…55).
- Groups: **Built-in Skills 51** (expanded by default) and **Extra Skills 2** (collapsed; header toggles) (deep-56). Extra group contains 2 non-bundled skills.
- Skill detail dialogs: **github** (deep-57) — 🐙, "openclaw-bundled", state **eligible**, Enabled checkbox, source path `/tmp/openclaw-home/npm-global/lib/node_modules/openclaw/skills/github/SKILL.md`. No extra setup needed (gh CLI present).
- **gifgrep** (deep-58) — state **blocked**, "Missing requirements: bin:gifgrep", offers an **"Install gifgrep (go)"** one-click installer button plus homepage link. This is the shape of "Needs Setup": missing binary/env requirement + install affordance.
- Also present: filter-installed searchbox and a ClawHub registry search box ("Search and install skills from the registry").

## 11. /skills/workshop (deep-59, deep-60)

- Tabs **Board** and **Today** (Today selected by default); both show empty state "No proposals yet — Assistant hasn't drafted any skill proposals." Checkbox "Use current chat for revision requests" present.
- **Console errors here**: `GET /skills/manifest.webmanifest → 404` (PWA manifest requested relative to the /skills/ path — base-path bug; same pattern under /settings/*).

## 12. /nodes (deep-61, deep-62)

- **Exec approvals** panel: Target Host combobox (Gateway/Node), Scope buttons **Defaults** and **crestodian**; Security mode (Deny/Allowlist/Full), Ask (Off/On miss/Always), Ask fallback (Deny/Allowlist/Full), Auto-allow skill CLIs checkbox, Allowlist with "Add pattern" (glob, case-insensitive). Save is **disabled until a change is made** (so "Save without changes" is impossible by design).
- **crestodian scope** (deep-62): Security=Full, empty allowlist.
- Exec node binding: default binding "Any node" (disabled — "No nodes with system.run available"), per-agent binding row for `main`.
- Devices: one paired operator device with role token (operator · active · 5 scopes) and **Rotate / Revoke** buttons. **Deliberately not clicked at all** — the crawl rule was to only open/cancel their confirms, but since I could not verify beforehand that a confirm exists (Archive/Remove elsewhere in this UI act with *no* confirm), clicking risked invalidating the live operator token. Not exercised.
- Nodes list: "No nodes found." Pair mobile device + Refresh present.

## 13. /dreaming (deep-63 … deep-66)

- Tabs **Scene** (default; animated sleep scene, "Dreaming Idle", 0 promoted, Light/Deep/Rem all off), **Diary** (deep-64, empty), **Advanced** (deep-65; Recent Promotions = 0, "No recent promotions to inspect").
- **"Dreaming Off" toggle**: clicking it opens a modal **"Restart Gateway to Apply Change — Changing Dreaming mode restarts the gateway… may temporarily interrupt chats, automations, and connected channels"** with Confirm Restart / Cancel (deep-66). **Cancelled** — the crawl rules forbid restarting the gateway, so the ON state could not be screenshotted. This ON→OFF exercise is intrinsically a gateway restart; it cannot be done under a no-restart constraint.

## 14. /settings (deep-67 … deep-82)

Sidebar enumerates **10 sections**: Settings (general), Channels, Communications, Appearance, Automation, MCP, Infrastructure, Worktrees, AI & Agents, Debug (→ /debug), plus a Logs link (→ /logs).

- **General** (deep-67): Model & Thinking (model picker button; Thinking Off/Low/Medium/High; Fast mode Auto/Fast/Standard), Channels quick-connect rows (Telegram/Discord/Slack/WhatsApp/Signal/… each with **Connect →**), Security card (**Configure →**, gateway auth, exec policy, browser enabled, Tool profile minimal/coding/messaging/full, device auth, Pair mobile device), Gateway Host info (Node v22.22.3, PID, uptime, CPU, memory). Clicking Thinking "Low" flagged **"1 unsaved change"** with Open/Reload — used **Reload** to discard (nothing persisted).
- **Connect → (Telegram)** navigates to /settings/communications anchored at the Telegram config section (deep-68).
- **Channels** (deep-70): channel status/config page. **Communications** (deep-69): channels, messages, audio settings; raw config editor with Open/Reload/Clear/Save/Apply/Update.
- **Appearance** (deep-71…73): sub-tabs Theme/UI/Setup Wizard. Theme families = **Claw / Knot / Dash** + **Import** (tweakcn share-link import, browser-local). Clicked Knot (deep-71), Dash (deep-72), restored Claw (deep-73). Roundness (None/Slight/Default/Round/Full), Text size (90-140%), Connection info (ws://127.0.0.1:18789, Connected).
- **Color mode** (sidebar footer button): cycles **System → Light → Dark → System**; exercised full cycle (deep-74 Light, deep-75 Dark) and left it on **System (Auto)** — verified by aria-label.
- **Automation** (deep-76), **MCP** (deep-77: config editor + Save & Publish, numeric spinners), **Infrastructure** (deep-78), **Worktrees** (deep-79: "No managed worktrees." — corroborates the /chat worktree-button no-op), **AI & Agents** (deep-80: config editor Open/Clear/Save/Apply/Update).
- **Debug** (deep-81) and **Logs** (deep-82) pages load fine.
- **Console errors on every /settings/* load**: `GET /settings/manifest.webmanifest → 404` (9 occurrences logged) — manifest href is relative, breaks on nested routes.

## 15. Command palette (deep-83)

- Opened with Ctrl+K (also a sidebar-header button). Dialog: "Search chats and commands…" combobox; **Navigation** group (Overview, Sessions, Scheduled, Skills, Settings, Agents) + **Search** group surfacing slash commands (e.g. /verbose); footer hints ↑↓ navigate · ↵ select. Closed with Escape.

---

## Broken / surprising (ranked)

1. **"New chat in worktree" doesn't create a worktree** — no URL change, no worktree session; message lands in the plain dashboard session, and /settings/worktrees shows "No managed worktrees". Dead/no-op button in this install.
2. **Destructive actions with no confirmation**: session **Archive** and cron **Remove** act instantly with no confirm dialog (while Dreaming toggle *does* confirm because it restarts the gateway). Inconsistent risk gating — this is also why Rotate/Revoke were left untouched.
3. **manifest.webmanifest 404 on nested routes** (/settings/*, /skills/workshop) — PWA manifest requested with a relative path; console error on every visit to those pages.
4. Agents → Files lists **7 files, BOOTSTRAP missing** from the editor UI even though BOOTSTRAP.md exists in the workspace.
5. SOUL.md editor: a **Save clicked while a previous save is in flight is silently dropped** (needed a second click; verified via on-disk tail).
6. Voice input fails with `Realtime voice provider "openai" is not configured` (expected in a token-only sandbox; error surfacing is clean).
7. Transient "Try again / Keep waiting" overlay appears during slow gateway RPCs and self-dismisses.
8. Fork of an `explicit` session lands in a `dashboard`-kind session key.

## Not exercised (and why)

- **Rotate / Revoke** on the operator token (/nodes): rule said don't execute; since other destructive buttons in this UI proved confirm-less, even a "click then cancel" probe was unsafe for the live operator token.
- **Dreaming ON** state: the toggle requires a gateway restart (confirm modal); cancelled per the no-restart rule. deep-66 shows the modal instead.
- **Activity Expand all / Clear**: disabled — activity log was empty (browser-local; no tool events generated in this tab).
- **Sessions pagination Previous/Next** and **Usage "Filter (client-side)"**: disabled (only one page of rows / no filter selection active).
- **Model switch in the model popover**: only one provider/model (xai grok-4.3) exists in the sandbox, so there was nothing to switch to; changes were discarded.

---

## Follow-up: Settings Automation + Infrastructure (exhaustive)

Second pass (same session, deep-84 … deep-108, 25 new screenshots). Both sections share the same shell: change-banner ("No changes" / "N unsaved changes"), header buttons **Open / Reload / Clear / Save / Apply / Update**, a **Search settings** box, and per-section tab strips. All edits below were either fully reverted and verified on disk, or discarded via Reload before ever reaching Save/Apply.

### /settings/automation (deep-84 … deep-95)

Tabs: **Commands · Hooks · Bindings · Cron · Approvals · Plugins**.

- **Commands** (deep-84): Command Elevated Access Rules (custom entries list, empty), Allow Bash Chat Command (off), Bash Foreground Window ms (default 2000, unset), Allow /config (off), Allow /debug (off), Allow /mcp (off), Native Commands, Native Skill Commands, Command Owners list (0 items), Owner ID Display (raw|hash, raw), Owner ID Hash Secret (empty), Allow /plugins (off), **Allow Restart (checked — default true)**, Text Commands, Use Access Groups.
  - Exercised: toggled Allow /debug → banner "1 unsaved change" (deep-85); incremented Bash Foreground spinner and clicked Owner ID Display "hash" (deep-86); **Reload discarded everything** → banner back to "No changes", spinner cleared. Verified.
  - **Disk round-trip (SOUL.md pattern)**: set Bash Foreground Window to 1, **Save** → verified in `/tmp/openclaw-home/.openclaw/openclaw.json`: `commands.bashForegroundMs = 1` (deep-87). Cleared the field, Save again → key removed from disk (verified via python json load; `.bak` held the intermediate value, confirming save-with-backup). Residue: an empty `commands: {}` object remains after the revert — semantically harmless but not byte-identical to the original.
- **Hooks** (deep-88): Hooks Allowed Agent IDs (list, 0), Hooks Allowed Session Key Prefixes (0), Hooks Allow Request Session Key (off), Hooks Default Session Key, Hooks Enabled (off), and a full **Gmail Hook** group (Account, Allow Unsafe External Content, Callback URL, Include Body, Label, …).
  - Exercised the list-widget "Add" on Allowed Agent IDs → new row with textbox + "Remove item", banner jumped to "2 unsaved changes" (deep-89 — **counter counted 2 for a single Add**, minor accounting bug). Removed the item and Reloaded → clean.
- **Bindings** (deep-90): single top-level list — binding rules for routing / persistent ACP ownership (type=route / type=acp), 0 items, Add button.
- **Cron** (deep-91): Cron Enabled (checked), **Failure Alert** group (Account Id, After, Cooldown Ms, Enabled, Include Skipped, Mode announce|webhook), **Failure Destination** group (Account Id, Channel, Mode, To), Cron Max Concurrent Runs (default 8), **Cron Retry Policy** group (Backoff ms list, default [30000, 60000, 300000]).
- **Approvals** (deep-92): **Exec Approval Forwarding** group — Approval Agent Filter list, Forward Exec Approvals (default false), Approval Forwarding Mode (session|targets|both), Approval Session Filter, targets.
- **Plugins** (deep-93): Plugin Allowlist (0), Bundled Discovery (compat|allowlist), Plugin Denylist (0), Enable Plugins (default true), Plugin Loader group (Plugin Load Paths), Plugin Slots group (Context Engine Plugin, Memory Plugin).
- **Search box** (deep-94): typed "heartbeat" → **"No settings match \"heartbeat\""** — heartbeat config is not surfaced in Automation at all (it lives in per-agent HEARTBEAT.md / other sections), and (see Infrastructure) the search only scans the active tab anyway.
- **Open** button (deep-95): clicked — **no observable UI change** (no dialog, no editor, no navigation). Either a host-side file-open that can't surface here, or a dead button. UNVERIFIED what it should do.
- **Update** button: deliberately NOT clicked — unlabeled semantics next to Save/Apply on a gateway-config page; update/restart risk could not be ruled out.

### /settings/infrastructure (deep-96 … deep-108)

Tabs: **Gateway · Web · Browser · NodeHost · Discovery · Media · Acp · Mcp**.

- **Gateway** (deep-96): Allow x-real-ip Fallback; **Gateway Auth** group — Allow Tailscale Identity (off), **Auth Mode (none|token|password|trusted-proxy)**, Gateway Password, Auth Rate Limit sub-group, **Gateway Token (redacted textbox + Reveal value)**, Trusted Proxy Auth; **Gateway Bind Mode (auto|lan|loopback|custom|tailnet — current loopback)**; Channel Health Check Interval (min); Channel Max Restarts Per Hour; Channel Stale Event Threshold; **Control UI** group — Allowed Origins list, four *DANGEROUS*-flagged toggles (External Embed URLs, Insecure Auth, Host-Header Origin Fallback, Disable Device Auth), Base Path, Chat Message Max Width, Embed Sandbox Mode, Enabled, Assets Root; Custom Bind Host; Handshake Timeout; **HTTP API** group (endpoints, security headers); Gateway Mode; Node Allowlist/Denylist/Pairing; **Gateway Port (18789)**; Push Delivery / APNs; **Config Reload** group (Debounce ms, Restart Deferral Timeout ms, Reload Mode); **Remote Gateway** group (Enabled, Password, Remote Port, SSH Host-Key Policy/Identity/Target, TLS Fingerprint, Remote Token).
  - **Reveal value** on Gateway Token: token shown in plaintext (deep-97), then Hide value — round-trip verified.
  - **Bind mode**: clicked "lan" → "1 unsaved change" (deep-98) → **Reload discarded, never saved/applied**; on-disk `gateway.bind` verified still `loopback`. No auth/bind change was ever saved.
  - **Validation gap**: Channel Health Check Interval spinner decremented from unset straight to **-1** — no client-side minimum clamp (deep-99); discarded via Reload (server-side validation unverified; never saved).
- **Web** (deep-100): Web Channel Enabled, Heartbeat Interval (sec), Reconnect Policy group (Backoff Factor, Initial Delay ms, …).
- **Browser** (deep-101): Action Timeout ms, Attach-only Mode, CDP Port Range Start, CDP URL, Accent Color, Default Profile, Browser Enabled, further profile/automation fields.
- **NodeHost** (deep-102): **Node Browser Proxy** group — Allowed Profiles list (least-privilege note), Proxy Enabled.
- **Discovery** (deep-103): **Wide-area Discovery** group — Domain (unicast DNS-SD, e.g. openclaw.internal), Enabled (off); local mDNS options.
- **Media** (deep-104): Preserve Media Filenames (off), Media Retention TTL hours (unset = never prune).
- **Acp** (deep-105): ACP Allowed Agents list (0), ACP Backend, ACP Default Agent.
- **Mcp** (deep-106): MCP Servers (named definitions, no custom entries), MCP Runtime Idle TTL (default 10 min, 0 disables eviction).
- **Search scoping bug**: with the Mcp tab active, searching "tailscale" reports **"No settings match \"tailscale\""** (deep-107); switching to the Gateway tab with the same query shows the Tailscale matches (deep-108). Search filters **only the active tab** but the empty-state message implies the whole section — misleading.
- Deep links: neither section contains "Manage →/Configure →/Browse →" links (those live on Settings → General); nothing to follow.
- End state verified: banner "No changes"; on-disk diff vs pre-crawl = `commands: {}` residue only; `gateway.bind` = loopback; gateway never restarted.

### Follow-up findings (ranked)

1. **Settings search is per-active-tab but claims section-wide "No settings match"** — actively misleading (tailscale repro, deep-107/108).
2. **"Open" header button is a visible no-op** in both sections.
3. **Change counter mis-counts**: one list "Add" click = "2 unsaved changes"; three distinct edits earlier showed "1 unsaved change" — badge unreliable.
4. **Number spinners lack a min clamp** — health-check interval goes to -1 in the UI.
5. **Reverting a numeric field to unset leaves `{}` residue** in openclaw.json rather than restoring the original document.
6. Save writes are backed up (`openclaw.json.bak`, `.last-good`) — good operational safety.

### Not exercised (follow-up)

- **Update** button (both sections): semantics unknown; gateway-update/restart risk could not be excluded.
- **Save/Apply on any auth, bind, port, or Control UI field**: forbidden by the task (bind test stopped at unsaved state + Reload).
- **Apply** in general: applies config live (hybrid reload can trigger restarts per the Config Reload group's own description); only Save was used, and only for the harmless `bashForegroundMs` round-trip.
