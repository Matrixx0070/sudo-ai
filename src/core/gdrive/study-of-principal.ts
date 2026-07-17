/**
 * @file gdrive/study-of-principal.ts
 * @description F62 — study of the principal. A structured operator-model built
 * from the principal's own corrections: their standing directives, the themes
 * they emphasise, and an interaction profile. Because it models a PERSON it is
 * ZONE-1 by construction — SEALED at rest with AES-256-GCM (the same
 * encryptZone1 primitive F10/F11/F27 use) and NEVER routed through any
 * NotebookLM export lane (invariant 1: only zone-2 is exported; there is no F62
 * export shape, enforced by tests/notebooklm/no-zone1-export.test.ts).
 *
 * The sealed model is a private self-knowledge artifact: written locally as
 * ciphertext (0600) and, if synced, only ever as ciphertext.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../shared/logger.js';
import { dataPath } from '../shared/paths.js';
import { readDataset } from './datasets.js';
import { contentWords } from './error-atlas.js';
import { encryptZone1, decryptZone1 } from './zones.js';

const log = createLogger('gdrive:study-of-principal');

/** F62 output is zone-1 by policy — it models the principal. */
export const OPERATOR_MODEL_ZONE = 1 as const;

export interface OperatorModel {
  generatedAt: string;
  /** Verbatim standing directives (principal's words → the sensitive part). */
  standingDirectives: string[];
  /** Themes the principal emphasises most (from directive corrections). */
  emphasizedThemes: Array<{ theme: string; count: number }>;
  interactionProfile: { totalCorrections: number; directiveShare: number; distinctDocs: number };
  markers: Record<string, number>;
}

interface CorrectionRow {
  doc?: string;
  correction?: string;
  directive?: boolean;
  marker?: string | null;
}

export function buildOperatorModel(now: () => Date = () => new Date()): OperatorModel {
  const all = readDataset<CorrectionRow>('corrections').filter(
    (r): r is CorrectionRow & { correction: string } => typeof r.correction === 'string',
  );
  const directives = all.filter((r) => r.directive);
  const themeCount = new Map<string, number>();
  for (const r of directives) {
    for (const term of new Set(contentWords(r.correction))) {
      themeCount.set(term, (themeCount.get(term) ?? 0) + 1);
    }
  }
  const emphasizedThemes = [...themeCount.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([theme, count]) => ({ theme, count }));

  const docs = new Set(all.map((r) => r.doc).filter(Boolean) as string[]);
  const markers: Record<string, number> = {};
  for (const r of all) if (r.marker) markers[r.marker] = (markers[r.marker] ?? 0) + 1;

  return {
    generatedAt: now().toISOString(),
    standingDirectives: directives.map((r) => r.correction.replace(/\s+/g, ' ').trim().slice(0, 300)).slice(0, 30),
    emphasizedThemes,
    interactionProfile: {
      totalCorrections: all.length,
      directiveShare: all.length ? directives.length / all.length : 0,
      distinctDocs: docs.size,
    },
    markers,
  };
}

// ---------------------------------------------------------------------------
// Seal / unseal (AES-256-GCM) — the model never sits at rest in plaintext.
// ---------------------------------------------------------------------------

function sealedPath(): string {
  const d = join(dataPath('gdrive'), 'self');
  mkdirSync(d, { recursive: true });
  return join(d, 'operator-model.sealed');
}

/** Encrypt + persist the model locally as ciphertext (0600). Returns the path. */
export function sealOperatorModel(model: OperatorModel, encKey: Buffer): string {
  const wire = encryptZone1(Buffer.from(JSON.stringify(model), 'utf-8'), encKey);
  const p = sealedPath();
  writeFileSync(p, wire, { mode: 0o600 });
  log.info({ directives: model.standingDirectives.length }, 'F62 operator model sealed (zone-1, AES-256-GCM)');
  return p;
}

/** Read + decrypt the sealed model, or null if none / undecryptable. */
export function loadSealedOperatorModel(encKey: Buffer): OperatorModel | null {
  const p = sealedPath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(decryptZone1(readFileSync(p), encKey).toString('utf-8')) as OperatorModel;
  } catch (err) {
    log.warn({ err: String(err) }, 'F62 sealed model unreadable');
    return null;
  }
}

/** Raw sealed bytes on disk (for a "never plaintext at rest" assertion). */
export function readSealedBytes(): Buffer | null {
  const p = sealedPath();
  return existsSync(p) ? readFileSync(p) : null;
}

/** Cron: rebuild + reseal the operator model. No-op without an enc key. */
export async function runSealOperatorModelJob(): Promise<{ sealed: boolean }> {
  const { loadEncKey } = await import('./keys.js');
  let encKey: Buffer;
  try {
    encKey = loadEncKey();
  } catch {
    log.warn('F62 seal job: no enc key configured — skipping');
    return { sealed: false };
  }
  sealOperatorModel(buildOperatorModel(), encKey);
  return { sealed: true };
}
