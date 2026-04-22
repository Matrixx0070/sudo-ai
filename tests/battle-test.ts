import { config as loadEnv } from 'dotenv';
loadEnv({ path: 'config/.env' });

import { Brain } from '../src/core/brain/index.js';
import { ToolRegistry, loadBuiltinTools } from '../src/core/tools/index.js';
import { SessionManager } from '../src/core/sessions/index.js';
import { MindDB } from '../src/core/memory/index.js';
import { AgentLoop } from '../src/core/agent/index.js';

async function main() {
  const db = new MindDB('data/battle-test.db');
  const brain = new Brain({});
  const registry = new ToolRegistry();
  await loadBuiltinTools(registry, 'src/core/tools/builtin');
  const sm = new SessionManager(db);
  const loop = new AgentLoop(brain, registry, sm, { maxIterations: 15 });

  const session = await sm.getOrCreate('electron', 'battle-test');
  console.log('Session ID:', session.id, 'type:', typeof session.id);

  const start = Date.now();
  const result = await loop.run(String(session.id),
    'Write a TypeScript URL shortener module to /root/battle-test/sudo-ai/url-shortener.ts using the coder.write-file tool. It must have: a UrlShortener class with shorten(url, options?), resolve(code), getStats(code), delete(id), listAll() methods. Include custom short codes, TTL/expiry support, click counting. Add a self-test at bottom that creates a short URL, resolves it, checks clicks, prints TEST PASS. Use crypto for hashing. Production quality code.',
    (e) => {
      if (e.type === 'tool-call') console.log('TOOL CALLED:', e.name);
      if (e.type === 'tool-result') console.log('TOOL RESULT received');
    }
  );
  const elapsed = Date.now() - start;

  console.log('\n=== SUDO-AI RESULT ===');
  console.log('Time:', elapsed + 'ms');
  console.log('Response:', result?.substring(0, 500));

  db.close();
}

main().catch(console.error);
