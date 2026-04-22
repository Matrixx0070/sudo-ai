#!/usr/bin/env tsx
/**
 * @file scripts/fuzz-runner.ts
 * @description Wave 8F: CI convenience wrapper to run fuzz tests via vitest.
 *
 * Usage:
 *   npx tsx scripts/fuzz-runner.ts
 *   node --import tsx/esm scripts/fuzz-runner.ts
 *
 * Equivalent to: npx vitest run tests/fuzz/
 * Exists as a named entry point for CI pipelines.
 */

import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

console.log('Wave 8F Fuzz Runner — running tests/fuzz/*.fuzz.test.ts');
console.log(`Project root: ${projectRoot}`);
console.log('');

try {
  execSync('npx vitest run tests/fuzz/', {
    cwd: projectRoot,
    stdio: 'inherit',
    env: { ...process.env },
  });
  console.log('\nFuzz suite: PASS');
  process.exit(0);
} catch (err: unknown) {
  const exitCode = (err as { status?: number }).status ?? 1;
  console.error(`\nFuzz suite: FAIL (exit code ${exitCode})`);
  process.exit(exitCode);
}
