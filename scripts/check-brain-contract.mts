/**
 * CI guard: no tool/helper may declare `chat(...): Promise<{ content }>`.
 *
 * Brain.chat() resolves to a STRING (brain.ts). Sites that re-declared it as
 * `Promise<{ content }>` and read `response.content` crashed on `.trim()` — a bug that
 * silently killed whole tool suites (marketing, finance, translate, …). See #610–#612.
 *
 * Guarding the DECLARATION is sufficient: with the correct `Promise<string>` type, tsc
 * itself rejects any `.content` read on a string. So the only way to reintroduce the
 * crash is to re-type `chat` wrongly — which this catches. Prefer importing the shared
 * `ToolBrain` from core/brain/brain-text.ts over re-declaring the shape.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'src';
// A `chat(...)` method typed to resolve to an object with a `content` field.
const WRONG_CHAT = /\bchat\s*\([^)]*\)\s*:\s*Promise<\s*\{\s*content\b/;

const violations: string[] = [];

function walk(dir: string): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      walk(p);
    } else if (p.endsWith('.ts') || p.endsWith('.mts')) {
      const lines = readFileSync(p, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (WRONG_CHAT.test(line)) violations.push(`${p}:${i + 1}: ${line.trim()}`);
      });
    }
  }
}

walk(ROOT);

if (violations.length > 0) {
  console.error('✗ brain-contract guard FAILED — chat() must resolve to Promise<string> (Brain.chat returns a string).');
  console.error('  Import { ToolBrain } from core/brain/brain-text.js instead of re-declaring a { content } chat type,');
  console.error('  and normalize the reply with normalizeBrainText(). Offending declarations:');
  for (const v of violations) console.error('   ' + v);
  process.exit(1);
}

console.log('✓ brain-contract guard: no `chat(): Promise<{ content }>` declarations in src/.');
