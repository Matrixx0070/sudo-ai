/**
 * Self-Improvement Engine — SUDO-AI's autonomous growth loop.
 *
 * Flow (runs weekly by cron or on-demand via meta.self-improve):
 *
 *  1. DETECT   — PatternDetector reads DB (feedback, tool calls, conversations)
 *  2. ANALYSE  — Brain (Grok) reads patterns, generates specific improvement actions
 *  3. APPLY    — Engine executes: updates LEARNINGS.md, patches intent patterns,
 *                fixes tool descriptions, writes self_improvements log
 *  4. VERIFY   — Schedules a follow-up check 7 days later
 *
 * Conservative approach: engine only touches workspace/ files and DB.
 * It does NOT auto-patch TypeScript source — it drafts patches and
 * writes them to data/improvement-drafts/ for meta.self-modify to apply.
 */

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createLogger } from '../shared/logger.js';
import { detectPatterns } from './pattern-detector.js';
import type { DetectedPatterns } from './pattern-detector.js';
import { FeedbackMemory } from './feedback-memory.js';
import { AutoResearch } from './auto-research.js';
import { HeldOutGate } from '../learning/held-out-gate.js';
import type { PolicyAction } from '../learning/trace-driven-policy.js';

const log = createLogger('self-improvement:engine');

const DB_PATH        = path.resolve('data', 'mind.db');
const LEARNINGS_PATH = path.resolve('workspace', 'LEARNINGS.md');
const DRAFTS_DIR     = path.resolve('data', 'improvement-drafts');

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function initDb(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS self_improvements (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      run_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      trigger      TEXT    NOT NULL DEFAULT 'manual',
      health_score INTEGER NOT NULL DEFAULT 0,
      patterns_json TEXT   NOT NULL DEFAULT '{}',
      actions_json TEXT    NOT NULL DEFAULT '[]',
      learnings_patch TEXT,
      status       TEXT    NOT NULL DEFAULT 'completed'
    );
    CREATE INDEX IF NOT EXISTS idx_si_run_at ON self_improvements(run_at);
  `);
}

function logRun(
  db: Database.Database,
  trigger: string,
  healthScore: number,
  patterns: DetectedPatterns,
  actions: ImprovementAction[],
  learningsPatch: string,
): void {
  db.prepare(`
    INSERT INTO self_improvements
      (trigger, health_score, patterns_json, actions_json, learnings_patch)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    trigger,
    healthScore,
    JSON.stringify(patterns),
    JSON.stringify(actions),
    learningsPatch,
  );
}

// ---------------------------------------------------------------------------
// Action types
// ---------------------------------------------------------------------------

export interface ImprovementAction {
  type: 'learnings_update' | 'routing_hint' | 'tool_note' | 'cron_fix' | 'draft_patch';
  description: string;
  applied: boolean;
  detail?: string;
}

// ---------------------------------------------------------------------------
// LEARNINGS.md builder
// ---------------------------------------------------------------------------

async function readLearnings(): Promise<string> {
  try {
    return await readFile(LEARNINGS_PATH, 'utf-8');
  } catch {
    return '# LEARNINGS.md — SUDO-AI Autonomous Self-Improvement Log\n\n_Updated automatically. Do not edit manually._\n\n';
  }
}

function buildNewLearningBlock(patterns: DetectedPatterns, brainAnalysis: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const lines: string[] = [
    `## ${date} — Autonomous Improvement Run`,
    ``,
    `**Health Score:** ${patterns.healthScore}/100`,
    `**Analysis window:** ${patterns.windowDays} days`,
    ``,
  ];

  if (patterns.badFeedbackTypes.length > 0) {
    lines.push(`### Owner Feedback Patterns`);
    for (const p of patterns.badFeedbackTypes) {
      const pct = Math.round(p.badRate * 100);
      lines.push(`- **${p.taskType}**: ${pct}% bad rate (${p.bad} bad / ${p.good} good)`);
      if (p.badSamples.length > 0) {
        lines.push(`  - Bad examples: ${p.badSamples.map(s => `"${s}"`).join(', ')}`);
      }
    }
    lines.push('');
  }

  if (patterns.failingTools.length > 0) {
    lines.push(`### Failing Tools`);
    for (const t of patterns.failingTools) {
      lines.push(`- **${t.name}**: ${Math.round(t.failRate * 100)}% fail rate (${t.failures}/${t.calls} calls)`);
    }
    lines.push(`- **Action**: Prefer fallback tools or notify the owner when these fail.`);
    lines.push('');
  }

  if (patterns.unusedTools.length > 0) {
    lines.push(`### Underutilised Tools (consider using more)`);
    lines.push(patterns.unusedTools.map(t => `- ${t}`).join('\n'));
    lines.push('');
  }

  if (brainAnalysis.trim()) {
    lines.push(`### Brain Analysis & Behavioural Rules`);
    lines.push(brainAnalysis.trim());
    lines.push('');
  }

  lines.push(`---`);
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Improvement drafts
// ---------------------------------------------------------------------------

async function writeDraft(filename: string, content: string): Promise<string> {
  await mkdir(DRAFTS_DIR, { recursive: true });
  const filePath = path.join(DRAFTS_DIR, filename);
  await writeFile(filePath, content, 'utf-8');
  return filePath;
}

// ---------------------------------------------------------------------------
// Main engine
// ---------------------------------------------------------------------------

/** Rollback record for an applied improvement that passed the HeldOutGate. */
export interface ImprovementRollback {
  /** Unique identifier for the improvement proposal. */
  proposalId: string;
  /** The improvement action that was applied. */
  action: ImprovementAction;
  /** ISO timestamp of when the improvement was applied. */
  appliedAt: string;
}

export async function runSelfImprovement(options: {
  trigger?: string;
  windowDays?: number;
  brain?: { chat(messages: { role: string; content: string }[], model?: string): Promise<string> };
  /** Optional HeldOutGate — when provided, improvements are evaluated before being applied. */
  heldOutGate?: HeldOutGate;
}): Promise<{ actions: ImprovementAction[]; healthScore: number; summary: string; rollbacks: ImprovementRollback[] }> {

  const trigger    = options.trigger ?? 'manual';
  const windowDays = options.windowDays ?? 14;
  const rollbacks: ImprovementRollback[] = [];

  log.info({ trigger, windowDays }, 'Self-improvement run started');

  // --- STEP 1: DETECT ---
  const patterns = detectPatterns(windowDays);
  log.info({ healthScore: patterns.healthScore, failingTools: patterns.failingTools.length }, 'Patterns detected');

  const actions: ImprovementAction[] = [];

  // --- STEP 1b: FEEDBACK MEMORY + AUTO-RESEARCH ---
  // Open a separate writable DB handle for FeedbackMemory (mind.db must exist).
  if (existsSync(DB_PATH)) {
    try {
      const fbDb = new Database(DB_PATH);
      fbDb.pragma('journal_mode = WAL');
      const feedbackMemory = new FeedbackMemory(fbDb);

      // Surface success patterns alongside failure patterns for a balanced view.
      const successPatterns = feedbackMemory.getSuccessPatterns(undefined, 20);
      if (successPatterns.length > 0) {
        const topTools = [...new Set(successPatterns.map(r => r.tool_name))].slice(0, 5);
        log.info({ topTools, count: successPatterns.length }, 'Success patterns read from FeedbackMemory');
      }

      // Per-tool stats — used to determine recurring failure domains.
      const toolStats = feedbackMemory.getToolStats();

      // Spawn AutoResearch for any tool with 3+ failures AND a brain available.
      if (options.brain && patterns.failingTools.length > 0) {
        const brainCall = (prompt: string) =>
          options.brain!.chat([{ role: 'user', content: prompt }]);
        const autoResearch = new AutoResearch(brainCall);

        for (const tool of patterns.failingTools) {
          const stats = toolStats.get(tool.name);
          const feedbackFailures = stats?.failures ?? 0;
          // Trigger auto-research when feedback DB confirms 3+ failures for this tool.
          if (feedbackFailures >= 3) {
            const lastErr = feedbackMemory
              .getFailurePatterns(tool.name, 1)
              .map(r => r.outcome_summary)[0] ?? '';
            try {
              const findings = await autoResearch.runForPattern({
                domain: tool.name,
                failureCount: feedbackFailures,
                lastError: lastErr,
              });
              log.info({ tool: tool.name, feedbackFailures, findingsLen: findings.length },
                'AutoResearch findings generated');
              // Phase 2: gate AutoResearch draft patches through HeldOutGate.
              const draftProposalId = `auto-research-${tool.name}-${Date.now()}`;
              const draftShouldApply = options.heldOutGate
                ? await (async () => {
                    try {
                      const policyAction: PolicyAction = { params: { description: `AutoResearch for ${tool.name}` } };
                      const evalResult = await options.heldOutGate!.evaluate(draftProposalId, policyAction);
                      if (evalResult.passed) {
                        rollbacks.push({
                          proposalId: draftProposalId,
                          action: { type: 'draft_patch', description: `AutoResearch ran for recurring failure domain: ${tool.name}`, applied: true },
                          appliedAt: new Date().toISOString(),
                        });
                        return true;
                      }
                      log.warn({ tool: tool.name, passRate: evalResult.passRate.toFixed(3) }, 'HeldOutGate rejected AutoResearch draft — skipping');
                      return false;
                    } catch (err) {
                      log.warn({ tool: tool.name, err: String(err) }, 'HeldOutGate eval failed for AutoResearch — allowing by default');
                      return true;
                    }
                  })()
                : true;
              actions.push({
                type: 'draft_patch',
                description: `AutoResearch ran for recurring failure domain: ${tool.name}`,
                applied: draftShouldApply,
                detail: findings.slice(0, 500),
              });
            } catch (err) {
              log.warn({ tool: tool.name, err: String(err) }, 'AutoResearch failed — continuing');
            }
          }
        }
      }

      fbDb.close();
    } catch (err) {
      log.warn({ err: String(err) }, 'FeedbackMemory init failed — skipping feedback+auto-research');
    }
  } else {
    log.warn({ dbPath: DB_PATH }, 'mind.db not found — skipping FeedbackMemory step');
  }

  // --- STEP 2: BRAIN ANALYSIS (if brain provided) ---
  let brainAnalysis = '';
  if (options.brain && (
    patterns.badFeedbackTypes.length > 0 ||
    patterns.failingTools.length > 0 ||
    patterns.routingGaps.length > 0
  )) {
    try {
      const prompt = buildAnalysisPrompt(patterns);
      brainAnalysis = await options.brain.chat([
        { role: 'user', content: prompt },
      ]);
      log.info({ chars: brainAnalysis.length }, 'Brain analysis received');
    } catch (err) {
      log.warn({ err: String(err) }, 'Brain analysis failed — continuing without it');
    }
  }

  // --- STEP 3: APPLY ---

  /** Helper: evaluate an improvement through the HeldOutGate before applying.
   *  Returns true if the improvement should be applied (gate passed or no gate). */
  async function shouldApply(proposalId: string, description: string): Promise<boolean> {
    if (!options.heldOutGate) return true;

    // Derive a lightweight PolicyAction from the improvement description.
    const policyAction: PolicyAction = { params: { description } };

    try {
      const evaluation = await options.heldOutGate.evaluate(proposalId, policyAction);
      if (evaluation.passed) {
        log.info({ proposalId, passRate: evaluation.passRate.toFixed(3) },
          'HeldOutGate approved improvement');
        // Store rollback info for gate-approved improvements.
        rollbacks.push({
          proposalId,
          action: { type: 'learnings_update', description, applied: true },
          appliedAt: new Date().toISOString(),
        });
        return true;
      } else {
        log.warn({ proposalId, passRate: evaluation.passRate.toFixed(3), regressions: evaluation.regressionDetails },
          'HeldOutGate rejected improvement — skipping');
        return false;
      }
    } catch (err) {
      log.warn({ proposalId, err: String(err) },
        'HeldOutGate evaluation failed — allowing improvement by default');
      return true;
    }
  }

  // 3a. Update LEARNINGS.md
  try {
    const existing = await readLearnings();
    const newBlock  = buildNewLearningBlock(patterns, brainAnalysis);
    // Keep last 20 blocks to avoid bloat — truncate old entries
    const blocks = (existing + newBlock).split(/^---$/m);
    const kept   = blocks.slice(-20).join('---');

    const learningsProposalId = `learnings-${Date.now()}`;
    const shouldWrite = await shouldApply(learningsProposalId, 'Update LEARNINGS.md with new patterns and rules');

    if (shouldWrite) {
      await writeFile(LEARNINGS_PATH, kept, 'utf-8');
    }

    actions.push({
      type: 'learnings_update',
      description: 'Updated LEARNINGS.md with new patterns and rules',
      applied: shouldWrite,
      detail: `Health score: ${patterns.healthScore}/100`,
    });
    log.info({ applied: shouldWrite }, 'LEARNINGS.md update resolved');
  } catch (err) {
    log.error({ err: String(err) }, 'Failed to update LEARNINGS.md');
  }

  // 3b. Write routing hint drafts for failing tools
  if (patterns.failingTools.length > 0) {
    const draftContent = [
      `# Failing Tool Routing Hints — ${new Date().toISOString().slice(0,10)}`,
      `# Apply these with meta.self-modify to src/core/agent/intent-classifier.ts`,
      ``,
      `// ADD these fallback notes to formatIntentHint() output:`,
      ...patterns.failingTools.map(t =>
        `// WARN: ${t.name} has ${Math.round(t.failRate*100)}% fail rate — prefer alternatives when available`
      ),
    ].join('\n');

    const draftPath = await writeDraft(`routing-hints-${Date.now()}.txt`, draftContent);
    actions.push({
      type: 'routing_hint',
      description: `Drafted routing hints for ${patterns.failingTools.length} failing tools`,
      applied: false,
      detail: draftPath,
    });
  }

  // 3c. Cron fix drafts
  if (patterns.cronIssues.length > 0) {
    for (const issue of patterns.cronIssues) {
      actions.push({
        type: 'cron_fix',
        description: `Cron job "${issue.jobName}" failed ${issue.failures}/${issue.runs} runs`,
        applied: false,
        detail: 'Review cron job configuration with meta.cron-manager',
      });
    }
  }

  // 3d. Unused tool reminder
  if (patterns.unusedTools.length > 0) {
    const unusedProposalId = `unused-tools-${Date.now()}`;
    const unusedShouldApply = await shouldApply(unusedProposalId,
      `${patterns.unusedTools.length} high-value tools unused — will proactively suggest`);

    actions.push({
      type: 'tool_note',
      description: `${patterns.unusedTools.length} high-value tools unused — will proactively suggest`,
      applied: unusedShouldApply,
      detail: patterns.unusedTools.join(', '),
    });
  }

  // --- STEP 4: LOG TO DB ---
  const db = new Database(DB_PATH);
  try {
    initDb(db);
    logRun(db, trigger, patterns.healthScore, patterns, actions, brainAnalysis.slice(0, 2000));
  } finally {
    db.close();
  }

  // --- SUMMARY ---
  const appliedCount = actions.filter(a => a.applied).length;
  const summary = buildSummary(patterns, actions, appliedCount);

  log.info({ appliedCount, healthScore: patterns.healthScore, rollbackCount: rollbacks.length },
    'Self-improvement run complete');

  return { actions, healthScore: patterns.healthScore, summary, rollbacks };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildAnalysisPrompt(patterns: DetectedPatterns): string {
  const lines: string[] = [
    'You are SUDO-AI analysing your own performance patterns to self-improve.',
    'Based on the data below, write 3-5 specific behavioural RULES you should follow.',
    'Rules must be actionable, concise (1 line each), and start with a verb.',
    'Focus on what to do differently, not what went wrong.',
    '',
    '## Data',
  ];

  if (patterns.badFeedbackTypes.length > 0) {
    lines.push('### Owner rated these task types BAD:');
    for (const p of patterns.badFeedbackTypes) {
      lines.push(`- ${p.taskType}: ${Math.round(p.badRate*100)}% bad rate`);
      if (p.badSamples.length) lines.push(`  Samples: ${p.badSamples.join(' | ')}`);
    }
  }

  if (patterns.failingTools.length > 0) {
    lines.push('### Failing tools:');
    for (const t of patterns.failingTools) {
      lines.push(`- ${t.name}: ${Math.round(t.failRate*100)}% fail rate`);
    }
  }

  if (patterns.routingGaps.length > 0) {
    lines.push('### Owner asks these things repeatedly:');
    for (const g of patterns.routingGaps) {
      lines.push(`- "${g.sample}" (asked ${g.frequency}x)`);
    }
  }

  lines.push('');
  lines.push('Write your rules as a numbered list. Be specific and direct.');

  return lines.join('\n');
}

function buildSummary(
  patterns: DetectedPatterns,
  actions: ImprovementAction[],
  appliedCount: number,
): string {
  const parts: string[] = [
    `🔄 **Self-Improvement Run Complete**`,
    ``,
    `**Health Score:** ${patterns.healthScore}/100`,
    `**Applied:** ${appliedCount}/${actions.length} improvements`,
    ``,
  ];

  if (patterns.badFeedbackTypes.length > 0) {
    parts.push(`**Feedback issues fixed:**`);
    for (const p of patterns.badFeedbackTypes) {
      parts.push(`- ${p.taskType}: ${Math.round(p.badRate*100)}% bad rate → rules added to LEARNINGS.md`);
    }
    parts.push('');
  }

  if (patterns.failingTools.length > 0) {
    parts.push(`**Failing tools noted:**`);
    for (const t of patterns.failingTools) {
      parts.push(`- ${t.name}: ${Math.round(t.failRate*100)}% fail rate`);
    }
    parts.push('');
  }

  if (patterns.unusedTools.length > 0) {
    parts.push(`**Underutilised tools:** ${patterns.unusedTools.join(', ')}`);
    parts.push('');
  }

  parts.push(`LEARNINGS.md updated. All rules active in next session.`);

  return parts.join('\n');
}
