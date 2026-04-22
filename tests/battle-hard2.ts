import { config as loadEnv } from 'dotenv';
loadEnv({ path: 'config/.env' });
import { Brain } from '../src/core/brain/index.js';
import { ToolRegistry, loadBuiltinTools } from '../src/core/tools/index.js';
import { SessionManager } from '../src/core/sessions/index.js';
import { MindDB } from '../src/core/memory/index.js';
import { AgentLoop } from '../src/core/agent/index.js';
import { existsSync, readFileSync } from 'fs';

async function main() {
  const db = new MindDB('data/battle-hard2.db');
  const brain = new Brain({});
  const registry = new ToolRegistry();
  await loadBuiltinTools(registry, 'src/core/tools/builtin');
  const sm = new SessionManager(db);
  const loop = new AgentLoop(brain, registry, sm, { maxIterations: 15 });
  const session = await sm.getOrCreate('electron', 'hard2');

  const start = Date.now();
  const result = await loop.run(String(session.id),
`Use coder.write-file to write to path "event-bus.ts" (relative to working dir).

Build a complete TypeScript EventBus class with pub/sub, wildcards, middleware, replay, persistence. Requirements:

1. EventBus class with: on(pattern, handler, opts?), once(pattern, handler), off(id), emit(topic, payload, metadata?), use(middleware), onDeadLetter(handler)
2. Wildcard patterns: * matches one segment (order.* matches order.placed), ** matches multiple segments (system.** matches system.cpu.high)
3. Priority-based handler ordering (higher priority runs first)
4. Middleware chain: use(async (event, next) => { ... await next(); }) — runs before handlers
5. Dead letter handler: catches errors from handlers
6. Replay: replay(pattern, since?) returns past events matching pattern. replayTo(pattern, handler, since?) replays to handler.
7. File persistence: save history to JSON file, load on construct
8. Stats: topics(), stats() returning subscriber/event counts

Self-test with 11 tests:
1. Simple sub → PASS/FAIL
2. Wildcard * → PASS/FAIL
3. Wildcard ** → PASS/FAIL
4. Once (fires only once) → PASS/FAIL
5. Priority ordering → PASS/FAIL
6. Middleware intercept → PASS/FAIL
7. Dead letter on error → PASS/FAIL
8. Replay past events → PASS/FAIL
9. Stats → PASS/FAIL
10. Unsubscribe → PASS/FAIL
11. Persistence across instances → PASS/FAIL
Print TEST PASS at end.

No external deps. Use fs for persistence. Use coder.write-file tool.`,
    (e) => {
      if (e.type === 'tool-call') console.log('TOOL:', e.name);
    }
  );
  const elapsed = Date.now() - start;
  console.log('\nTime:', elapsed + 'ms');

  // Check both possible paths
  for (const p of ['/root/sudo-ai-v3/event-bus.ts', '/root/battle-test-v2/sudo-ai/event-bus.ts']) {
    if (existsSync(p)) {
      const lines = readFileSync(p, 'utf-8').split('\n').length;
      console.log('FILE:', p, 'Lines:', lines);
    }
  }
  db.close();
}
main().catch(console.error);
