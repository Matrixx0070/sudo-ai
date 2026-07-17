/**
 * @file gdrive/inbox.ts
 * @description F1 — the knowledge inbox: files dropped in Drive become memory.
 *
 * Per file in knowledge/inbox/:
 *   canary fileId check -> size cap -> type-route (Google Doc export /
 *   text download / OCR import for images+PDFs, F15) -> canary marker check
 *   -> quarantine + inspection (F18) ->
 *     clean: chunk -> ingest via the MEMORY API (storeChunk, role 'user' =>
 *            full injection scan) + provenance (F16 ACL tier, citations
 *            fileId@revisionId) -> move original to knowledge/processed/ +
 *            ingestion record beside it
 *     hold:  move original to knowledge/quarantine/ (report already written)
 *
 * Every outcome audits. A canary hit aborts the whole sweep (F19 pause).
 */

import { createLogger } from '../shared/logger.js';
import type { AuditTrail } from '../security/audit-trail.js';
import type { DriveClient } from './client.js';
import type { FolderIdMap, GdriveFileMeta } from './types.js';
import type { ChunkStoreLike, StructuredStoreLike } from './brain-serializer.js';
import { quarantineAndInspect, type InspectOptions } from './quarantine.js';
import { ocrViaDriveImport, OCR_CONVERTIBLE_MIMES, looksLikeUsableText } from './ocr.js';
import { deriveTrustTier, type TrustContext, type ProvenanceRecord } from './trust.js';
import { classifyZone } from './zones.js';
import { sha256Hex } from './manifest.js';
import { emitGdriveAudit } from './audit.js';
import {
  loadCanaryConfig,
  checkCanaryFileId,
  checkCanaryPayload,
  tripCanary,
  isGdrivePaused,
} from './canary.js';

const log = createLogger('gdrive:inbox');

export const DEFAULT_MAX_SOURCE_BYTES = 20 * 1024 * 1024; // 20 MB (spec)
const CHUNK_CHARS = 4_000;

export interface InboxDeps {
  client: DriveClient;
  folders: FolderIdMap;
  audit: AuditTrail | null;
  chunks: ChunkStoreLike;
  structured: StructuredStoreLike;
  trustCtx: TrustContext;
  inspect?: InspectOptions;
  maxSourceBytes?: number;
}

export interface InboxSweepResult {
  processed: string[];
  held: string[];
  skipped: string[];
  aborted?: 'canary' | 'paused';
}

/** Simple paragraph-preserving splitter (bounded chunks for storeChunk). */
export function chunkText(text: string, maxChars = CHUNK_CHARS): string[] {
  if (text.length <= maxChars) return [text];
  const out: string[] = [];
  let buf = '';
  const flush = (): void => {
    if (buf.trim()) out.push(buf);
    buf = '';
  };
  for (const para of text.split(/\n{2,}/)) {
    let p = para;
    while (p.length > maxChars) {
      flush();
      out.push(p.slice(0, maxChars));
      p = p.slice(maxChars);
    }
    if (buf.length + p.length + 2 > maxChars) flush();
    buf = buf ? `${buf}\n\n${p}` : p;
  }
  flush();
  return out;
}

/** Type-route a file to text. Returns null when no textual route exists. */
async function extractText(
  client: DriveClient,
  folders: FolderIdMap,
  file: GdriveFileMeta,
): Promise<string | null> {
  const mime = file.mimeType ?? '';
  if (mime === 'application/vnd.google-apps.document') {
    return client.filesExport(file.id, 'text/markdown');
  }
  if (mime.startsWith('text/') || mime === 'application/json' || file.name.endsWith('.md')) {
    return client.filesDownload(file.id);
  }
  if (OCR_CONVERTIBLE_MIMES.has(mime)) {
    const raw = await client.filesDownloadRaw(file.id);
    const ocr = await ocrViaDriveImport(client, folders, file.name, raw, mime);
    if (ocr.ok) return ocr.text;
    // PDF fallback: some PDFs export poorly but still contain a text layer a
    // plain download won't give us — nothing more to try without a local
    // extractor; report unusable.
    return looksLikeUsableText(ocr.text) ? ocr.text : null;
  }
  return null;
}

async function moveFile(
  client: DriveClient,
  file: GdriveFileMeta,
  fromFolderId: string,
  toFolderId: string,
): Promise<void> {
  await client.filesUpdate(file.id, { addParents: toFolderId, removeParents: fromFolderId });
}

/** One inbox sweep. Called by the cron job; also the F38 curiosity funnel. */
export async function processInboxOnce(deps: InboxDeps): Promise<InboxSweepResult> {
  const result: InboxSweepResult = { processed: [], held: [], skipped: [] };
  if (isGdrivePaused()) {
    log.warn('gdrive is PAUSED (canary/operator) — inbox sweep skipped');
    return { ...result, aborted: 'paused' };
  }

  const { client, folders, audit } = deps;
  const inboxId = folders['knowledge/inbox'];
  const processedId = folders['knowledge/processed'];
  const quarantineId = folders['knowledge/quarantine'];
  if (!inboxId || !processedId || !quarantineId) {
    throw new Error('gdrive inbox: folder ids missing — bootstrap first');
  }
  const canaries = loadCanaryConfig();
  const started = Date.now();

  for (const file of await client.listChildren(inboxId)) {
    if (file.mimeType === 'application/vnd.google-apps.folder') continue;

    // F19 — a canary planted (or lured) into the inbox is an alarm, not input.
    const idHit = checkCanaryFileId(file.id, canaries);
    if (idHit) {
      tripCanary(audit, idHit, `inbox file ${file.name}`);
      return { ...result, aborted: 'canary' };
    }

    const size = Number(file.size ?? 0);
    if (size > (deps.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES)) {
      log.warn({ name: file.name, size }, 'inbox file over size cap — skipped');
      result.skipped.push(file.name);
      continue;
    }

    let text: string | null;
    try {
      text = await extractText(client, folders, file);
    } catch (err) {
      log.warn({ name: file.name, err: String(err) }, 'inbox extract failed — will retry next sweep');
      continue;
    }
    if (text === null || !text.trim()) {
      result.skipped.push(file.name);
      log.warn({ name: file.name, mime: file.mimeType }, 'no textual route — left in inbox for HUMAN');
      continue;
    }

    const markerHit = checkCanaryPayload(text, canaries);
    if (markerHit) {
      tripCanary(audit, markerHit, `inbox content ${file.name}`);
      return { ...result, aborted: 'canary' };
    }

    // F18 — detonation chamber.
    const q = await quarantineAndInspect(client, folders, file.name, text, deps.inspect);
    if (q.verdict.verdict === 'hold') {
      await moveFile(client, file, inboxId, quarantineId);
      result.held.push(file.name);
      emitGdriveAudit(audit, {
        job: 'inbox-ingest',
        outcome: 'denied',
        durationMs: Date.now() - started,
        filesTouched: [file.id],
        detail: { name: file.name, riskScore: q.verdict.riskScore, reasons: q.verdict.reasons.slice(0, 10) },
      });
      continue;
    }

    // F16 — provenance from actual ACLs (file + inbox folder).
    const [filePerms, parentPerms] = await Promise.all([
      client.permissionsList(file.id),
      client.permissionsList(inboxId),
    ]);
    const tier = deriveTrustTier(filePerms, parentPerms, deps.trustCtx);
    const citation = `${file.id}@${file.headRevisionId ?? 'head'}`;
    const contentSha = sha256Hex(text);

    // Ingest through the MEMORY API — role 'user' = full injection scan on
    // every chunk (quarantine screened first; this is defense in depth).
    const pieces = chunkText(text);
    for (const piece of pieces) {
      deps.chunks.storeChunk(piece, `gdrive/${file.name}`, 'file', { role: 'user' });
    }

    const provenance: ProvenanceRecord = {
      sourceFileId: file.id,
      sourceName: file.name,
      sourceRevisionId: file.headRevisionId,
      trustTier: tier,
      zone: classifyZone(text) === 0 ? 2 : classifyZone(text),
      ingestedAt: new Date().toISOString(),
      contentSha256: contentSha,
      quarantineVerdict: 'clean',
      citations: [citation],
    };
    await deps.structured.saveMemory({
      type: 'reference',
      id: `gdrive-${file.id}`,
      name: `Drive ingest: ${file.name}`,
      description: `Ingested from Drive inbox (${tier}); ${pieces.length} chunks; ${citation}`,
      content: JSON.stringify(provenance),
    });

    // F22 — register the belief so source edits/deletions propagate and the
    // epistemic ranking rider can weight these chunks by trust + validation.
    try {
      const { loadBeliefs, saveBeliefs, upsertBelief } = await import('./beliefs.js');
      const graph = loadBeliefs();
      upsertBelief(graph, {
        id: `gdrive-${file.id}`,
        chunkPathPrefix: `gdrive/${file.name}`,
        sources: [{ fileId: file.id, revisionId: file.headRevisionId }],
        trustTier: tier,
      });
      saveBeliefs(graph);
    } catch (err) {
      log.warn({ err: String(err) }, 'belief registration failed (ingest still recorded)');
    }

    // Move original + write the ingestion record beside it.
    await moveFile(client, file, inboxId, processedId);
    await client.filesCreate(
      { name: `${file.name}.ingested.json`, parents: [processedId] },
      { mimeType: 'application/json', body: JSON.stringify({ ...provenance, chunks: pieces.length }, null, 2) },
    );
    result.processed.push(file.name);
    emitGdriveAudit(audit, {
      job: 'inbox-ingest',
      outcome: 'success',
      durationMs: Date.now() - started,
      filesTouched: [file.id],
      bytes: text.length,
      inputsDigest: contentSha,
      detail: { name: file.name, tier, chunks: pieces.length },
    });
  }
  return result;
}
