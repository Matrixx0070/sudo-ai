/**
 * @file grok-realtime-voice.ts
 * @description Path A — one realtime voice turn with grok's own voice agent
 * (grok-as-agent), over LiveKit, browserless, on the $30 subscription seat.
 *
 * grok.com voice mode runs on LiveKit (WebRTC). The seat mints a room token for
 * free (POST /rest/livekit/tokens, cookies only, statsig-free); joining the room
 * auto-dispatches grok's "prod" voice agent. `grokRealtimeVoiceTurn` speaks the
 * user's audio into the room and captures the agent's spoken reply — a full
 * realtime turn, no browser, no metered api.x.ai.
 *
 * Reuses the shared `SUDO_GROK_WEBSESSION` gate + session manager. Secrets never
 * logged; callers get audio bytes back, never cookie material.
 */

import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from '../core/shared/paths.js';
import { createLogger } from '../core/shared/logger.js';
import {
  getGrokWebSessionManager,
  GrokWebReloginRequiredError,
  type GrokWebSessionManager,
} from './grok-web-session-manager.js';
import { callGrokLivekitBridge } from './grok-livekit-bridge.js';
import { isGrokWebSessionEnabled, GrokWebDisabledError } from './grok-web-media.js';
import type { GrokWebCreds } from './grok-web-bridge.js';

const log = createLogger('llm:grok-realtime-voice');

const VOICE_DIR = path.join(DATA_DIR, 'grok-realtime-voice');

export interface GrokRealtimeDeps {
  manager: GrokWebSessionManager;
  bridge: typeof callGrokLivekitBridge;
  now: () => number;
}

export interface GrokRealtimeVoiceResult {
  /** The agent's spoken reply as a 48 kHz mono WAV. */
  replyWav: Buffer;
  durationMs: number;
  agentIdentity?: string;
}

function defaultDeps(): GrokRealtimeDeps {
  return { manager: getGrokWebSessionManager(), bridge: callGrokLivekitBridge, now: () => Date.now() };
}

/**
 * Speak `inputWav` to grok's realtime voice agent and capture its spoken reply.
 * `inputWav` may be any ffmpeg-decodable container (wav/mp3/ogg…). Returns the
 * reply WAV. Throws GrokWebDisabledError when the flag is off and
 * GrokWebReloginRequiredError when the seat session is dead.
 */
export async function grokRealtimeVoiceTurn(
  inputWav: Buffer,
  opts: { captureSeconds?: number; deps?: GrokRealtimeDeps } = {},
): Promise<GrokRealtimeVoiceResult> {
  if (!Buffer.isBuffer(inputWav) || inputWav.length === 0) {
    throw new TypeError('grokRealtimeVoiceTurn: inputWav must be a non-empty Buffer');
  }
  if (!isGrokWebSessionEnabled()) throw new GrokWebDisabledError();

  const deps = opts.deps ?? defaultDeps();
  const session = await deps.manager.ensureHealthy(); // throws GrokWebReloginRequiredError on dead sso
  const creds: GrokWebCreds = { cookie: session.cookie, userAgent: session.userAgent };

  await mkdir(VOICE_DIR, { recursive: true });
  const stamp = deps.now();
  const inPath = path.join(VOICE_DIR, `in-${stamp}.wav`);
  const outPath = path.join(VOICE_DIR, `reply-${stamp}.wav`);
  await writeFile(inPath, inputWav, { mode: 0o600 });

  try {
    const r = await deps.bridge(
      { inputWav: inPath, outputPath: outPath, ...(opts.captureSeconds ? { captureSeconds: opts.captureSeconds } : {}) },
      creds,
    );
    if (!r.ok || !r.path) {
      throw new Error(`Grok realtime voice failed: ${r.errorClass ?? 'unknown'}${r.detail ? ` (${r.detail})` : ''}`);
    }
    const replyWav = await readFile(r.path);
    log.info({ bytes: replyWav.length, durationMs: r.durationMs, agent: r.agentIdentity }, 'grok realtime voice turn complete');
    return {
      replyWav,
      durationMs: r.durationMs ?? 0,
      ...(r.agentIdentity ? { agentIdentity: r.agentIdentity } : {}),
    };
  } finally {
    await rm(inPath, { force: true }).catch(() => undefined);
    // Leave the reply on disk only if the caller wants it; we return the bytes.
    await rm(outPath, { force: true }).catch(() => undefined);
  }
}

export { GrokWebReloginRequiredError, GrokWebDisabledError, isGrokWebSessionEnabled };
