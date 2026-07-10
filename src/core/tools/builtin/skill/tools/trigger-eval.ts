/**
 * @file trigger-eval.ts
 * @description skill.trigger-eval — measure (and optionally optimize) a
 * skill's trigger phrases against should/should-not-trigger queries, using
 * the PRODUCTION matcher (skills/skill-activator.ts). Evaluation is free and
 * deterministic; only eval-set generation and optimization proposals cost
 * brain calls. Read-only: proposed trigger sets are reported, never written
 * (adopt via skill.apply — the single gated write path).
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createLogger } from '../../../../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../../types.js';
import { parseSkillFile } from '../../../../skills/markdown-loader.js';
import { effectiveTriggers } from '../../../../skills/skill-activator.js';
import {
  runTriggerEval,
  runTriggerEvalCombined,
  optimizeTriggers,
  generateTriggerEvalSet,
  type TriggerBrain,
  type TriggerEvalCase,
} from '../../../../skills/trigger-eval.js';
import { SkillRegistryClient, isSkillRegistryEnabled } from '../../../../skills/registry-client.js';

const logger = createLogger('skill.trigger-eval');

function fmtPct(x: number | null): string {
  return x === null ? 'n/a' : `${Math.round(x * 100)}%`;
}

export const triggerEvalTool: ToolDefinition = {
  name: 'skill.trigger-eval',
  description:
    'Measure whether a skill TRIGGERS correctly: runs should-trigger / should-not-trigger queries '
    + 'through the real runtime matcher and reports precision, recall, accuracy, and every miss or '
    + 'false fire. With optimize=true it also proposes a better trigger set (train/test split, '
    + 'best-by-held-out selection) — report only, adopt via skill.apply. Use when asked to "test '
    + 'the triggers", "why did the skill (not) activate", or after installing/authoring a skill.',
  category: 'skill' as import('../../../types.js').ToolCategory,
  timeout: 180_000,
  parameters: {
    name: {
      type: 'string',
      description: 'Skill name: installed local skill (skills/<name>/SKILL.md) or registry skill.',
    },
    markdown: {
      type: 'string',
      description: 'Inline SKILL.md content to evaluate instead of a named skill.',
    },
    queries: {
      type: 'array',
      description: 'Eval cases: [{query, should_trigger}]. Omit to auto-generate (costs 1 brain call).',
    },
    optimize: {
      type: 'boolean',
      description: 'Propose an improved trigger set from the failures (default false).',
      default: false,
    },
    maxIterations: {
      type: 'number',
      description: 'Optimization iterations (default 5, max 10). Scoring is free; each iteration costs 1 brain call.',
      default: 5,
    },
    semantic: {
      type: 'boolean',
      description: 'Also measure the COMBINED activator (deterministic + semantic recall assist, the real turn path) and report both matrices side by side (default false; local embeddings, no API cost).',
      default: false,
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const name = typeof params['name'] === 'string' ? params['name'].trim() : '';
    const inlineMd = typeof params['markdown'] === 'string' && params['markdown'].trim() ? params['markdown'] : undefined;
    const optimize = params['optimize'] === true;
    const maxIterations = typeof params['maxIterations'] === 'number' ? params['maxIterations'] : 5;
    const brain = (ctx.config as { brain?: TriggerBrain } | null)?.brain;

    // Resolve the skill: inline > local install > registry.
    let markdown = inlineMd;
    let skillName = name || 'inline-skill';
    let source = 'inline';
    try {
      if (!markdown) {
        if (!name) return { success: false, output: 'Provide a skill `name` or inline `markdown`.' };
        const localPath = /^[a-z0-9][a-z0-9.-]{0,63}$/i.test(name)
          ? path.join(process.cwd(), 'skills', name, 'SKILL.md') : '';
        if (localPath && existsSync(localPath)) {
          markdown = readFileSync(localPath, 'utf8');
          source = `local (${localPath})`;
        } else if (isSkillRegistryEnabled()) {
          const fetched = await new SkillRegistryClient().fetchSkill(name);
          markdown = fetched.markdown;
          skillName = fetched.entry.name;
          source = `registry (${fetched.sourceUrl})`;
        }
        if (!markdown) return { success: false, output: `Skill "${name}" not found locally or in the registry.` };
      }
      const parsed = parseSkillFile(markdown, 'inline.md', skillName);
      skillName = parsed.name || skillName;
      const triggers = effectiveTriggers(parsed);
      if (triggers.length === 0) {
        return { success: false, output: `Skill "${skillName}" declares no trigger phrases (frontmatter \`triggers:\`) — nothing to evaluate.` };
      }

      // Eval cases: explicit or generated.
      let cases: TriggerEvalCase[] = Array.isArray(params['queries'])
        ? (params['queries'] as unknown[]).flatMap((q) => {
            const o = q as { query?: unknown; should_trigger?: unknown; shouldTrigger?: unknown };
            const st = typeof o?.should_trigger === 'boolean' ? o.should_trigger
              : typeof o?.shouldTrigger === 'boolean' ? o.shouldTrigger : undefined;
            return typeof o?.query === 'string' && st !== undefined ? [{ query: o.query, shouldTrigger: st }] : [];
          })
        : [];
      if (cases.length === 0) {
        if (!brain || typeof brain.call !== 'function') {
          return { success: false, output: 'No queries provided and no brain available to generate them — pass `queries` explicitly.' };
        }
        cases = await generateTriggerEvalSet(skillName, markdown, brain);
      }

      logger.info({ session: ctx.sessionId, skillName, source, cases: cases.length, optimize }, 'skill.trigger-eval invoked');

      const report = runTriggerEval(skillName, triggers, cases);
      const m = report.matrix;
      const failures = report.results.filter((r) => !r.pass);
      const lines = [
        `Trigger eval for "${skillName}" (${source}) — ${cases.length} queries against the PRODUCTION matcher:`,
        `accuracy ${fmtPct(m.accuracy)} | precision ${fmtPct(m.precision)} | recall ${fmtPct(m.recall)} (tp ${m.tp} / fp ${m.fp} / tn ${m.tn} / fn ${m.fn})`,
      ];
      if (failures.length > 0) {
        lines.push('', 'Failures:');
        for (const f of failures) {
          lines.push(f.shouldTrigger
            ? `- MISSED: "${f.query}"`
            : `- FALSE FIRE (matched "${f.matchedPhrase}"): "${f.query}"`);
        }
      } else {
        lines.push('', 'All queries classified correctly.');
      }

      // semantic=true: measure the COMBINED path (what the agent loop actually
      // runs) with the budget disabled so results are exact, and report both
      // matrices. Fail-open: an unavailable embedder just reports as such.
      let combinedReport = null;
      if (params['semantic'] === true) {
        const { selectSemanticSkill } = await import('../../../../skills/semantic-assist.js');
        const probeSkill = { name: skillName, description: parsed.description, content: '', triggers };
        combinedReport = await runTriggerEvalCombined(skillName, triggers, cases, async (q) => {
          const hit = await selectSemanticSkill(q, [probeSkill], { budgetMs: 0 });
          return hit ? { phrase: hit.phrase } : null;
        });
        const cm = combinedReport.matrix;
        const semanticHits = combinedReport.results.filter((r) => r.matchedPhrase?.startsWith('~')).length;
        lines.push(
          '',
          `COMBINED activator (deterministic + semantic recall, the real turn path; ${semanticHits} semantic hit(s)):`,
          `accuracy ${fmtPct(cm.accuracy)} | precision ${fmtPct(cm.precision)} | recall ${fmtPct(cm.recall)} (tp ${cm.tp} / fp ${cm.fp} / tn ${cm.tn} / fn ${cm.fn})`,
        );
      }

      let optReport = null;
      if (optimize && failures.length > 0) {
        if (!brain || typeof brain.call !== 'function') {
          lines.push('', 'optimize=true requested but no brain available — skipped.');
        } else {
          optReport = await optimizeTriggers({
            skillName,
            description: parsed.description,
            triggers,
            cases,
            brain,
            maxIterations,
          });
          const fm = optReport.finalReport.matrix;
          lines.push(
            '',
            `Optimization (${optReport.iterationsRun} iteration(s), ${optReport.exitReason}; winner by held-out accuracy):`,
            `best triggers: ${JSON.stringify(optReport.bestTriggers)}`,
            `full-set accuracy with best triggers: ${fmtPct(fm.accuracy)} (was ${fmtPct(m.accuracy)})`,
            'Adopt by re-authoring the skill with these triggers via skill.apply (the gated write path).',
          );
        }
      }

      return { success: true, output: lines.join('\n'), data: { report, combined: combinedReport, optimize: optReport, source } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ session: ctx.sessionId, skillName, err: msg }, 'skill.trigger-eval failed');
      return { success: false, output: `skill.trigger-eval failed: ${msg}` };
    }
  },
};
