import { ToolRegistry, loadBuiltinTools } from '../../src/core/tools/index.js';

const start = Date.now();
try {
  const registry = new ToolRegistry();
  await loadBuiltinTools(registry, 'src/core/tools/builtin');
  console.log('Tools loaded:', registry.size);
  const result = await registry.execute('coder.read-file', { path: 'package.json', limit: 5 }, {
    sessionId: 'test', workingDir: process.cwd(), config: {}, logger: console
  });
  console.log('Read file success:', result.success);
  console.log('Content preview:', result.output?.substring(0, 100));
  if (result.success && result.output?.includes('sudo-ai')) {
    console.log(`TEST 5 TOOL REGISTRY: PASS (${Date.now() - start}ms)`);
  } else {
    console.log('TEST 5 TOOL REGISTRY: FAIL - read-file did not return expected content');
    process.exit(1);
  }
} catch (err) {
  console.error('TEST 5 TOOL REGISTRY: FAIL', err);
  process.exit(1);
}
