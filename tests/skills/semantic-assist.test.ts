/**
 * Tests for the semantic recall assist — the layer that catches
 * intent-without-keyword messages the deterministic matcher cannot
 * (measured ceiling ~50-75%, #665). All tests inject a fake embedder;
 * the real MiniLM is exercised by the offline calibration harness, never
 * in unit tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isSemanticAssistEnabled,
  semanticThreshold,
  selectSemanticSkill,
  anchorTexts,
  __resetSemanticAssist,
  type AssistEmbedder,
} from '../../src/core/skills/semantic-assist.js';
import { activateSkillsForMessage, formatSkillInjection, type ActivatableSkill } from '../../src/core/skills/skill-activator.js';
import { runTriggerEvalCombined, type TriggerEvalCase } from '../../src/core/skills/trigger-eval.js';

const tldr: ActivatableSkill = {
  name: 'tldr',
  description: 'Summarize long content into a compact TLDR',
  content: '# TLDR\nOne-line takeaway first.',
  triggers: ['tldr', 'summarize this'],
};
const eli5: ActivatableSkill = {
  name: 'eli5',
  description: 'Explain concepts simply',
  content: '# ELI5\nUse one analogy.',
  triggers: ['eli5'],
};

/**
 * Fake embedder: unit vectors from a fixed table. Similarity is controlled
 * by hand-placing vectors; unknown texts get an orthogonal default.
 */
function fakeEmbedder(table: Record<string, [number, number, number]>): AssistEmbedder & { embedCalls: string[]; batchCalls: number } {
  const state = {
    embedCalls: [] as string[],
    batchCalls: 0,
    async embed(text: string): Promise<Float32Array | null> {
      state.embedCalls.push(text);
      const v = table[text] ?? [0, 0, 1];
      return Float32Array.from(v);
    },
    async embedBatch(texts: string[]): Promise<(Float32Array | null)[]> {
      state.batchCalls++;
      return texts.map((t) => Float32Array.from(table[t] ?? [0, 0, 1]));
    },
  };
  return state;
}

const ENV_KEYS = ['SUDO_SKILL_SEMANTIC_ASSIST', 'SUDO_SKILL_SEMANTIC_THRESHOLD', 'SUDO_SKILL_ACTIVATION'];
const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  __resetSemanticAssist();
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  __resetSemanticAssist();
});

describe('env gates', () => {
  it('assist default ON, =0 disables; threshold default 0.35, clamped', () => {
    expect(isSemanticAssistEnabled()).toBe(true);
    process.env['SUDO_SKILL_SEMANTIC_ASSIST'] = '0';
    expect(isSemanticAssistEnabled()).toBe(false);
    expect(semanticThreshold()).toBe(0.35);
    process.env['SUDO_SKILL_SEMANTIC_THRESHOLD'] = '0.5';
    expect(semanticThreshold()).toBe(0.5);
    process.env['SUDO_SKILL_SEMANTIC_THRESHOLD'] = '99';
    expect(semanticThreshold()).toBe(0.95);
    process.env['SUDO_SKILL_SEMANTIC_THRESHOLD'] = '-1';
    expect(semanticThreshold()).toBe(0.05);
    process.env['SUDO_SKILL_SEMANTIC_THRESHOLD'] = 'junk';
    expect(semanticThreshold()).toBe(0.35);
  });
});

describe('anchorTexts', () => {
  it('is trigger phrases ONLY — descriptions measured as the junk source on real traffic', () => {
    expect(anchorTexts(tldr)).toEqual(['tldr', 'summarize this']);
    expect(anchorTexts({ name: 'x', content: '', description: 'prose that must NOT anchor' })).toEqual([]);
  });
});

describe('internal-turn gate wiring in activateSkillsForMessage', () => {
  it('internal:true skips the semantic assist entirely (no module/ONNX load)', async () => {
    // Assist env deliberately ENABLED: if the gate were removed, this miss
    // would import semantic-assist and attempt a real embedder load in CI.
    delete process.env['SUDO_SKILL_SEMANTIC_ASSIST'];
    const r = await activateSkillsForMessage('give me the gist of this thread', [tldr], 's1', { internal: true });
    expect(r).toBeNull();
  });

  it('internal:true still allows deterministic dispatch', async () => {
    delete process.env['SUDO_SKILL_SEMANTIC_ASSIST'];
    const r = await activateSkillsForMessage('tldr this article', [tldr], 's1', { internal: true });
    expect(r).not.toBeNull();
    expect(r!.names).toEqual(['tldr']);
  });
});

describe('selectSemanticSkill', () => {
  it('fires the best skill above threshold and reports similarity', async () => {
    const embedder = fakeEmbedder({
      'give me the gist': [1, 0, 0],
      'summarize this': [0.9, Math.sqrt(1 - 0.81), 0], // cos 0.9 vs query
      'eli5': [0, 1, 0],                                // cos 0 vs query
    });
    const hit = await selectSemanticSkill('give me the gist', [eli5, tldr], { embedder });
    expect(hit).not.toBeNull();
    expect(hit!.skill.name).toBe('tldr');
    expect(hit!.semantic).toBe(true);
    expect(hit!.phrase).toBe('summarize this');
    expect(hit!.similarity).toBeCloseTo(0.9, 5);
  });

  it('returns null below threshold and on embed failure (fail-open)', async () => {
    const cold = fakeEmbedder({ 'query': [1, 0, 0] }); // anchors default orthogonal
    expect(await selectSemanticSkill('query', [tldr], { embedder: cold })).toBeNull();
    const broken: AssistEmbedder = {
      async embed() { return null; },
      async embedBatch(texts) { return texts.map(() => null); },
    };
    expect(await selectSemanticSkill('query', [tldr], { embedder: broken })).toBeNull();
  });

  it('caches anchor vectors per skill across queries (one batch per skill)', async () => {
    const embedder = fakeEmbedder({ 'q1': [1, 0, 0], 'q2': [0, 1, 0] });
    await selectSemanticSkill('q1', [tldr], { embedder });
    await selectSemanticSkill('q2', [tldr], { embedder });
    expect(embedder.batchCalls).toBe(1);
  });

  it('re-embeds anchors when the trigger set changes (cache invalidation)', async () => {
    const embedder = fakeEmbedder({});
    const mutable: ActivatableSkill = { name: 's', content: '', triggers: ['alpha'] };
    await selectSemanticSkill('q', [mutable], { embedder });
    mutable.triggers = ['beta'];
    await selectSemanticSkill('q', [mutable], { embedder });
    expect(embedder.batchCalls).toBe(2);
  });

  it('budget expiry returns null fast instead of blocking the turn', async () => {
    const slow: AssistEmbedder = {
      embed: () => new Promise((r) => setTimeout(() => r(Float32Array.from([1, 0, 0])), 300)),
      embedBatch: async (texts) => texts.map(() => Float32Array.from([1, 0, 0])),
    };
    const t0 = Date.now();
    const hit = await selectSemanticSkill('query', [tldr], { embedder: slow, budgetMs: 50 });
    expect(hit).toBeNull();
    expect(Date.now() - t0).toBeLessThan(250); // returned on budget, not on the 300ms embed
  });

  it('budgetMs 0 disables the budget (exact eval mode)', async () => {
    const slow: AssistEmbedder = {
      embed: (text) => new Promise((r) => setTimeout(() => r(Float32Array.from(text === 'query' ? [1, 0, 0] : [0, 0, 1])), 60)),
      embedBatch: async (texts) => texts.map((t) => Float32Array.from(t === 'summarize this' ? [1, 0, 0] : [0, 0, 1])),
    };
    const hit = await selectSemanticSkill('query', [tldr], { embedder: slow, budgetMs: 0, threshold: 0.9 });
    expect(hit).not.toBeNull();
    expect(hit!.skill.name).toBe('tldr');
  });

  it('a failed query embed opens a cooldown — no re-attempt on the next miss turn', async () => {
    const failing = fakeEmbedder({});
    failing.embed = async (text: string) => { failing.embedCalls.push(text); return null; };
    expect(await selectSemanticSkill('q1', [tldr], { embedder: failing })).toBeNull();
    expect(await selectSemanticSkill('q2', [tldr], { embedder: failing })).toBeNull();
    expect(failing.embedCalls).toEqual(['q1']); // q2 short-circuited by cooldown
  });

  it('semanticBudgetMs: default 400, clamped, junk-safe', async () => {
    const { semanticBudgetMs } = await import('../../src/core/skills/semantic-assist.js');
    expect(semanticBudgetMs({} as NodeJS.ProcessEnv)).toBe(400);
    expect(semanticBudgetMs({ SUDO_SKILL_SEMANTIC_BUDGET_MS: '0' } as unknown as NodeJS.ProcessEnv)).toBe(0);
    expect(semanticBudgetMs({ SUDO_SKILL_SEMANTIC_BUDGET_MS: '99999' } as unknown as NodeJS.ProcessEnv)).toBe(10_000);
    expect(semanticBudgetMs({ SUDO_SKILL_SEMANTIC_BUDGET_MS: '-5' } as unknown as NodeJS.ProcessEnv)).toBe(400);
    expect(semanticBudgetMs({ SUDO_SKILL_SEMANTIC_BUDGET_MS: 'junk' } as unknown as NodeJS.ProcessEnv)).toBe(400);
  });
});

describe('activateSkillsForMessage integration (recall-only invariant)', () => {
  it('deterministic match wins without consulting the assist', async () => {
    // Assist enabled by default here, but the phrase fires first; if the
    // activator consulted the real embedder this test would try to load ONNX.
    const r = await activateSkillsForMessage('tldr this article', [tldr], 's1');
    expect(r).not.toBeNull();
    expect(r!.content).toContain('matched trigger: "tldr"');
    expect(r!.content).not.toContain('semantic match');
  });

  it('assist disabled → non-matching message stays null', async () => {
    process.env['SUDO_SKILL_SEMANTIC_ASSIST'] = '0';
    expect(await activateSkillsForMessage('give me the gist of this', [tldr], 's1')).toBeNull();
  });
});

describe('formatSkillInjection semantic label', () => {
  it('renders similarity for semantic activations', () => {
    const out = formatSkillInjection([
      { skill: tldr, phrase: 'summarize this', score: 412, semantic: true, similarity: 0.412 },
    ]);
    expect(out).toContain('semantic match: "summarize this", similarity 0.41');
  });
});

describe('runTriggerEvalCombined', () => {
  const cases: TriggerEvalCase[] = [
    { query: 'tldr this thread', shouldTrigger: true },       // deterministic hit
    { query: 'give me the short version', shouldTrigger: true }, // miss → semantic recovers
    { query: 'weather in berlin', shouldTrigger: false },     // true negative
  ];

  it('ORs semantic recall into misses and marks them with ~', async () => {
    const report = await runTriggerEvalCombined('tldr', ['tldr'], cases, async (q) =>
      q.includes('short version') ? { phrase: 'summarize this' } : null);
    expect(report.matrix.accuracy).toBe(1);
    expect(report.results[0]!.matchedPhrase).toBe('tldr');
    expect(report.results[1]!.matchedPhrase).toBe('~summarize this');
    expect(report.results[2]!.triggered).toBe(false);
  });

  it('without semantic hits it matches the sync eval exactly', async () => {
    const report = await runTriggerEvalCombined('tldr', ['tldr'], cases, async () => null);
    expect(report.matrix.accuracy).toBeCloseTo(2 / 3, 5);
  });
});
