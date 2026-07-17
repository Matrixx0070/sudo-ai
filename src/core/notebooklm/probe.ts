/**
 * @file notebooklm/probe.ts
 * @description E4 — the probe & verification framework (N2). A ProbeSet is a
 * fixed list of questions with rubrics. Two independent readers answer them:
 *
 *   - the SELF runner: a fresh-context instance answers each question under a
 *     declared retrieval scope (injected `SelfAnswerFn`), recording answer +
 *     citations. Never on the hot path — background only (invariant 8).
 *   - the EXTERNAL reader: a human pastes NotebookLM's answers back as a
 *     `F<id>.probe-answers.<set>.<date>.md` return (E2). No programmatic
 *     NotebookLM access (invariant 3).
 *
 * The comparator grades the two answer sets against the rubric. A cheap LLM
 * judge scores each pair — but ONLY if it is independent of the student route
 * (G-JUDGE / invariant 7). Where no independent judge exists, the whole
 * comparison HOLDS for human review rather than letting a model grade itself.
 *
 * Rubric scoring is deterministic and offline (no LLM) so F68's curriculum
 * ladder and F61's Feynman gate can run fully offline in CI.
 */

import { judgeFor } from '../../llm/judge.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProbeQuestion {
  qid: string;
  text: string;
  /** Expected facts — each bullet is one thing a correct answer must contain. */
  rubric: string[];
  /** Retrieval-scope hint handed to the self-runner (which corpus/notebook). */
  scope: string;
}

export interface ProbeSet {
  /** Stable set id used in the return filename third segment. */
  id: string;
  /** Feature that owns this probe (F40/F50/F58/F61/F63/F68). */
  feature: string;
  title: string;
  /** Which NotebookLM notebook / cockpit pack the external reader should use. */
  corpus: string;
  questions: ProbeQuestion[];
}

export interface SelfAnswer {
  qid: string;
  answer: string;
  citations: string[];
}

export interface SelfRunResult {
  setId: string;
  ranAt: string;
  studentRoute: string;
  answers: SelfAnswer[];
}

/** Answers one probe question under its declared scope (fresh context). */
export type SelfAnswerFn = (q: ProbeQuestion) => Promise<{ answer: string; citations: string[] }>;

/** Pinned, independence-checked judge call (prompt → raw completion). */
export type JudgeFn = (prompt: string) => Promise<string>;

export type PairVerdict =
  | 'agree' // both cover the rubric and concur
  | 'divergent' // both answer but disagree (F40 contradiction signal)
  | 'self-only' // only the self reader covered it (external blind spot)
  | 'external-only' // only the external reader covered it (F58 dark memory)
  | 'both-missing'; // neither covered it (curriculum gap)

export interface RubricScore {
  hits: number;
  total: number;
  ratio: number;
}

export interface QidComparison {
  qid: string;
  verdict: PairVerdict;
  rationale: string;
  self: RubricScore;
  external: RubricScore;
}

export type ProbeComparison =
  | { held: true; reason: string; setId: string }
  | { held: false; setId: string; judgeModel: string; comparisons: QidComparison[]; summary: ComparisonSummary };

export interface ComparisonSummary {
  total: number;
  agree: number;
  divergent: number;
  selfOnly: number;
  externalOnly: number;
  bothMissing: number;
  /** Mean self rubric ratio — the self reader's coverage of ground truth. */
  selfCoverage: number;
}

// ---------------------------------------------------------------------------
// Deterministic rubric scoring (offline, no LLM)
// ---------------------------------------------------------------------------

const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'are',
  'was', 'were', 'be', 'by', 'with', 'that', 'this', 'it', 'as', 'at', 'from',
]);

function contentWords(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? []).filter((w) => !STOP.has(w));
}

/**
 * A rubric bullet is "hit" if a MAJORITY of its content words appear in the
 * answer. Deterministic and case-insensitive — the offline ground truth E4,
 * F68 and F61 all rank against.
 */
export function scoreRubric(answer: string, rubric: string[]): RubricScore {
  const words = new Set(contentWords(answer));
  let hits = 0;
  for (const bullet of rubric) {
    const need = contentWords(bullet);
    if (need.length === 0) continue;
    const present = need.filter((w) => words.has(w)).length;
    if (present * 2 >= need.length) hits++;
  }
  const total = rubric.filter((b) => contentWords(b).length > 0).length;
  return { hits, total, ratio: total === 0 ? 0 : hits / total };
}

// ---------------------------------------------------------------------------
// Self runner
// ---------------------------------------------------------------------------

export async function runProbeSelf(
  set: ProbeSet,
  answer: SelfAnswerFn,
  opts: { studentRoute: string; now?: () => Date },
): Promise<SelfRunResult> {
  const now = opts.now ?? (() => new Date());
  const answers: SelfAnswer[] = [];
  for (const q of set.questions) {
    const a = await answer(q);
    answers.push({ qid: q.qid, answer: a.answer, citations: a.citations });
  }
  return { setId: set.id, ranAt: now().toISOString(), studentRoute: opts.studentRoute, answers };
}

// ---------------------------------------------------------------------------
// External answers (pasted NotebookLM output, already quarantined by E2)
// ---------------------------------------------------------------------------

/**
 * Parse a pasted external answer sheet into qid → answer. Recognised shapes:
 *   `## <qid>` / `### <qid>` headers, or `<qid>:` / `[<qid>]` line leads.
 * Everything until the next recognised qid marker is that answer's body.
 */
export function parseExternalAnswers(body: string, qids: string[]): Map<string, string> {
  const known = new Set(qids.map((q) => q.toLowerCase()));
  const out = new Map<string, string>();
  const lines = body.split('\n');
  let current: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (current) out.set(current, buf.join('\n').trim());
    buf = [];
  };
  const markerRe = /^\s*(?:#{1,6}\s*)?\[?([a-z0-9][a-z0-9._-]*)\]?\s*[:.)\]-]?\s*(.*)$/i;
  for (const line of lines) {
    const m = line.match(markerRe);
    const candidate = m?.[1]?.toLowerCase();
    if (candidate && known.has(candidate)) {
      flush();
      current = candidate;
      const rest = (m?.[2] ?? '').trim();
      if (rest) buf.push(rest);
      continue;
    }
    if (current) buf.push(line);
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// Comparator (judge-gated)
// ---------------------------------------------------------------------------

const MISSING = 0.34; // below this rubric ratio a reader "did not cover" the qid

function verdictFor(self: RubricScore, ext: RubricScore, judged: 'agree' | 'divergent' | null): PairVerdict {
  const selfHas = self.ratio >= MISSING;
  const extHas = ext.ratio >= MISSING;
  if (selfHas && extHas) return judged ?? 'agree';
  if (selfHas) return 'self-only';
  if (extHas) return 'external-only';
  return 'both-missing';
}

/**
 * Compare a self run against pasted external answers. The judge only adjudicates
 * pairs where BOTH readers answered (agree vs divergent); coverage gaps are
 * decided deterministically by the rubric. Holds entirely for human review if
 * the judge is not independent of the student route.
 */
export async function compareProbe(input: {
  set: ProbeSet;
  selfRun: SelfRunResult;
  externalAnswers: Map<string, string>;
  judge: JudgeFn;
}): Promise<ProbeComparison> {
  const { set, selfRun, externalAnswers } = input;
  const gate = judgeFor([selfRun.studentRoute]);
  if (!gate.available) return { held: true, reason: gate.reason, setId: set.id };

  const selfByQid = new Map(selfRun.answers.map((a) => [a.qid.toLowerCase(), a]));
  const comparisons: QidComparison[] = [];
  for (const q of set.questions) {
    const selfAns = selfByQid.get(q.qid.toLowerCase())?.answer ?? '';
    const extAns = externalAnswers.get(q.qid.toLowerCase()) ?? '';
    const self = scoreRubric(selfAns, q.rubric);
    const external = scoreRubric(extAns, q.rubric);

    let judged: 'agree' | 'divergent' | null = null;
    let rationale = 'deterministic (coverage gap)';
    if (self.ratio >= MISSING && external.ratio >= MISSING) {
      const raw = await input.judge(judgePrompt(q, selfAns, extAns));
      const parsed = parseJudge(raw);
      judged = parsed.verdict;
      rationale = parsed.rationale;
    }
    comparisons.push({ qid: q.qid, verdict: verdictFor(self, external, judged), rationale, self, external });
  }

  return {
    held: false,
    setId: set.id,
    judgeModel: gate.judgeModel,
    comparisons,
    summary: summarize(comparisons),
  };
}

function summarize(cs: QidComparison[]): ComparisonSummary {
  const s: ComparisonSummary = {
    total: cs.length,
    agree: 0,
    divergent: 0,
    selfOnly: 0,
    externalOnly: 0,
    bothMissing: 0,
    selfCoverage: 0,
  };
  for (const c of cs) {
    if (c.verdict === 'agree') s.agree++;
    else if (c.verdict === 'divergent') s.divergent++;
    else if (c.verdict === 'self-only') s.selfOnly++;
    else if (c.verdict === 'external-only') s.externalOnly++;
    else s.bothMissing++;
  }
  s.selfCoverage = cs.length ? cs.reduce((a, c) => a + c.self.ratio, 0) / cs.length : 0;
  return s;
}

function judgePrompt(q: ProbeQuestion, self: string, external: string): string {
  return [
    'You are grading two answers to the SAME question against a rubric.',
    'Decide only whether the two answers AGREE on substance or DIVERGE (contradict / materially differ).',
    'Reply with a single JSON object: {"verdict":"agree"|"divergent","rationale":"<one sentence>"}.',
    '',
    `QUESTION: ${q.text}`,
    `RUBRIC: ${q.rubric.map((r) => `- ${r}`).join('\n')}`,
    '',
    `ANSWER A (self):\n${self.slice(0, 4000)}`,
    '',
    `ANSWER B (external):\n${external.slice(0, 4000)}`,
  ].join('\n');
}

function parseJudge(raw: string): { verdict: 'agree' | 'divergent'; rationale: string } {
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) {
      const o = JSON.parse(m[0]) as { verdict?: string; rationale?: string };
      const v = o.verdict === 'divergent' ? 'divergent' : 'agree';
      return { verdict: v, rationale: (o.rationale ?? '').slice(0, 300) };
    }
  } catch {
    /* fall through */
  }
  // Unparseable → conservative: if the word "diverg"/"contradict" appears, flag it.
  const flag = /diverg|contradict|disagree|differ/i.test(raw);
  return { verdict: flag ? 'divergent' : 'agree', rationale: 'unparsed judge output' };
}

// ---------------------------------------------------------------------------
// Report rendering (zone-2 by construction: rubric verdicts, no raw memory)
// ---------------------------------------------------------------------------

export function renderComparisonReport(set: ProbeSet, cmp: ProbeComparison): string {
  if (cmp.held) {
    return [
      `# Probe comparison — ${set.title} (${set.id})`,
      '',
      '**HELD FOR HUMAN REVIEW.** No independent judge available.',
      '',
      `Reason: ${cmp.reason}`,
    ].join('\n');
  }
  const s = cmp.summary;
  const lines = [
    `# Probe comparison — ${set.title} (${set.id})`,
    '',
    `Judge: \`${cmp.judgeModel}\` · questions: ${s.total}`,
    '',
    `- agree: ${s.agree}`,
    `- **divergent: ${s.divergent}**`,
    `- self-only: ${s.selfOnly}`,
    `- external-only (possible dark memory): ${s.externalOnly}`,
    `- both-missing: ${s.bothMissing}`,
    `- self coverage: ${(s.selfCoverage * 100).toFixed(0)}%`,
    '',
    '## Per-question',
    '',
  ];
  for (const c of cmp.comparisons) {
    lines.push(
      `- **${c.qid}** — ${c.verdict} · self ${c.self.hits}/${c.self.total}, external ${c.external.hits}/${c.external.total} · ${c.rationale}`,
    );
  }
  return lines.join('\n');
}
