// LoopGuard is not exported from barrel, import directly
import { LoopGuard } from '../../src/core/agent/loop-guard.js';

const start = Date.now();
try {
  const guard = new LoopGuard();
  const results: string[] = [];
  for (let i = 0; i < 6; i++) {
    const r = guard.recordCall('coder.read-file', { path: '/same/file' });
    results.push(r.action);
    console.log(`Call ${i+1}:`, r.action, r.reason || '');
  }
  // Should see 'allow' initially, then 'warn', then 'abort'
  const hasWarn = results.includes('warn');
  const hasAbort = results.includes('abort');
  console.log('Has warn:', hasWarn, 'Has abort:', hasAbort);
  if (hasWarn || hasAbort) {
    console.log(`TEST 17 LOOP GUARD: PASS (${Date.now() - start}ms)`);
  } else {
    console.log('TEST 17 LOOP GUARD: FAIL - no warn/abort detected');
    process.exit(1);
  }
} catch (err) {
  console.error('TEST 17 LOOP GUARD: FAIL', err);
  process.exit(1);
}
