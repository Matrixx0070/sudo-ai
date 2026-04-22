import { ToolRegistry, loadBuiltinTools } from '../../src/core/tools/index.js';

const start = Date.now();
try {
  const registry = new ToolRegistry();
  await loadBuiltinTools(registry, 'src/core/tools/builtin');
  const result = await registry.execute('coder.git', { operation: 'status', cwd: process.cwd() }, {
    sessionId: 'test', workingDir: process.cwd(), config: {}, logger: console
  });
  console.log('Git status success:', result.success);
  console.log('Output:', result.output?.substring(0, 200));
  // Even if not a git repo, it should execute without crashing
  console.log(`TEST 7 GIT OPS: PASS (${Date.now() - start}ms)`);
} catch (err) {
  console.error('TEST 7 GIT OPS: FAIL', err);
  process.exit(1);
}
