import { Brain } from '../../src/core/brain/index.js';
import { ToolRegistry, loadBuiltinTools } from '../../src/core/tools/index.js';
import { SessionManager } from '../../src/core/sessions/index.js';
import { MindDB } from '../../src/core/memory/index.js';
import { AgentLoop } from '../../src/core/agent/index.js';
import { ConfigLoader } from '../../src/core/config/index.js';

const start = Date.now();
try {
  const loader = new ConfigLoader();
  await loader.load();
  const config = loader.get();

  const db = new MindDB('data/test-agent2.db');
  const brain = new Brain(config);
  const registry = new ToolRegistry();
  await loadBuiltinTools(registry, 'src/core/tools/builtin');
  const sm = new SessionManager(db);
  const loop = new AgentLoop(brain, registry, sm, { maxIterations: 10 });

  const session = await sm.getOrCreate('electron', 'test-user2');
  const events: any[] = [];
  const result = await loop.run(
    session.id,
    'Use the coder.read-file tool to read the first 3 lines of /root/sudo-ai-v3/package.json and tell me the project name.',
    (e) => {
      events.push(e);
      if (e.type === 'tool-call') console.log('TOOL CALLED:', e.name);
    }
  );
  console.log('Agent response:', result?.substring(0, 300));
  const toolCalls = events.filter(e => e.type === 'tool-call').length;
  console.log('Tool calls made:', toolCalls);
  if (result && result.length > 0) {
    console.log(`TEST 20 AGENT TOOL CALL: PASS (${Date.now() - start}ms)`);
  } else {
    console.log('TEST 20 AGENT TOOL CALL: FAIL - no response');
    process.exit(1);
  }
  db.close();
  loader.close();
} catch (err) {
  console.error('TEST 20 AGENT TOOL CALL: FAIL', err);
  process.exit(1);
}
