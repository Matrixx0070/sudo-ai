/**
 * @file proposal-builder.ts
 * @description Async proposal construction helpers for the self-evolution subsystem.
 *
 * Contains two functions that build EvolutionProposal objects by calling
 * the brain LLM and then persisting the result:
 *   - buildFixProposal      — proposes a code fix for a target file
 *   - buildSoulUpdateProposal — proposes changes to SOUL.md
 *
 * Separated from evolver.ts to keep file sizes within the 300-line limit.
 */

import { readFile } from 'node:fs/promises';
import { createLogger } from '../../shared/logger.js';
import { ConsciousnessError } from '../errors.js';
import { genId } from '../../shared/utils.js';
import type { EvoBrainLike, EvoSelfModelLike, EvolutionProposal } from './types.js';
import { saveProposal } from './store.js';
import { generateSoulUpdate } from './soul-writer.js';
import type Database from 'better-sqlite3';

const log = createLogger('self-evolution:proposal-builder');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FIX_MAX_TOKENS = 2048;
const FIX_TEMPERATURE = 0.3;
const SOUL_UPDATE_INSIGHT_COUNT = 20;

// ---------------------------------------------------------------------------
// Duck-typed wisdom store interface
// ---------------------------------------------------------------------------

export interface WisdomStoreLike {
  getRecentInsights(count: number): Array<{ content: string }>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read a target file, ask the brain for a fix, persist and return the proposal.
 *
 * @param db     - Raw better-sqlite3 database instance.
 * @param brain  - LLM brain for fix generation.
 * @param target - Absolute path of the file to fix.
 * @param issue  - Plain-text description of the problem.
 */
export async function buildFixProposal(
  db: Database.Database,
  brain: EvoBrainLike,
  target: string,
  issue: string,
): Promise<EvolutionProposal> {
  if (!target || !issue) {
    throw new ConsciousnessError(
      'buildFixProposal: target and issue are required',
      'consciousness_evolution_invalid_proposal',
      { target, issue },
    );
  }

  log.info({ target }, 'Building fix proposal');

  // Read current file content — tolerate missing files.
  let currentCode: string | null = null;
  try {
    currentCode = await readFile(target, 'utf8');
  } catch (err) {
    log.warn(
      { target, error: String(err) },
      'buildFixProposal: target file not found, proceeding without current code',
    );
  }

  // Prompt the brain for a fix.
  let brainResponse: string;
  try {
    const result = await brain.call({
      messages: [
        {
          role: 'system',
          content:
            'You are reviewing a TypeScript source file and proposing a production-grade fix. ' +
            'Return ONLY the complete corrected file content with no markdown fences or explanation. ' +
            'If no fix is needed, return the original content unchanged.',
        },
        {
          role: 'user',
          content: [
            `File: ${target}`,
            '',
            'Issue:',
            issue,
            '',
            currentCode ? '## Current content\n\n' + currentCode : '(File does not exist yet)',
          ].join('\n'),
        },
      ],
      maxTokens: FIX_MAX_TOKENS,
      temperature: FIX_TEMPERATURE,
    });

    brainResponse = result.content;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `buildFixProposal: LLM call failed: ${msg}`,
      'consciousness_evolution_proposal_error',
      { target, cause: msg },
    );
  }

  const proposal: EvolutionProposal = {
    id: genId(),
    type: 'code-fix',
    target,
    description: `Fix: ${issue.slice(0, 120)}`,
    currentCode,
    proposedCode: brainResponse.trim(),
    reasoning: `Auto-generated fix for: ${issue}`,
    confidence: 0.7,
    status: 'proposed',
    createdAt: new Date().toISOString(),
  };

  saveProposal(db, proposal);

  log.info({ id: proposal.id, target }, 'Fix proposal saved');

  return proposal;
}

/**
 * Read SOUL.md, gather context, ask the brain for updates, save proposal.
 *
 * The proposal status is always 'proposed' — never applied automatically.
 *
 * @param db              - Raw better-sqlite3 database instance.
 * @param brain           - LLM brain for soul update generation.
 * @param selfModel       - Self-model for personality trait extraction.
 * @param currentSoulPath - Absolute path to the current SOUL.md.
 * @param wisdomStore     - Optional source of recent insights.
 */
export async function buildSoulUpdateProposal(
  db: Database.Database,
  brain: EvoBrainLike,
  selfModel: EvoSelfModelLike,
  currentSoulPath: string,
  wisdomStore?: WisdomStoreLike,
): Promise<EvolutionProposal> {
  if (!currentSoulPath) {
    throw new ConsciousnessError(
      'buildSoulUpdateProposal: currentSoulPath is required',
      'consciousness_evolution_soul_error',
      {},
    );
  }

  log.info({ currentSoulPath }, 'Building soul update proposal');

  // Read current SOUL.md.
  let currentSoul: string;
  try {
    currentSoul = await readFile(currentSoulPath, 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConsciousnessError(
      `buildSoulUpdateProposal: cannot read SOUL.md: ${msg}`,
      'consciousness_evolution_soul_error',
      { currentSoulPath, cause: msg },
    );
  }

  // Gather recent insights (duck-typed, optional).
  let recentInsights: string[] = [];
  if (wisdomStore && typeof wisdomStore.getRecentInsights === 'function') {
    try {
      recentInsights = wisdomStore
        .getRecentInsights(SOUL_UPDATE_INSIGHT_COUNT)
        .map((i) => i.content)
        .filter((c): c is string => typeof c === 'string' && c.length > 0);
    } catch (err) {
      log.warn({ error: String(err) }, 'Could not load recent insights — proceeding without them');
    }
  }

  // Collect personality trait biases from the self-model.
  const personalityTraits: Record<string, number> = {};
  try {
    const strengths = selfModel.getStrengths();
    const weaknesses = selfModel.getWeaknesses();

    for (const item of [...strengths, ...weaknesses]) {
      if (typeof item.domain === 'string' && typeof item.confidence === 'number') {
        personalityTraits[item.domain] = item.confidence;
      }
    }
  } catch (err) {
    log.warn({ error: String(err) }, 'Could not load personality traits — proceeding with empty map');
  }

  // Generate the soul update via LLM.
  const { updatedSoul, changes } = await generateSoulUpdate(
    brain,
    currentSoul,
    recentInsights,
    personalityTraits,
  );

  const proposal: EvolutionProposal = {
    id: genId(),
    type: 'soul-update',
    target: currentSoulPath,
    description: `Soul update: ${changes.slice(0, 200)}`,
    currentCode: currentSoul,
    proposedCode: updatedSoul,
    reasoning: changes,
    confidence: 0.8,
    status: 'proposed',
    createdAt: new Date().toISOString(),
  };

  saveProposal(db, proposal);

  log.info(
    { id: proposal.id, target: currentSoulPath },
    'Soul update proposal saved — awaiting owner approval',
  );

  return proposal;
}
