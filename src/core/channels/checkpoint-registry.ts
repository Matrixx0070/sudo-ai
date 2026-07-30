/**
 * @file checkpoint-registry.ts
 * @description Process-wide accessor for the TX10 CheckpointProtocol. cli.ts
 * initialises it at boot (db under DATA_DIR, sender = Telegram owner DM);
 * consumers (mission control, TX19 deploy gate, telegram callback route) reach
 * it here without import cycles. Null before init — callers treat that as
 * "checkpoint surface unavailable" and HOLD (never approve).
 */

import { CheckpointProtocol } from './checkpoint-protocol.js';

let _protocol: CheckpointProtocol | null = null;

export function initCheckpointProtocol(protocol: CheckpointProtocol): void {
  _protocol = protocol;
}

export function getCheckpointProtocol(): CheckpointProtocol | null {
  return _protocol;
}

/** Test hook — reset the singleton. */
export function _resetCheckpointProtocol(): void {
  _protocol = null;
}
