/**
 * @file tests/privacy/zdr-persistence.test.ts
 * @description F105 — ZDR is honored at every user-content persistence path.
 *
 * For each newly-guarded store: with SUDO_ZDR on, user content is absent/redacted
 * while operational metadata (hashes, tokens, counts, timestamps, delivery state)
 * still persists; with ZDR off behavior is unchanged. Plus the per-channel
 * privacy hook (a channel marked 'zdr' gets ZDR semantics even when the global
 * flag is off).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  __resetZDRManager,
  setChannelPrivacy,
  getChannelPrivacy,
  isChannelZDR,
  isZDRBlocked,
  isZDRBlockedForChannel,
  loadChannelPrivacyFromEnv,
  clearChannelPrivacy,
} from '../../src/core/privacy/zdr-mode.js';
import { TraceStore } from '../../src/core/learning/trace-store.js';
import { GatewayCallLog } from '../../src/llm/logging.js';
import { ConsciousnessDB } from '../../src/core/consciousness/consciousness-db.js';
import { EpisodicMemory } from '../../src/core/consciousness/episodic-memory/index.js';
import type { Episode } from '../../src/core/consciousness/episodic-memory/types.js';
import { DeliveryQueue } from '../../src/core/channels/delivery-queue.js';
import { saveMemory, getMemory } from '../../src/core/memory/structured-memory.js';
import { DATA_DIR } from '../../src/core/shared/paths.js';

// --- env helpers ------------------------------------------------------------
let savedZdr: string | undefined;
let savedChannels: string | undefined;

function zdrOn(): void {
  process.env['SUDO_ZDR'] = '1';
  __resetZDRManager();
  isZDRBlocked('memory_write'); // force resolve from env
}
function zdrOff(): void {
  delete process.env['SUDO_ZDR'];
  __resetZDRManager();
  isZDRBlocked('memory_write');
}

beforeEach(() => {
  savedZdr = process.env['SUDO_ZDR'];
  savedChannels = process.env['SUDO_ZDR_CHANNELS'];
  delete process.env['SUDO_ZDR'];
  delete process.env['SUDO_ZDR_CHANNELS'];
  __resetZDRManager();
});
afterEach(() => {
  if (savedZdr === undefined) delete process.env['SUDO_ZDR']; else process.env['SUDO_ZDR'] = savedZdr;
  if (savedChannels === undefined) delete process.env['SUDO_ZDR_CHANNELS']; else process.env['SUDO_ZDR_CHANNELS'] = savedChannels;
  __resetZDRManager();
});

// ---------------------------------------------------------------------------
// 1) traces.db — raw prompt/response/args/result capture
// ---------------------------------------------------------------------------
describe('F105 traces.db raw capture', () => {
  let dir: string;
  let dbPath: string;
  let savedCapture: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'zdr-trace-'));
    dbPath = path.join(dir, 'traces.db');
    savedCapture = process.env['SUDO_TRACE_CAPTURE'];
    process.env['SUDO_TRACE_CAPTURE'] = '1'; // capture ON so raw fields WOULD be written
  });
  afterEach(() => {
    if (savedCapture === undefined) delete process.env['SUDO_TRACE_CAPTURE']; else process.env['SUDO_TRACE_CAPTURE'] = savedCapture;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('ZDR ON: raw args/result/prompt/response absent, hashes + metadata kept', async () => {
    zdrOn();
    const store = new TraceStore(dbPath);
    await store.init();
    store.recordToolCall('s1', 'search', true, 5, undefined, { q: 'secret user query' }, { output: 'private result' });
    store.recordBrainCall('s1', 'grok', true, 12, { total: 30 }, undefined, { prompt: 'user prompt text', response: 'model reply text' });

    const tool = store.query({ sessionId: 's1', toolName: 'search' })[0];
    expect(tool.argsRaw).toBeUndefined();
    expect(tool.resultRaw).toBeUndefined();
    expect(tool.argsHash).toBeTruthy();      // hash (operational) still kept
    expect(tool.resultHash).toBeTruthy();

    const brain = store.query({ sessionId: 's1', type: 'brain_call' })[0];
    expect(brain.promptRaw).toBeUndefined();
    expect(brain.responseRaw).toBeUndefined();
    expect(brain.tokenUsage?.total).toBe(30); // metadata still kept
    store.close();
  });

  it('ZDR OFF: raw capture unchanged (payloads present)', async () => {
    zdrOff();
    const store = new TraceStore(dbPath);
    await store.init();
    store.recordToolCall('s2', 'search', true, 5, undefined, { q: 'hello' }, { output: 'ok' });
    store.recordBrainCall('s2', 'grok', true, 12, { total: 30 }, undefined, { prompt: 'p', response: 'r' });

    const tool = store.query({ sessionId: 's2', toolName: 'search' })[0];
    expect(tool.argsRaw).toBe(JSON.stringify({ q: 'hello' }));
    const brain = store.query({ sessionId: 's2', type: 'brain_call' })[0];
    expect(brain.promptRaw).toBe('p');
    expect(brain.responseRaw).toBe('r');
    store.close();
  });
});

// ---------------------------------------------------------------------------
// 2) gateway.db — ir_request / ir_response
// ---------------------------------------------------------------------------
describe('F105 gateway.db ir_request/ir_response', () => {
  let dir: string;
  let dbPath: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'zdr-gw-'));
    dbPath = path.join(dir, 'gateway.db');
  });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  function readRow(traceId: string): Record<string, unknown> | undefined {
    const db = new Database(dbPath, { readonly: true });
    try { return db.prepare('SELECT * FROM llm_calls WHERE trace_id = ?').get(traceId) as Record<string, unknown>; }
    finally { db.close(); }
  }

  it('ZDR ON: ir_request/ir_response NULL, caller/tokens/fingerprint kept', () => {
    zdrOn();
    const gw = new GatewayCallLog(dbPath);
    gw.record({
      traceId: 't1', caller: 'agent-loop', tokensIn: 10, tokensOut: 5, costUsd: 0.01,
      irRequest: { messages: [{ role: 'user', content: 'secret prompt' }] },
      irResponse: { content: 'secret reply' },
    });
    gw.close();
    const row = readRow('t1')!;
    expect(row.ir_request).toBeNull();
    expect(row.ir_response).toBeNull();
    expect(row.caller).toBe('agent-loop');   // metadata kept
    expect(row.tokens_in).toBe(10);
    expect(row.content_sha256).toBeTruthy();  // dedup fingerprint kept
  });

  it('ZDR OFF: ir_request/ir_response persisted (redacted-but-present)', () => {
    zdrOff();
    const gw = new GatewayCallLog(dbPath);
    gw.record({
      traceId: 't2', caller: 'agent-loop',
      irRequest: { messages: [{ role: 'user', content: 'hello world' }] },
      irResponse: { content: 'hi there' },
    });
    gw.close();
    const row = readRow('t2')!;
    expect(row.ir_request).not.toBeNull();
    expect(String(row.ir_request)).toContain('hello world');
    expect(String(row.ir_response)).toContain('hi there');
  });
});

// ---------------------------------------------------------------------------
// 3) episodic memory (consciousness.db)
// ---------------------------------------------------------------------------
describe('F105 episodic memory writes', () => {
  let dir: string;
  let cdb: ConsciousnessDB;
  let em: EpisodicMemory;

  function ep(id: string): Episode {
    const now = new Date().toISOString();
    return {
      id, summary: `episode ${id}`, participants: ['user-1'], topic: 'testing', tags: [],
      emotionalValence: { tags: ['calm'], dominantEmotion: 'calm', intensity: 0.3 },
      surpriseLevel: 0, outcome: 'neutral', significance: 0.5, sessionId: 's1',
      startedAt: now, endedAt: now, durationMs: 0,
    };
  }

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'zdr-epi-'));
    cdb = new ConsciousnessDB(path.join(dir, 'consciousness.db'));
    em = new EpisodicMemory(cdb);
  });
  afterEach(() => {
    try { cdb.getDb().close(); } catch { /* ignore */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('ZDR ON: episode not persisted', () => {
    zdrOn();
    em.recordEpisode(ep('e1'));
    expect(em.getRecent(10).length).toBe(0);
  });

  it('ZDR OFF: episode persisted', () => {
    zdrOff();
    em.recordEpisode(ep('e2'));
    const recent = em.getRecent(10);
    expect(recent.length).toBe(1);
    expect(recent[0].id).toBe('e2');
  });
});

// ---------------------------------------------------------------------------
// 4) structured memory store
// ---------------------------------------------------------------------------
describe('F105 structured memory writes', () => {
  const writtenIds: Array<{ type: string; id: string }> = [];
  afterEach(() => {
    for (const { type, id } of writtenIds) {
      try { rmSync(path.join(DATA_DIR, 'structured-memory', `${type}_${id}.json`), { force: true }); } catch { /* ignore */ }
    }
    writtenIds.length = 0;
  });

  it('ZDR ON: saveMemory returns record but writes nothing to disk', async () => {
    zdrOn();
    const rec = await saveMemory({ type: 'semantic', name: 'zdr-fact', content: 'sensitive content' });
    expect(rec.name).toBe('zdr-fact');           // usable in-memory object returned
    await expect(getMemory('semantic', rec.id)).rejects.toThrow(); // nothing persisted
  });

  it('ZDR OFF: saveMemory persists to disk', async () => {
    zdrOff();
    const rec = await saveMemory({ type: 'semantic', name: 'kept-fact', content: 'ordinary content' });
    writtenIds.push({ type: 'semantic', id: rec.id });
    const loaded = await getMemory('semantic', rec.id);
    expect(loaded.content).toBe('ordinary content');
  });
});

// ---------------------------------------------------------------------------
// 5) channel outbox payload persistence + per-channel hook
// ---------------------------------------------------------------------------
describe('F105 channel outbox payload persistence', () => {
  let dir: string;
  let q: DeliveryQueue;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'zdr-dq-'));
    q = new DeliveryQueue(path.join(dir, 'deliveries.db'), { mediaDir: path.join(dir, 'media') });
  });
  afterEach(() => {
    try { q.close(); } catch { /* ignore */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const okDeliver = async () => { /* platform accepted */ };

  it('ZDR ON (global): payload tombstoned after ack, row + state kept', async () => {
    zdrOn();
    const id = q.enqueue({ channel: 'telegram', account: 'default', peer: 'u1', text: 'reply body text' });
    const state = await q.dispatchOne(okDeliver);
    expect(state).toBe('acked');
    const row = q.get(id)!;
    expect(row.state).toBe('acked');            // delivery metadata preserved
    const payload = JSON.parse(row.payload_ref);
    expect(payload.text).toBe('');              // user content purged post-delivery
    expect(payload._zdrRedacted).toBe(true);
  });

  it('ZDR OFF (global): payload retained after ack', async () => {
    zdrOff();
    const id = q.enqueue({ channel: 'telegram', account: 'default', peer: 'u1', text: 'reply body text' });
    await q.dispatchOne(okDeliver);
    const payload = JSON.parse(q.get(id)!.payload_ref);
    expect(payload.text).toBe('reply body text');
  });

  it('per-channel: a channel marked zdr tombstones even when global flag OFF', async () => {
    zdrOff();
    setChannelPrivacy('telegram', 'zdr');
    const zdrId = q.enqueue({ channel: 'telegram', account: 'default', peer: 'u1', text: 'private tg reply' });
    const webId = q.enqueue({ channel: 'web', account: 'default', peer: 'u2', text: 'public web reply' });
    await q.dispatchOne(okDeliver); // telegram (enqueued first)
    await q.dispatchOne(okDeliver); // web
    expect(JSON.parse(q.get(zdrId)!.payload_ref).text).toBe('');           // channel zdr → purged
    expect(JSON.parse(q.get(webId)!.payload_ref).text).toBe('public web reply'); // standard → kept
    clearChannelPrivacy();
  });
});

// ---------------------------------------------------------------------------
// 6) per-channel privacy hook (unit)
// ---------------------------------------------------------------------------
describe('F105 per-channel privacy hook', () => {
  afterEach(() => clearChannelPrivacy());

  it('setChannelPrivacy / isChannelZDR / getChannelPrivacy', () => {
    zdrOff();
    expect(isChannelZDR('email')).toBe(false);
    setChannelPrivacy('email', 'zdr');
    expect(isChannelZDR('email')).toBe(true);
    expect(getChannelPrivacy('email')).toBe('zdr');
    setChannelPrivacy('email', 'standard');
    expect(isChannelZDR('email')).toBe(false);
  });

  it('isZDRBlockedForChannel: channel zdr blocks content ops, not telemetry', () => {
    zdrOff();
    setChannelPrivacy('sms', 'zdr');
    expect(isZDRBlockedForChannel('session_persistence', 'sms')).toBe(true);
    expect(isZDRBlockedForChannel('memory_write', 'sms')).toBe(true);
    expect(isZDRBlockedForChannel('telemetry', 'sms')).toBe(false);   // metadata op unaffected
    expect(isZDRBlockedForChannel('session_persistence', 'web')).toBe(false); // other channel unaffected
  });

  it('global ZDR blocks all channels regardless of per-channel policy', () => {
    zdrOn();
    expect(isZDRBlockedForChannel('session_persistence', 'anything')).toBe(true);
    expect(isZDRBlockedForChannel('session_persistence', undefined)).toBe(true);
  });

  it('loadChannelPrivacyFromEnv registers SUDO_ZDR_CHANNELS list', () => {
    zdrOff();
    loadChannelPrivacyFromEnv({ SUDO_ZDR_CHANNELS: 'telegram, email  slack' } as NodeJS.ProcessEnv);
    expect(isChannelZDR('telegram')).toBe(true);
    expect(isChannelZDR('email')).toBe(true);
    expect(isChannelZDR('slack')).toBe(true);
    expect(isChannelZDR('web')).toBe(false);
  });
});
