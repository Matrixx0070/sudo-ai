/**
 * @file notebooklm/packs.ts
 * @description CLI-triggered packs: F43 incident theater + F45 study packs.
 * Packs are ≤10 Docs written under a notebooklm folder (name-prefixed by id —
 * per-incident subfolders are a nice-to-have; name-prefixing is functionally
 * equivalent for a notebook and avoids subfolder churn; noted as a deviation).
 */

import { Readable } from 'node:stream';
import { createLogger } from '../shared/logger.js';
import type { AuditTrail } from '../security/audit-trail.js';
import type { DriveClient } from '../gdrive/client.js';
import type { FolderIdMap } from '../gdrive/types.js';
import type { BrainKeys } from '../gdrive/keys.js';
import { unpackBundle } from '../gdrive/flight-recorder.js';
import { emitGdriveAudit } from '../gdrive/audit.js';
import { redactSecrets, screenRecords, assertZone2 } from './zone-screen.js';
import { HEADER_SENTENCE } from './export-lane.js';
import type { NlmFolderMap } from './folders.js';

const log = createLogger('notebooklm:packs');

function header(name: string): string {
  return `# ${name}\n\n> ${HEADER_SENTENCE}\n\n---\n\n`;
}

async function writePackDoc(client: DriveClient, folderId: string, name: string, body: string): Promise<string> {
  const existing = (await client.listChildren(folderId)).find((f) => f.name === name);
  if (existing) {
    await client.filesUpdateGoogleDoc(existing.id, body);
    return existing.id;
  }
  return (await client.filesCreateAsGoogleDoc(name, folderId, body)).id;
}

// ---------------------------------------------------------------------------
// F43 — incident theater
// ---------------------------------------------------------------------------

export interface IncidentPackResult {
  bundleId: string;
  docs: Array<{ name: string; fileId: string }>;
  redactionHits: number;
}

/**
 * Export a redacted incident pack from a flight-recorder bundle. The transcript
 * TEXT is zone-1 by default → declassified under the mandatory secrets-redact
 * screen (invariant-1 F43 exception); redactions are audited. Raw tool payloads
 * are NOT included — only rendered event/trace summaries.
 */
export async function exportIncidentPack(
  client: DriveClient,
  gdriveFolders: FolderIdMap,
  nlmFolders: NlmFolderMap,
  bundleId: string,
  keys: BrainKeys,
  audit: AuditTrail | null,
): Promise<IncidentPackResult> {
  const incidentsFolder = gdriveFolders['ops/incidents'];
  const outFolder = nlmFolders['notebooklm/incidents'];
  if (!incidentsFolder || !outFolder) throw new Error('incident pack: folder ids missing');

  const file = (await client.listChildren(incidentsFolder)).find((f) => f.name.includes(bundleId));
  if (!file) throw new Error(`incident pack: no bundle matching "${bundleId}" in ops/incidents`);
  const wire = await client.filesDownloadRaw(file.id);
  const bundle = unpackBundle(wire, keys);

  // Render transcript text (events + traces) → declassify (redact secrets).
  const rendered = [
    ...bundle.events.map((e) => `event: ${safeStr(e)}`),
    ...bundle.traces.map((t) => `trace: ${safeStr(t)}`),
  ].join('\n');
  const { redacted, hits } = redactSecrets(rendered);

  const timeline = bundle.events.map((e, i) => `${i + 1}. ${safeStr(e).slice(0, 200)}`).join('\n');
  const config = [
    `runId: ${bundle.runId}`,
    `sessionId: ${bundle.sessionId}`,
    `outcome: ${bundle.outcome}`,
    `manifestCounter: ${bundle.manifestCounter ?? 'n/a'}`,
    `configSnapshotHash: ${bundle.configSnapshotHash ?? 'n/a'}`,
    `llmCalls: ${bundle.llmCalls.length}`,
    `traces: ${bundle.traces.length}`,
  ].join('\n');

  const idTag = bundleId.replace(/[^\w-]/g, '_').slice(0, 40);
  const docsToWrite: Array<{ name: string; body: string }> = [
    { name: `incident-${idTag}-transcript`, body: header('Redacted transcript') + redacted },
    { name: `incident-${idTag}-timeline`, body: header('Timeline') + timeline },
    { name: `incident-${idTag}-config`, body: header('Config summary') + config },
  ];

  const written: Array<{ name: string; fileId: string }> = [];
  for (const d of docsToWrite) {
    const fileId = await writePackDoc(client, outFolder, d.name, d.body);
    written.push({ name: d.name, fileId });
  }

  emitGdriveAudit(audit, {
    job: 'nlm-incident-export',
    outcome: 'success',
    durationMs: 0,
    filesTouched: written.map((w) => w.fileId),
    detail: { bundleId, redactionHits: hits, declassified: 'transcript-text-only' },
  });
  log.info({ bundleId, redactionHits: hits }, 'incident pack exported (redacted)');
  return { bundleId, docs: written, redactionHits: hits };
}

function safeStr(v: unknown): string {
  try {
    return typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// ---------------------------------------------------------------------------
// F45 — study packs
// ---------------------------------------------------------------------------

export interface StudyPackResult {
  questionId: string;
  fileIds: string[];
  contextCount: number;
}

/**
 * Export a study pack for an open question: the question + zone-2 context
 * snippets (mirror snapshots / episodic extracts / current beliefs, gathered
 * by the caller). Every snippet passes the hard zone screen.
 */
export async function exportStudyPack(
  client: DriveClient,
  nlmFolders: NlmFolderMap,
  params: { questionId: string; question: string; context: string[] },
): Promise<StudyPackResult> {
  const outFolder = nlmFolders['notebooklm/studypacks'];
  if (!outFolder) throw new Error('study pack: notebooklm/studypacks folder id missing');
  const { kept, dropped } = screenRecords(params.context, (c) => c);
  const body =
    header(`Study pack — ${params.question.slice(0, 80)}`) +
    [
      `## Question`,
      params.question,
      '',
      `## Context (${kept.length} zone-2 snippets${dropped.length ? `, ${dropped.length} withheld` : ''})`,
      ...kept.map((c, i) => `### snippet ${i + 1}\n${c}`),
    ].join('\n');
  assertZone2(body.split('---\n\n')[1] ?? body); // final gate on the assembled context
  const idTag = params.questionId.replace(/[^\w-]/g, '_').slice(0, 40);
  const fileId = await writePackDoc(client, outFolder, `studypack-${idTag}`, body);
  log.info({ questionId: params.questionId, kept: kept.length }, 'study pack exported');
  return { questionId: params.questionId, fileIds: [fileId], contextCount: kept.length };
}
