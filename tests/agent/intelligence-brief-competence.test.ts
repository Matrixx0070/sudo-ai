/**
 * @file intelligence-brief-competence.test.ts
 * @description Track 2 — surface SelfModel competence into the Intelligence
 * Brief. Previously SelfModel.toPromptSummary fed only an internal status line
 * (truncated to 80 chars) and never reached the agent; getIntelligenceBriefContext
 * omitted it entirely. These tests drive the REAL generateIntelligenceBrief with
 * a mock consciousness and assert the competence section flows into `formatted`.
 *
 * SUDO_AI_HOME is pointed at a temp dir so the unconditional structured-memory
 * search (wrapped in Promise.allSettled) cannot touch real data.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateIntelligenceBrief,
  type ConsciousnessLike,
} from '../../src/core/agent/intelligence-brief.js';

type Competence = {
  overallConfidence: number;
  strengths: Array<{ domain: string; confidence: number }>;
  weaknesses: Array<{ domain: string; confidence: number }>;
} | null;

function mockConsciousness(selfCompetence: Competence): ConsciousnessLike {
  return {
    getIntelligenceBriefContext: () => ({
      dominantDrive: null,
      emotionalState: null,
      matchingProcedure: null,
      relevantPredictions: [],
      recentEpisodes: [],
      counterfactualLessons: [],
      metacognitiveReflections: [],
      surpriseLevel: 0,
      temporalNarrative: '',
      activeConcepts: [],
      selfCompetence,
    }),
  };
}

let dir: string;
let savedHome: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ib-competence-'));
  savedHome = process.env['SUDO_AI_HOME'];
  process.env['SUDO_AI_HOME'] = dir;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env['SUDO_AI_HOME'];
  else process.env['SUDO_AI_HOME'] = savedHome;
  rmSync(dir, { recursive: true, force: true });
});

describe('Intelligence Brief — self-assessed competence', () => {
  it('IBC-1: competence with strengths + weaknesses renders a Self-Assessed Competence section', async () => {
    const consciousness = mockConsciousness({
      overallConfidence: 0.82,
      strengths: [{ domain: 'coding', confidence: 0.91 }, { domain: 'research', confidence: 0.8 }],
      weaknesses: [{ domain: 'design', confidence: 0.34 }],
    });

    const brief = await generateIntelligenceBrief('build a feature', consciousness, null);

    // Structured field carried through.
    expect(brief.selfCompetence).toEqual({
      overallConfidence: 0.82,
      strengths: [{ domain: 'coding', confidence: 0.91 }, { domain: 'research', confidence: 0.8 }],
      weaknesses: [{ domain: 'design', confidence: 0.34 }],
    });

    // Formatted section the agent actually sees.
    expect(brief.formatted).toContain('### Self-Assessed Competence (overall 82%)');
    expect(brief.formatted).toContain('Strengths: coding (91%), research (80%)');
    expect(brief.formatted).toContain('Weaknesses: design (34%)');

    // The brief is framed as background, not the task, so the agent does not
    // mistake injected memory for a stale/missing instruction and disown work.
    expect(brief.formatted).toContain('Your actual task is the most recent user message');
  });

  it('IBC-2: strengths only → weaknesses line omitted', async () => {
    const consciousness = mockConsciousness({
      overallConfidence: 0.6,
      strengths: [{ domain: 'coding', confidence: 0.7 }],
      weaknesses: [],
    });

    const brief = await generateIntelligenceBrief('x', consciousness, null);
    expect(brief.formatted).toContain('### Self-Assessed Competence (overall 60%)');
    expect(brief.formatted).toContain('Strengths: coding (70%)');
    expect(brief.formatted).not.toContain('Weaknesses:');
  });

  it('IBC-3: null competence → no section, field is null', async () => {
    const brief = await generateIntelligenceBrief('x', mockConsciousness(null), null);
    expect(brief.selfCompetence).toBeNull();
    expect(brief.formatted).not.toContain('Self-Assessed Competence');
  });

  it('IBC-4: older consciousness impl omitting selfCompetence → no throw, field null', async () => {
    // A consciousness whose context object simply has no selfCompetence key
    // (predates Track 2). The `?? null` guard must keep it safe.
    const legacy: ConsciousnessLike = {
      getIntelligenceBriefContext: () => ({
        dominantDrive: null,
        emotionalState: null,
        matchingProcedure: null,
        relevantPredictions: [],
        recentEpisodes: [],
      }) as ReturnType<ConsciousnessLike['getIntelligenceBriefContext']>,
    };

    const brief = await generateIntelligenceBrief('x', legacy, null);
    expect(brief.selfCompetence).toBeNull();
    expect(brief.formatted).not.toContain('Self-Assessed Competence');
  });

  it('IBC-5: no consciousness wired → empty brief, null competence, no throw', async () => {
    const brief = await generateIntelligenceBrief('x', null, null);
    expect(brief.selfCompetence).toBeNull();
    expect(brief.formatted).not.toContain('Self-Assessed Competence');
  });
});
