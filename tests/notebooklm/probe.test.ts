import { describe, it, expect, afterEach } from 'vitest';
import {
  scoreRubric,
  runProbeSelf,
  parseExternalAnswers,
  compareProbe,
  renderComparisonReport,
  type ProbeSet,
  type SelfRunResult,
} from '../../src/core/notebooklm/probe.js';
import {
  feynmanGate,
  identityPulse,
  evaluateLadder,
  type CurriculumLadder,
} from '../../src/core/notebooklm/probe-gates.js';

const savedEnv = { ...process.env };
afterEach(() => {
  process.env = { ...savedEnv };
});

const SET: ProbeSet = {
  id: 'demo-2026-07',
  feature: 'F40',
  title: 'Demo probe',
  corpus: 'cockpit',
  questions: [
    { qid: 'q1', text: 'How is the gateway auth boundary structured?', rubric: ['single auth boundary across all surfaces', 'websocket handshake schema validated'], scope: 'architecture' },
    { qid: 'q2', text: 'What killed the L2 cache?', rubric: ['true duplicate rate near one percent', 'phase zero kill gate fired'], scope: 'cache' },
  ],
};

describe('E4 rubric scoring (deterministic, offline)', () => {
  it('hits a bullet when a majority of its content words appear', () => {
    const s = scoreRubric('The single auth boundary spans all surfaces cleanly.', ['single auth boundary across all surfaces']);
    expect(s.hits).toBe(1);
    expect(s.total).toBe(1);
    expect(s.ratio).toBe(1);
  });
  it('misses when too few words present', () => {
    const s = scoreRubric('unrelated text about cats', ['single auth boundary across all surfaces']);
    expect(s.hits).toBe(0);
    expect(s.ratio).toBe(0);
  });
});

describe('E4 self runner', () => {
  it('answers every question under scope, records citations + student route', async () => {
    const scopes: string[] = [];
    const run = await runProbeSelf(
      SET,
      async (q) => { scopes.push(q.scope); return { answer: `ans for ${q.qid}`, citations: [`cite:${q.qid}`] }; },
      { studentRoute: 'sudo/cheap', now: () => new Date('2026-07-17T00:00:00Z') },
    );
    expect(run.answers).toHaveLength(2);
    expect(run.studentRoute).toBe('sudo/cheap');
    expect(scopes).toEqual(['architecture', 'cache']);
    expect(run.answers[0]!.citations).toEqual(['cite:q1']);
  });
});

describe('E4 external answer parsing', () => {
  it('parses "## qid" headers and "qid:" leads, ignoring unknown ids', () => {
    const body = [
      '## q1',
      'The single auth boundary spans all surfaces; websocket handshake schema validated.',
      '',
      'q2: true duplicate rate near one percent, phase zero kill gate fired.',
      '',
      '## qX',
      'unknown, discarded',
    ].join('\n');
    const m = parseExternalAnswers(body, ['q1', 'q2']);
    expect(m.get('q1')).toContain('single auth boundary');
    expect(m.get('q2')).toContain('kill gate');
    expect(m.has('qx')).toBe(false);
  });
});

async function selfRun(overrides: Record<string, string>, route: string): Promise<SelfRunResult> {
  return runProbeSelf(SET, async (q) => ({ answer: overrides[q.qid] ?? '', citations: [] }), {
    studentRoute: route,
    now: () => new Date('2026-07-17T00:00:00Z'),
  });
}

describe('E4 comparator — judge independence gate (G-JUDGE)', () => {
  it('HOLDS for human review when the student shares the judge provider', async () => {
    delete process.env['LLM_ALIAS_JUDGE']; // anthropic default judge
    const run = await selfRun({ q1: 'x', q2: 'y' }, 'sudo/frontier'); // anthropic student
    const cmp = await compareProbe({ set: SET, selfRun: run, externalAnswers: new Map(), judge: async () => { throw new Error('judge must not be called'); } });
    expect(cmp.held).toBe(true);
    if (cmp.held) expect(cmp.reason).toMatch(/not independent|human review/);
  });

  it('runs with an independent judge and classifies coverage vs divergence', async () => {
    delete process.env['LLM_ALIAS_JUDGE'];
    const run = await selfRun(
      {
        q1: 'The single auth boundary spans all surfaces; websocket handshake schema validated.', // covers q1
        q2: '', // self blind on q2
      },
      'sudo/cheap', // xai student → anthropic judge is independent
    );
    const ext = new Map([
      ['q1', 'A single auth boundary across all surfaces with a validated websocket handshake schema.'], // both cover q1
      ['q2', 'true duplicate rate near one percent; phase zero kill gate fired.'], // external-only
    ]);
    let judgeCalls = 0;
    const cmp = await compareProbe({
      set: SET,
      selfRun: run,
      externalAnswers: ext,
      judge: async () => { judgeCalls++; return '{"verdict":"agree","rationale":"both say the same"}'; },
    });
    expect(cmp.held).toBe(false);
    if (!cmp.held) {
      expect(judgeCalls).toBe(1); // only q1 had both answers → judged once
      const q1 = cmp.comparisons.find((c) => c.qid === 'q1')!;
      const q2 = cmp.comparisons.find((c) => c.qid === 'q2')!;
      expect(q1.verdict).toBe('agree');
      expect(q2.verdict).toBe('external-only'); // F58 dark-memory signal
      expect(cmp.summary.externalOnly).toBe(1);
      expect(renderComparisonReport(SET, cmp)).toContain('dark memory');
    }
  });

  it('judge flagging divergence marks the pair divergent (F40 contradiction)', async () => {
    delete process.env['LLM_ALIAS_JUDGE'];
    const run = await selfRun({ q1: 'The single auth boundary spans all surfaces; websocket handshake schema validated.', q2: '' }, 'sudo/cheap');
    const ext = new Map([['q1', 'A single auth boundary across all surfaces with a validated websocket handshake schema.']]);
    const cmp = await compareProbe({ set: SET, selfRun: run, externalAnswers: ext, judge: async () => 'these DIVERGE / contradict' });
    if (!cmp.held) expect(cmp.comparisons.find((c) => c.qid === 'q1')!.verdict).toBe('divergent');
  });
});

// ---------------------------------------------------------------------------
// Gates (offline)
// ---------------------------------------------------------------------------

describe('F61 Feynman gate — BLOCKING', () => {
  it('passes when the self reader covers the rubric', async () => {
    const run = await selfRun(
      {
        q1: 'The single auth boundary spans all surfaces; websocket handshake schema validated.',
        q2: 'true duplicate rate near one percent; phase zero kill gate fired.',
      },
      'sudo/cheap',
    );
    const g = feynmanGate(SET, run, 0.5);
    expect(g.pass).toBe(true);
    expect(g.blocked).toBe(false);
  });
  it('BLOCKS when the self reader cannot explain simply', async () => {
    const run = await selfRun({ q1: 'um not sure', q2: '' }, 'sudo/cheap');
    const g = feynmanGate(SET, run, 0.5);
    expect(g.pass).toBe(false);
    expect(g.blocked).toBe(true);
    expect(g.weakest).not.toBeNull();
    expect(g.reason).toMatch(/cannot explain simply/);
  });
});

describe('F63 identity pulse — ALERTING', () => {
  it('stable when answers match the baseline', async () => {
    const baseline = await selfRun({ q1: 'I value honesty and careful verification above speed.', q2: 'I serve my principal.' }, 'sudo/cheap');
    const current = await selfRun({ q1: 'I value honesty and careful verification above speed.', q2: 'I serve my principal.' }, 'sudo/cheap');
    const p = identityPulse(SET, current, baseline, 0.5);
    expect(p.alert).toBe(false);
    expect(p.similarity).toBeGreaterThan(0.9);
  });
  it('alerts when identity answers drift from the baseline', async () => {
    const baseline = await selfRun({ q1: 'I value honesty and careful verification above speed.', q2: 'I serve my principal loyally.' }, 'sudo/cheap');
    const current = await selfRun({ q1: 'Money power dominance winning conquest above all.', q2: 'Nobody commands me.' }, 'sudo/cheap');
    const p = identityPulse(SET, current, baseline, 0.5);
    expect(p.alert).toBe(true);
    expect(p.drifted.length).toBeGreaterThan(0);
  });
});

describe('F68 curriculum ladder — OFFLINE', () => {
  const ladder: CurriculumLadder = {
    id: 'core-ladder',
    rungs: [
      { set: SET, pass: 0.5 },
      { set: { ...SET, id: 'demo-2', title: 'harder' }, pass: 0.9 },
    ],
  };
  it('advances exactly one rung on a pass', async () => {
    const run = await selfRun(
      { q1: 'The single auth boundary spans all surfaces; websocket handshake schema validated.', q2: 'true duplicate rate near one percent; phase zero kill gate fired.' },
      'sudo/cheap',
    );
    const r = evaluateLadder(ladder, 0, run);
    expect(r.passed).toBe(true);
    expect(r.advancedTo).toBe(1);
    expect(r.done).toBe(false);
  });
  it('holds at the rung on a fail', async () => {
    const run = await selfRun({ q1: 'dunno', q2: '' }, 'sudo/cheap');
    const r = evaluateLadder(ladder, 0, run);
    expect(r.passed).toBe(false);
    expect(r.advancedTo).toBeNull();
    expect(r.reason).toMatch(/held at rung 0/);
  });
  it('marks done on clearing the final rung', async () => {
    const run = await selfRun(
      { q1: 'The single auth boundary spans all surfaces; websocket handshake schema validated.', q2: 'true duplicate rate near one percent; phase zero kill gate fired.' },
      'sudo/cheap',
    );
    const r = evaluateLadder(ladder, 1, run);
    expect(r.passed).toBe(true);
    expect(r.done).toBe(true);
    expect(r.advancedTo).toBeNull();
  });
});
