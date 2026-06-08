/**
 * @file builtin/forge.ts
 * @description /forge — learning flywheel, stage 3 (SkillForge). Scans recorded
 * usage traces and PROPOSES reusable skills, then a human-gated review flow:
 *
 *   /forge                 scan recorded usage → write proposals (review dir)
 *   /forge list            list pending proposals
 *   /forge accept <name>   PROMOTE a reviewed proposal into the live skills dir
 *   /forge reject <name>   discard a proposal
 *
 * Review-only by design: scan writes to data/skill-proposals/ — NEVER the live
 * skills dir. Nothing goes live except via an explicit human `accept`. Opt-in:
 * SUDO_SKILL_FORGE=1 (requires SUDO_TRACE_LEARNING=1 so traces exist).
 */

import { mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
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
 * Sanitize a user-supplied proposal name to a safe file stem. Strips any path
 * component (no traversal), lowercases, keeps [a-z0-9-], caps length. Returns
 * null when nothing usable remains.
 */
function sanitizeName(raw: string): string | null {
  const base = path.basename((raw ?? '').trim()).replace(/\.md$/i, '');
  const clean = base.toLowerCase().replace(/[^a-z0-9-]/g, '');
  return clean.length > 0 ? clean.slice(0, 60) : null;
}

/**
 * Run a SkillForge scan and write each candidate's generated SKILL.md to the
 * proposals (review) directory. Does NOT call accept() and does NOT write to the
 * live skills dir — proposals stay inert until a human promotes them. Returns a
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
    'NONE are live. Review each, then `/forge accept <name>` to promote or `/forge reject <name>` to discard.',
    '',
    ...lines,
  ].join('\n');
}

/** List the pending proposals in the review dir. Exported for testing. */
export function listProposals(proposalsDir: string): string {
  if (!existsSync(proposalsDir)) {
    return 'No proposals yet. Run `/forge` to scan recorded usage and generate some.';
  }
  const files = readdirSync(proposalsDir).filter((f) => f.endsWith('.md'));
  if (files.length === 0) return 'No pending skill proposals.';
  const lines = files.map((f) => `  • ${f.replace(/\.md$/i, '')}`);
  return [
    'Pending skill proposals (review the markdown, then accept/reject):',
    ...lines,
    '',
    'Promote: `/forge accept <name>`   Discard: `/forge reject <name>`',
  ].join('\n');
}

/**
 * PROMOTE a reviewed proposal into the live skills dir (the explicit human gate).
 * Never overwrites an existing live skill. Exported for testing.
 */
export function acceptProposal(proposalsDir: string, liveSkillsDir: string, rawName: string): string {
  const name = sanitizeName(rawName);
  if (!name) return 'Usage: `/forge accept <name>` (see `/forge list`).';
  const proposalPath = path.join(proposalsDir, `${name}.md`);
  if (!existsSync(proposalPath)) {
    return `No proposal named "${name}". Run \`/forge list\` to see pending proposals.`;
  }
  const livePath = path.join(liveSkillsDir, `${name}.md`);
  if (existsSync(livePath)) {
    return `A live skill "${name}" already exists at ${livePath} — remove it first if you want to replace it.`;
  }
  mkdirSync(liveSkillsDir, { recursive: true });
  writeFileSync(livePath, readFileSync(proposalPath, 'utf8'), 'utf8');
  rmSync(proposalPath, { force: true });
  log.info({ name, livePath }, 'Skill proposal accepted → promoted to live skills');
  return `Accepted "${name}" → ${livePath}. It will load as a skill on next start.`;
}

/** Discard a proposal. Exported for testing. */
export function rejectProposal(proposalsDir: string, rawName: string): string {
  const name = sanitizeName(rawName);
  if (!name) return 'Usage: `/forge reject <name>` (see `/forge list`).';
  const proposalPath = path.join(proposalsDir, `${name}.md`);
  if (!existsSync(proposalPath)) return `No proposal named "${name}".`;
  rmSync(proposalPath, { force: true });
  log.info({ name }, 'Skill proposal rejected (deleted)');
  return `Rejected "${name}" — proposal deleted.`;
}

export const forgeCommand: SlashCommand = {
  name: 'forge',
  description: 'Propose reusable skills from recorded usage; review with list/accept/reject (nothing goes live without accept).',
  usage: '/forge [list | accept <name> | reject <name>]',

  async execute(args: string, _ctx: CommandContext): Promise<string> {
    if (process.env['SUDO_SKILL_FORGE'] !== '1') {
      return 'Skill forge is disabled. Set SUDO_SKILL_FORGE=1 (and SUDO_TRACE_LEARNING=1) to enable it.';
    }
    const dataDir = process.env['DATA_DIR'];
    if (!dataDir) {
      return 'Skill forge needs DATA_DIR set (the directory holding traces.db).';
    }
    const proposalsDir = path.join(dataDir, 'skill-proposals');
    const liveSkillsDir = path.resolve(process.cwd(), 'skills');

    const trimmed = (args ?? '').trim();
    const [sub, ...rest] = trimmed.split(/\s+/);
    const argName = rest.join(' ');

    try {
      if (sub === 'list') return listProposals(proposalsDir);
      if (sub === 'accept') return acceptProposal(proposalsDir, liveSkillsDir, argName);
      if (sub === 'reject') return rejectProposal(proposalsDir, argName);
      if (trimmed !== '' && sub !== 'scan') {
        return 'Usage: `/forge` (scan) · `/forge list` · `/forge accept <name>` · `/forge reject <name>`';
      }

      // Default: scan recorded usage → propose (review-only).
      let traceStore: TraceStore | undefined;
      try {
        traceStore = new TraceStore(path.join(dataDir, 'traces.db'));
        await traceStore.init();
        const analyzer = new TraceAnalyzer(traceStore);
        const forge = new SkillForge(traceStore, analyzer, proposalsDir);
        return await proposeSkills(forge, proposalsDir);
      } finally {
        try { traceStore?.close(); } catch { /* ignore */ }
      }
    } catch (err) {
      log.warn({ err: String(err) }, 'Skill forge command failed');
      return `Skill forge failed: ${String(err)}`;
    }
  },
};
