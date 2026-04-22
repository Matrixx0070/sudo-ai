import { config as loadEnv } from 'dotenv';
loadEnv({ path: 'config/.env' });
import { Brain } from '../src/core/brain/index.js';
import { ToolRegistry, loadBuiltinTools } from '../src/core/tools/index.js';
import { SessionManager } from '../src/core/sessions/index.js';
import { MindDB } from '../src/core/memory/index.js';
import { AgentLoop } from '../src/core/agent/index.js';

const TESTS = [
  { name: '1. Brain responds', msg: 'Say exactly: SUDO-AI ONLINE', check: (r: string) => r.includes('SUDO') || r.includes('ONLINE') },
  { name: '2. Read file (coder.read-file)', msg: 'Use coder.read-file to read the first 3 lines of package.json and tell me the project name', check: (r: string) => r.toLowerCase().includes('sudo') },
  { name: '3. Write file (coder.write-file)', msg: 'Use coder.write-file to create "test-backend-output.txt" with content "Hello from SUDO-AI v3 backend test"', check: (_r: string) => { try { return require('fs').existsSync('/root/sudo-ai-v3/test-backend-output.txt'); } catch { return false; } } },
  { name: '4. System monitor', msg: 'Use system.monitor with operation snapshot and tell me the CPU and memory usage percentages', check: (r: string) => /\d+%/.test(r) || /\d+.*[MGmg][Bb]/.test(r) },
  { name: '5. Git status', msg: 'Use coder.git with operation status and tell me if there are any changes', check: (r: string) => r.length > 20 },
  { name: '6. Glob files', msg: 'Use coder.glob to find all .ts files in src/core/brain/ and list them', check: (r: string) => r.includes('brain.ts') || r.includes('providers') },
  { name: '7. Grep code', msg: 'Use coder.grep to search for "AgentLoop" in src/core/agent/ and tell me which files contain it', check: (r: string) => r.includes('loop') },
  { name: '8. Disk usage', msg: 'Use system.disk with operation usage and tell me how much disk space is used', check: (r: string) => /\d+[%GMgm]/.test(r) },
  { name: '9. Network ports', msg: 'Use system.network with operation ports and tell me how many ports are listening', check: (r: string) => /\d+/.test(r) },
  { name: '10. Process list', msg: 'Use system.process with operation list and tell me the top 3 processes by name', check: (r: string) => r.length > 30 },
];

async function main() {
  const db = new MindDB('data/backend-test.db');
  const brain = new Brain({});
  const reg = new ToolRegistry();
  await loadBuiltinTools(reg, 'src/core/tools/builtin');
  const sm = new SessionManager(db);
  const loop = new AgentLoop(brain, reg, sm, { maxIterations: 10 });

  console.log(`\nSUDO-AI v3 Full Backend Test | Tools: ${reg.size} | Model: grok-4.20-reasoning\n`);

  let passed = 0;
  let failed = 0;

  for (const test of TESTS) {
    process.stdout.write(`${test.name}... `);
    const session = await sm.getOrCreate('electron', `test-${Date.now()}`);
    const tools: string[] = [];
    const start = Date.now();

    try {
      const result = await loop.run(String(session.id), test.msg, (e) => {
        if (e.type === 'tool-call') tools.push(e.name);
      });
      const elapsed = Date.now() - start;
      const ok = test.check(result ?? '');
      if (ok) { passed++; console.log(`PASS (${elapsed}ms) [${tools.join(',')||'no tool'}]`); }
      else { failed++; console.log(`FAIL (${elapsed}ms) [${tools.join(',')||'no tool'}] response: ${(result??'').substring(0,80)}`); }
    } catch (err: any) {
      failed++;
      console.log(`ERROR: ${err.message?.substring(0,100)}`);
    }
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`RESULT: ${passed}/${TESTS.length} PASSED | ${failed} FAILED`);
  console.log('='.repeat(50));

  // Cleanup
  try { require('fs').unlinkSync('/root/sudo-ai-v3/test-backend-output.txt'); } catch {}
  db.close();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
