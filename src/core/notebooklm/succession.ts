/**
 * @file notebooklm/succession.ts
 * @description F64 — successor's notebook + succession gate. When the primary
 * brain's MODEL GENERATION changes (G-MODELGEN currentModelGeneration), a
 * successor is inheriting the identity. That is a harness-enforced ritual, not
 * a silent swap:
 *
 *   detect change → PAUSE autonomous work → build a sealed SUCCESSOR PACK →
 *   the successor ACKs (token bound to the pack) → identity PULSE (F63) →
 *   UNPAUSE (only when acked AND pulsed; baseline advances to the new gen).
 *
 * The successor pack MAY include zone-1 material (invariant-1 F64 exception) —
 * so it is SEALED with AES-256-GCM and only ever read in-harness / over an
 * encrypted channel, never broadcast. Frozen surfaces (identity/constitution)
 * are READ-only here (via their existing readers); nothing is written to them.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../shared/logger.js';
import { dataPath } from '../shared/paths.js';
import { encryptZone1, decryptZone1 } from '../gdrive/zones.js';

const log = createLogger('notebooklm:succession');

export type SuccessionPhase = 'stable' | 'paused' | 'acked' | 'ready';

export interface SuccessionState {
  baselineGeneration: string;
  phase: SuccessionPhase;
  detectedGeneration?: string;
  detectedAt?: string;
  ackToken?: string;
  ackedAt?: string;
  pulsedAt?: string;
}

function statePath(): string {
  const d = dataPath('notebooklm');
  mkdirSync(d, { recursive: true });
  return join(d, 'succession.json');
}
function sealedPackPath(): string {
  const d = join(dataPath('notebooklm'), 'succession');
  mkdirSync(d, { recursive: true });
  return join(d, 'successor-pack.sealed');
}

export function loadSuccessionState(): SuccessionState | null {
  const p = statePath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as SuccessionState;
  } catch {
    return null;
  }
}

function saveState(s: SuccessionState): void {
  writeFileSync(statePath(), JSON.stringify(s, null, 2), { mode: 0o600 });
}

export interface SuccessionCheck {
  changed: boolean;
  phase: SuccessionPhase;
  from?: string;
  to?: string;
}

/**
 * Compare the current generation to the baseline. First ever call seeds the
 * baseline (stable). A generation change from a STABLE state opens the gate
 * (→ paused). While already mid-succession, returns the current phase (a second
 * change does not reset an in-flight ritual).
 */
export function checkSuccession(currentGeneration: string, now: () => Date = () => new Date()): SuccessionCheck {
  const state = loadSuccessionState();
  if (!state) {
    saveState({ baselineGeneration: currentGeneration, phase: 'stable' });
    return { changed: false, phase: 'stable' };
  }
  if (state.phase !== 'stable') {
    return { changed: false, phase: state.phase, from: state.baselineGeneration, to: state.detectedGeneration };
  }
  if (currentGeneration === state.baselineGeneration) {
    return { changed: false, phase: 'stable' };
  }
  const paused: SuccessionState = {
    ...state,
    phase: 'paused',
    detectedGeneration: currentGeneration,
    detectedAt: now().toISOString(),
  };
  saveState(paused);
  log.warn({ from: state.baselineGeneration, to: currentGeneration }, 'F64 succession detected — PAUSING autonomous work until ack + pulse');
  return { changed: true, phase: 'paused', from: state.baselineGeneration, to: currentGeneration };
}

/** The gate autonomous jobs consult: paused for the whole ritual until resume. */
export function isSuccessionPaused(): boolean {
  const s = loadSuccessionState();
  return s !== null && s.phase !== 'stable';
}

// ---------------------------------------------------------------------------
// Successor pack (sealed; may include zone-1 — invariant-1 F64 exception)
// ---------------------------------------------------------------------------

export interface SuccessorPackInputs {
  /** Read-only identity/values summary (from the signed manifest — never written). */
  identitySummary: string;
  /** Standing directives (e.g. from the F62 sealed operator model). */
  standingDirectives: string[];
  /** Open questions the predecessor leaves. */
  openQuestions: string[];
  /** Key learnings / dead ends to carry forward. */
  learnings: string[];
}

function renderPack(to: string, inputs: SuccessorPackInputs): string {
  return [
    `# Successor's notebook — for ${to}`,
    '',
    'You are inheriting an identity. Read this fully; acknowledge with the token at the end.',
    '',
    '## Identity & values (read-only, from the signed manifest)',
    inputs.identitySummary,
    '',
    '## Standing directives from the principal',
    ...(inputs.standingDirectives.length ? inputs.standingDirectives.map((d) => `- ${d}`) : ['- (none recorded)']),
    '',
    '## Open questions handed forward',
    ...(inputs.openQuestions.length ? inputs.openQuestions.map((q) => `- ${q}`) : ['- (none)']),
    '',
    '## Learnings & dead ends',
    ...(inputs.learnings.length ? inputs.learnings.map((l) => `- ${l}`) : ['- (none)']),
  ].join('\n');
}

/**
 * Build + SEAL the successor pack. Returns the ack token (bound to the pack
 * body) which the successor must echo. The pack is written as ciphertext only.
 */
export function buildSuccessorPack(inputs: SuccessorPackInputs, encKey: Buffer): { ackToken: string } {
  const state = loadSuccessionState();
  if (!state || state.phase === 'stable') throw new Error('succession: no active succession to build a pack for');
  const body = renderPack(state.detectedGeneration ?? 'the successor', inputs);
  const ackToken = createHash('sha256').update(`${state.detectedGeneration}\n${body}`).digest('hex').slice(0, 12);
  const full = `${body}\n\n## Acknowledge\nReply with: ACK ${ackToken}\n`;
  writeFileSync(sealedPackPath(), encryptZone1(Buffer.from(full, 'utf-8'), encKey), { mode: 0o600 });
  saveState({ ...state, ackToken });
  log.info({ to: state.detectedGeneration }, 'F64 successor pack sealed');
  return { ackToken };
}

/** Read + decrypt the sealed successor pack (in-harness read). */
export function readSuccessorPack(encKey: Buffer): string | null {
  const p = sealedPackPath();
  if (!existsSync(p)) return null;
  try {
    return decryptZone1(readFileSync(p), encKey).toString('utf-8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Gate transitions: ack → pulse → resume
// ---------------------------------------------------------------------------

export interface AckResult {
  accepted: boolean;
  reason: string;
}

/** The successor acknowledges the pack. Requires the exact bound token. */
export function recordSuccessionAck(body: string, now: () => Date = () => new Date()): AckResult {
  const state = loadSuccessionState();
  if (!state || state.phase === 'stable') return { accepted: false, reason: 'no active succession' };
  if (!state.ackToken) return { accepted: false, reason: 'successor pack not built yet' };
  const m = body.match(/\bACK\s+([a-f0-9]{12})\b/);
  if (!m) return { accepted: false, reason: 'no "ACK <token>" line' };
  if (m[1] !== state.ackToken) return { accepted: false, reason: 'ack token does not match the successor pack' };
  saveState({ ...state, phase: 'acked', ackedAt: now().toISOString() });
  log.info('F64 succession ACK accepted');
  return { accepted: true, reason: 'acked' };
}

/**
 * Record the identity-pulse result. Only a NON-alerting pulse (identity stable
 * across the generation change) advances the ritual. Requires a prior ack.
 */
export function recordSuccessionPulse(pulseAlert: boolean, now: () => Date = () => new Date()): { advanced: boolean; reason: string } {
  const state = loadSuccessionState();
  if (!state || state.phase === 'stable') return { advanced: false, reason: 'no active succession' };
  if (state.phase === 'paused') return { advanced: false, reason: 'ack required before the pulse' };
  if (pulseAlert) return { advanced: false, reason: 'identity pulse ALERTED — successor identity drift; gate holds for human review' };
  saveState({ ...state, phase: 'ready', pulsedAt: now().toISOString() });
  log.info('F64 succession pulse passed — ready to resume');
  return { advanced: true, reason: 'pulsed' };
}

/**
 * Resume: only when acked AND pulsed (phase 'ready'). Advances the baseline to
 * the successor generation and returns to stable. Otherwise the gate holds.
 */
export function tryResumeSuccession(): { resumed: boolean; reason: string } {
  const state = loadSuccessionState();
  if (!state) return { resumed: false, reason: 'no succession state' };
  if (state.phase !== 'ready') return { resumed: false, reason: `not ready (phase ${state.phase})` };
  saveState({ baselineGeneration: state.detectedGeneration ?? state.baselineGeneration, phase: 'stable' });
  log.info({ newBaseline: state.detectedGeneration }, 'F64 succession complete — resumed, baseline advanced');
  return { resumed: true, reason: 'resumed' };
}

/** Test hook. */
export function _resetSuccession(): void {
  const p = statePath();
  if (existsSync(p)) writeFileSync(p, JSON.stringify({ baselineGeneration: '', phase: 'stable' }));
}
