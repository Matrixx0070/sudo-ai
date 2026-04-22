import { ToolRegistry, loadBuiltinTools } from '../../src/core/tools/index.js';

const start = Date.now();
try {
  const registry = new ToolRegistry();
  await loadBuiltinTools(registry, 'src/core/tools/builtin');
  const result = await registry.execute('system.monitor', { operation: 'snapshot' }, {
    sessionId: 'test', workingDir: process.cwd(), config: {}, logger: console
  });
  console.log('Monitor success:', result.success);
  console.log('System stats:', result.output?.substring(0, 200));
  if (result.success) {
    console.log(`TEST 6 SYSTEM MONITOR: PASS (${Date.now() - start}ms)`);
  } else {
    console.log('TEST 6 SYSTEM MONITOR: FAIL');
    process.exit(1);
  }
} catch (err) {
  console.error('TEST 6 SYSTEM MONITOR: FAIL', err);
  process.exit(1);
}
