import { config as loadEnv } from 'dotenv';
loadEnv({ path: 'config/.env' });
import { Brain } from '../src/core/brain/index.js';
import { ToolRegistry, loadBuiltinTools } from '../src/core/tools/index.js';
import { SessionManager } from '../src/core/sessions/index.js';
import { MindDB } from '../src/core/memory/index.js';
import { AgentLoop } from '../src/core/agent/index.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';

interface TestResult { name: string; time: number; toolCalls: string[]; passed: boolean; detail: string; }

async function runElite(
  name: string, prompt: string, verify: () => { passed: boolean; detail: string },
  loop: AgentLoop, sm: SessionManager
): Promise<TestResult> {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  ELITE CHALLENGE: ${name}`);
  console.log('='.repeat(70));

  const session = await sm.getOrCreate('electron', `elite-${Date.now()}`);
  const toolCalls: string[] = [];
  const start = Date.now();

  await loop.run(String(session.id), prompt, (e) => {
    if (e.type === 'tool-call') { toolCalls.push(e.name); console.log('  TOOL:', e.name); }
  });

  const elapsed = Date.now() - start;
  console.log('  Time:', elapsed + 'ms');
  console.log('  Tool calls:', toolCalls.length, '(' + [...new Set(toolCalls)].join(', ') + ')');

  const { passed, detail } = verify();
  console.log('  Detail:', detail);
  console.log(`  RESULT: ${passed ? 'PASS' : 'FAIL'}`);
  return { name, time: elapsed, toolCalls, passed, detail };
}

async function main() {
  const db = new MindDB('data/battle-elite.db');
  const brain = new Brain({});
  const registry = new ToolRegistry();
  await loadBuiltinTools(registry, 'src/core/tools/builtin');
  const sm = new SessionManager(db);
  const loop = new AgentLoop(brain, registry, sm, { maxIterations: 25 });
  console.log(`SUDO-AI v3 | Model: grok-4.20-reasoning | Tools: ${registry.size}`);

  // Kill any leftover test servers
  try { execSync('fuser -k 39885/tcp 39886/tcp 39887/tcp 2>/dev/null'); } catch {}

  const results: TestResult[] = [];

  // ═══════════════════════════════════════════════════════════════════
  // ELITE 1: Read existing code, find a bug, fix it
  // Create a buggy file, ask SUDO-AI to find and fix the bug
  // ═══════════════════════════════════════════════════════════════════
  mkdirSync('/root/sudo-ai-v3/elite-test', { recursive: true });
  writeFileSync('/root/sudo-ai-v3/elite-test/buggy-server.ts', `
import { createServer } from 'http';

interface User { id: number; name: string; email: string; }
const users: User[] = [];
let nextId = 1;

const server = createServer(async (req, res) => {
  const url = new URL(req.url!, \`http://\${req.headers.host}\`);

  if (req.method === 'GET' && url.pathname === '/users') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(users));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/users') {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      // BUG 1: doesn't validate email format
      // BUG 2: doesn't check for duplicate email
      // BUG 3: id is never incremented
      const user: User = { id: nextId, name: body.name, email: body.email };
      users.push(user);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(user));
    });
    return;
  }

  if (req.method === 'DELETE' && url.pathname.startsWith('/users/')) {
    const id = parseInt(url.pathname.split('/')[2]);
    // BUG 4: uses = instead of === for comparison
    const idx = users.findIndex(u => u.id = id);
    if (idx === -1) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    users.splice(idx, 1);
    res.writeHead(200);
    res.end('Deleted');
    return;
  }

  // BUG 5: missing Content-Type header on 404
  res.writeHead(404);
  res.end('Not found');
});

server.listen(39885);
console.log('Server running on 39885');
`);

  results.push(await runElite(
    '1. Bug Finder + Fixer (5 bugs in existing code)',
    `There is a buggy TypeScript server at elite-test/buggy-server.ts. Use coder.read-file to read it, find ALL bugs, then use coder.edit-file to fix each one. The file has exactly 5 bugs:
1. No email validation on POST /users
2. No duplicate email check on POST /users
3. nextId is never incremented after creating a user
4. DELETE uses = instead of === in findIndex (assignment not comparison)
5. 404 response missing Content-Type header

Fix all 5 bugs using coder.edit-file (surgical edits, not full rewrite). After fixing, use coder.read-file to verify the fixes are applied.`,
    () => {
      const content = readFileSync('/root/sudo-ai-v3/elite-test/buggy-server.ts', 'utf-8');
      const fixes = {
        emailValidation: content.includes('@') && (content.includes('regex') || content.includes('match') || content.includes('includes') || content.includes('test')),
        duplicateCheck: content.includes('find') && (content.includes('duplicate') || content.includes('already') || content.includes('exists') || content.includes('some')),
        idIncrement: content.includes('nextId++') || content.includes('nextId +=') || content.includes('++nextId'),
        comparisonFix: content.includes('u.id === id') || content.includes('u.id==id'),
        contentType: content.match(/404[\s\S]*Content-Type/m) || content.includes("'Content-Type': 'application/json'") && content.split('404').length > 2,
      };
      const fixCount = Object.values(fixes).filter(Boolean).length;
      return {
        passed: fixCount >= 4,
        detail: `${fixCount}/5 bugs fixed: ${Object.entries(fixes).map(([k, v]) => `${k}:${v ? 'OK' : 'MISS'}`).join(', ')}`,
      };
    },
    loop, sm
  ));

  // ═══════════════════════════════════════════════════════════════════
  // ELITE 2: Analyze a codebase and generate a report
  // ═══════════════════════════════════════════════════════════════════
  results.push(await runElite(
    '2. Codebase Analyzer (read multiple files, generate report)',
    `Analyze the SUDO-AI v3 codebase. Use coder.glob to find all TypeScript files in src/core/brain/, then use coder.read-file to read each one. Generate a markdown report and save it to "elite-test/brain-analysis.md" using coder.write-file.

The report must include:
1. File list with line counts
2. All exported classes and functions (with brief descriptions)
3. Dependencies (what external packages each file imports)
4. Architecture diagram in ASCII art showing how the files connect
5. Potential improvements or issues you notice

Use the tools: coder.glob, coder.read-file (multiple times), coder.write-file.`,
    () => {
      const reportPath = '/root/sudo-ai-v3/elite-test/brain-analysis.md';
      if (!existsSync(reportPath)) return { passed: false, detail: 'Report not created' };
      const report = readFileSync(reportPath, 'utf-8');
      const checks = {
        hasFileList: report.includes('brain.ts') && report.includes('providers.ts'),
        hasExports: report.includes('Brain') && (report.includes('export') || report.includes('class')),
        hasDeps: report.includes('ai') || report.includes('vercel') || report.includes('import'),
        hasDiagram: report.includes('─') || report.includes('|') || report.includes('→') || report.includes('->'),
        hasImprovements: report.includes('improv') || report.includes('issue') || report.includes('suggest') || report.includes('could') || report.includes('recommend'),
        length: report.length > 500,
      };
      const score = Object.values(checks).filter(Boolean).length;
      return {
        passed: score >= 4,
        detail: `Report ${report.length} chars, ${score}/6 sections: ${Object.entries(checks).map(([k, v]) => `${k}:${v ? 'OK' : 'MISS'}`).join(', ')}`,
      };
    },
    loop, sm
  ));

  // ═══════════════════════════════════════════════════════════════════
  // ELITE 3: Multi-step system admin task
  // ═══════════════════════════════════════════════════════════════════
  results.push(await runElite(
    '3. System Admin (check disk, processes, ports, generate report)',
    `Perform a system health audit using the system tools. Do ALL of these steps:

1. Use system.monitor with operation "snapshot" to get CPU/memory/disk stats
2. Use system.process with operation "list" to find the top 5 processes by memory
3. Use system.network with operation "ports" to list open ports
4. Use system.disk with operation "usage" to check disk space

Then write a markdown health report to "elite-test/system-health.md" using coder.write-file with:
- CPU usage percentage
- Memory used/total
- Disk usage percentage
- Top 5 processes by memory
- Open ports list
- Overall health verdict (HEALTHY/WARNING/CRITICAL based on thresholds: >90% CPU or >95% memory or >90% disk = CRITICAL)

Use the tools. Do not guess system stats.`,
    () => {
      const reportPath = '/root/sudo-ai-v3/elite-test/system-health.md';
      if (!existsSync(reportPath)) return { passed: false, detail: 'Report not created' };
      const report = readFileSync(reportPath, 'utf-8');
      const checks = {
        hasCPU: /cpu|CPU/i.test(report) && /\d+/.test(report),
        hasMemory: /mem|RAM/i.test(report) && /\d+/.test(report),
        hasDisk: /disk|storage/i.test(report) && /\d+/.test(report),
        hasProcesses: /process|PID|pid/i.test(report),
        hasPorts: /port|listen/i.test(report),
        hasVerdict: /HEALTHY|WARNING|CRITICAL/i.test(report),
        length: report.length > 200,
      };
      const score = Object.values(checks).filter(Boolean).length;
      return {
        passed: score >= 5,
        detail: `Report ${report.length} chars, ${score}/7: ${Object.entries(checks).map(([k, v]) => `${k}:${v ? 'OK' : 'MISS'}`).join(', ')}`,
      };
    },
    loop, sm
  ));

  // ═══════════════════════════════════════════════════════════════════
  // ELITE 4: Read, understand, extend existing code
  // ═══════════════════════════════════════════════════════════════════
  writeFileSync('/root/sudo-ai-v3/elite-test/calculator.ts', `
export class Calculator {
  private history: Array<{ op: string; a: number; b: number; result: number }> = [];

  add(a: number, b: number): number {
    const result = a + b;
    this.history.push({ op: 'add', a, b, result });
    return result;
  }

  subtract(a: number, b: number): number {
    const result = a - b;
    this.history.push({ op: 'subtract', a, b, result });
    return result;
  }

  multiply(a: number, b: number): number {
    const result = a * b;
    this.history.push({ op: 'multiply', a, b, result });
    return result;
  }

  getHistory() { return [...this.history]; }
  clearHistory() { this.history = []; }
}
`);

  results.push(await runElite(
    '4. Extend Existing Code (read, understand, add features)',
    `There is a Calculator class at elite-test/calculator.ts. Use coder.read-file to understand it, then use coder.edit-file to ADD these features WITHOUT breaking existing ones:

1. Add divide(a, b) method — throws Error("Division by zero") if b is 0
2. Add power(a, b) method — a raised to power b
3. Add sqrt(a) method — throws Error("Cannot sqrt negative") if a < 0
4. Add modulo(a, b) method — throws Error("Division by zero") if b is 0
5. Add undo() method — removes last operation from history and returns it
6. Add replay() method — re-executes all operations in history and returns results array

After editing, create elite-test/calculator-test.ts using coder.write-file with tests:
1. divide works 2. divide by zero throws 3. power works 4. sqrt works 5. sqrt negative throws
6. modulo works 7. undo removes last 8. replay re-executes 9. history still tracks all ops
10. Original add/subtract/multiply still work
Print TEST PASS if 10/10. process.exit(0).`,
    () => {
      // Check the calculator was extended
      const calcPath = '/root/sudo-ai-v3/elite-test/calculator.ts';
      const testPath = '/root/sudo-ai-v3/elite-test/calculator-test.ts';
      if (!existsSync(calcPath)) return { passed: false, detail: 'Calculator not found' };
      if (!existsSync(testPath)) return { passed: false, detail: 'Test file not created' };

      const calc = readFileSync(calcPath, 'utf-8');
      const features = {
        divide: calc.includes('divide'),
        power: calc.includes('power'),
        sqrt: calc.includes('sqrt'),
        modulo: calc.includes('modulo'),
        undo: calc.includes('undo'),
        replay: calc.includes('replay'),
        originalIntact: calc.includes('add') && calc.includes('subtract') && calc.includes('multiply'),
      };
      const featureCount = Object.values(features).filter(Boolean).length;

      // Try running the test
      let testResult = 'not run';
      try {
        const out = execSync(`timeout 10 npx tsx ${testPath}`, { encoding: 'utf-8', timeout: 15000, cwd: '/root/sudo-ai-v3' });
        testResult = out.includes('TEST PASS') ? 'TEST PASS' : 'TEST FAIL';
      } catch (e: any) {
        testResult = 'ERROR: ' + (e.stderr ?? e.message)?.substring(0, 100);
      }

      return {
        passed: featureCount >= 6 && testResult === 'TEST PASS',
        detail: `Features: ${featureCount}/7 (${Object.entries(features).map(([k, v]) => `${k}:${v ? 'OK' : 'MISS'}`).join(', ')}). Test: ${testResult}`,
      };
    },
    loop, sm
  ));

  // ═══════════════════════════════════════════════════════════════════
  // ELITE 5: Multi-file project from scratch with imports between files
  // ═══════════════════════════════════════════════════════════════════
  results.push(await runElite(
    '5. Multi-File Project (3 files that import each other)',
    `Create a mini project with 3 TypeScript files that work together. Use coder.write-file for EACH file:

File 1: "elite-test/models.ts"
- Export interfaces: Product {id, name, price, stock}, CartItem {product: Product, quantity: number}, Order {id, items: CartItem[], total: number, status: 'pending'|'paid'|'shipped'}

File 2: "elite-test/cart.ts"
- Import Product, CartItem from "./models.js"
- Export class ShoppingCart with: addItem(product, qty), removeItem(productId), getItems(), getTotal(), clear(), itemCount()
- Validate: can't add more than available stock, quantity must be > 0

File 3: "elite-test/shop-test.ts"
- Import Product from "./models.js"
- Import ShoppingCart from "./cart.js"
- Create products, test cart operations:
  1. Add item 2. Get total is correct 3. Add multiple items 4. Remove item 5. Can't exceed stock
  6. Item count correct 7. Clear empties cart 8. Quantity must be positive
- Print TEST PASS if 8/8. process.exit(0).

IMPORTANT: Use ".js" extension in imports (ESM). Call coder.write-file 3 times, once per file.`,
    () => {
      const files = ['elite-test/models.ts', 'elite-test/cart.ts', 'elite-test/shop-test.ts'];
      const existing = files.filter(f => existsSync(`/root/sudo-ai-v3/${f}`));
      if (existing.length < 3) return { passed: false, detail: `Only ${existing.length}/3 files created` };

      try {
        const out = execSync('timeout 10 npx tsx elite-test/shop-test.ts', {
          encoding: 'utf-8', timeout: 15000, cwd: '/root/sudo-ai-v3'
        });
        const passed = out.includes('TEST PASS');
        return { passed, detail: passed ? 'All 3 files work together' : 'Tests failed: ' + out.split('\n').slice(-3).join(' ') };
      } catch (e: any) {
        return { passed: false, detail: 'ERROR: ' + (e.stderr ?? e.message)?.substring(0, 150) };
      }
    },
    loop, sm
  ));

  // ═══════════════════════════════════════════════════════════════════
  // FINAL SCORECARD
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(70));
  console.log('  ELITE BATTLE TEST — FINAL SCORECARD');
  console.log('='.repeat(70));
  console.log('');
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const toolTypes = [...new Set(r.toolCalls)].join('+');
    console.log(`  ${r.passed ? 'PASS' : 'FAIL'} | ${r.name}`);
    console.log(`       ${(r.time / 1000).toFixed(1)}s | ${r.toolCalls.length} tool calls (${toolTypes})`);
    console.log(`       ${r.detail}`);
    console.log('');
  }

  const passCount = results.filter(r => r.passed).length;
  console.log('='.repeat(70));
  console.log(`  SUDO-AI ELITE SCORE: ${passCount}/${results.length}`);
  if (passCount === results.length) {
    console.log('  *** PERFECT SCORE — SUDO-AI MATCHES CLAUDE CODE CAPABILITIES ***');
  }
  console.log('='.repeat(70));

  db.close();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
