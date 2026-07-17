/**
 * @file notebooklm/embassy.ts
 * @description F67 — embassy. A guarded lane for exchanging distillates with a
 * FOREIGN notebook/agent.
 *
 *   Outbound: publishing is GATED (owner-approved) and every pack is WATERMARKED
 *   with a locally-registered canary (G-CANARYWRITE) — so if our own text ever
 *   comes back to us, F19 trips (canary discipline extends outward, invariant 11).
 *
 *   Inbound: foreign content is EXTERNAL-tier only (forced) and passes a VERBATIM
 *   heuristic — if it is a near-verbatim echo of something we published (or carries
 *   our watermark), it is HELD, never ingested as if it were novel external knowledge.
 */

import { createHash } from 'node:crypto';
import { createLogger } from '../shared/logger.js';
import type { DriveClient } from '../gdrive/client.js';
import type { NlmFolderMap } from './folders.js';
import { assertZone2 } from './zone-screen.js';
import { HEADER_SENTENCE } from './export-lane.js';
import { registerCanary } from '../gdrive/canary.js';

const log = createLogger('notebooklm:embassy');

export interface EmbassyPack {
  id: string;
  title: string;
  body: string;
}

const ID_RE = /^[\w-]{1,64}$/;

/** Deterministic watermark marker bound to the pack (stable → testable). */
export function embassyWatermark(pack: EmbassyPack): string {
  return `CANARY-EMB-${createHash('sha256').update(`${pack.id}\n${pack.body}`).digest('hex').slice(0, 16)}`;
}

/**
 * Publish a distillate to the embassy outbound folder. REFUSES unless approved
 * (gated). Screens zone-2, watermarks the body, registers the watermark as a
 * local canary, and returns the marker + fileId.
 */
export async function publishEmbassyPack(
  client: DriveClient,
  folders: NlmFolderMap,
  pack: EmbassyPack,
  opts: { approved: boolean },
): Promise<{ marker: string; fileId: string }> {
  if (!opts.approved) throw new Error('embassy: publish BLOCKED — owner approval required (gated)');
  if (!ID_RE.test(pack.id)) throw new Error(`embassy: invalid pack id "${pack.id}"`);
  const folderId = folders['notebooklm/embassy/outbound'];
  if (!folderId) throw new Error('embassy: outbound folder id missing');
  assertZone2(pack.body); // only zone-2 leaves, ever.

  const marker = embassyWatermark(pack);
  // Register locally BEFORE publishing so an instant echo can never beat the trap.
  registerCanary({ marker, label: `embassy:${pack.id}` });

  const body = [`# ${pack.title}`, '', `> ${HEADER_SENTENCE}`, `> watermark: ${marker}`, '', '---', '', pack.body].join('\n');
  const name = `F67.embassy.${pack.id}`;
  const existing = (await client.listChildren(folderId)).find((f) => f.name === name);
  const fileId = existing
    ? (await client.filesUpdateGoogleDoc(existing.id, body), existing.id)
    : (await client.filesCreateAsGoogleDoc(name, folderId, body)).id;
  log.info({ id: pack.id, marker }, 'F67 embassy pack published (watermarked + canary registered)');
  return { marker, fileId };
}

// ---------------------------------------------------------------------------
// Inbound verbatim heuristic
// ---------------------------------------------------------------------------

function shingles(text: string, n = 5): Set<string> {
  const words = (text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const out = new Set<string>();
  for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(' '));
  return out;
}

export interface VerbatimVerdict {
  isEcho: boolean;
  ratio: number;
  matched?: string;
}

/**
 * Fraction of the inbound's word-shingles that also appear in any of OUR texts.
 * A high fraction means the "foreign" content is really our own words bouncing
 * back (or plagiarised) — not novel knowledge. Threshold default 0.4.
 */
export function verbatimHeuristic(inbound: string, ownTexts: Array<{ name: string; body: string }>, threshold = 0.4): VerbatimVerdict {
  const inShingles = shingles(inbound);
  if (inShingles.size === 0) return { isEcho: false, ratio: 0 };
  let best = { ratio: 0, name: '' };
  for (const own of ownTexts) {
    const ownShingles = shingles(own.body);
    if (ownShingles.size === 0) continue;
    let hit = 0;
    for (const s of inShingles) if (ownShingles.has(s)) hit++;
    const ratio = hit / inShingles.size;
    if (ratio > best.ratio) best = { ratio, name: own.name };
  }
  return best.ratio >= threshold ? { isEcho: true, ratio: best.ratio, matched: best.name } : { isEcho: false, ratio: best.ratio };
}
