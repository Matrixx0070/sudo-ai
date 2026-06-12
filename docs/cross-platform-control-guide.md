# Cross-Platform System Control Guide — SUDO-AI (IComputerUse)

**Status:** Shipped. This guide documents the unified `IComputerUse` API, cross-platform usage (Linux, Windows, macOS), the integrations that hook control actions into the learning and self-repair layers, autonomy/approval tiers, kill-switches, the sandbox, and desktop/GUI access setup.

SUDO-AI is an owner-controlled automation agent. It runs with the privileges you grant it on the host where you run it, and it exposes a single interface for shell execution, browser automation, file operations, and low-level GUI/desktop control across platforms.

> **Platform support:** Linux is fully supported. Windows and macOS backends are experimental — several actions are currently stubs and may report no-ops rather than performing real work. Use the kill-switches below to disable non-Linux paths if you are not on a supported host.

See the README, `docs/architecture.md`, `docs/api-reference.md`, `docs/configuration.md`, and `tui-v4-spec.md` (for TUI chat) for related details.

---

## Unified IComputerUse Interface

```ts
export interface IComputerUse {
  // Execute shell / process commands (cross-platform aware)
  exec(cmd: string, opts?: {
    cwd?: string;
    env?: Record<string, string>;
    timeout?: number;
    requiresApproval?: boolean;
    platform?: 'linux' | 'win' | 'mac';
  }): Promise<ExecResult>;

  // Browser / web automation actions (unified; falls back to platform browser control or Playwright equiv)
  browser(action: 'navigate' | 'click' | 'type' | 'screenshot' | 'scroll' | 'key' | 'vision' | 'interact' | ..., params: any): Promise<BrowserResult>;

  // File system ops (cross FS semantics, paths normalized)
  file(op: 'read' | 'write' | 'list' | 'stat' | 'delete' | 'mkdir' | ..., path: string, content?: string, opts?: any): Promise<FileResult>;

  // Low-level GUI / desktop mouse/keyboard/screen (unified over xdotool / Win32 / CGEvent / osascript)
  gui(action: 'mouse' | 'key' | 'screenshot' | 'scroll' | ..., params: any): Promise<GUIResult>;

  // Higher desktop / app management (open apps, focus windows, list desktops)
  desktop(action: 'open' | 'focus' | 'list' | 'screenshot' | 'switch' | ..., params: any): Promise<DesktopResult>;
}

export interface ExecResult { success: boolean; stdout: string; stderr: string; exitCode: number; durationMs: number; platform: string; }
export interface BrowserResult { success: boolean; data?: any; screenshot?: string; error?: string; /* ... */ }
export interface FileResult { success: boolean; content?: string; entries?: string[]; /* ... */ error?: string; }
export interface GUIResult { success: boolean; screenshot?: string; /* coords etc */ error?: string; }
export interface DesktopResult { success: boolean; /* app/window info */ error?: string; }
```

Factory: `createComputerUse(platform?: 'linux'|'win'|'mac' | 'auto')` or platform-specific backends under `src/core/tools/builtin/computer-use/cross-platform/{index,linux,win,mac,types}.ts`.

**Legacy path:** The original `computer.use` tool (Linux-only ScreenAction via xdotool/scrot in `browser/computer-use.ts` plus a tool wrapper) is still supported for compatibility. The new `IComputerUse` supersets and unifies it, adds cross-OS support, and broadens the surface (exec/file/gui/desktop) with learning hooks.

**Power and safety model:** `IComputerUse` is designed to carry out the owner's instructions, including privileged and GUI actions. It does not add its own product-level policy layer on top of what you ask for; instead, high-power actions are governed by operator-controlled safety controls:

- **Autonomy / approval tiers** (auto / notify / confirm / never).
- **Kill-switches** (operator controlled, listed below).
- **Sandbox** (defense in depth; bwrap/seccomp on Linux).
- **Audit logging and self-reporting** (via the monitoring/self-repair layer and dashboard).

You decide how much autonomy to grant and which controls to enable for your environment.

---

## Cross-Platform Usage Examples

### Linux (native, fully supported)

Requires: xdotool, scrot (or equivalent), bwrap for sandboxed exec, and `DISPLAY` set (or a desktop/RDP setup for GUI).

```bash
# Via agent chat / API (tool calls happen internally)
"Use computer control to open a terminal, type 'ls', take a screenshot of the desktop, write a file /tmp/note.txt, and report."
```

Programmatic (in a custom skill or internally):
```ts
import { createComputerUse } from '../tools/builtin/computer-use/cross-platform';
const cu = createComputerUse('linux');
const r1 = await cu.exec('echo "control" > /tmp/note.txt', {timeout: 3000});
const r2 = await cu.gui({action: 'screenshot'});
const r3 = await cu.browser({action: 'navigate', url: 'https://example.com'});
const r4 = await cu.desktop({action: 'open', app: 'firefox'});
// All outcomes -> ToolOutcomeLearner + monitoring/self-repair layer
console.log(r1, r2);
```

Sandbox: runs under bwrap + seccomp/LD_PRELOAD (policy can be expanded for cross-platform work).

### Windows (experimental)

Backends: node `child_process` + `powershell.exe`, a Rust portable backend, or native Win32 via optional native modules (no Python). File paths use `\` or `/` (normalized). GUI via PowerShell SendKeys or an equivalent shim. Several GUI/desktop actions are currently stubs.

```ts
const cu = createComputerUse('win');
await cu.exec('powershell -Command "Get-Process | Select-Object -First 5"', {platform: 'win'});
await cu.file({op: 'write', path: 'C:\\Users\\Public\\note.txt', content: 'note'});
await cu.gui({action: 'key', key: 'win+r'}); // example
await cu.desktop({action: 'focus', title: 'Notepad'});
```

The test harness uses mocks or WSL interop for CI.

### macOS (experimental)

Backends: osascript / AppleScript, node for some operations, or CGEvent via a native/Rust shim. Several GUI/desktop actions are currently stubs.

```ts
const cu = createComputerUse('mac');
await cu.exec('osascript -e \'tell app "System Events" to keystroke "hello"\'');
await cu.file({op: 'list', path: '/Users/'});
await cu.gui({action: 'mouse', x: 500, y: 300, button: 'left'});
await cu.browser({action: 'screenshot', format: 'png'});
```

---

## Integrations (Learning + Self-Repair + Autonomy)

**ToolOutcomeLearner (learning on control outcomes):**
- On every `IComputerUse.*` completion (success/fail plus metadata: action, platform, duration, error, tags such as `['control','cross-platform', platform]`):
  `learner.learn({ toolName: 'computer-use.exec' | 'computer-use.gui' | ..., input, outcome: {ok, ...}, score, sessionId, tags })`
- Feeds several modules (e.g. FailureLearner, ImprovementLoop, SkillDiscovery, Brier scoring, TrustTierTracker).
- Result: the control surface improves over time, with trust tiers rising on reliable control. Visible in metrics.

**Monitoring + self-repair (closed loop):**
- The monitoring layer watches control health (e.g. `control_degraded`, large control logs, platform-specific issues) alongside existing signals (large files >750L, TypeScript errors, etc.).
- On a detected control issue, it can trigger a repair task.
- The self-repair tooling reads control code and logs, runs a baseline `tsc`, proposes edits, applies them, and verifies with `tsc`/tests, recording the repair outcome to the learner.
- Practice: prefer small, targeted search/replace edits with `tsc` after each change to avoid large-refactor breakage.
- Outcome: a self-healing control layer with reduced noise from large-file/critical signals.

**Autonomy / approval:**
- The ApprovalMatrix tiers (auto / notify / confirm / never) apply to `IComputerUse` actions. Default rules can append, for example, `{pattern:'control.*', tier:'auto', reason:'Cross-platform system control (exec/browser/file/gui/desktop), owner-controlled'}`, with stricter tiers for risky operations (e.g. `rm` → never, writes → notify).
- AutonomousExecutor wraps calls (`executeControl`); high-power actions may queue as pending and notify, depending on configured tier.
- `SUDO_AUTO_APPROVE=1` favors automatic approval (operator opt-in).
- Pending actions are surfaced in the dashboard; you can confirm them via configured channels.
- Balance: keep the sandbox on and kill-switches available, and choose the autonomy tier that fits your trust level for the host.

**Other wires:**
- Sandbox policy equivalents for Windows/macOS (or host-side handling for GUI).
- Agent loop / tool-router: route `computer.*` to the `IComputerUse` implementation.
- Outcomes also flow to the consciousness layer (episodic memory, etc.) and to federation where applicable.
- Optional portable low-level control / control-agent swarm via the Rust backend (later phase).

**End-to-end learning loop example:**
Control action (e.g. a GUI click on Windows) → outcome recorded → learner updates trust/Brier/strategy → monitoring sees repeated failures → self-repair fixes the backend shim → learner records the repair success → subsequent control actions are faster and more reliable.

---

## Kill-Switches & Safety for Full-Power Control

**All use exact `= "1"` semantics** (see the API reference for details). Set them in `.env`, `ecosystem.config.cjs`, systemd, or a pm2 env. Never set them from user input.

**Core control switches:**
- `SUDO_COMPUTER_USE_DISABLE=1` — Disable the entire `IComputerUse` plus the legacy `computer.use` (and related GUI/desktop).
- `SUDO_CROSS_PLATFORM_DISABLE=1` — Force Linux-only even if other backends are present; disable Windows/macOS paths.
- `SUDO_TOOL_LEARNING_DISABLE=1` — Disable ToolOutcomeLearner entirely (including on control outcomes; useful for debugging the learning layer).
- `SUDO_SANDBOX_DISABLE=1` (or per-scope) — Run control/exec outside bwrap. Dangerous; for trusted owner use only.

**Feature switches (still apply):**
- `SUDO_MCP_DISABLE=1`, `SUDO_MCP_OAUTH_DISABLE=1`, `SUDO_MCP_REMOTE_DISABLE=1`
- `SUDO_DASHBOARD_DISABLE=1`
- `SUDO_BRAIN_RACE_DISABLE=1`, `SUDO_BRAIN_CONSENSUS_DISABLE=1`
- `SUDO_AUTO_APPROVE=1` (enables automatic approval for autonomy; the opposite of gating)

**General / prior:**
- `SUDO_TAINT_DISABLE=1`, `SUDO_SIGNING_DISABLE=1`, etc.
- The full current table is maintained in `docs/api-reference.md#kill-switches` (update there when switches change).

**Usage recommendation:** For full-power use on a trusted host: `SUDO_AUTO_APPROVE=1 SUDO_COMPUTER_USE_DISABLE=0 ...` plus desktop access. For safer/shared environments: leave defaults (confirm tier for destructive actions) and set disables as needed. Audit activity via the monitoring layer and dashboard.

**Sandbox + security for control:** Control actions pass through SecurityGuard (injection and dangerous-pattern checks) plus the sandbox where applicable. Adversarial review (security review plus `/codex:adversarial-review`) is recommended before merging high-power changes.

---

## Cross-Platform Setup & Desktop/GUI Access

**Linux (primary, fully supported):**
- Install: `apt install xdotool scrot bwrap` (or equivalent).
- `DISPLAY`: usually `:0`, or set it via your desktop scripts.
- Sandbox: automatic via bwrap in the system/exec and control paths.
- GUI desktop: if running in a container/sandbox without X, use a host RDP/VNC desktop.
  - Provide your own desktop start/stop scripts (e.g. Xvnc + xrdp) as appropriate for your host.
  - Connect with an RDP client to `host:3389` using your own credentials.
  - Note: if the agent session is inside bwrap, run desktop setup on the host (or outside the sandbox) for full desktop control.
- Config: see `docs/configuration.md` (sandbox policy, `DISPLAY` env).

**Windows (experimental):**
- Backends auto-detect, or set `platform: 'win'`.
- For development: WSL2 + interop, or native Windows node + PowerShell.
- GUI: requires an active session (or RDP to a Windows host); the agent drives it via a shim.
- Sandbox: Windows equivalents (job objects / restricted tokens) or host-side handling for full GUI; Linux bwrap for WSL parts.
- If you have no Windows host, use the disable switches above.

**macOS (experimental):**
- osascript is always available; GUI requires accessibility permissions or an active UI session.
- Development: on a Mac host or via a VM; RDP/VNC for remote access.
- Sandbox: app sandbox or seatbelt profiles; expand as needed.

**RDP / Remote Desktop Notes (for host GUI when the agent is sandboxed):**
- RDP/VNC enables full visual and input control from outside, so the agent can screenshot via `cu.gui` and interact via GUI actions even without a local X server.
- Provide scripts to start/stop your Xvnc/xrdp session.
- Security: use a strong password, restrict port 3389 with a firewall (or a tunnel), and keep access owner-only.
- For the agent: use `desktop` actions or `exec` to launch RDP clients if needed, or use `cu.gui` directly (xdotool on the RDP X display).

**Testing / harness:**
- `tests/tools/computer-use-cross-platform.test.ts`: a 3-OS matrix (real Linux plus mocks for Windows/macOS), success rates, integration tests for learner calls, monitoring hooks, and autonomy gating.
- Metrics: action coverage, cross-platform success rate, learning delta.
- Run with the appropriate platform env flags.

**Desktop / GUI for full-power control:**
When the agent must drive a real GUI (e.g. desktop apps that are not headless), use an RDP/VNC session on the host and set `DISPLAY` to the VNC display in your scripts. The agent (if privileged) can then use `cu.gui` / `cu.desktop` on it. For safety, combine this with the confirm autonomy tier and kill-switches.

---

## Control Power Model

`IComputerUse` carries out owner intent, including privileged actions, GUI automation on the desktop, and cross-OS automation. It does not add a separate product-level refusal layer on top of your instructions. Safety is handled operationally rather than by the tool deciding what to refuse:

- **Kill-switches** (operator controlled).
- **Autonomy tiers** (configurable per environment).
- **Sandbox** (defense in depth, not a refusal mechanism).
- **Learning** (the system gets better at executing reliably and safely over time).
- **Audit / monitoring** (self-reports issues).
- **Security and code-review gates** on the implementation.

You remain responsible for how you configure and deploy the system, including which autonomy tiers and kill-switches are active for your host and users.

---

## Capability Context

The control layer (`IComputerUse`) provides a single cross-platform surface for shell, browser, file, GUI, and desktop control, with every outcome fed into the learning and self-repair layers.

- It preserves the existing tool and feature set.
- Control outcomes broaden the learning surface, which improves the agent's reliability over time.
- See `state.md` and `decisions.md` for the full feature list and design decisions.

---

## Roadmap / Updates

- Core: `IComputerUse` core + full Linux support + experimental Windows/macOS backends and mocks + learner/monitoring/autonomy wires + tests + this guide.
- Next: higher reliability on control, quieter monitoring on control debt, more actions, the portable Rust backend, and polish.
- As work lands: revise with end-to-end examples, validation logs, and metrics.
- Kill-switch and config updates are tracked in the API reference and config docs in parallel (the setup wizard can populate the cross-platform switches).

For questions or issues with control, use your configured channels; the agent self-diagnoses via the monitoring and self-repair layers.

**Safety first:** Even with full power, use kill-switches, the sandbox, and confirm tiers in untrusted or multi-user environments. Reserve full automatic approval for trusted, owner-only hosts.

## Validating Control via the TUI

After install and setup, launch the Ink TUI (`sudo-ai chat`, or the default on run) and interact with SUDO-AI directly to validate features, setup, cross-platform control, self-improvement, and the learner.

**Example TUI prompts and expected behavior:**

1. Cross-platform IComputerUse (exec/file/gui etc.):
   ```
   User: use your unified IComputerUse cross-platform to list files in /tmp and describe what you see. Also try a file write to /tmp/sudo-test.txt with content "validated via TUI".
   SUDO: [uses control.exec or control.file on Linux (or the win/mac backend), reports results in chat, tool cards show in the TUI in real time, outcome recorded to the learner]
   Validation: success visible in the TUI, no silent failure, learner records the 'control.*' outcome.
   ```

2. Self-improvement / ToolOutcomeLearner on control:
   ```
   User: report on your ToolOutcomeLearner learnings specifically from computer-use / IComputerUse control actions. What trust tiers or Brier improvements?
   SUDO: [queries the learner, reports gains on control outcomes, plus any degraded signals and repairs]
   Validation: self-improvement visible in the chat; confirms the learning loop.
   ```

3. Setup / wizard / profiles / config:
   ```
   User: check your current setup: what is your name, primary model, is cross-platform IComputerUse enabled, any active kill-switches for control? Set up a research profile if possible.
   SUDO: [reports config from the wizard, kill-switches, and profiles; may use tools as needed]
   Validation: the wizard covered cross-platform control, the learner, monitoring, and service config; the TUI confirms the configuration.
   ```

4. Full-power control with autonomy:
   ```
   User: as owner, execute a safe desktop action using IComputerUse (e.g. get active window info) with full autonomy.
   SUDO: [uses the auto tier and succeeds, subject to the configured controls]
   Validation: only technical gates (denylist, sandbox, window guard) apply, per your configuration.
   ```

**Recent fixes (no regressions):**
- `control.file` denylist narrowed to sensitive subpaths only (avoids blocking normal `/root` / `/home` workspace operations).
- `executeControl` now propagates the backend `res.success` (no more reporting `success: true` on failure).
- Windows/macOS browser/gui/desktop stubs now report accurate results (not always success for a no-op).
- Earlier bypasses from pre-remediation were closed during remediation (approval handling, env scrub, window guard, FS denylist + sandbox, win/mac child env); security review approved afterward, with no regressions on the legacy path.

**TUI UX:** the Ink app shows live tool cards for control actions, alignment, and learner signals where exposed, with fast responses.

See `tui-v4-spec.md`, the README, and `state.md` for further details.

---

*This doc is user-facing. Covers installation, setup, and interacting with SUDO-AI via the TUI for cross-platform control.*
