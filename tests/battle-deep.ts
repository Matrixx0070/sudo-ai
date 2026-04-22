import { config as loadEnv } from 'dotenv';
loadEnv({ path: 'config/.env' });
import { Brain } from '../src/core/brain/index.js';
import { ToolRegistry, loadBuiltinTools } from '../src/core/tools/index.js';
import { SessionManager } from '../src/core/sessions/index.js';
import { MindDB } from '../src/core/memory/index.js';
import { AgentLoop } from '../src/core/agent/index.js';
import { existsSync, readFileSync, unlinkSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';

interface TestResult { name: string; time: number; lines: number; passed: boolean; tests: string; error?: string; }

async function runChallenge(
  name: string, prompt: string, file: string,
  loop: AgentLoop, sm: SessionManager
): Promise<TestResult> {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  CHALLENGE: ${name}`);
  console.log('='.repeat(70));

  const fullPath = `/root/sudo-ai-v3/${file}`;
  try { unlinkSync(fullPath); } catch {}

  const session = await sm.getOrCreate('electron', `deep-${Date.now()}`);
  const tools: string[] = [];
  const start = Date.now();

  await loop.run(String(session.id), prompt, (e) => {
    if (e.type === 'tool-call') { tools.push(e.name); console.log('  TOOL:', e.name); }
  });

  const elapsed = Date.now() - start;
  console.log('  Time:', elapsed + 'ms');
  console.log('  Tools:', tools.join(', '));

  if (!existsSync(fullPath)) {
    console.log('  RESULT: FAIL (no file created)');
    return { name, time: elapsed, lines: 0, passed: false, tests: '0/0', error: 'No file' };
  }

  const lines = readFileSync(fullPath, 'utf-8').split('\n').length;
  console.log('  Lines:', lines);

  try {
    const out = execSync(`timeout 20 npx tsx ${fullPath}`, {
      encoding: 'utf-8', timeout: 25000, cwd: '/root/sudo-ai-v3'
    }).trim();
    for (const l of out.split('\n')) console.log('  >', l);
    const passed = out.includes('TEST PASS');
    const testMatch = out.match(/(\d+)\/(\d+)/);
    const tests = testMatch ? testMatch[0] : passed ? 'ALL' : '?/?';
    console.log(`  RESULT: ${passed ? 'PASS' : 'FAIL'}`);
    return { name, time: elapsed, lines, passed, tests };
  } catch (err: any) {
    const msg = ((err.stdout ?? '') + (err.stderr ?? '')).split('\n').filter((l: string) => l.trim()).slice(0, 8);
    for (const l of msg) console.log('  >', l);
    console.log('  RESULT: FAIL (runtime error)');
    return { name, time: elapsed, lines, passed: false, tests: '0/0', error: msg[0]?.substring(0, 100) };
  }
}

async function main() {
  const db = new MindDB('data/battle-deep.db');
  const brain = new Brain({});
  const registry = new ToolRegistry();
  await loadBuiltinTools(registry, 'src/core/tools/builtin');
  const sm = new SessionManager(db);
  const loop = new AgentLoop(brain, registry, sm, { maxIterations: 15 });
  console.log(`SUDO-AI v3 loaded | Model: grok-4.20-reasoning | Tools: ${registry.size}`);

  // Kill any leftover test servers
  try { execSync('fuser -k 39880/tcp 39881/tcp 39882/tcp 2>/dev/null'); } catch {}

  const results: TestResult[] = [];

  // ═══════════════════════════════════════════════════════════════════
  // CHALLENGE 1: In-memory database with indexing, queries, and joins
  // ═══════════════════════════════════════════════════════════════════
  results.push(await runChallenge(
    '1. In-Memory Database (indexes, queries, joins)',
`Use coder.write-file to create "deep-test-db.ts".

Build an in-memory database engine in TypeScript. Requirements:

1. Database class with createTable(name, columns: {name, type: 'string'|'number'|'boolean'}[])
2. Insert rows: insert(table, row)
3. Select with conditions: select(table, where?: Record<string, unknown>) — returns matching rows
4. Update: update(table, where, set) — updates matching rows, returns count
5. Delete: delete(table, where) — deletes matching rows, returns count
6. Indexes: createIndex(table, column) — speeds up where queries on that column
7. Join: join(table1, table2, on: {left: string, right: string}) — inner join
8. Aggregation: aggregate(table, column, fn: 'count'|'sum'|'avg'|'min'|'max', where?)
9. Order by: select with orderBy option {column, direction: 'asc'|'desc'}
10. Unique constraints: createTable supports unique columns, insert throws on duplicate

Self-test with 12 tests:
1. Create table 2. Insert rows 3. Select all 4. Select with where 5. Update rows
6. Delete rows 7. Create index + fast lookup 8. Inner join 9. Aggregate sum
10. Aggregate avg 11. Order by 12. Unique constraint violation throws
Print PASS/FAIL per test. Print "TEST PASS: 12/12" if all pass. Call process.exit(0).
ESM only. No external deps.`,
    'deep-test-db.ts', loop, sm
  ));

  // ═══════════════════════════════════════════════════════════════════
  // CHALLENGE 2: HTTP Router with middleware, params, guards, and rate limiting
  // ═══════════════════════════════════════════════════════════════════
  results.push(await runChallenge(
    '2. HTTP Router (middleware, params, guards, rate limit)',
`Use coder.write-file to create "deep-test-router.ts".

Build a complete HTTP router framework in TypeScript using http.createServer. Requirements:

1. Router class with: get(path, ...handlers), post(path, ...handlers), put(path, ...handlers), delete(path, ...handlers)
2. Path parameters: /users/:id extracts {id: "123"} from /users/123
3. Middleware: use(fn) — runs before route handlers. fn(req, res, next)
4. Route-level middleware: get('/admin', authMiddleware, handler)
5. Request body parsing: auto-parse JSON body for POST/PUT
6. Response helpers: res.json(data, status?), res.text(str, status?)
7. 404 handler for unmatched routes
8. Error handler: catches thrown errors, returns 500 with message
9. Route groups: group(prefix, (router) => { router.get(...) }) — e.g. group('/api', ...)
10. Rate limiting middleware: rateLimit({windowMs, max}) — returns 429 when exceeded

Self-test on port 39880 using fetch():
1. GET / returns 200 2. GET /users/:id extracts param 3. POST /data parses JSON body
4. Middleware runs in order 5. 404 on unknown route 6. Error handler catches throw
7. Route group /api/health works 8. Rate limit returns 429 after max requests
9. PUT with body 10. DELETE works
Print PASS/FAIL per test. Print "TEST PASS: 10/10". server.close() + process.exit(0).
ESM only. Use fetch(). Email regex: /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/`,
    'deep-test-router.ts', loop, sm
  ));

  // ═══════════════════════════════════════════════════════════════════
  // CHALLENGE 3: Reactive store with computed values, middleware, undo/redo
  // ═══════════════════════════════════════════════════════════════════
  results.push(await runChallenge(
    '3. Reactive Store (computed, middleware, undo/redo, subscriptions)',
`Use coder.write-file to create "deep-test-store.ts".

Build a reactive state management store (like Redux + MobX hybrid). Requirements:

1. Store<S> class with generic state type. Constructor takes initial state.
2. getState(): returns current state (readonly copy)
3. setState(partial): merge partial state, notify subscribers
4. subscribe(selector, callback): call callback when selected value changes. Returns unsubscribe fn.
5. Computed values: computed(name, deps: string[], fn: (state) => value) — cached, recalculates when deps change
6. Middleware: use(fn) — fn(action, state, next) intercepts every setState
7. Actions: dispatch(name, payload) — named actions that go through middleware
8. Undo/redo: undo() restores previous state, redo() re-applies. History stack of max 50 entries.
9. Batch updates: batch(fn) — groups multiple setState calls, notifies subscribers only once at the end
10. Persistence: persist(key) — saves to a Map (simulating localStorage), loads on construct
11. Reset: reset() — back to initial state

Self-test with 12 tests:
1. Initial state 2. setState merges 3. Subscribe fires on change 4. Subscribe doesn't fire if value unchanged
5. Computed value calculates 6. Computed caches (doesn't recalculate if deps unchanged)
7. Middleware intercepts 8. Undo restores previous 9. Redo re-applies
10. Batch fires subscriber only once 11. Persist saves and loads 12. Reset to initial
Print PASS/FAIL per test. Print "TEST PASS: 12/12". process.exit(0).
ESM only. No deps.`,
    'deep-test-store.ts', loop, sm
  ));

  // ═══════════════════════════════════════════════════════════════════
  // CHALLENGE 4: Task scheduler with DAG dependencies, parallel execution
  // ═══════════════════════════════════════════════════════════════════
  results.push(await runChallenge(
    '4. DAG Task Scheduler (dependencies, parallel, retry, cancel)',
`Use coder.write-file to create "deep-test-dag.ts".

Build a DAG-based task scheduler. Requirements:

1. Scheduler class. addTask(id, fn, opts?: {depends?: string[], retries?, timeout?})
2. Dependency resolution: tasks run only after their dependencies complete
3. Parallel execution: independent tasks run concurrently (configurable concurrency limit)
4. Topological sort: detect circular dependencies and throw
5. Retry on failure: up to N retries with backoff
6. Timeout: cancel task if it exceeds timeout
7. Cancel: cancel(taskId) — cancels a pending/running task
8. Status: getStatus() — returns map of taskId -> {status, result?, error?, duration?}
9. Events: onComplete(taskId, cb), onError(taskId, cb)
10. run() — executes all tasks respecting dependencies, returns results map

Self-test with 10 tests:
1. Single task runs 2. Sequential deps (A->B->C) 3. Parallel independent tasks
4. Diamond dependency (A->B,C->D where D depends on B and C)
5. Circular dependency throws 6. Task timeout 7. Retry on failure
8. Cancel pending task 9. Status tracking 10. Full DAG execution
Print PASS/FAIL per test. Print "TEST PASS: 10/10". process.exit(0).
ESM only. No deps. Use Promise.race for timeout.`,
    'deep-test-dag.ts', loop, sm
  ));

  // ═══════════════════════════════════════════════════════════════════
  // CHALLENGE 5: JSON Schema validator with refs, patterns, custom errors
  // ═══════════════════════════════════════════════════════════════════
  results.push(await runChallenge(
    '5. JSON Schema Validator (types, patterns, nested, refs, errors)',
`Use coder.write-file to create "deep-test-validator.ts".

Build a JSON Schema validator. Requirements:

1. validate(data, schema): returns {valid: boolean, errors: ValidationError[]}
2. Type validation: string, number, boolean, array, object, null
3. String constraints: minLength, maxLength, pattern (regex), enum
4. Number constraints: minimum, maximum, multipleOf
5. Array constraints: minItems, maxItems, items (validates each element)
6. Object constraints: required fields, properties (recursive validation), additionalProperties
7. Nested validation: objects within objects, arrays of objects
8. $ref support: definitions section with $ref pointers (e.g. {"$ref": "#/definitions/Address"})
9. Custom error messages: each constraint can have a "message" override
10. oneOf/anyOf: validate against one or any of multiple schemas

Self-test with 12 tests:
1. Valid string 2. String too short 3. Number out of range 4. Required field missing
5. Pattern mismatch 6. Array items validation 7. Nested object validation
8. $ref resolution 9. Enum validation 10. additionalProperties false
11. oneOf validation 12. Custom error message
Print PASS/FAIL per test. Print "TEST PASS: 12/12". process.exit(0).
ESM only. No deps.`,
    'deep-test-validator.ts', loop, sm
  ));

  // ═══════════════════════════════════════════════════════════════════
  // FINAL SCORECARD
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(70));
  console.log('  DEEP BATTLE TEST — FINAL SCORECARD');
  console.log('='.repeat(70));
  console.log('');
  console.log('  # | Challenge                          | Time   | Lines | Tests  | Result');
  console.log('  --+--------------------------------------+--------+-------+--------+-------');
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const name = r.name.padEnd(36).substring(0, 36);
    const time = `${(r.time / 1000).toFixed(1)}s`.padStart(6);
    const lines = String(r.lines).padStart(5);
    const tests = r.tests.padStart(6);
    const result = r.passed ? 'PASS' : 'FAIL';
    console.log(`  ${i + 1} | ${name} | ${time} | ${lines} | ${tests} | ${result}`);
  }

  const passCount = results.filter(r => r.passed).length;
  const totalTime = results.reduce((s, r) => s + r.time, 0);
  const totalLines = results.reduce((s, r) => s + r.lines, 0);
  console.log('  --+--------------------------------------+--------+-------+--------+-------');
  console.log(`     TOTAL: ${passCount}/${results.length} PASS | ${(totalTime / 1000).toFixed(0)}s | ${totalLines} lines`);
  console.log('');

  if (passCount === results.length) {
    console.log('  *** SUDO-AI v3 PERFECT SCORE — ALL CHALLENGES PASSED ***');
  } else {
    const failed = results.filter(r => !r.passed).map(r => r.name);
    console.log('  Failed:', failed.join(', '));
  }
  console.log('='.repeat(70));

  db.close();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
