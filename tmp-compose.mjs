/**
 * tmp-compose.mjs
 * One-shot script: invoke CreativeEngine.composeMusic('epic', 15) and print result as JSON.
 * Runs via tsx (TypeScript source directly — no compiled dist/core/creative).
 *
 * Usage:
 *   node --import tsx/esm tmp-compose.mjs
 *   OR: ./node_modules/.bin/tsx tmp-compose.mjs
 */

import { createRequire } from 'node:module';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

// Use tsx to load TypeScript source via the Node loader API.
// tsx registers a loader that compiles .ts files on the fly.
const tsxLoaderUrl = pathToFileURL(
  new URL('./node_modules/tsx/dist/esm/index.cjs', import.meta.url).pathname
).href;

// We cannot dynamically re-register loaders in the same process after startup,
// so instead we spawn a child process with tsx as the loader.
// This is the most reliable approach for ad-hoc TS execution.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// Inner script content executed by tsx
const innerScript = `
import { CreativeEngine } from './src/core/creative/creative-engine.js';

const DB_PATH = '/root/sudo-ai-v3/data/mind.db';
const engine = new CreativeEngine(DB_PATH);

try {
  const result = engine.composeMusic('epic', 15);
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
} catch (err) {
  console.error('ERROR:', err instanceof Error ? err.message : String(err));
  process.exit(1);
}
`;

import { writeFileSync, unlinkSync, existsSync } from 'node:fs';

const innerPath = resolve(__dirname, '_inner-compose.ts');

writeFileSync(innerPath, innerScript, 'utf8');

const tsx = resolve(__dirname, 'node_modules/.bin/tsx');

const result = spawnSync(tsx, [innerPath], {
  cwd: __dirname,
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'development' },
});

// Clean up temp file
try { unlinkSync(innerPath); } catch (_) { /* ignore */ }

if (result.error) {
  console.error('Failed to spawn tsx:', result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
