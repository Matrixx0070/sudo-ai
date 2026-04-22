import { defineConfig } from 'vitest/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    root: '.',
    include: ['tests/**/*.test.ts'],
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
  },
});
