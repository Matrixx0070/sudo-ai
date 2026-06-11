/**
 * Regression guard: forbid cwd-relative data/ path construction in src/.
 *
 * All data-directory paths must go through the shared DATA_DIR constant in
 * src/core/shared/paths.ts (which honors the DATA_DIR env override used for
 * prod/staging isolation). A bare resolve('data') or join(process.cwd(),
 * 'data') silently ignores that override and splits state across two
 * directories.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const SRC_ROOT = path.resolve(process.cwd(), 'src');

const FORBIDDEN: RegExp[] = [
  // resolve('data'), resolve('data', ...), resolve('data/...')
  /\bresolve\(\s*['"]data['"/]/,
  // join/resolve(process.cwd(), 'data') and 'data/...' variants
  /\b(?:join|resolve)\(\s*process\.cwd\(\)\s*,\s*['"]data['"/]/,
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('no cwd-relative data paths in src/', () => {
  it('constructs all data/ paths via shared/paths.ts DATA_DIR', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_ROOT)) {
      const lines = readFileSync(file, 'utf-8').split('\n');
      lines.forEach((line, i) => {
        if (FORBIDDEN.some((re) => re.test(line))) {
          offenders.push(`${path.relative(SRC_ROOT, file)}:${i + 1}  ${line.trim()}`);
        }
      });
    }
    expect(
      offenders,
      `cwd-relative data path(s) found — import DATA_DIR from core/shared/paths.js instead:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
