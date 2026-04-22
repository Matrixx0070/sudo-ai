import { WorkspaceManager } from '../../src/core/workspace/index.js';

const start = Date.now();
try {
  const wm = new WorkspaceManager('workspace');
  const soul = await wm.readFile('SOUL');
  console.log('SOUL.md length:', soul?.content?.length, 'bytes');
  const files = await wm.listAll();
  console.log('Workspace files:', files.length, files.map(f => f.name).join(', '));
  if (soul && soul.content && soul.content.length > 0 && files.length > 0) {
    console.log(`TEST 18 WORKSPACE: PASS (${Date.now() - start}ms)`);
  } else {
    console.log('TEST 18 WORKSPACE: FAIL - SOUL.md empty or no files');
    process.exit(1);
  }
} catch (err) {
  console.error('TEST 18 WORKSPACE: FAIL', err);
  process.exit(1);
}
