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

`ownerVerified` is threaded from the channel adapter's authenticated peer check
(`ToolContext.isOwner`), never from anything the model can set. On Telegram
that resolves to the constructor allowlist (`TELEGRAM_CHAT_ID`) — pairing-
admitted users are explicitly excluded from owner status.

A god-mode pass logs at `warn` with the surface, action and command, so
unlimited authority is always *recorded*, even though it is never *questioned*.

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
