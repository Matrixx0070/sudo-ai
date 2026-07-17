/**
 * @file notebooklm/informed-approval.ts
 * @description F54 — informed approval. A gated action (e.g. an F8 skill
 * promotion) must not proceed on a blind rubber-stamp: the agent publishes an
 * EXPLAINER pack (what the action does + its risks) and the principal must
 * return a signed ATTESTATION echoing a token that only appears in that
 * explainer. The gate is HARNESS-ENFORCED (invariant 8): code can't verify the
 * human actually read anything, but it verifies the required artifact exists and
 * carries the explainer-derived token before unblocking. No-human never means
 * no-gate — absent a valid attestation the gate HOLDS.
 *
 * Flow: requestInformedApproval() → explainer Doc + pending record →
 * `F54.attestation.<id>.md` return → recordAttestation() validates the token →
 * isInformedApprovalGranted() unblocks the consumer.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../shared/logger.js';
import { dataPath } from '../shared/paths.js';
import type { DriveClient } from '../gdrive/client.js';
import type { NlmFolderMap } from './folders.js';
import { assertZone2 } from './zone-screen.js';
import { HEADER_SENTENCE } from './export-lane.js';

const log = createLogger('notebooklm:informed-approval');

export interface ApprovalSubject {
  /** Stable id — also the attestation filename segment. [\w-]{1,64}. */
  id: string;
  /** What the principal is approving (one line). */
  title: string;
  /** What the action does — the substance of the explainer. */
  whatItDoes: string[];
  /** Risks / what could go wrong. */
  risks: string[];
}

export interface ApprovalRecord {
  id: string;
  title: string;
  token: string;
  explainerAt: string;
  granted: boolean;
  grantedAt?: string;
}

const ID_RE = /^[\w-]{1,64}$/;

function dir(): string {
  const d = join(dataPath('notebooklm'), 'approvals');
  mkdirSync(d, { recursive: true });
  return d;
}
const recPath = (id: string) => join(dir(), `${id}.json`);

/**
 * Token the attestation must echo — derived from the id + explainer body, so it
 * only exists once the explainer has been produced (a blind approval that never
 * received the explainer can't guess it).
 */
export function explainerToken(id: string, explainerBody: string): string {
  return createHash('sha256').update(`${id}\n${explainerBody}`).digest('hex').slice(0, 12);
}

function renderExplainer(subject: ApprovalSubject, token: string): string {
  return [
    `# Informed-approval explainer — ${subject.title}`,
    '',
    `> ${HEADER_SENTENCE}`,
    '',
    `Approval id: \`${subject.id}\``,
    '',
    '## What you are approving',
    ...subject.whatItDoes.map((w) => `- ${w}`),
    '',
    '## Risks',
    ...(subject.risks.length ? subject.risks.map((r) => `- ${r}`) : ['- (none stated)']),
    '',
    '## To approve',
    'Only after reading the above, create a file `F54.attestation.' + subject.id + '.md` in',
    'notebooklm/returns/ containing exactly this line:',
    '',
    '```',
    `APPROVE ${subject.id} ${token}`,
    '```',
  ].join('\n');
}

/**
 * Publish the explainer + persist a PENDING record. The token is bound to the
 * explainer body. Returns the record (granted=false). Idempotent by id.
 */
export async function requestInformedApproval(
  client: DriveClient,
  folders: NlmFolderMap,
  subject: ApprovalSubject,
  now: () => Date = () => new Date(),
): Promise<ApprovalRecord> {
  if (!ID_RE.test(subject.id)) throw new Error(`informed-approval: invalid id "${subject.id}"`);
  const folderId = folders['notebooklm/approvals'];
  if (!folderId) throw new Error('informed-approval: notebooklm/approvals folder id missing');

  // Body WITHOUT the token first (token is derived from this stable body).
  const bodyForHash = renderExplainer(subject, 'PENDING');
  const token = explainerToken(subject.id, bodyForHash);
  const body = renderExplainer(subject, token);
  assertZone2(body); // explainer is agent-authored; belt-and-braces zone-2.

  const name = `F54.explainer.${subject.id}`;
  const existing = (await client.listChildren(folderId)).find((f) => f.name === name);
  if (existing) await client.filesUpdateGoogleDoc(existing.id, body);
  else await client.filesCreateAsGoogleDoc(name, folderId, body);

  const rec: ApprovalRecord = { id: subject.id, title: subject.title, token, explainerAt: now().toISOString(), granted: false };
  writeFileSync(recPath(subject.id), JSON.stringify(rec, null, 2));
  log.info({ id: subject.id }, 'informed-approval explainer published; gate HOLDS until attestation');
  return rec;
}

export function loadApprovalRecord(id: string): ApprovalRecord | null {
  if (!existsSync(recPath(id))) return null;
  try {
    return JSON.parse(readFileSync(recPath(id), 'utf-8')) as ApprovalRecord;
  } catch {
    return null;
  }
}

export interface AttestationResult {
  granted: boolean;
  reason: string;
}

/**
 * Validate a returned attestation body against the pending record. Grants only
 * on an EXACT `APPROVE <id> <token>` line matching the explainer-bound token.
 */
export function recordAttestation(id: string, body: string, now: () => Date = () => new Date()): AttestationResult {
  const rec = loadApprovalRecord(id);
  if (!rec) return { granted: false, reason: `no pending approval for "${id}"` };
  if (rec.granted) return { granted: true, reason: 'already granted' };
  const re = new RegExp(`\\bAPPROVE\\s+${id.replace(/[^\w-]/g, '')}\\s+([a-f0-9]{12})\\b`);
  const m = body.match(re);
  if (!m) return { granted: false, reason: 'attestation missing a valid "APPROVE <id> <token>" line' };
  if (m[1] !== rec.token) return { granted: false, reason: 'attestation token does not match the explainer' };
  rec.granted = true;
  rec.grantedAt = now().toISOString();
  writeFileSync(recPath(id), JSON.stringify(rec, null, 2));
  log.info({ id }, 'informed-approval GRANTED (valid attestation)');
  return { granted: true, reason: 'valid attestation' };
}

/** The gate query a consumer (F8 promotion, etc.) MUST pass before proceeding. */
export function isInformedApprovalGranted(id: string): boolean {
  return loadApprovalRecord(id)?.granted === true;
}
