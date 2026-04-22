import { config as loadEnv } from 'dotenv';
loadEnv({ path: 'config/.env' });

import { Brain } from '../src/core/brain/index.js';
import { ToolRegistry, loadBuiltinTools } from '../src/core/tools/index.js';
import { SessionManager } from '../src/core/sessions/index.js';
import { MindDB } from '../src/core/memory/index.js';
import { AgentLoop } from '../src/core/agent/index.js';
import { existsSync, readFileSync } from 'fs';

async function main() {
  const db = new MindDB('data/battle-test3.db');
  const brain = new Brain({});
  const registry = new ToolRegistry();
  await loadBuiltinTools(registry, 'src/core/tools/builtin');
  const sm = new SessionManager(db);
  const loop = new AgentLoop(brain, registry, sm, { maxIterations: 15 });
  const session = await sm.getOrCreate('electron', 'battle3');

  const start = Date.now();
  const result = await loop.run(String(session.id),
    `Use coder.write-file to create /root/sudo-ai-v3/battle-task-queue.ts with a complete TaskQueue class in TypeScript:

Requirements:
- Task interface with: id, name, priority, status (pending/running/done/failed), retries, maxRetries, timeout, result, error, createdAt
- TaskQueue class with concurrency limit (constructor param, default 3)
- add(name, fn, opts?) method — adds task with priority sorting, returns id
- Priority queue — higher priority tasks run first
- Retry on failure — up to maxRetries attempts
- Timeout support — reject if task takes too long
- getStatus(id) — returns task status
- stats() — returns {pending, running, completed, failed} counts
- Self-test at bottom: add 5 tasks (fast, slow, fail, timeout, high-priority), wait 1s, print stats, print TEST PASS if completed>=2 and failed>=1

Pure TypeScript, no external deps. Use coder.write-file tool.`,
    (e) => {
      if (e.type === 'tool-call') console.log('TOOL:', e.name);
    }
  );
  const elapsed = Date.now() - start;
  console.log('Time:', elapsed + 'ms');

  const outPath = '/root/sudo-ai-v3/battle-task-queue.ts';
  if (existsSync(outPath)) {
    console.log('Lines:', readFileSync(outPath, 'utf-8').split('\n').length);
    console.log('FILE CREATED');
  } else {
    console.log('FILE NOT CREATED');
  }
  db.close();
}
main().catch(console.error);
