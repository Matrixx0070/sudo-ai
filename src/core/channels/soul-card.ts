/**
 * @file soul-card.ts
 * @description TX25 — the /soul identity card. STRICTLY READ-ONLY over the
 * frozen identity surfaces (SOUL.md / IDENTITY.md / USER.md; CLAUDE.md
 * invariant 4: nothing writes them — this module only reads and hashes).
 * The card is a SUMMARY (headings + first lines), not a dump: it shows what
 * the identity is anchored to, with a provenance line (short sha256 per file)
 * so drift is visible at a glance against the signed manifest.
 * Owner-only at the command layer.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export interface SoulCardSource {
  /** Absolute file path. */
  file: string;
  /** Card section label, e.g. 'Soul'. */
  label: string;
}

export interface SoulCardSection {
  label: string;
  /** First H1 line (sans #) or '(untitled)'. */
  title: string;
  /** H2 headings, capped. */
  headings: string[];
  /** Short (12-hex) sha256 of the exact bytes — provenance anchor. */
  sha: string;
}

/** Extract summary + hash from one identity file's raw text. Pure. */
export function summariseIdentityFile(label: string, raw: string): SoulCardSection {
  const lines = raw.split('\n');
  const h1 = lines.find((l) => l.startsWith('# '));
  const headings = lines.filter((l) => l.startsWith('## ')).map((l) => l.slice(3).trim()).slice(0, 8);
  return {
    label,
    title: h1 ? h1.slice(2).trim() : '(untitled)',
    headings,
    sha: createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 12),
  };
}

/** Render the card body (markdown). Pure. */
export function renderSoulCard(sections: SoulCardSection[], missing: string[]): string {
  const lines: string[] = ['🪪 **Identity — frozen surfaces (read-only)**', ''];
  for (const s of sections) {
    lines.push(`**${s.label}** — ${s.title}`);
    if (s.headings.length > 0) lines.push(s.headings.map((h) => `  • ${h}`).join('\n'));
    lines.push(`  _sha256 ${s.sha}_`);
    lines.push('');
  }
  if (missing.length > 0) lines.push(`_(missing: ${missing.join(', ')})_`);
  lines.push('_These files are never modified by the agent; hashes anchor the identity pulse._');
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** Read + summarise the standard identity trio from a workspace dir. */
export async function buildSoulCard(workspaceDir: string): Promise<string> {
  const sources: SoulCardSource[] = [
    { file: path.join(workspaceDir, 'SOUL.md'), label: 'Soul' },
    { file: path.join(workspaceDir, 'IDENTITY.md'), label: 'Identity' },
    { file: path.join(workspaceDir, 'USER.md'), label: 'User' },
  ];
  const sections: SoulCardSection[] = [];
  const missing: string[] = [];
  for (const s of sources) {
    try {
      sections.push(summariseIdentityFile(s.label, await readFile(s.file, 'utf8')));
    } catch {
      missing.push(s.label);
    }
  }
  return renderSoulCard(sections, missing);
}
