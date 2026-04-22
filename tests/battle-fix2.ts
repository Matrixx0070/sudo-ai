import { config as loadEnv } from 'dotenv';
loadEnv({ path: 'config/.env' });
import { Brain } from '../src/core/brain/index.js';
import { ToolRegistry, loadBuiltinTools } from '../src/core/tools/index.js';
import { SessionManager } from '../src/core/sessions/index.js';
import { MindDB } from '../src/core/memory/index.js';
import { AgentLoop } from '../src/core/agent/index.js';
import { existsSync, readFileSync } from 'fs';
import { execSync } from 'child_process';

async function run(name: string, prompt: string, file: string, loop: AgentLoop, sm: SessionManager) {
  console.log(`\n=== ${name} ===`);
  try { require('fs').unlinkSync(`/root/sudo-ai-v3/${file}`); } catch {}
  const session = await sm.getOrCreate('electron', `fix2-${Date.now()}`);
  const start = Date.now();
  await loop.run(String(session.id), prompt, (e) => {
    if (e.type === 'tool-call') console.log('  TOOL:', e.name);
  });
  console.log('  Time:', (Date.now() - start) + 'ms');
  const p = `/root/sudo-ai-v3/${file}`;
  if (!existsSync(p)) { console.log('  NO FILE'); return false; }
  console.log('  Lines:', readFileSync(p, 'utf-8').split('\n').length);
  try {
    const out = execSync(`timeout 15 npx tsx ${p}`, { encoding: 'utf-8', timeout: 20000, cwd: '/root/sudo-ai-v3' });
    for (const l of out.trim().split('\n')) console.log('  >', l);
    const pass = out.includes('TEST PASS');
    console.log('  =>', pass ? 'PASS' : 'FAIL');
    return pass;
  } catch (e: any) {
    const msg = ((e.stdout ?? '') + (e.stderr ?? '')).split('\n').slice(0, 5);
    for (const l of msg) console.log('  >', l);
    console.log('  => FAIL (error)');
    return false;
  }
}

async function main() {
  const db = new MindDB('data/battle-fix2.db');
  const brain = new Brain({});
  const reg = new ToolRegistry();
  await loadBuiltinTools(reg, 'src/core/tools/builtin');
  const sm = new SessionManager(db);
  const loop = new AgentLoop(brain, reg, sm, { maxIterations: 15 });

  const r1 = await run('API Server', `Use coder.write-file to create "fix2-api.ts".

REST API with http.createServer. NO express. Include:
- POST /auth/register: validate email with /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/, name 2-50 chars, password min 6, SHA-256 hash, 409 duplicate
- POST /auth/login: return Bearer token
- POST /todos: title 1-200 chars, priority 1-5 (auth required)
- GET /todos: list with ?status filter (auth required)
- PUT /todos/:id: update, ownership check (auth required)
- DELETE /todos/:id: ownership check (auth required)
- GET /health: status + uptime

SELF-TEST on port 39879: use fetch() for ALL requests. Test register, dup 409, login, create todo, list, update, delete, health. Print TEST PASS. Call process.exit(0).

CRITICAL: Use ESM imports only. Use fetch(). Call process.exit(0). Use this exact email regex: /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/`, 'fix2-api.ts', loop, sm);

  const r2 = await run('Event Bus', `Use coder.write-file to create "fix2-eventbus.ts".

EventBus with: on(pattern, handler, {priority?}), once, off(id), emit(topic, payload), use(middleware), onDeadLetter.
Wildcards: * = one segment, ** = multiple. Priority sort. Middleware chain. Dead letter.

IMPORTANT for replay/stats:
- Store ALL emitted events in a this.history array INSIDE emit()
- replay(pattern): filter this.history where topic matches pattern regex
- stats(): return { subscribers: this.subs.size, topics: new Set(this.history.map(e=>e.topic)).size, totalEvents: this.history.length }
- Persistence: writeFileSync history to /tmp/fix2-eventbus.json in emit(). Constructor loads from file if exists.

SELF-TEST 11 tests: 1.Simple 2.Wildcard* 3.Wildcard** 4.Once 5.Priority 6.Middleware 7.Dead letter 8.Replay(emit 3 events FIRST, then call replay, check length>=1) 9.Stats(emit events FIRST, then check totalEvents>0) 10.Unsub 11.Persistence(emit, create NEW instance with same path, check it has events)
Print TEST PASS only if 11/11. process.exit(0).`, 'fix2-eventbus.ts', loop, sm);

  console.log(`\n=== SCORE: ${[r1,r2].filter(Boolean).length}/2 ===`);
  db.close();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
