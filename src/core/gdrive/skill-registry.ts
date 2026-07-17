/**
 * @file gdrive/skill-registry.ts
 * @description F8 — eval-gated skill promotion: candidates, metrics, HUMAN
 * gate, promote, rollback.
 *
 * Candidates land in skills/candidates/ (artifact + metadata JSON). An eval
 * run scores each (injected runner) -> scorecard Skills row. Promotion to
 * skills/stable/ requires BOTH the eval gate passing AND an approval row in
 * the control-panel Sheet's Approvals tab — enforced HARNESS-SIDE. Promoted
 * artifacts also mirror into the local stable-skills dir, which the F2
 * serializer checkpoints as `category: skill` manifest entries (signed brain,
 * F17). skills/stable/ files update in place — Drive revisions = rollback.
 *
 * FROZEN surfaces stay frozen: this registry can only ever write skill
 * artifacts, never source/config (no path escapes — names are validated).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataPath } from '../shared/paths.js';
import { createLogger } from '../shared/logger.js';
import type { DriveClient } from './client.js';
import type { FolderIdMap } from './types.js';
import { appendEvalRow } from './scorecard.js';

const log = createLogger('gdrive:skill-registry');

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

export interface SkillCandidate {
  candidateId: string; // filename-safe
  description: string;
  suite: string;
  artifactFileId: string;
}

export function stableSkillsDir(): string {
  return dataPath('gdrive', 'stable-skills');
}

/** List candidates: each is an <id>.md artifact + <id>.meta.json pair. */
export async function listCandidates(client: DriveClient, folders: FolderIdMap): Promise<SkillCandidate[]> {
  const folderId = folders['skills/candidates'];
  if (!folderId) return [];
  const children = await client.listChildren(folderId);
  const out: SkillCandidate[] = [];
  for (const meta of children.filter((f) => f.name.endsWith('.meta.json'))) {
    try {
      const parsed = JSON.parse(await client.filesDownload(meta.id)) as { candidateId?: string; description?: string; suite?: string };
      const id = parsed.candidateId ?? meta.name.replace(/\.meta\.json$/, '');
      if (!NAME_RE.test(id)) continue;
      const artifact = children.find((f) => f.name === `${id}.md`);
      if (!artifact) continue;
      out.push({ candidateId: id, description: parsed.description ?? '', suite: parsed.suite ?? 'skill-default', artifactFileId: artifact.id });
    } catch {
      /* torn candidate — skip */
    }
  }
  return out;
}

export type SkillEvalRunner = (candidateId: string, artifact: string, suite: string) => Promise<{ score: number; pass: boolean }>;

/** Evaluate one candidate and append the scorecard Skills row. */
export async function evalCandidate(
  client: DriveClient,
  scorecardId: string,
  candidate: SkillCandidate,
  runner: SkillEvalRunner,
): Promise<{ score: number; pass: boolean }> {
  const artifact = await client.filesDownload(candidate.artifactFileId);
  const result = await runner(candidate.candidateId, artifact, candidate.suite);
  await client.sheetsValuesAppend(scorecardId, 'Skills!A1', [[
    candidate.candidateId, candidate.suite, result.score, result.pass, '', '',
  ]]);
  // Also feed the F26 eval-pairs dataset.
  try {
    const { appendDatasetRow } = await import('./datasets.js');
    appendDatasetRow('eval-pairs', {
      candidateId: candidate.candidateId, suite: candidate.suite,
      score: result.score, pass: result.pass, at: new Date().toISOString(),
    });
  } catch {
    /* dataset best-effort */
  }
  return result;
}

/** Read the HUMAN approval set from the control panel's Approvals tab. */
export async function readApprovals(client: DriveClient, controlPanelId: string): Promise<Set<string>> {
  let rows: unknown[][] = [];
  try {
    rows = await client.sheetsValuesGet(controlPanelId, 'Approvals!A2:B');
  } catch {
    // Tab may not exist yet — create with header; nothing approved.
    try {
      await client.sheetsBatchUpdate(controlPanelId, [{ addSheet: { properties: { title: 'Approvals' } } }]);
      await client.sheetsValuesUpdate(controlPanelId, 'Approvals!A1', [['candidateId', 'approved (TRUE to approve)']]);
    } catch {
      /* concurrent create */
    }
    return new Set();
  }
  return new Set(
    rows
      .filter((r) => String(r[1] ?? '').trim().toUpperCase() === 'TRUE')
      .map((r) => String(r[0] ?? '').trim())
      .filter((id) => NAME_RE.test(id)),
  );
}

export type PromotionOutcome =
  | { action: 'promoted'; stableFileId: string }
  | { action: 'blocked'; reason: 'eval-failed' | 'not-approved' | 'informed-approval-pending' };

/**
 * Optional F54 hook. When provided, a candidate that requires informed approval
 * must ALSO clear the informed-approval gate (explainer read + valid
 * attestation) before promotion. Injected so gdrive never imports notebooklm.
 */
export interface PromoteOpts {
  /** Returns true if this candidate needs the informed-approval gate. */
  requiresInformedApproval?: (candidateId: string) => boolean;
  /** Returns true if the informed-approval gate is satisfied for this candidate. */
  informedApprovalGranted?: (candidateId: string) => boolean;
}

/**
 * Promote: eval + control-panel approval required; the optional F54 informed-
 * approval gate adds a third. Stable file updates in place (revisions =
 * rollback); artifact mirrors locally for the signed checkpoint.
 */
export async function promoteCandidate(
  client: DriveClient,
  folders: FolderIdMap,
  scorecardId: string,
  controlPanelId: string,
  candidate: SkillCandidate,
  evalResult: { score: number; pass: boolean },
  opts: PromoteOpts = {},
): Promise<PromotionOutcome> {
  if (!evalResult.pass) return { action: 'blocked', reason: 'eval-failed' };
  const approvals = await readApprovals(client, controlPanelId);
  if (!approvals.has(candidate.candidateId)) return { action: 'blocked', reason: 'not-approved' };
  // F54 — harness-enforced informed-approval gate: HOLDS when required but not
  // yet granted (invariant 8 — no-human never means no-gate).
  if (opts.requiresInformedApproval?.(candidate.candidateId) && !opts.informedApprovalGranted?.(candidate.candidateId)) {
    return { action: 'blocked', reason: 'informed-approval-pending' };
  }

  const stableFolder = folders['skills/stable'];
  if (!stableFolder) throw new Error('skill-registry: skills/stable folder id missing');
  const artifact = await client.filesDownload(candidate.artifactFileId);
  const name = `${candidate.candidateId}.md`;
  const media = { mimeType: 'text/markdown', body: artifact };
  const existing = (await client.listChildren(stableFolder)).find((f) => f.name === name);
  const stableFileId = existing
    ? (await client.filesUpdate(existing.id, {}, media), existing.id)
    : (await client.filesCreate({ name, parents: [stableFolder] }, media)).id;

  // Local mirror -> checkpointed as a signed `category: skill` entry (F17).
  mkdirSync(stableSkillsDir(), { recursive: true });
  writeFileSync(join(stableSkillsDir(), name), artifact, { mode: 0o600 });

  await client.sheetsValuesAppend(scorecardId, 'Skills!A1', [[
    candidate.candidateId, candidate.suite, evalResult.score, evalResult.pass, 'TRUE', new Date().toISOString(),
  ]]);
  log.info({ candidate: candidate.candidateId }, 'skill promoted (eval + approval gates passed)');
  return { action: 'promoted', stableFileId };
}

/** Rollback: restore the previous Drive revision of a stable skill. */
export async function rollbackSkill(
  client: DriveClient,
  folders: FolderIdMap,
  skillName: string,
): Promise<boolean> {
  if (!NAME_RE.test(skillName)) throw new Error(`skill-registry: invalid skill name "${skillName}"`);
  const stableFolder = folders['skills/stable'];
  if (!stableFolder) return false;
  const file = (await client.listChildren(stableFolder)).find((f) => f.name === `${skillName}.md`);
  if (!file) return false;
  const revisions = await client.revisionsList(file.id);
  if (revisions.length < 2) return false;
  const previous = revisions[revisions.length - 2]!;
  const content = await client.revisionsGetContent(file.id, previous.id!);
  await client.filesUpdate(file.id, {}, { mimeType: 'text/markdown', body: content });
  mkdirSync(stableSkillsDir(), { recursive: true });
  writeFileSync(join(stableSkillsDir(), `${skillName}.md`), content, { mode: 0o600 });
  log.info({ skillName, restoredRevision: previous.id }, 'skill rolled back');
  return true;
}
