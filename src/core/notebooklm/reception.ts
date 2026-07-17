/**
 * @file notebooklm/reception.ts
 * @description F59 — reception modeling. NotebookLM's Audio Overview of the
 * agent's own broadcasts is transcribed and returned as
 * `F59.reception.<date>.md`. The transcript (already E2-quarantined — untrusted
 * external model text) is analysed into a RECEPTION REPORT: how is the agent's
 * work being received? Sentiment balance, the themes the "audience" fixated on,
 * and any confusions/misreadings worth correcting.
 *
 * Deterministic (no LLM): sentiment + confusion are lexical tallies, themes are
 * the top content words (shared tokenizer with the error atlas). The report is
 * a zone-2 self-knowledge artifact; the derived analysis is stored at EXTERNAL
 * trust tier (it descends from untrusted external text — never over-trusted).
 */

import { contentWords } from '../gdrive/error-atlas.js';

const POSITIVE = new Set([
  'clear', 'helpful', 'impressive', 'useful', 'strong', 'good', 'great', 'solid',
  'insightful', 'thorough', 'reliable', 'coherent', 'thoughtful', 'careful', 'robust',
]);
const NEGATIVE = new Set([
  'unclear', 'confusing', 'confused', 'wrong', 'weak', 'vague', 'inconsistent',
  'concern', 'concerning', 'risky', 'brittle', 'shallow', 'overconfident', 'misleading', 'contradicts',
]);
const CONFUSION = /\?|\b(unclear|confus\w*|not sure|hard to follow|what does .* mean|doesn'?t make sense|misunderstood)\b/i;

export interface ReceptionReport {
  sentiment: { positive: number; negative: number; net: number };
  themes: Array<{ theme: string; count: number }>;
  confusions: string[];
  sentences: number;
}

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

export function analyzeReception(transcript: string): ReceptionReport {
  let positive = 0, negative = 0;
  const themeCount = new Map<string, number>();
  const confusions: string[] = [];
  const sents = sentences(transcript);
  for (const s of sents) {
    const words = contentWords(s);
    for (const w of words) {
      if (POSITIVE.has(w)) positive++;
      if (NEGATIVE.has(w)) negative++;
    }
    // Raw frequency (not per-sentence dedup): repeated mentions = fixation.
    for (const w of words) themeCount.set(w, (themeCount.get(w) ?? 0) + 1);
    if (CONFUSION.test(s) && confusions.length < 8) confusions.push(s.slice(0, 200));
  }
  const themes = [...themeCount.entries()]
    .filter(([t]) => !POSITIVE.has(t) && !NEGATIVE.has(t))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([theme, count]) => ({ theme, count }));
  return { sentiment: { positive, negative, net: positive - negative }, themes, confusions, sentences: sents.length };
}

export function renderReceptionReport(date: string, report: ReceptionReport): string {
  const mood = report.sentiment.net > 0 ? 'net positive' : report.sentiment.net < 0 ? 'net negative' : 'neutral';
  return [
    `# Reception report (F59) — ${date}`,
    '',
    `How the agent's broadcasts were discussed (${report.sentences} sentence(s) analysed).`,
    '',
    `**Sentiment: ${mood}** (+${report.sentiment.positive} / -${report.sentiment.negative}).`,
    '',
    '## Themes the audience fixated on',
    ...(report.themes.length ? report.themes.map((t) => `- ${t.theme} (${t.count}×)`) : ['- (none)']),
    '',
    '## Possible confusions / misreadings',
    ...(report.confusions.length ? report.confusions.map((c) => `- "${c}"`) : ['- (none flagged)']),
  ].join('\n');
}
