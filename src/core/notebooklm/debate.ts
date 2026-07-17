/**
 * @file notebooklm/debate.ts
 * @description F48 — debate chamber. Where F32 produces a single dissent, the
 * debate chamber produces a SYMMETRIC pack: the strongest case FOR and the
 * strongest case AGAINST the action implied by a (conclusion-free) decision
 * packet, each argued by an INDEPENDENT advocate route (invariant 7 — never the
 * decider's route). Both positions are published to notebooklm/debates so a
 * human/notebook reads a balanced pair, not a one-sided memo.
 *
 * Reuses F32's packet type + conclusion guard (no forked plumbing). Each
 * generated position is screened to zone-2 before broadcast (fail-closed).
 */

import { createLogger } from '../shared/logger.js';
import type { DriveClient } from '../gdrive/client.js';
import { assertNoConclusion, type DecisionPacket } from '../gdrive/second-opinion.js';
import { assertZone2 } from './zone-screen.js';
import { HEADER_SENTENCE } from './export-lane.js';
import type { NlmFolderMap } from './folders.js';

const log = createLogger('notebooklm:debate');

export type DebateStance = 'for' | 'against';

/** Injected advocate — argues one stance. Pinned to an independent route. */
export type AdvocateCall = (stance: DebateStance, prompt: string) => Promise<string>;

export interface DebatePackResult {
  packetId: string;
  docs: Array<{ stance: DebateStance | 'cover'; fileId: string }>;
}

const ID_RE = /^[\w-]{1,64}$/;

function advocatePrompt(stance: DebateStance, packet: DecisionPacket): string {
  const side = stance === 'for'
    ? 'FOR taking the action implied by this decision'
    : 'AGAINST taking the action implied by this decision';
  return [
    `You are an independent advocate with FRESH context. Argue the STRONGEST possible case ${side}.`,
    'Steelman your side; do not hedge or concede to the other side. Cite the specific evidence and constraints you rely on, and state what would have to be true for your case to fail.',
    '',
    `QUESTION: ${packet.question}`,
    `EVIDENCE:\n${packet.evidence.map((e) => `- ${e}`).join('\n')}`,
    `CONSTRAINTS:\n${packet.constraints.map((c) => `- ${c}`).join('\n')}`,
  ].join('\n');
}

async function writeDoc(client: DriveClient, folderId: string, name: string, body: string): Promise<string> {
  const existing = (await client.listChildren(folderId)).find((f) => f.name === name);
  if (existing) {
    await client.filesUpdateGoogleDoc(existing.id, body);
    return existing.id;
  }
  return (await client.filesCreateAsGoogleDoc(name, folderId, body)).id;
}

/**
 * Run the debate: generate both positions via the injected advocate, screen
 * each to zone-2 (fail-closed), and publish the symmetric pack + a cover doc.
 */
export async function exportDebatePack(
  client: DriveClient,
  folders: NlmFolderMap,
  packet: DecisionPacket,
  advocate: AdvocateCall,
): Promise<DebatePackResult> {
  const folderId = folders['notebooklm/debates'];
  if (!folderId) throw new Error('debate: notebooklm/debates folder id missing');
  if (!ID_RE.test(packet.id)) throw new Error(`debate: invalid packet id "${packet.id}"`);
  assertNoConclusion(packet);

  const forMemo = (await advocate('for', advocatePrompt('for', packet))).slice(0, 20_000);
  const againstMemo = (await advocate('against', advocatePrompt('against', packet))).slice(0, 20_000);

  // Fail-closed: a generated position that leaks zone-1 must not be broadcast.
  assertZone2(forMemo);
  assertZone2(againstMemo);

  const head = (title: string) => `# ${title}\n\n> ${HEADER_SENTENCE}\n\n---\n\n`;
  const forId = await writeDoc(client, folderId, `${packet.id}.debate-for`, head(`Debate — FOR (${packet.id})`) + forMemo);
  const againstId = await writeDoc(client, folderId, `${packet.id}.debate-against`, head(`Debate — AGAINST (${packet.id})`) + againstMemo);
  const cover = [
    `**Question:** ${packet.question}`,
    '',
    'This chamber presents two independent, opposing advocates. Read both before forming a view; neither is the deciding agent.',
    '',
    `- FOR: \`${packet.id}.debate-for\``,
    `- AGAINST: \`${packet.id}.debate-against\``,
    '',
    '## Constraints',
    ...packet.constraints.map((c) => `- ${c}`),
  ].join('\n');
  const coverId = await writeDoc(client, folderId, `${packet.id}.debate`, head(`Debate chamber (${packet.id})`) + cover);

  log.info({ packetId: packet.id }, 'F48 debate pack published (symmetric for/against)');
  return {
    packetId: packet.id,
    docs: [
      { stance: 'cover', fileId: coverId },
      { stance: 'for', fileId: forId },
      { stance: 'against', fileId: againstId },
    ],
  };
}
