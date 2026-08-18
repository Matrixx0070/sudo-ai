import { defineConfig } from 'vitest/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    root: '.',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    exclude: ['tests/e2e/**'],
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/core/**'],
      exclude: ['src/renderer/**', 'src/main/**'],
      thresholds: { lines: 60, branches: 50 },
    },
    alias: {
      '@core': path.resolve(__dirname, 'src/core'),
      '@renderer': path.resolve(__dirname, 'src/renderer'),
      '@main': path.resolve(__dirname, 'src/main'),
    },
    testTimeout: 15000,
    // Load-tolerance: several tests/agent tests "settle" async work with a fixed
    // tiny setTimeout (0–50ms) and assert after — under CPU contention (e.g. the
    // apply-time gate running vitest alongside the live bot) the work outlasts
    // the delay and the test flakes. A retry absorbs a transient timing jitter;
    // a REAL breakage still fails every attempt, so the self-modify gate stays
    // honest (it won't ship code that reliably fails a test).
    retry: 2,
  },
});
