/**
 * @file eval.ts
 * @description skill.eval — prove a skill helps BEFORE adopting it.
 *
 * Runs test prompts with and without the candidate skill and reports a
 * position-debiased blind-judge win-rate plus an adopt/reject/inconclusive
 * recommendation (see skills/skill-eval.ts for the method). Candidate
 * sources, in precedence order: inline `markdown`, a registry skill by
 * `name` (checksum-verified fetch), or an already-installed local skill.
 *
 * Read-only: evaluates and reports; it never writes a skill. Follow up with
 * skill.install / skill.apply to adopt.
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createLogger } from '../../../../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../../types.js';
import { runSkillEval, type EvalBrain } from '../../../../skills/skill-eval.js';
import { SkillRegistryClient, isSkillRegistryEnabled } from '../../../../skills/registry-client.js';

const logger = createLogger('skill.eval');

function localSkillPath(name: string): string | null {
  if (!/^[a-z0-9][a-z0-9.-]{0,63}$/i.test(name)) return null;
  const p = path.join(process.cwd(), 'skills', name, 'SKILL.md');
  return existsSync(p) ? p : null;
}

export const evalTool: ToolDefinition = {
  name: 'skill.eval',
  description:
    'Measure whether a skill actually improves answers BEFORE adopting it: runs test prompts '
    + 'with and without the skill, judges the pairs blind (order-swapped to cancel position bias), '
    + 'and reports a win-rate plus adopt/reject/inconclusive recommendation. Use before '
    + 'skill.install or skill.apply, when asked to "test/benchmark/evaluate a skill", or to compare '
    + 'a skill against no-skill baseline. Read-only — never installs anything.',
  category: 'skill' as import('../../../types.js').ToolCategory,
  timeout: 240_000,
  parameters: {
    name: {
      type: 'string',
      description: 'Skill to evaluate: a registry name (fetched + checksum-verified) or an installed local skill name.',
    },
    markdown: {
      type: 'string',
      description: 'Inline SKILL.md content to evaluate (takes precedence over name).',
    },
    prompts: {
      type: 'array',
      description: 'Explicit test prompts. Omit to auto-generate realistic ones from the skill itself.',
    },
    maxPrompts: {
      type: 'number',
      description: 'How many prompts to test (default 3, max 8). Each costs 4 fast-tier brain calls.',
      default: 3,
    },
    threshold: {
      type: 'number',
      description: 'Win-rate required for an "adopt" recommendation (default 0.6).',
      default: 0.6,
    },
    runs: {
      type: 'number',
      description: 'Complete passes per prompt for variance (mean ± stddev). Default 1, max 3; cost scales linearly.',
      default: 1,
    },
    assertions: {
      type: 'array',
      description: 'Format/outcome contracts (strings) graded against BOTH arms with evidence; assertions behaving identically on both arms are flagged non-discriminating.',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const brain = (ctx.config as { brain?: EvalBrain } | null)?.brain;
    if (!brain || typeof brain.call !== 'function') {
      return { success: false, output: 'skill.eval: brain is not available on ctx.config — cannot run evaluations.' };
    }

    const inlineMd = typeof params['markdown'] === 'string' && params['markdown'].trim() ? params['markdown'] : undefined;
    const name = typeof params['name'] === 'string' ? params['name'].trim() : '';
    const prompts = Array.isArray(params['prompts'])
      ? (params['prompts'] as unknown[]).filter((p): p is string => typeof p === 'string')
      : undefined;
    const maxPrompts = typeof params['maxPrompts'] === 'number' ? params['maxPrompts'] : 3;
    const threshold = typeof params['threshold'] === 'number' ? params['threshold'] : 0.6;
    const runs = typeof params['runs'] === 'number' ? params['runs'] : 1;
    const assertions = Array.isArray(params['assertions'])
      ? (params['assertions'] as unknown[]).filter((a): a is string => typeof a === 'string')
      : undefined;

    let skillName = name || 'inline-skill';
    let markdown = inlineMd;
    let source = 'inline';

    try {
      if (!markdown) {
        if (!name) return { success: false, output: 'Provide a skill `name` (registry or local) or inline `markdown`.' };
        const local = localSkillPath(name);
        if (isSkillRegistryEnabled()) {
          try {
            const fetched = await new SkillRegistryClient().fetchSkill(name);
            markdown = fetched.markdown;
            skillName = fetched.entry.name;
            source = `registry (${fetched.sourceUrl})`;
          } catch (err) {
            if (!local) throw err;
          }
        }
        if (!markdown && local) {
          markdown = readFileSync(local, 'utf8');
          source = `local (${local})`;
        }
        if (!markdown) return { success: false, output: `Skill "${name}" not found in the registry or locally.` };
      }

      logger.info({ session: ctx.sessionId, skillName, source, maxPrompts, runs }, 'skill.eval invoked');
      const report = await runSkillEval({ skillName, markdown, brain, prompts, maxPrompts, threshold, runs, assertions });

      const lines = report.results.map((r) => {
        const score = r.withScore !== undefined && r.withoutScore !== undefined
          ? ` (rubric with ${Math.round(r.withScore * 100)} vs without ${Math.round(r.withoutScore * 100)})` : '';
        return `- [${r.winner.toUpperCase()}]${score} ${r.prompt.slice(0, 90)}${r.prompt.length > 90 ? '…' : ''}\n  judge: ${r.reason}`;
      });
      const rate = report.winRate === null ? 'n/a' : `${Math.round(report.winRate * 100)}%`;
      const variance = report.winRateStddev !== undefined
        ? ` (±${Math.round(report.winRateStddev * 100)}pp over ${report.runsPerPrompt} runs)` : '';
      let assertionBlock = '';
      if (report.assertions && report.assertions.length > 0) {
        assertionBlock = '\nAssertions (with | without | discriminating):\n' + report.assertions
          .map((a) => `- ${a.withPassed ? '✓' : '✗'} | ${a.withoutPassed ? '✓' : '✗'} | ${a.discriminating ? 'yes' : 'NO'} — ${a.text}\n  evidence: ${a.evidence}`)
          .join('\n') + '\n';
        if ((report.nonDiscriminatingAssertions ?? []).length > 0) {
          assertionBlock += `Non-discriminating (same outcome on both arms — cannot measure the skill): ${report.nonDiscriminatingAssertions!.length}\n`;
        }
      }
      return {
        success: true,
        output:
          `Skill eval for "${skillName}" (${source}) — ${report.prompts} prompt(s) × ${report.runsPerPrompt} run(s), with-vs-without baseline:\n`
          + `wins ${report.wins} / losses ${report.losses} / ties ${report.ties} / inconsistent-judge ${report.inconsistent}\n`
          + `win-rate ${rate}${variance} vs threshold ${Math.round(report.threshold * 100)}% → **${report.recommendation.toUpperCase()}**\n`
          + assertionBlock + '\n'
          + `${lines.join('\n')}\n\n`
          + (report.recommendation === 'adopt'
            ? 'Recommendation: adopt — follow up with skill.install/skill.apply.'
            : report.recommendation === 'reject'
              ? 'Recommendation: reject — the skill did not beat the no-skill baseline.'
              : 'Recommendation: inconclusive — too few decisive verdicts; add explicit prompts or raise maxPrompts.'),
        data: { report, source },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ session: ctx.sessionId, skillName, err: msg }, 'skill.eval failed');
      return { success: false, output: `skill.eval failed: ${msg}` };
    }
  },
};
