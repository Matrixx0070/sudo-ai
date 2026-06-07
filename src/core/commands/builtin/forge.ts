/**
 * @file builtin/forge.ts
 * @description /forge — learning flywheel, stage 3 (SkillForge). Scans recorded
 * usage traces and PROPOSES reusable skills. Review-only by design: candidates
 * are written to data/skill-proposals/ — NEVER the live skills directory and
 * NEVER via SkillForge.accept() — so model-generated skills cannot go live
 * without a human reviewing and moving them.
 *
 * Opt-in: SUDO_SKILL_FORGE=1 (requires SUDO_TRACE_LEARNING=1 so traces exist).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createLogger } from '../../shared/index.js';
import type { SlashCommand, CommandContext } from '../types.js';
import { TraceStore } from '../../learning/trace-store.js';
import { TraceAnalyzer } from '../../learning/trace-analyzer.js';
import { SkillForge } from '../../learning/skill-forge.js';
import type { SkillCandidate } from '../../learning/skill-forge.js';

const log = createLogger('commands:forge');

/** Derive a safe kebab-case file stem from a tool sequence. */
function skillName(toolSequence: string[]): string {
  const base = toolSequence.join('-').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (base || 'skill').slice(0, 60);
}

/**
 * Run a SkillForge scan and write each candidate's generated SKILL.md to the
 * proposals (review) directory. Does NOT call accept() and does NOT write to the
 * live skills dir — proposals stay inert until a human moves them. Returns a
 * user-facing summary. Exported for testing.
 */
export async function proposeSkills(
  forge: { scan(): Promise<SkillCandidate[]> },
  proposalsDir: string,
): Promise<string> {
  const candidates = await forge.scan();
  if (candidates.length === 0) {
    return 'No skill candidates found yet — keep using the agent (with SUDO_TRACE_LEARNING=1) so recurring tool patterns can accumulate.';
  }

  mkdirSync(proposalsDir, { recursive: true });
  const lines: string[] = [];
  for (const c of candidates) {
    const name = skillName(c.pattern.toolSequence);
    writeFileSync(path.join(proposalsDir, `${name}.md`), c.generatedSkill, 'utf8');
    lines.push(
      `  • ${name} — ${(c.confidence * 100).toFixed(0)}% confidence ` +
      `(${c.pattern.occurrenceCount}× seen, ${(c.pattern.successRate * 100).toFixed(0)}% success)`,
    );
  }
  log.info({ count: candidates.length, proposalsDir }, 'Skill candidates proposed (review-only)');
  return [
    `Proposed ${candidates.length} skill candidate(s) for review — written to ${proposalsDir}.`,
    'NONE are live. Review each markdown and move the ones you approve into your skills directory.',
    '',
    ...lines,
  ].join('\n');
}

export const forgeCommand: SlashCommand = {
  name: 'forge',
  description: 'Scan recorded usage and propose reusable skills for review (nothing goes live).',
  usage: '/forge',

  async execute(_args: string, _ctx: CommandContext): Promise<string> {
    if (process.env['SUDO_SKILL_FORGE'] !== '1') {
      return 'Skill forge is disabled. Set SUDO_SKILL_FORGE=1 (and SUDO_TRACE_LEARNING=1) to enable it.';
    }
    const dataDir = process.env['DATA_DIR'];
    if (!dataDir) {
      return 'Skill forge needs DATA_DIR set (the directory holding traces.db).';
    }

    let traceStore: TraceStore | undefined;
    try {
      traceStore = new TraceStore(path.join(dataDir, 'traces.db'));
      await traceStore.init();
      const analyzer = new TraceAnalyzer(traceStore);
      const proposalsDir = path.join(dataDir, 'skill-proposals');
      // skillDir is set to the proposals dir too, so even an accidental accept()
      // would land in review, not live. (We do not call accept() here.)
      const forge = new SkillForge(traceStore, analyzer, proposalsDir);
      return await proposeSkills(forge, proposalsDir);
    } catch (err) {
      log.warn({ err: String(err) }, 'Skill forge scan failed');
      return `Skill forge scan failed: ${String(err)}`;
    } finally {
      try { traceStore?.close(); } catch { /* ignore */ }
    }
  },
};
