/**
 * @file skill-catalog.ts
 * @description BO6 / scorecard-S3 — the always-visible skill CATALOG.
 *
 * OpenClaw keeps a compact, always-in-the-prefix catalog of every installed
 * skill (~24 tokens each: name + one-line purpose + path + a version marker)
 * and reads the full skill file ON DEMAND when a task matches. That scales to
 * 100+ skills for a near-constant prompt cost, and — critically — nothing that
 * doesn't match is invisible to the model.
 *
 * SUDO-AI's pre-BO6 default injected up to 2 MATCHED skill *bodies*
 * (≤6k chars each, skill-activator.ts). Precise when a trigger fires, but a
 * non-match was invisible and a misfire cost thousands of tokens. This module
 * adds the missing baseline: a byte-stable `<available_skills>` block, ≤30
 * tokens per skill (name/desc/path/hash — never the body), rendered into the
 * STABLE cached prefix (system-prompt.ts). It is a HYBRID, not a replacement:
 * the deterministic whole-word triggers still fast-path a matched body in
 * (skill-activator.ts, the SUDO-AI advantage); the catalog is the always-on
 * floor for everything the triggers don't catch, and the model pulls a body
 * with the `skill.read` tool.
 *
 * Byte-stability (BO2b/S1 invariant): entries are sorted deterministically by
 * name and the per-skill `hash` is a pure function of the SKILL.md body, so the
 * rendered block is byte-identical within a session and changes ONLY when a
 * skill file changes — the model then sees a new hash and re-reads on demand
 * (version-marker invalidation).
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import { estimateTokens } from '../shared/utils.js';

// ---------------------------------------------------------------------------
// Types + budget
// ---------------------------------------------------------------------------

/** Minimal structural input — MarkdownSkill satisfies this. */
export interface CatalogSkillInput {
  name: string;
  description?: string;
  /** Full SKILL.md body — hashed for the version marker (never rendered). */
  content: string;
  /** Absolute or cwd-relative path to the skill file (rendered, shortened). */
  filePath?: string;
}

/** One rendered catalog row — name/desc/path/hash only, never the body. */
export interface SkillCatalogEntry {
  name: string;
  description: string;
  /** Short, cwd-relative path used both for display and read-on-demand. */
  path: string;
  /** Version marker: first 8 hex of sha256(body). Changes iff the body changes. */
  hash: string;
}

/** Hard per-skill token budget (name/desc/path/hash line). */
export const MAX_ENTRY_TOKENS = 30;

/** Default ON; SUDO_SKILL_CATALOG=0 disables the catalog block. */
export function isSkillCatalogEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['SUDO_SKILL_CATALOG'] !== '0';
}

// ---------------------------------------------------------------------------
// Hashing + building
// ---------------------------------------------------------------------------

/**
 * Version marker for a skill body. Pure function of the bytes: identical body →
 * identical hash (byte-stable catalog); any edit → new hash (invalidation).
 */
export function skillHash(content: string): string {
  return createHash('sha256').update(content ?? '', 'utf8').digest('hex').slice(0, 8);
}

/** Collapse a description to a single clean line (first line, whitespace-normalized). */
function oneLine(desc: string | undefined): string {
  if (!desc) return '';
  return desc.replace(/\s+/g, ' ').trim();
}

/** Shorten a path for display: relative to cwd when possible, else basename-ish. */
function shortPath(filePath: string | undefined, name: string): string {
  if (!filePath) return `skills/${name}`;
  const rel = path.relative(process.cwd(), filePath);
  // A relative path that doesn't climb out of cwd is the most useful+compact.
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  return filePath;
}

/**
 * Build catalog entries from loaded skills. Deterministic: deduped by name
 * (first wins, mirroring the loader's flat-over-directory precedence) and
 * sorted by name so the rendered block is byte-stable for a fixed skill set.
 */
export function buildSkillCatalog(skills: readonly CatalogSkillInput[]): SkillCatalogEntry[] {
  const seen = new Set<string>();
  const entries: SkillCatalogEntry[] = [];
  for (const s of skills) {
    if (!s || typeof s.name !== 'string' || s.name.trim() === '') continue;
    if (seen.has(s.name)) continue;
    seen.add(s.name);
    entries.push({
      name: s.name,
      description: oneLine(s.description),
      path: shortPath(s.filePath, s.name),
      hash: skillHash(s.content ?? ''),
    });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Render ONE entry as a single line, guaranteed ≤ MAX_ENTRY_TOKENS. The name,
 * hash and path are load-bearing (identity, invalidation, read-on-demand) so
 * the description is what gets trimmed to fit the budget; a final hard clamp
 * guards pathological name/path lengths.
 */
export function renderCatalogEntry(entry: SkillCatalogEntry): string {
  const suffix = ` [${entry.hash}] (${entry.path})`;
  const head = `- ${entry.name}:`;
  const fixed = head + suffix; // everything except the description
  let desc = entry.description;
  // Trim the description until the whole line fits the token budget.
  while (desc.length > 0 && estimateTokens(`${head} ${desc}${suffix}`) > MAX_ENTRY_TOKENS) {
    // Drop whole trailing words first for readable truncation.
    const cut = desc.replace(/\s*\S+$/, '');
    desc = cut.length < desc.length ? cut : desc.slice(0, -1);
  }
  let line = desc ? `${head} ${desc}${suffix}` : fixed;
  // Final safety clamp (extreme name/path): 30 tokens ≈ 120 chars.
  if (estimateTokens(line) > MAX_ENTRY_TOKENS) {
    line = line.slice(0, MAX_ENTRY_TOKENS * 4 - 1) + '…';
  }
  return line;
}

/** Estimated token cost of a single rendered entry (for budget assertions/telemetry). */
export function entryTokens(entry: SkillCatalogEntry): number {
  return estimateTokens(renderCatalogEntry(entry));
}

/**
 * Render the full `<available_skills>` block for the stable prefix. Returns ''
 * for an empty catalog (nothing injected). The header is fixed overhead (not
 * per-skill); every skill row is ≤ MAX_ENTRY_TOKENS.
 */
export function renderSkillCatalog(entries: readonly SkillCatalogEntry[]): string {
  if (entries.length === 0) return '';
  const lines = [
    '<available_skills>',
    'Installed skills you can consult on demand. Each row: name — one-line purpose [version-hash] (path).',
    'When a request matches a skill, call the skill.read tool with its name to load the full instructions;',
    'do not guess a skill\'s contents from its description. The version-hash changes when a skill file is',
    'edited — if it differs from a body you already read this session, re-read it. Skills not listed here',
    'are not installed. (Matched skills may also be fast-pathed in automatically via their trigger phrases.)',
    ...entries.map(renderCatalogEntry),
    '</available_skills>',
  ];
  return lines.join('\n');
}

/** Convenience: skills → rendered block in one call. */
export function buildAndRenderSkillCatalog(skills: readonly CatalogSkillInput[]): string {
  return renderSkillCatalog(buildSkillCatalog(skills));
}
