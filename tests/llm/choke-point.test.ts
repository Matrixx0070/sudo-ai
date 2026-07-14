/**
 * @file tests/llm/choke-point.test.ts
 * @description gw-refactor Phase 1 guard: every provider URL and every direct
 * provider API-key env read must live under src/llm/. If either grep matches
 * outside src/llm/, a call site has bypassed the choke point.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';

/** Provider hostname fragments that must never appear outside src/llm/. */
const PROVIDER_URL_PATTERN =
  'api\\.openai\\.com|api\\.x\\.ai|api\\.anthropic\\.com|api\\.groq\\.com|generativelanguage\\.googleapis|api\\.deepseek|api\\.moonshot|bigmodel';

/**
 * Direct provider key env READS (process.env.X / process.env['X']). Mentions of
 * the names as display strings (doctor, admin UI labels, error messages,
 * SECRET_ENV_DENYLIST) are deliberately allowed — only actual reads are the
 * choke-point violation.
 */
const PROVIDER_KEY_READ_PATTERN =
  "process\\.env(\\.|\\[['\\\"])(OPENAI_API_KEY|XAI_API_KEY|XAI_VOICE_API_KEY|ANTHROPIC_API_KEY|GROQ_API_KEY|GEMINI_API_KEY|DEEPSEEK_API_KEY)";

/**
 * Explicit whitelists. Every entry must carry a comment justifying it.
 */
const URL_WHITELIST: string[] = [];
const KEY_READ_WHITELIST: string[] = [
  // Setup wizard: reads XAI_API_KEY only to PRE-FILL the .env file it is about
  // to write (config authoring, not an LLM call). Importing src/llm/client.ts
  // here would drag the AI-SDK into the standalone setup CLI for no benefit.
  'src/cli/commands/setup.tsx',
];

/** git grep -lE <pattern> -- src — returns matching file paths ([] on no match). */
function gitGrepFiles(pattern: string): string[] {
  try {
    const out = execFileSync('git', ['grep', '-lE', pattern, '--', 'src'], {
      encoding: 'utf8',
    });
    return out.split('\n').filter(Boolean);
  } catch (err) {
    // git grep exits 1 when nothing matches — that is the passing case.
    if ((err as { status?: number }).status === 1) return [];
    throw err;
  }
}

function offenders(files: string[], whitelist: string[]): string[] {
  return files.filter(
    (f) =>
      (f.endsWith('.ts') || f.endsWith('.tsx')) &&
      !f.startsWith('src/llm/') &&
      !f.endsWith('.test.ts') &&
      !whitelist.includes(f),
  );
}

describe('src/llm choke point (gw-refactor Phase 1)', () => {
  it('no provider URL literal exists outside src/llm/', () => {
    const files = gitGrepFiles(PROVIDER_URL_PATTERN);
    expect(offenders(files, URL_WHITELIST)).toEqual([]);
  });

  it('no direct provider API-key env read exists outside src/llm/', () => {
    const files = gitGrepFiles(PROVIDER_KEY_READ_PATTERN);
    expect(offenders(files, KEY_READ_WHITELIST)).toEqual([]);
  });
});
