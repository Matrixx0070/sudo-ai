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

  // Cleanup
  try { unlinkSync(outputFile); } catch {}

  const session = await sm.getOrCreate('electron', `final-${Date.now()}`);
  const tools: string[] = [];
  const start = Date.now();

  const result = await loop.run(String(session.id), prompt, (e) => {
    if (e.type === 'tool-call') { tools.push(e.name); console.log('  TOOL:', e.name); }
  });

  const elapsed = Date.now() - start;
  console.log('  Time:', elapsed + 'ms');
  console.log('  Tools used:', tools.join(', '));

  // Check file
  const fullPath = `/root/sudo-ai-v3/${outputFile}`;
  if (existsSync(fullPath)) {
    const content = readFileSync(fullPath, 'utf-8');
    const lines = content.split('\n').length;
    console.log('  File:', fullPath);
    console.log('  Lines:', lines);

    // Try to run it
    console.log('  --- Running ---');
    try {
      const output = execSync(`timeout 15 npx tsx ${fullPath}`, { encoding: 'utf-8', timeout: 20000, cwd: '/root/sudo-ai-v3' }).trim();
      console.log(output);
      const passed = output.includes('TEST PASS');
      console.log(`  RESULT: ${passed ? 'PASS' : 'FAIL'}`);
      return { name, time: elapsed, lines, passed, error: null };
    } catch (err: any) {
      const stderr = err.stderr?.substring(0, 300) ?? err.message?.substring(0, 300);
      console.log('  RUN ERROR:', stderr);
      console.log('  RESULT: FAIL (runtime error)');
      return { name, time: elapsed, lines, passed: false, error: stderr };
    }
  } else {
    console.log('  FILE NOT CREATED');
    console.log('  RESULT: FAIL (no file)');
    return { name, time: elapsed, lines: 0, passed: false, error: 'File not created' };
  }
}

async function main() {
  const db = new MindDB('data/battle-final.db');
  const brain = new Brain({});
  const registry = new ToolRegistry();
  await loadBuiltinTools(registry, 'src/core/tools/builtin');
  const sm = new SessionManager(db);
  const loop = new AgentLoop(brain, registry, sm, { maxIterations: 15 });
  console.log('SUDO-AI v3 loaded:', registry.size, 'tools');

  const results = [];

  // CHALLENGE 1: REST API Server
  results.push(await runChallenge(
    'REST API Server (auth + CRUD + validation)',
`Use coder.write-file to create file "challenge-api.ts" (relative path).

Build a complete REST API server using Node.js http.createServer (NO express). Include:

1. AUTH: POST /auth/register (email regex validation, name 2-50 chars, password min 6 chars, SHA-256 hash, 409 on duplicate). POST /auth/login (verify, return Bearer token, 1hr session).
2. TODO CRUD (all require Bearer auth):
   - POST /todos — title required 1-200 chars, description optional, priority 1-5, returns 201
   - GET /todos — list user's todos, ?status= filter, ?sort=priority
   - PUT /todos/:id — update fields, check ownership (403 if not owner and not admin)
   - DELETE /todos/:id — check ownership
3. GET /health — status, uptime, counts
4. Validation helper function, proper error handling (400/401/403/404/500)
5. In-memory Maps, crypto for hashing, no external deps

SELF-TEST: Start on port 39877, test: register → dup register (409) → login → bad login (401) → create todo → unauth create (401) → list → update status → delete → health. Print each test result. Close server. Print TEST PASS.

IMPORTANT: Use ESM imports only. Never use require() or __dirname.`,
    'challenge-api.ts',
    loop, sm
  ));

  // CHALLENGE 2: Event Bus
  results.push(await runChallenge(
    'Event Bus (pub/sub + wildcards + middleware + replay)',
`Use coder.write-file to create file "challenge-eventbus.ts" (relative path).

Build a TypeScript EventBus class with:

1. on(pattern, handler, opts?{priority}), once(pattern, handler), off(id), emit(topic, payload, metadata?)
2. Wildcard patterns: * = one segment (order.* matches order.placed), ** = multi-segment (system.** matches system.cpu.high)
3. Priority ordering: higher priority handlers run first
4. Middleware: use(async (event, next) => { ... await next(); }) — chain runs before handlers
5. Dead letter: onDeadLetter(handler) catches handler errors
6. Replay: replay(pattern, since?) returns past events. replayTo(pattern, handler) replays to handler.
7. Persistence: save/load history from JSON file (fs.writeFileSync/readFileSync)
8. stats() returning {subscribers, topics, totalEvents}

SELF-TEST with 11 tests:
1. Simple subscription 2. Wildcard * 3. Wildcard ** 4. Once fires only once 5. Priority ordering [10,5,1]
6. Middleware intercept 7. Dead letter on throw 8. Replay 9. Stats 10. Unsubscribe 11. Persistence across instances
Print PASS/FAIL per test. Print TEST PASS only if all 11 pass.

IMPORTANT: Use ESM imports only. Never use require() or __dirname. Use import.meta.url if needed.`,
    'challenge-eventbus.ts',
    loop, sm
  ));

  // CHALLENGE 3: State Machine
  results.push(await runChallenge(
    'Finite State Machine (transitions + guards + hooks + history)',
`Use coder.write-file to create file "challenge-fsm.ts" (relative path).

Build a TypeScript generic FiniteStateMachine<S, E> class:

1. Constructor takes: initialState, transitions array [{from, to, event, guard?}]
2. send(event, payload?) — triggers transition if valid, throws if invalid
3. Guards: optional (context) => boolean function on transitions, blocks transition if false
4. Hooks: onEnter(state, cb), onExit(state, cb), onTransition(cb) — called on state changes
5. can(event) — returns boolean if event is valid from current state
6. history — array of {from, to, event, timestamp} records
7. getState() — current state
8. reset() — back to initial state, clear history
9. context — generic mutable context object passed to guards
10. Serialization: toJSON() / fromJSON(data) for state persistence

SELF-TEST with 10 tests:
1. Initial state correct 2. Valid transition 3. Invalid transition throws 4. Guard blocks when false
5. Guard allows when true 6. onEnter/onExit hooks fire 7. onTransition hook fires with details
8. History records transitions 9. Reset clears state+history 10. toJSON/fromJSON round-trip
Print PASS/FAIL per test. Print TEST PASS only if all 10 pass.

IMPORTANT: Use ESM imports. Never require() or __dirname. Keep code clean and minimal.`,
    'challenge-fsm.ts',
    loop, sm
  ));

  // FINAL SCORECARD
  console.log('\n' + '='.repeat(60));
  console.log('FINAL SCORECARD');
  console.log('='.repeat(60));
  console.log('');
  for (const r of results) {
    console.log(`${r.passed ? 'PASS' : 'FAIL'} | ${r.name} | ${r.time}ms | ${r.lines} lines | ${r.error ?? 'clean'}`);
  }
  const passCount = results.filter(r => r.passed).length;
  console.log(`\nSUDO-AI SCORE: ${passCount}/${results.length}`);

  db.close();
}
main().catch(console.error);
