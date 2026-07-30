# ADR 0004 — Self-heal & telemetry posture: pull-only, artifact-out

Status: **Accepted** (Fable, CEO-mode decision, 2026-07-30)
Informed by: read-only audit of OpenClaw @ `66b91d78` (`/root/openclaw-security-audit/`, esp. doc 06) + live GitHub governance review 2026-07-30.

## Problem

Sudo-ai needs a standing answer to three recurring asks before any of them get built ad-hoc:

1. **Self-heal** — agent detects a known-fixable fault (config drift, dead process, stale token) and repairs it locally.
2. **Auto-update** — installs pull upstream fixes automatically.
3. **Crash phone-home** — installs upload sanitized bug reports so the fleet learns.

Each is individually attractive; together they define the product's egress posture. Deciding them piecemeal risks shipping the dangerous one (3) by momentum.

## Evidence (what OpenClaw teaches)

- OpenClaw (384k stars, 3,022 contributors) ships **zero** push telemetry: no analytics SDK anywhere in `src/`, `extensions/`, `apps/` (iOS/Android incl.), `ui/`. Verified by word-boundary sweep of our local clone.
- Their entire on-user-machine self-fix story is **pull-only**: version check against `registry.npmjs.org` (`src/infra/update-check.ts:333`), no request body, no custom headers.
- They built ~90% of a crash-report pipeline — 30 diagnostic modules, two redaction passes, global exception handlers — and **stopped at the upload**: `writeSupportBundleZip` writes a local zip `0700/0600` and tells the human "attach this to the bug report". The human is the transport.
- Their self-*fixing* automation (docs-agent, clawsweeper) runs only in their own CI, gated six ways, path-allowlisted after the agent runs, re-verified, and drops changes on conflict rather than rebasing.
- Their one telemetry POST (ClawHub install) fires only when logged in, carries sha256(path)+skill slugs, and has an env opt-out.

The load-bearing insight: **a sanitizer bug behind an auto-uploader is a fleet-wide credential-exfil incident; behind a local file it is nothing.** OpenClaw's own audit (S1: transcripts persist unredacted tool output) shows how plausible such a bug is even in a mature codebase.

## Alternatives considered

| Option | Verdict |
|---|---|
| A. Full trio incl. auto-upload crash reports (opt-in) | **Rejected.** Redactor becomes a single point of fleet-wide failure; consent doesn't cure a sanitizer hole. |
| B. Nothing (status quo, manual ops forever) | Rejected. Self-heal is high-value, zero-egress, and OpenClaw's gap — no reason to forgo it. |
| C. Pull-only + artifact-out (this ADR) | **Accepted.** |

## Decision

1. **Self-heal, disclosed — BUILD.**
   - Agent may auto-repair faults only in **owner-pre-approved categories** (initial set: dead process restart, stale OAuth token refresh, config-drift revert to last-known-good, log/uploads GC).
   - Every heal writes a disclosure record (what, when, diff/action, trigger) and notifies the owner via the existing proactive-notify seam. Silent healing is forbidden.
   - The category allowlist is config, gated like a sensitive surface: changes require owner action, never self-modification. Heals must never touch identity/constitution/PROTECTED_PATHS (invariant 4) and go through existing seams — no new privileged pathway.
   - Kill switch: `SUDO_SELF_HEAL=0` disables all healing.
2. **Signed pull updates — BUILD (formalize existing).**
   - Deploys stay ff-only from the canonical repo. Any future multi-install channel asks once at setup ("allow sudo-ai to pull signed fixes from upstream?"), pins signatures, and surfaces every applied update visibly. No update path may execute unsigned code.
3. **Crash reporting — artifact-only. Auto-upload REJECTED at default.**
   - On qualifying faults the agent builds a **sanitized local bundle** (redaction pass mandatory; zone rules from CLAUDE.md apply — zone-0/1 content never enters a bundle in plaintext), writes it `0600` under the state dir, and notifies the owner: "report written, want me to file it?"
   - The owner files it (or explicitly commands the agent to, per-incident). No standing upload credential, no default endpoint.
   - **Revisit gate:** automatic upload may be reconsidered only after ≥20 real bundles have been human-reviewed with zero redaction misses, and then only as per-install opt-in with the endpoint pinned in signed config. Until that evidence exists, this line is closed.

## Tradeoffs

- We forgo automatic fleet-wide learning from crashes; the loop has a human in it. Accepted: at current fleet size (~1 install) the loss is zero, and the gate above defines exactly what evidence reopens the question.
- Self-heal adds an autonomous-action surface; bounded by category allowlist + disclosure + kill switch + frozen-surface exclusion.

## Consequences

- Any future PR adding default-on egress of diagnostic/usage data violates this ADR and must be rejected in review; reviewers should cite ADR-0004.
- The self-heal engine (categories, disclosure log, notify wiring) becomes a roadmap item; build flag-off per house rules, activation = owner call.
- The redaction module gets built and exercised **now** (on local bundles), so that if the revisit gate ever opens, the sanitizer has a real-world track record first.
