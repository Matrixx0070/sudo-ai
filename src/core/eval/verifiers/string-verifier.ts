/**
 * @file string-verifier.ts
 * @description Regex/include-based BenchVerifier. Cheap, deterministic, no external calls.
 *
 * Each rule is either a literal substring (case-insensitive) or a RegExp.
 * `mode: 'all'` requires every rule to match; `mode: 'any'` requires at least one.
 * Score = fraction of rules that matched (regardless of mode).
 */

import type { BenchTask, BenchVerifier, VerifierResult } from '../../shared/wave10-types.js';

export type StringRule = string | RegExp;

export interface StringVerifierOptions {
  /** Rules that must match. `all` = AND, `any` = OR. Default 'all'. */
  mode?: 'all' | 'any';
  /** The rules. Strings are tested case-insensitively. */
  rules: StringRule[];
}

export class StringVerifier implements BenchVerifier {
  readonly type = 'string';
  private readonly mode: 'all' | 'any';
  private readonly rules: StringRule[];

  constructor(opts: StringVerifierOptions) {
    if (!opts.rules || opts.rules.length === 0) {
      throw new Error('StringVerifier: at least one rule is required');
    }
    this.mode = opts.mode ?? 'all';
    this.rules = opts.rules;
  }

  async verify(_task: BenchTask, response: string): Promise<VerifierResult> {
    const matched: boolean[] = this.rules.map(rule => matches(rule, response));
    const hitCount = matched.filter(Boolean).length;
    const score = hitCount / this.rules.length;
    const passed = this.mode === 'all' ? hitCount === this.rules.length : hitCount > 0;

    const missed = this.rules
      .map((r, i) => (matched[i] ? null : describe(r)))
      .filter((s): s is string => s !== null);

    const detail = passed
      ? `matched ${hitCount}/${this.rules.length} rules`
      : `missed: ${missed.join(', ')}`;

    return { passed, score, detail, type: this.type };
  }
}

function matches(rule: StringRule, text: string): boolean {
  if (typeof rule === 'string') return text.toLowerCase().includes(rule.toLowerCase());
  return rule.test(text);
}

function describe(rule: StringRule): string {
  return typeof rule === 'string' ? `"${rule}"` : rule.toString();
}
