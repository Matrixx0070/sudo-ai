import { config as loadEnv } from 'dotenv';
loadEnv({ path: 'config/.env' });

import { Brain } from '../src/core/brain/index.js';
import { ToolRegistry, loadBuiltinTools } from '../src/core/tools/index.js';
import { SessionManager } from '../src/core/sessions/index.js';
import { MindDB } from '../src/core/memory/index.js';
import { AgentLoop } from '../src/core/agent/index.js';
import { existsSync, readFileSync } from 'fs';

async function main() {
  const db = new MindDB('data/battle-test4.db');
  const brain = new Brain({});
  const registry = new ToolRegistry();
  await loadBuiltinTools(registry, 'src/core/tools/builtin');
  const sm = new SessionManager(db);
  const loop = new AgentLoop(brain, registry, sm, { maxIterations: 15 });
  const session = await sm.getOrCreate('electron', 'battle4');

  const start = Date.now();
  const result = await loop.run(String(session.id),
    `Use coder.write-file to create /root/sudo-ai-v3/battle-kv-store.ts with a KV store class:

Requirements:
- KVStore class with in-memory Map storage
- set(key, value, ttlMs?) — store with optional TTL
- get(key) — return value or undefined, respect TTL expiry
- delete(key), has(key), keys(), size(), clear()
- Transaction support: begin(), commit(), rollback() — rollback undoes all changes since begin()
- Optional file persistence (constructor param persistPath)
- Self-test: set values, test TTL expiry (50ms), test transaction rollback, test commit, print TEST PASS

No external deps. Use crypto for nothing, just Map. Use coder.write-file tool.`,
    (e) => {
      if (e.type === 'tool-call') console.log('TOOL:', e.name);
    }
  );
  const elapsed = Date.now() - start;
  console.log('Time:', elapsed + 'ms');

  const outPath = '/root/sudo-ai-v3/battle-kv-store.ts';
  if (existsSync(outPath)) {
    const lines = readFileSync(outPath, 'utf-8').split('\n').length;
    console.log('Lines:', lines);
    console.log('FILE CREATED — running it...');
  } else {
    console.log('FILE NOT CREATED');
  }
  db.close();
}
main().catch(console.error);
