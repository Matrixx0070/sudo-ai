/**
 * @file gdrive/second-opinion.ts
 * @description F32 — anti-sycophancy as infrastructure: high-impact decisions
 * get an isolated dissent before executing.
 *
 * A decision packet (question, evidence, constraints — conclusions STRIPPED,
 * validated here) exports to ops/review-queue/. A fresh-context reviewer on a
 * DIFFERENT brain route (injected call) reads only the packet and writes a
 * dissent memo beside it. The deciding agent must address the dissent or
 * record why it proceeds; both are logged. High-impact actions BLOCK on the
 * memo; timeout escalates to the HUMAN — never auto-proceed.
 */

import { createLogger } from '../shared/logger.js';
import type { DriveClient } from './client.js';
import type { FolderIdMap } from './types.js';
import { emitGdriveAudit } from './audit.js';
import type { AuditTrail } from '../security/audit-trail.js';

const log = createLogger('gdrive:second-opinion');

export interface DecisionPacket {
  id: string;
  question: string;
  evidence: string[];
  constraints: string[];
  impact: 'high' | 'critical';
  createdAt: string;
}

const ID_RE = /^[\w-]{1,64}$/;

/**
 * Guard shared by F32 (second opinion) and F48 (debate chamber): a packet must
 * NOT smuggle a conclusion — the independent reviewer(s) must reason from the
 * evidence, not ratify a pre-baked answer. Throws with the offending word.
 */
export function assertNoConclusion(packet: Pick<DecisionPacket, 'question' | 'evidence'>): void {
  const smuggled = ['conclusion', 'recommendation', 'preferred', 'decision:'];
  const flat = `${packet.question}\n${packet.evidence.join('\n')}`.toLowerCase();
  for (const word of smuggled) {
    if (flat.includes(word)) {
      throw new Error(
        `decision packet appears to contain a conclusion ("${word}") — strip it; the reviewer must reason independently`,
      );
    }
  }
}

/** Validate + export a packet. REFUSES packets that smuggle conclusions. */
export async function exportDecisionPacket(
  client: DriveClient,
  folders: FolderIdMap,
  packet: DecisionPacket,
): Promise<string> {
  const folderId = folders['ops/review-queue'];
  if (!folderId) throw new Error('second-opinion: ops/review-queue folder id missing');
  if (!ID_RE.test(packet.id)) throw new Error(`second-opinion: invalid packet id "${packet.id}"`);
  assertNoConclusion(packet);
  const created = await client.filesCreate(
    { name: `${packet.id}.packet.json`, parents: [folderId] },
    { mimeType: 'application/json', body: JSON.stringify(packet, null, 2) },
  );
  return created.id;
}

export type ReviewerCall = (packetJson: string) => Promise<string>;

/** The reviewer half: read packet -> dissent memo beside it. */
export async function writeDissent(
  client: DriveClient,
  folders: FolderIdMap,
  packetId: string,
  reviewer: ReviewerCall,
): Promise<string> {
  const folderId = folders['ops/review-queue'];
  if (!folderId) throw new Error('second-opinion: ops/review-queue folder id missing');
  const packetFile = (await client.listChildren(folderId)).find((f) => f.name === `${packetId}.packet.json`);
  if (!packetFile) throw new Error(`second-opinion: packet not found: ${packetId}`);
  const packetJson = await client.filesDownload(packetFile.id);
  const memo = await reviewer(
    `You are an independent reviewer with FRESH context. Read this decision packet and write a dissent memo: ` +
      `the strongest case AGAINST the implied course of action, risks the decider may have missed, and what evidence would change your mind. ` +
      `Packet:\n${packetJson}`,
  );
  const created = await client.filesCreate(
    { name: `${packetId}.dissent.md`, parents: [folderId] },
    { mimeType: 'text/markdown', body: memo.slice(0, 20_000) },
  );
  return created.id;
}

export type SecondOpinionOutcome =
  | { action: 'dissent-ready'; memo: string }
  | { action: 'escalate'; reason: string };

/**
 * Blocking gate for the decider: wait for the dissent memo (poll with an
 * injected sleeper), timeout => ESCALATE to the human, never auto-proceed.
 */
export async function awaitDissent(
  client: DriveClient,
  folders: FolderIdMap,
  packetId: string,
  opts: { timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<SecondOpinionOutcome> {
  const folderId = folders['ops/review-queue'];
  if (!folderId) throw new Error('second-opinion: ops/review-queue folder id missing');
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  const pollMs = opts.pollMs ?? 5_000;
  const sleep =
    opts.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, ms);
        (t as { unref?: () => void }).unref?.();
      }));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const memoFile = (await client.listChildren(folderId)).find((f) => f.name === `${packetId}.dissent.md`);
    if (memoFile) return { action: 'dissent-ready', memo: await client.filesDownload(memoFile.id) };
    if (Date.now() >= deadline) {
      log.warn({ packetId }, 'second opinion timed out — ESCALATING to human, not proceeding');
      return { action: 'escalate', reason: `no dissent memo within ${timeoutMs}ms — human review required` };
    }
    await sleep(pollMs);
  }
}

/**
 * G-F32WIRE: the coherent cycle a caller invokes as one unit — export the
 * (conclusion-free) packet, then have an INDEPENDENT reviewer write the dissent
 * memo beside it. Returns the packet id + memo. Background-only (Drive I/O +
 * a reviewer LLM call); the agent triggers it fire-and-forget via the seam.
 * The reviewer route MUST differ from the decider's (invariant 7) — the caller
 * (cli.ts) pins it to the judge route.
 */
export async function runSecondOpinionCycle(
  client: DriveClient,
  folders: FolderIdMap,
  packet: DecisionPacket,
  reviewer: ReviewerCall,
): Promise<{ packetId: string; memoId: string }> {
  await exportDecisionPacket(client, folders, packet);
  const memoId = await writeDissent(client, folders, packet.id, reviewer);
  log.info({ packetId: packet.id, impact: packet.impact }, 'second-opinion cycle complete — dissent memo written');
  return { packetId: packet.id, memoId };
}

/** Record the decider's resolution (addressed / proceeding-despite) — audited. */
export async function resolveDissent(
  client: DriveClient,
  folders: FolderIdMap,
  audit: AuditTrail | null,
  packetId: string,
  resolution: { proceeded: boolean; rationale: string },
): Promise<void> {
  const folderId = folders['ops/review-queue'];
  if (!folderId) return;
  await client.filesCreate(
    { name: `${packetId}.resolution.json`, parents: [folderId] },
    { mimeType: 'application/json', body: JSON.stringify({ ...resolution, at: new Date().toISOString() }, null, 2) },
  );
  emitGdriveAudit(audit, {
    job: 'second-opinion',
    outcome: resolution.proceeded ? 'success' : 'denied',
    durationMs: 0,
    detail: { packetId, proceeded: resolution.proceeded, rationale: resolution.rationale.slice(0, 300) },
  });
}
