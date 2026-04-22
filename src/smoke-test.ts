/**
 * @file smoke-test.ts
 * @description Quick import-resolution smoke test. Run with: npx tsx src/smoke-test.ts
 * Temporary file — safe to delete after verification.
 */

export {};

const results: Array<{ module: string; status: 'OK' | 'FAIL'; exports?: number; error?: string }> = [];

async function probe(label: string, importFn: () => Promise<Record<string, unknown>>): Promise<void> {
  try {
    const m = await importFn();
    const count = Object.keys(m).length;
    results.push({ module: label, status: 'OK', exports: count });
    console.log(`[OK]   ${label} — ${count} exports`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ module: label, status: 'FAIL', error: msg });
    console.error(`[FAIL] ${label} — ${msg}`);
  }
}

await probe('shared',   () => import('./core/shared/index.js') as Promise<Record<string, unknown>>);
await probe('config',   () => import('./core/config/index.js') as Promise<Record<string, unknown>>);
await probe('memory',   () => import('./core/memory/index.js') as Promise<Record<string, unknown>>);
await probe('tools',    () => import('./core/tools/index.js') as Promise<Record<string, unknown>>);
await probe('brain',    () => import('./core/brain/index.js') as Promise<Record<string, unknown>>);
await probe('sessions', () => import('./core/sessions/index.js') as Promise<Record<string, unknown>>);
await probe('agent',    () => import('./core/agent/index.js') as Promise<Record<string, unknown>>);
await probe('channels', () => import('./core/channels/index.js') as Promise<Record<string, unknown>>);
await probe('cron',     () => import('./core/cron/index.js') as Promise<Record<string, unknown>>);

const passed = results.filter(r => r.status === 'OK').length;
const failed = results.filter(r => r.status === 'FAIL').length;

console.log('');
console.log(`Smoke test complete: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
