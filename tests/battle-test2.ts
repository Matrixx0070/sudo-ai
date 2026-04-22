import { config as loadEnv } from 'dotenv';
loadEnv({ path: 'config/.env' });

import { Brain } from '../src/core/brain/index.js';
import { ToolRegistry, loadBuiltinTools } from '../src/core/tools/index.js';
import { SessionManager } from '../src/core/sessions/index.js';
import { MindDB } from '../src/core/memory/index.js';
import { AgentLoop } from '../src/core/agent/index.js';

async function main() {
  const db = new MindDB('data/battle-test2.db');
  const brain = new Brain({});
  const registry = new ToolRegistry();
  await loadBuiltinTools(registry, 'src/core/tools/builtin');
  const sm = new SessionManager(db);
  const loop = new AgentLoop(brain, registry, sm, { maxIterations: 15 });

  console.log('Tools available:', registry.size);
  console.log('Has coder.write-file:', registry.isEnabled('coder.write-file'));

  const session = await sm.getOrCreate('electron', 'battle2');

  const start = Date.now();
  const result = await loop.run(String(session.id),
    `You MUST use the coder.write-file tool to create a file at /root/battle-test/sudo-ai/url-shortener.ts

The file must contain a complete TypeScript URL shortener module with:
- UrlShortener class
- shorten(url, options?) method with custom code and TTL support
- resolve(code) method with click tracking
- getStats(code) method
- delete(id) method
- listAll() method
- Self-test at bottom that prints TEST PASS

Use crypto.createHash for generating short codes. This is a TOOL USE task - you must call coder.write-file.`,
    (e) => {
      if (e.type === 'tool-call') console.log('>>> TOOL CALLED:', e.name, JSON.stringify(e.args).substring(0, 100));
      if (e.type === 'tool-result') console.log('>>> TOOL RESULT:', String(e.result).substring(0, 100));
      if (e.type === 'error') console.log('>>> ERROR:', e.error);
    }
  );
  const elapsed = Date.now() - start;

  console.log('\n=== SUDO-AI RESULT ===');
  console.log('Time:', elapsed + 'ms');
  console.log('Response preview:', result?.substring(0, 300));

  // Check if file was created
  const fs = await import('fs');
  if (fs.existsSync('/root/battle-test/sudo-ai/url-shortener.ts')) {
    const content = fs.readFileSync('/root/battle-test/sudo-ai/url-shortener.ts', 'utf-8');
    console.log('\nFILE CREATED! Lines:', content.split('\n').length);
  } else {
    console.log('\nFILE NOT CREATED — agent did not use tool');
  }

  db.close();
}

main().catch(console.error);
