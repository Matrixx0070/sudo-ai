import { config as loadEnv } from 'dotenv';
loadEnv({ path: 'config/.env' });

import { Brain } from '../src/core/brain/index.js';
import { ToolRegistry, loadBuiltinTools } from '../src/core/tools/index.js';
import { SessionManager } from '../src/core/sessions/index.js';
import { MindDB } from '../src/core/memory/index.js';
import { AgentLoop } from '../src/core/agent/index.js';
import { existsSync, readFileSync, unlinkSync } from 'fs';

const TESTS = [
  {
    name: 'Test 1: Read a file',
    prompt: 'Use coder.read-file to read the first 5 lines of /root/sudo-ai-v3/package.json and tell me the project name.',
    check: (result: string) => result.toLowerCase().includes('sudo-ai'),
  },
  {
    name: 'Test 2: Write a file',
    prompt: 'Use coder.write-file to create /root/sudo-ai-v3/test-output.txt with the content "SUDO-AI v3 tool test passed"',
    check: () => existsSync('/root/sudo-ai-v3/test-output.txt') && readFileSync('/root/sudo-ai-v3/test-output.txt', 'utf-8').includes('SUDO-AI'),
  },
  {
    name: 'Test 3: System monitor',
    prompt: 'Use system.monitor with operation "snapshot" and tell me how much RAM is being used.',
    check: (result: string) => /\d+/.test(result) && (result.toLowerCase().includes('mem') || result.toLowerCase().includes('ram') || result.toLowerCase().includes('mb') || result.toLowerCase().includes('gb')),
  },
  {
    name: 'Test 4: Write TypeScript code',
    prompt: 'Use coder.write-file to create /root/sudo-ai-v3/test-fibonacci.ts with a function that calculates fibonacci(n) recursively, and a console.log that prints fibonacci(10) which should be 55.',
    check: () => {
      if (!existsSync('/root/sudo-ai-v3/test-fibonacci.ts')) return false;
      const content = readFileSync('/root/sudo-ai-v3/test-fibonacci.ts', 'utf-8');
      return content.includes('fibonacci') && content.includes('console.log');
    },
  },
];

async function main() {
  const db = new MindDB('data/tool-retest.db');
  const brain = new Brain({});
  const registry = new ToolRegistry();
  await loadBuiltinTools(registry, 'src/core/tools/builtin');
  const sm = new SessionManager(db);
  const loop = new AgentLoop(brain, registry, sm, { maxIterations: 10 });

  console.log('Tools loaded:', registry.size);
  let passed = 0;
  let failed = 0;

  for (const test of TESTS) {
    console.log(`\n=== ${test.name} ===`);
    const session = await sm.getOrCreate('electron', `retest-${Date.now()}`);
    const toolsCalled: string[] = [];

    const start = Date.now();
    try {
      const result = await loop.run(String(session.id), test.prompt, (e) => {
        if (e.type === 'tool-call') {
          toolsCalled.push(e.name);
          console.log('  TOOL:', e.name);
        }
      });
      const elapsed = Date.now() - start;
      const ok = test.check(result ?? '');
      console.log('  Time:', elapsed + 'ms');
      console.log('  Tools used:', toolsCalled.join(', ') || 'none');
      console.log('  Response:', (result ?? '').substring(0, 150));
      console.log('  Result:', ok ? 'PASS' : 'FAIL');
      if (ok) passed++; else failed++;
    } catch (err: any) {
      console.log('  ERROR:', err.message?.substring(0, 200));
      console.log('  Result: FAIL');
      failed++;
    }
  }

  console.log(`\n=============================`);
  console.log(`TOTAL: ${passed}/${TESTS.length} PASSED, ${failed} FAILED`);
  console.log(`=============================`);

  // Cleanup
  try { unlinkSync('/root/sudo-ai-v3/test-output.txt'); } catch {}
  try { unlinkSync('/root/sudo-ai-v3/test-fibonacci.ts'); } catch {}
  db.close();
}

main().catch(console.error);
