# Pairing codes for unknown senders (GW-6)

Non-allowlisted senders used to be silently dropped — a correct default with
terrible recoverability (adding a legit contact meant config surgery). GW-6 adds
an opt-in pairing flow so an unknown sender can request access and the owner
approves it out-of-band, without ever exposing the agent to untrusted input.

## Policy (`src/core/channels/access-policy.ts`)
`ChannelPolicy.dmPolicy`:
- `allowlist` (default) — unknown sender denied (silent drop). Today's behavior.
- `pairing` — unknown sender gets a code; `resolve()` returns `action: 'pair'`.
- `open` — admit everyone, but **only effective with an explicit `'*'` wildcard**
  in `owners`/`allowedPeers` (OpenClaw guard); otherwise behaves as `allowlist`.
  Registered in `posture.ts` (`TELEGRAM_DM_POLICY=open`) as a widened surface.

## Pairing store (`src/core/channels/pairing.ts`)
`PairingManager` (process singleton via `getPairingManager()`, rooted at
`DATA_DIR/pairing/pairing.json`):
- Codes: 8 chars from an unambiguous alphabet (no `0 O 1 I L`), CSPRNG.
- 1-hour expiry; a peer with a live pending request gets the **same** code back.
- Max **3 pending** per `{channel, accountId}`; the 4th new peer is dropped.
- Per-peer request rate limit (shared `SlidingWindowLimiter`).
- `firstMessagePreview`: truncated to 128 chars + control-stripped, **display-only**
  (never executed, never sent to an LLM).
- `approve(code)` moves the peer into the persisted `paired` set (survives restart);
  `deny(code)`, `listPending()`, `isPaired()`, `pairedPeers()`.

## Telegram wiring (`src/core/channels/telegram.ts`)
- `TELEGRAM_DM_POLICY=pairing` turns the flow on. Paired peers are merged into the
  adapter allowlist on boot (approvals survive restart).
- Unknown sender ⇒ `_handleUnknownSenderPairing`: issues/re-issues a code as a
  **pure adapter-level reply — zero LLM, no agent turn**. The triggering message is
  NOT processed (it arrived pre-trust); the sender is told to resend after approval.
- Owner `/pair list | approve <code> | deny <code>` (`_handlePairAdmin`): adapter-
  level, restricted to the **original** owner allowlist (paired peers cannot approve
  others). Approve adds the peer to the live allowlist + persisted store.

## Deferred
Admin UI route `/v1/admin/pairing` (list + approve/deny) is NOT wired — the owner
DM command fully satisfies recoverability. The `PairingManager` singleton +
approve/deny/list API are ready for an admin handler in a follow-up. The generic
`action: 'pair'` access-policy decision is in place for other channels routed
through `MessageRouter`; only Telegram has the adapter-level reply wired so far.
