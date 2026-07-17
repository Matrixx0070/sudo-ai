/**
 * @file notebooklm/returns.ts
 * @description E2 returns pipeline. Everything a human pastes back from
 * NotebookLM lands in notebooklm/returns/ and re-enters as UNTRUSTED external
 * model text (invariant 2). Flow per file:
 *   parse filename → (unparseable → held/) → QUARANTINE (always, before ANY
 *   model, including a special route) → route: default = memory API with tier
 *   + category by convention; special routes (probes→E4, audio→F59) change the
 *   DESTINATION only, never the inspection → move original to processed/.
 *
 * Filename: F<id>.<type>.<YYYY-MM-DD>[.approved].md|txt|json
 */

import { createLogger } from '../shared/logger.js';
import type { AuditTrail } from '../security/audit-trail.js';
import type { DriveClient } from '../gdrive/client.js';
import type { ChunkStoreLike, StructuredStoreLike } from '../gdrive/brain-serializer.js';
import { inspectContent, type InspectOptions } from '../gdrive/quarantine.js';
import { chunkText } from '../gdrive/inbox.js';
import { sha256Hex } from '../gdrive/manifest.js';
import { emitGdriveAudit } from '../gdrive/audit.js';
import { classifyZone } from '../gdrive/zones.js';
import type { TrustTier } from '../gdrive/trust.js';
import type { NlmFolderMap } from './folders.js';

const log = createLogger('notebooklm:returns');

// ---------------------------------------------------------------------------
// Filename parsing
// ---------------------------------------------------------------------------

export interface ParsedReturn {
  featureId: string; // e.g. "F57"
  type: string; // e.g. "mirror-account"
  /** Third segment: a YYYY-MM-DD date OR an id (F43 uses an incident id). */
  date: string;
  approved: boolean;
  ext: 'md' | 'txt' | 'json';
  raw: string;
}

// Third segment is a date OR an id token (e.g. F43.postmortem.<incidentId>.md).
const RETURN_RE = /^(F\d{1,3})\.([a-z0-9-]+)\.([A-Za-z0-9][A-Za-z0-9-]*)(\.approved)?\.(md|txt|json)$/i;

export function parseReturnFilename(name: string): ParsedReturn | null {
  const m = RETURN_RE.exec(name);
  if (!m) return null;
  return {
    featureId: m[1]!.toUpperCase(),
    type: m[2]!.toLowerCase(),
    date: m[3]!,
    approved: Boolean(m[4]),
    ext: m[5]!.toLowerCase() as 'md' | 'txt' | 'json',
    raw: name,
  };
}

/** category by type keyword (spec conventions). */
export function categoryFor(type: string): string {
  if (/operator-model|principal-model/.test(type)) return 'operator-model';
  if (/bias-|taxonomy/.test(type)) return 'bias-priors';
  if (/precedent/.test(type)) return 'precedent';
  if (/reception/.test(type)) return 'reception';
  if (/mirror-account|self-model/.test(type)) return 'self-model';
  return 'knowledge';
}

/** tier by convention: default self_acquired; .approved → principal. */
export function tierFor(parsed: ParsedReturn): TrustTier {
  return parsed.approved ? 'principal' : 'self_acquired';
}

// ---------------------------------------------------------------------------
// Route registry (special routes plug in during N2/N3; default = memory)
// ---------------------------------------------------------------------------

export interface ReturnRouteCtx {
  parsed: ParsedReturn;
  /** ALREADY quarantined (clean) content. */
  content: string;
  deps: ReturnsDeps;
}
/** A route handles its own destination and returns a short label. */
export type ReturnRoute = (ctx: ReturnRouteCtx) => Promise<string>;

const ROUTES = new Map<string, ReturnRoute>();

/** key: `${featureId}` (broad) or `${featureId}:${type}` (specific). */
export function registerReturnRoute(key: string, fn: ReturnRoute): void {
  ROUTES.set(key.toUpperCase(), fn);
}
function findRoute(parsed: ParsedReturn): ReturnRoute | undefined {
  return ROUTES.get(`${parsed.featureId}:${parsed.type}`.toUpperCase()) ?? ROUTES.get(parsed.featureId);
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

export interface ReturnsDeps {
  client: DriveClient;
  folders: NlmFolderMap;
  audit: AuditTrail | null;
  chunks: ChunkStoreLike;
  structured: StructuredStoreLike;
  inspect?: InspectOptions;
  /** Optional forced-tier overrides per featureId (F67 embassy → external). */
  forcedTier?: Record<string, TrustTier>;
}

export interface ReturnsSweepResult {
  ingested: string[];
  routed: Array<{ file: string; route: string }>;
  held: string[];
  skipped: string[];
}

export async function processReturnsOnce(deps: ReturnsDeps): Promise<ReturnsSweepResult> {
  const result: ReturnsSweepResult = { ingested: [], routed: [], held: [], skipped: [] };
  const returnsId = deps.folders['notebooklm/returns'];
  const processedId = deps.folders['notebooklm/returns/processed'];
  const heldId = deps.folders['notebooklm/returns/held'];
  if (!returnsId || !processedId || !heldId) {
    throw new Error('returns: folder ids missing — ensure the notebooklm tree');
  }

  for (const file of await deps.client.listChildren(returnsId)) {
    if (file.mimeType === 'application/vnd.google-apps.folder') continue;
    const parsed = parseReturnFilename(file.name);
    if (!parsed) {
      await deps.client.filesUpdate(file.id, { addParents: heldId, removeParents: returnsId });
      result.held.push(file.name);
      log.warn({ name: file.name }, 'unparseable return filename — held');
      continue;
    }

    let content: string;
    try {
      content = await deps.client.filesDownload(file.id);
    } catch (err) {
      log.warn({ name: file.name, err: String(err) }, 'return download failed — retry next sweep');
      continue;
    }

    // QUARANTINE ALWAYS — before any model (incl. a special route) reads it.
    const verdict = await inspectContent(content, deps.inspect ?? {});
    if (verdict.verdict === 'hold') {
      await deps.client.filesUpdate(file.id, { addParents: heldId, removeParents: returnsId });
      result.held.push(file.name);
      emitGdriveAudit(deps.audit, {
        job: 'nlm-return',
        outcome: 'denied',
        durationMs: 0,
        filesTouched: [file.id],
        detail: { name: file.name, riskScore: verdict.riskScore, reasons: verdict.reasons.slice(0, 8) },
      });
      continue;
    }

    // Special route? (destination changes; inspection already done)
    const route = findRoute(parsed);
    if (route) {
      try {
        const label = await route({ parsed, content, deps });
        await deps.client.filesUpdate(file.id, { addParents: processedId, removeParents: returnsId });
        result.routed.push({ file: file.name, route: label });
        continue;
      } catch (err) {
        log.warn({ name: file.name, err: String(err) }, 'special route failed — file left for retry');
        continue;
      }
    }

    // Default route → memory API with tier + category by convention.
    const tier = deps.forcedTier?.[parsed.featureId] ?? tierFor(parsed);
    const category = categoryFor(parsed.type);
    const contentSha = sha256Hex(content);
    const chunkPrefix = `nlm/${parsed.featureId}/${parsed.type}`;
    for (const piece of chunkText(content)) {
      deps.chunks.storeChunk(piece, chunkPrefix, 'learning', { role: 'user' });
    }
    const zone = classifyZone(content) === 0 ? 2 : classifyZone(content);
    await deps.structured.saveMemory({
      type: 'reference',
      id: `nlm-${parsed.featureId}-${parsed.type}-${parsed.date}`,
      name: `NotebookLM return: ${parsed.featureId} ${parsed.type}`,
      description: `${category} · tier ${tier} · quarantine clean · returned ${parsed.date}`,
      content: JSON.stringify({
        sourceName: file.name,
        featureId: parsed.featureId,
        returnType: parsed.type,
        category,
        trustTier: tier,
        zone,
        ingestedAt: (new Date()).toISOString(),
        contentSha256: contentSha,
        quarantineVerdict: parsed.approved ? 'approved' : 'clean',
      }),
    });

    await deps.client.filesUpdate(file.id, { addParents: processedId, removeParents: returnsId });
    await deps.client.filesCreate(
      { name: `${file.name}.ingested.json`, parents: [processedId] },
      { mimeType: 'application/json', body: JSON.stringify({ featureId: parsed.featureId, type: parsed.type, tier, category, contentSha256: contentSha }, null, 2) },
    );
    result.ingested.push(file.name);
    emitGdriveAudit(deps.audit, {
      job: 'nlm-return',
      outcome: 'success',
      durationMs: 0,
      filesTouched: [file.id],
      inputsDigest: contentSha,
      detail: { name: file.name, tier, category },
    });
  }

  if (result.ingested.length || result.held.length || result.routed.length) {
    log.info(result, 'returns sweep complete');
  }
  return result;
}

/** Held-file names (for the self-report). */
export async function listHeldReturns(deps: Pick<ReturnsDeps, 'client' | 'folders'>): Promise<string[]> {
  const heldId = deps.folders['notebooklm/returns/held'];
  if (!heldId) return [];
  return (await deps.client.listChildren(heldId)).map((f) => f.name);
}
