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

  const db = new MindDB('data/test-agent.db');
  const brain = new Brain(config);
  const registry = new ToolRegistry();
  await loadBuiltinTools(registry, 'src/core/tools/builtin');
  const sm = new SessionManager(db);
  const loop = new AgentLoop(brain, registry, sm, { maxIterations: 5 });

  const session = await sm.getOrCreate('electron', 'test-user');
  const events: any[] = [];
  const result = await loop.run(session.id, 'What is 2+2? Reply with just the number.', (e) => events.push(e));
  console.log('Agent response:', result?.substring(0, 200));
  console.log('Events:', events.length, events.map(e => e.type).join(', '));
  if (result && result.length > 0) {
    console.log(`TEST 19 AGENT LOOP: PASS (${Date.now() - start}ms)`);
  } else {
    console.log('TEST 19 AGENT LOOP: FAIL - no response');
    process.exit(1);
  }
  db.close();
  loader.close();
} catch (err) {
  console.error('TEST 19 AGENT LOOP: FAIL', err);
  process.exit(1);
}
