import { config } from 'dotenv';
config({ path: 'config/.env' });
import { Brain } from '../src/core/brain/index.js';
import { ToolRegistry, loadBuiltinTools } from '../src/core/tools/index.js';
import { SessionManager } from '../src/core/sessions/index.js';
import { MindDB } from '../src/core/memory/index.js';
import { AgentLoop } from '../src/core/agent/index.js';

const MESSAGES = [
  'Hello! What can you do?',
  'Check my disk usage using the system.disk tool',
  'Read the first 3 lines of package.json using coder.read-file',
  'What processes are using the most memory? Use system.process',
  'Write a file called test-hello.txt with content "SUDO-AI says hello!" using coder.write-file',
];

async function main() {
  const db = new MindDB('data/chat-sim.db');
  const brain = new Brain({});
  const reg = new ToolRegistry();
  await loadBuiltinTools(reg, 'src/core/tools/builtin');
  const sm = new SessionManager(db);
  const loop = new AgentLoop(brain, reg, sm, { maxIterations: 10 });

  console.log(`\n=== SUDO-AI Chat Simulation (${reg.size} tools, grok-4.20) ===\n`);

  // Use same session for all messages (like a real chat)
  const session = await sm.getOrCreate('electron', 'chat-sim');

  for (const msg of MESSAGES) {
    console.log(`YOU: ${msg}`);
    const tools: string[] = [];
    const start = Date.now();
    const response = await loop.run(String(session.id), msg, (e) => {
      if (e.type === 'tool-call') tools.push(e.name);
    });
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    if (tools.length) console.log(`  [tools: ${tools.join(', ')}]`);
    console.log(`SUDO-AI (${elapsed}s): ${response?.substring(0, 300)}\n`);
  }

  db.close();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
