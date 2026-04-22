import { config as loadEnv } from 'dotenv';
loadEnv({ path: 'config/.env' });
import { Brain } from '../src/core/brain/index.js';
import { ToolRegistry, loadBuiltinTools } from '../src/core/tools/index.js';
import { SessionManager } from '../src/core/sessions/index.js';
import { MindDB } from '../src/core/memory/index.js';
import { AgentLoop } from '../src/core/agent/index.js';
import { existsSync, readFileSync, unlinkSync } from 'fs';
import { execSync } from 'child_process';

async function runChallenge(name: string, prompt: string, outputFile: string, loop: AgentLoop, sm: SessionManager) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`CHALLENGE: ${name}`);
  console.log('='.repeat(60));
  try { unlinkSync(`/root/sudo-ai-v3/${outputFile}`); } catch {}

  const session = await sm.getOrCreate('electron', `rerun-${Date.now()}`);
  const tools: string[] = [];
  const start = Date.now();

  await loop.run(String(session.id), prompt, (e) => {
    if (e.type === 'tool-call') { tools.push(e.name); console.log('  TOOL:', e.name); }
  });

  const elapsed = Date.now() - start;
  console.log('  Time:', elapsed + 'ms');

  const fullPath = `/root/sudo-ai-v3/${outputFile}`;
  if (!existsSync(fullPath)) {
    console.log('  FILE NOT CREATED — FAIL');
    return false;
  }

  const lines = readFileSync(fullPath, 'utf-8').split('\n').length;
  console.log('  Lines:', lines);

  try {
    const out = execSync(`timeout 15 npx tsx ${fullPath}`, { encoding: 'utf-8', timeout: 20000, cwd: '/root/sudo-ai-v3' }).trim();
    const outLines = out.split('\n');
    for (const l of outLines) console.log('  >', l);
    const passed = out.includes('TEST PASS');
    console.log(`  RESULT: ${passed ? 'PASS' : 'FAIL'}`);
    return passed;
  } catch (err: any) {
    const msg = (err.stdout ?? '') + (err.stderr ?? '');
    for (const l of msg.split('\n').slice(0, 10)) console.log('  >', l);
    console.log('  RESULT: FAIL (runtime error)');
    return false;
  }
}

async function main() {
  const db = new MindDB('data/battle-rerun.db');
  const brain = new Brain({});
  const registry = new ToolRegistry();
  await loadBuiltinTools(registry, 'src/core/tools/builtin');
  const sm = new SessionManager(db);
  const loop = new AgentLoop(brain, registry, sm, { maxIterations: 15 });
  console.log('Tools:', registry.size);

  const r1 = await runChallenge(
    'REST API Server (RERUN)',
`Use coder.write-file to create "rerun-api.ts" (relative path).

Build a REST API with Node.js http.createServer. NO express.

AUTH: POST /auth/register (validate email regex, name 2-50 chars, password min 6, SHA-256 hash, 409 duplicate). POST /auth/login (return Bearer token, 1hr expiry).
TODO CRUD (Bearer auth required): POST /todos (title 1-200, desc, priority 1-5, 201). GET /todos (?status filter, ?sort=priority). PUT /todos/:id (update, ownership check). DELETE /todos/:id (ownership).
GET /health (status, uptime, counts).
Validation, error handling (400/401/403/404/500). In-memory Maps. crypto for hashing.

SELF-TEST: port 39878. Use fetch() for ALL HTTP calls (NEVER require("http")). Register → dup register 409 → bad password 400 → login → bad login 401 → create todo 201 → unauth 401 → list 200 → update → delete → health. Print TEST PASS. Call process.exit(0).

REMEMBER: ESM only. Use fetch() not require("http"). Call process.exit(0) at the end.`,
    'rerun-api.ts', loop, sm
  );

  const r2 = await runChallenge(
    'Event Bus (RERUN)',
`Use coder.write-file to create "rerun-eventbus.ts" (relative path).

EventBus class: on(pattern, handler, {priority?}), once, off(id), emit(topic, payload, metadata?), use(middleware), onDeadLetter.
Wildcards: * = one segment, ** = multi-segment. Priority: higher first. Middleware: use(async(event,next)=>{await next()}).
Dead letter: catch handler errors. Replay: replay(pattern, since?), replayTo(pattern, handler). Persistence: save history to /tmp/rerun-eventbus.json.
stats(): {subscribers, topics, totalEvents}.

SELF-TEST (11 tests): 1.Simple sub 2.Wildcard * 3.Wildcard ** 4.Once 5.Priority [10,5,1] 6.Middleware 7.Dead letter 8.Replay (emit events FIRST then replay) 9.Stats (check AFTER emitting) 10.Unsub 11.Persistence (create new instance, verify it loads history).
Print PASS/FAIL per test. Print TEST PASS only if 11/11.

KEY: Emit events BEFORE replay test. Check stats AFTER emitting. For persistence test, write history then create a NEW EventBus instance with same path. Call process.exit(0).`,
    'rerun-eventbus.ts', loop, sm
  );

  console.log(`\n${'='.repeat(60)}`);
  console.log('RERUN RESULTS');
  console.log(`  API Server: ${r1 ? 'PASS' : 'FAIL'}`);
  console.log(`  Event Bus:  ${r2 ? 'PASS' : 'FAIL'}`);
  console.log(`  Score: ${[r1,r2].filter(Boolean).length}/2`);
  console.log('='.repeat(60));

  db.close();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
