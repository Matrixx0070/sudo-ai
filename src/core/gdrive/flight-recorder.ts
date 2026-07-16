/**
 * @file gdrive/flight-recorder.ts
 * @description F10 — per-run reproducible trace bundles.
 *
 * The run data already persists as it happens (traces.db per tool/brain
 * call, gateway.db llm_calls per LLM call), so a bundle is a post-hoc join
 * on session id — no agent-loop instrumentation, nothing on the hot path.
 * Bundles gzip to ops/incidents/ (failed runs) or ops/audit/runs/ (rolling),
 * always zone-1 semantics: run payloads can contain anything the agent saw,
 * so they are ALWAYS encrypted.
 *
 * Replay is digest verification in this phase (spec-sanctioned stub —
 * record-replay determinism work is not present in the repo); gap logged in
 * DRIVE_ROADMAP_STATUS.md.
 */

import { gzipSync, gunzipSync } from 'node:zlib';
import { createLogger } from '../shared/logger.js';
import type { DriveClient } from './client.js';
import type { FolderIdMap } from './types.js';
import type { BrainKeys } from './keys.js';
import { sha256Hex } from './manifest.js';
import { encryptZone1, decryptZone1 } from './zones.js';
import { Readable } from 'node:stream';

const log = createLogger('gdrive:flight-recorder');

// Duck-typed store surfaces (real impls: TraceStore.query, GatewayCallLog).
export interface TraceQueryLike {
  query(q: { sessionId?: string; limit?: number }): unknown[];
}

export interface RunBundle {
  schemaVersion: 1;
  runId: string;
  sessionId: string;
  startedAt: string;
  finishedAt: string;
  outcome: 'success' | 'failure';
  /** sha256 of the config snapshot in effect (never the config itself). */
  configSnapshotHash?: string;
  /** Brain manifest counter at run start (pairs with F9 bisection). */
  manifestCounter?: number;
  traces: unknown[];
  llmCalls: unknown[];
  events: unknown[];
  /** Digest over the canonical payload — replay verification anchor. */
  digest: string;
}

function computeBundleDigest(bundle: Omit<RunBundle, 'digest'>): string {
  return sha256Hex(
    JSON.stringify({
      runId: bundle.runId,
      sessionId: bundle.sessionId,
      traces: bundle.traces,
      llmCalls: bundle.llmCalls,
      events: bundle.events,
    }),
  );
}

export interface BuildBundleParams {
  runId: string;
  sessionId: string;
  startedAt: string;
  finishedAt: string;
  outcome: 'success' | 'failure';
  configSnapshotHash?: string;
  manifestCounter?: number;
  /** Optional live-loop event digests supplied by the caller. */
  events?: unknown[];
  traceStore?: TraceQueryLike;
  /** Pre-queried gateway llm_calls rows for the session. */
  llmCalls?: unknown[];
}

/** Assemble a bundle from the persisted stores (post-hoc join). */
export function buildRunBundle(params: BuildBundleParams): RunBundle {
  const traces = params.traceStore?.query({ sessionId: params.sessionId, limit: 10_000 }) ?? [];
  const unsigned: Omit<RunBundle, 'digest'> = {
    schemaVersion: 1,
    runId: params.runId,
    sessionId: params.sessionId,
    startedAt: params.startedAt,
    finishedAt: params.finishedAt,
    outcome: params.outcome,
    configSnapshotHash: params.configSnapshotHash,
    manifestCounter: params.manifestCounter,
    traces,
    llmCalls: params.llmCalls ?? [],
    events: params.events ?? [],
  };
  return { ...unsigned, digest: computeBundleDigest(unsigned) };
}

/** Serialize: JSON -> gzip -> AES-256-GCM (always encrypted). */
export function packBundle(bundle: RunBundle, keys: BrainKeys): Buffer {
  if (!keys.encKey) throw new Error('flight-recorder: BRAIN_ENC_KEY_PATH required for run bundles');
  return encryptZone1(gzipSync(Buffer.from(JSON.stringify(bundle), 'utf-8')), keys.encKey);
}

export function unpackBundle(wire: Buffer, keys: BrainKeys): RunBundle {
  if (!keys.encKey) throw new Error('flight-recorder: BRAIN_ENC_KEY_PATH required to read bundles');
  return JSON.parse(gunzipSync(decryptZone1(wire, keys.encKey)).toString('utf-8')) as RunBundle;
}

/**
 * Replay stub (spec-sanctioned): re-verify the bundle digest against its own
 * payload. True re-execution lands when record-replay determinism exists.
 */
export function verifyBundle(bundle: RunBundle): { ok: boolean; expected: string; actual: string } {
  const actual = computeBundleDigest(bundle);
  return { ok: actual === bundle.digest, expected: bundle.digest, actual };
}

/**
 * Upload: failures -> ops/incidents/ (kept), successes -> ops/audit/runs/
 * (rolling; retention handled by the GC/retention job later).
 */
export async function uploadBundle(
  client: DriveClient,
  folders: FolderIdMap,
  bundle: RunBundle,
  keys: BrainKeys,
): Promise<{ fileId: string; folder: string }> {
  const folderLogical = bundle.outcome === 'failure' ? 'ops/incidents' : 'ops/audit';
  const folderId = folders[folderLogical];
  if (!folderId) throw new Error(`flight-recorder: folder id missing for ${folderLogical}`);
  const wire = packBundle(bundle, keys);
  const created = await client.filesCreate(
    { name: `run-${bundle.runId}.json.gz.enc`, parents: [folderId] },
    { mimeType: 'application/octet-stream', body: Readable.from(wire) },
  );
  log.info({ runId: bundle.runId, folder: folderLogical, bytes: wire.length }, 'run bundle uploaded');
  return { fileId: created.id, folder: folderLogical };
}
