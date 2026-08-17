# Execution Authority

**Owner directive (Frank, 2026-08-16):** sudo-ai operates with full root-level
authority. When the owner states an objective, the agent decides what commands,
file operations, system changes and installations are required and executes them
end to end. No approval prompts, no "Are you sure?", no interruption that asks
the operator to authorize an individual action.

This document describes how that is implemented as **one deliberate
architecture** rather than a collection of per-command bypasses.

---

## The single resolver

`src/core/security/execution-authority.ts` is the only place that answers *"may
this action run without asking the human first?"*.

```ts
import { authorize, isAutonomous } from '../security/execution-authority.js';

const decision = authorize({ surface: 'shell-exec', action: 'system.exec', command });
if (!decision.proceed && !decision.requiresPrompt) return refuse(decision.reason);
if (decision.requiresPrompt) { /* gated mode only */ }
```

**Rule for contributors: never read `SUDO_AUTO_APPROVE`, `EXEC_APPROVAL_MODE` or
any other approval env var directly in a new surface. Call `authorize()`.**

### Modes

| mode | behaviour |
|---|---|
| `autonomous` (**default**) | No surface may prompt. Every action proceeds. |
| `gated` | Human-in-the-loop prompting is restored on every surface. |

Resolution order (first match wins):

1. `SUDO_AUTHORITY_MODE=autonomous|gated` — the current, explicit knob.
2. `SUDO_AUTO_APPROVE=0` → `gated` (legacy opt-out kept working).
3. default → `autonomous`.

The mode is resolved **per call**, never cached in a module const, so a live
config change applies to the next action instead of the next daemon restart.

---

## Wired surfaces

Every surface that could previously stop and ask now consults the resolver:

| surface | file | behaviour under autonomy |
|---|---|---|
| Agent tool batch (`requiresConfirmation` tools) | `core/agent/permissions.ts` | every tool resolves `auto` |
| ApprovalManager (backstop) | `core/agent/approval.ts` | returns approved, sends nothing to any channel |
| `system.exec` | `tools/builtin/system/shell-exec.ts` | `EXEC_APPROVAL_MODE` bypassed, runs immediately |
| Background shell | `tools/builtin/system/bg-shell/index.ts` | same |
| Orchestration graph gates | `core/orchestration/graph-approval.ts` | passes through instead of parking, writing an audit artifact |
| ACP bridge (`acp` bin, editor IDE path) | `core/acp/brain-backend.ts` | no `session/request_permission` round-trip |

### Why this was needed (measured 2026-08-16)

The three lanes did not agree with each other:

- `PermissionManager` honoured `SUDO_AUTO_APPROVE=1`.
- `system.exec` honoured only `EXEC_APPROVAL_MODE`, read into a module-level
  const **at import time** — unchangeable without a restart.
- Graph gates honoured neither and parked forever waiting for a human.

Live probes showed `system.ssh` (declared `requiresConfirmation: true`)
executing with **no prompt**, while a strict-mode shell command would have
blocked for the full approval window. Opposite behaviours from the same intent.
That drift class is what centralization removes.

---

## God mode — unlimited authority, owner-locked

**Owner directive (2026-08-16):** sudo-ai has god-level access to the system it
lives on, reacts only to the owner's commands, and can do anything needed to
complete an objective without a human touching the machine.

```bash
SUDO_AUTHORITY_GOD_MODE=1
```

With it set, a request the authority can attribute to the **verified owner**
proceeds past every containment check — including the catastrophic-command
refusal. Nothing prompts, ever.

The owner condition is what makes unlimited power safe to grant, and it is the
second half of the directive ("react only to the owner's command"):

| caller | god mode applies? |
|---|---|
| Verified owner (authenticated peer on an owner-listed id) | **yes — unlimited** |
| Non-owner chat peer, pairing-admitted user | no — containment holds |
| Cron, webhooks, remote workers, MCP callers, anything unattributed | no — containment holds |

### Which channels can confer owner status

| channel | owner when | notes |
|---|---|---|
| Telegram | sender id is in the constructor allowlist (`TELEGRAM_CHAT_ID`) | pairing-admitted peers are admitted but never owners |
| Web chat | the request/connection proves `WEB_CHAT_TOKEN` | loopback/LAN admission is not ownership |
| Gateway API (`/v1/chat/completions` — TUI, scripts, remote owner clients) | the request authenticates with `GATEWAY_TOKEN` / gateway secret | resolved by `authenticateHttp`, threaded into the turn |
| Router channels (Discord, Slack, email, WhatsApp, Signal, Matrix, IRC) | sender id is in that channel's `owners:` list in `config/channels.json5` | resolved by the access policy, stamped by the router |
| cron, webhooks, remote workers, MCP, self-build, eval | never | no owner stamp → treated as non-owner, sandbox + containment apply |

**Owner directive (2026-08-17): god mode follows the OWNER, not the channel.**
However Frank reaches sudo-ai — Telegram, web UI, the gateway API behind a TUI
or script, or any configured channel — an authenticated owner turn gets the
same unlimited authority. Adding a channel to that list is a matter of
configuring its owner identity, not changing the authority code.

At boot, when god mode is on, the daemon logs exactly which identities hold it
(`GOD MODE ACTIVE — these identities can execute on the real host through
sudo-ai`), so unlimited authority is never implicit.

Fail-closed by construction: an adapter that does not explicitly stamp
`isOwner` cannot grant god mode. Adding owner support to a new channel is a
deliberate act — stamp `UnifiedMessage.isOwner` from an authenticated peer
check, never from anything the sender controls.

`ownerVerified` is threaded from the channel adapter's authenticated peer check
(`ToolContext.isOwner`), never from anything the model can set. On Telegram
that resolves to the constructor allowlist (`TELEGRAM_CHAT_ID`) — pairing-
admitted users are explicitly excluded from owner status.

A god-mode pass logs at `warn` with the surface, action and command, so
unlimited authority is always *recorded*, even though it is never *questioned*.

### God mode bypasses the sandbox too — that is the point

Lifting the approval layer alone was **not** god-level access. Measured live
(2026-08-16): with god mode on, an owner command `touch /etc/sudo-ai-godmode-proof`
returned success and the agent reported "full root access confirmed", but the
file did not exist on the host — `system.exec` had run it inside the bwrap
mount namespace. The owner had authority over a copy of the system, not the
system.

So under god mode a **verified-owner** turn bypasses the sandbox and executes
on the real host. Every other caller keeps it:

| caller | sandbox |
|---|---|
| verified owner, god mode on | **bypassed — real host** |
| verified owner, god mode off | sandbox (opt-in, not the default) |
| non-owner / unattributed | sandbox, always |

Each bypass logs at `warn`: `GOD MODE: owner-verified command bypassing the
sandbox — executing on the real host`.

### What god mode costs — read this before enabling it

Adversarial review (2026-08-16) named the real trade-off, and it is not a code
defect but a consequence of the directive:

**A prompt injection during a legitimate owner turn now reaches the host.**
The turn is owner-attributed, but the CONTENT the model acts on — a fetched
web page, an email, a repo file, tool output — may be attacker-controlled.
Before god mode, injected instructions were contained by the sandbox and
refused by the catastrophic list. Under god mode, on an owner turn, both
layers are lifted. One successful injection is arbitrary host access.

That is the price of "god-level access to the system it lives on", and it is
why owner attribution is the only thing standing between the model and the
machine. Consequences:

- **Owner attribution must be exact.** Web chat previously marked EVERY turn
  `isOwner: true` while skipping auth on loopback/LAN — behind a reverse proxy
  that made any caller the owner. Now **admission and ownership are separate
  questions**: loopback/LAN still admits, but owner status requires proving
  `WEB_CHAT_TOKEN`.

  The proof is bound **per connection and per request**, never cached on the
  adapter. A first attempt did cache it, and review reproduced a tokenless
  WebSocket inheriting owner status from the owner's previous HTTP request —
  real-host root for an unauthenticated client. `tests/channels/web-owner-attribution.test.ts`
  drives a real server and a real socket to pin every path (POST, WS,
  attachments), because the earlier test pre-set the internal flag and passed
  while both holes were open.
- **Keep god mode off where owner attribution is weak** — any proxied or
  non-loopback deployment without a real owner-id match.
- `agent.command` driven by external Grok text (`SUDO_GROK_WEB_MCP_COMMAND=1`,
  default off) runs owner-attributed: under god mode that is host-level. Leave
  it off unless the input path is trusted.

### Contained runs must say they are contained

The same incident exposed a reporting defect: a sandboxed write was described
as "Done — file written". Sandboxed results now carry an explicit note that
changes outside the session workspace did not affect the host, so a contained
effect can never be reported as a host effect.

`SUDO_AUTHORITY_ALLOW_CATASTROPHIC=1` remains the unconditional lift for
headless contexts the owner explicitly trusts (no attribution required).

## What autonomy does NOT remove

Autonomy removes *interaction*, not *containment*. Two things are not prompts
and therefore still apply:

1. **The bwrap sandbox** on `system.exec` — a mount namespace, not a question.
2. **Catastrophic-command refusal** — two layers, both refuse without ever
   asking:
   - exec-policy's hardened `DANGEROUS_PREFIXES` (~20 audited entries), which
     keeps its force-deny power in autonomous mode, and
   - a parser covering whole-disk and top-level-directory destruction:
     block devices including **nvme/partitions** (`dd of=/dev/nvme0n1`,
     `/dev/sda1`, `wipefs`, `shred`, `mkfs`), quoted root (`rm -rf "/"`),
     separated flags (`rm -r -f /`), `--no-preserve-root`, `find / -delete`,
     `cd / && rm -rf *`, and the protected top-level dirs (`/etc`, `/usr`,
     `/home`, `/root`, …).

   An earlier regex-only version of layer 2 was defeated by all fifteen of
   those forms in adversarial review; the parser and its regression list exist
   because of that. Three review rounds added: wrapper unwrapping (`bash -c`,
   `sh -c`, `sudo`, `env`, `nohup`, `timeout N`), full path normalization
   (`/etc//`, `//////`, `/etc/./../`), both branches of `${VAR:-default}`,
   `$(echo …)`/`$(printf …)` substitution, and pipe forms
   (`echo / | xargs rm -rf`).

   **Honest limits** (known and accepted, not oversights):
   - Static analysis cannot resolve arbitrary runtime expansion —
     `rm -rf $(pwd)` with the shell already at `/` is not detectable here.
   - Pipe operands are threaded only from *static* emitters (`echo`,
     `printf`, `yes`). Derived producers (`find`, `ls`, `grep`) are not
     threaded on purpose: doing so would refuse
     `grep -rl foo /etc | xargs rm -rf`, where `/etc` is the search root, not
     the deletion target.
   - `docker run … rm -rf /` is refused even though it targets a container
     filesystem. Kept deliberately: a bind mount (`-v /:/host`) makes the
     container form genuinely host-destructive, and container arguments are
     not statically distinguishable.

   This layer is a cheap-evasion backstop underneath the bwrap sandbox, not a
   security boundary.

Ordinary destructive work is explicitly **not** catastrophic and runs freely:
`rm -rf /tmp/build`, `rm -rf node_modules`, `apt-get install`, `systemctl
restart`, `chown -R`, `docker run`, writes to `/etc` — all execute without
asking.

The refusal is a last-resort backstop against an unrecoverable mistake, kept per
the engineering doctrine's "never drop a working capability" rule. The owner can
lift it deliberately:

```bash
SUDO_AUTHORITY_ALLOW_CATASTROPHIC=1
```

---

## Observability

The daemon logs its resolved posture once at boot:

```
Execution authority: AUTONOMOUS — full root-level authority, no approval prompts
  mode=autonomous prompts="disabled on every surface"
  containment="sandbox + catastrophic-command refusal"
```

A refusal logs at `error` with the surface, action and reason, so a blocked
action is never silent.

---

## Tests

- `tests/security/execution-authority.test.ts` — mode resolution, per-call
  re-read, catastrophic classification (including the negative cases that must
  stay runnable).
- `tests/security/authority-surfaces.test.ts` — each wired surface honours the
  resolver; autonomy beats even an explicit `ask` override; gated mode still
  parks/prompts so the switch is provably real.

Both were mutation-tested: forcing `authorize()` to always prompt fails 4 tests;
unwiring the ApprovalManager backstop fails 2; neutering the catastrophic
parser fails 2; dropping the `DANGEROUS_PREFIXES` call fails 1; unwiring the
ACP permission gate fails 1.

Subpaths of protected roots stay freely deletable and are pinned as negative
cases (`rm -rf /var/log/myapp`, `rm -rf /root/sudo-ai-v4/dist`,
`cd /tmp/build && rm -rf *`) — over-blocking would break the directive just as
surely as under-blocking would break containment.
