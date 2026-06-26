/**
 * @file tests/agent/completion-verify-scope.test.ts
 * @description Scope guard for the agent loop's SUDO_COMPLETION_VERIFY block.
 *
 * The loop verifies the final response for phantom completion only on genuine
 * task turns. Ephemeral machine turns — cron/isolated heartbeats, health
 * probes, swarm sub-agents — legitimately end with terse acks like
 * "HEARTBEAT_OK" that the no-LLM heuristic misreads as a phantom completion
 * (output_length + cross_reference fail → confidence ~35). The loop gates the
 * verifier with `isEphemeralPeer(session.channel, session.peerId)`; this test
 * pins that discriminator against the exact live session that produced the
 * recurring false positives and against a real human peer that must STILL be
 * verified.
 */

import { describe, it, expect } from 'vitest';
import { isEphemeralPeer } from '../../src/core/sessions/crash-safe.js';

describe('CompletionVerify ephemeral-turn scope (isEphemeralPeer gate)', () => {
  it('skips the live cron/isolated heartbeat session that produced the false positives', () => {
    // Session u21IVEFgMKgrDeB45ZbOz, title web:cron:isolated:gtM774VTq1_Qjb3Te-m1O,
    // 7× "possible phantom completion" (confidence 35) — all HEARTBEAT_OK acks.
    expect(isEphemeralPeer('web', 'cron:isolated:gtM774VTq1_Qjb3Te-m1O')).toBe(true);
  });

  it('skips other autonomy/probe machine namespaces', () => {
    expect(isEphemeralPeer('web', 'subagent:swarm-7')).toBe(true);
    expect(isEphemeralPeer('web', 'goal:nightly-sweep')).toBe(true);
    expect(isEphemeralPeer('web', '127.0.0.1')).toBe(true);
  });

  it('STILL verifies genuine human task turns (telegram / web human peers)', () => {
    expect(isEphemeralPeer('telegram', '8087386717')).toBe(false);
    expect(isEphemeralPeer('web', 'frankmartin7722')).toBe(false);
  });
});
