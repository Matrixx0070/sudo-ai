import Database from 'better-sqlite3';
import { existsSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import os from 'node:os';

const ROOT = '/root/sudo-ai-v3';
const DATA_DIR = join(ROOT, 'data');
const TOOLS_DIR = join(ROOT, 'src/core/tools/builtin');
const SKILLS_DIR = join(ROOT, 'src/core/tools/builtin/custom');
const DB_PATH = join(DATA_DIR, 'mind.db');

const DB_PATHS = {
  mind: join(DATA_DIR, 'mind.db'),
  knowledge: join(DATA_DIR, 'knowledge.db'),
  consciousness: join(DATA_DIR, 'consciousness.db'),
};

const PROVIDER_ENV_KEYS = {
  anthropic: 'ANTHROPIC_API_KEY',
  xai: 'XAI_API_KEY',
  google: 'GEMINI_API_KEY',
  openai: 'OPENAI_API_KEY',
  groq: 'GROQ_API_KEY',
};

// Load .env if exists
const envFile = join(ROOT, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

async function runTest(name, fn) {
  const start = Date.now();
  try {
    const output = await fn();
    return { name, passed: true, duration: Date.now() - start, output };
  } catch (err) {
    return { name, passed: false, duration: Date.now() - start, error: err.message };
  }
}

// 1. Database check
const testDatabase = () => runTest('database', async () => {
  const missing = [];
  const issues = [];
  for (const [name, dbPath] of Object.entries(DB_PATHS)) {
    if (!existsSync(dbPath)) { missing.push(name); continue; }
    try {
      const d = new Database(dbPath, { readonly: true });
      d.pragma('integrity_check');
      d.close();
    } catch (err) { issues.push(`${name}: ${err.message}`); }
  }
  if (missing.length > 0) throw new Error(`Missing databases: ${missing.join(', ')}`);
  if (issues.length > 0) throw new Error(`DB issues: ${issues.join('; ')}`);
  return `All ${Object.keys(DB_PATHS).length} databases readable and healthy`;
});

// 2. Brain check
const testBrain = () => runTest('brain', async () => {
  const presentKeys = Object.entries(PROVIDER_ENV_KEYS)
    .filter(([, envKey]) => !!process.env[envKey]?.trim())
    .map(([provider]) => provider);
  if (presentKeys.length === 0) throw new Error('No LLM provider API keys configured');
  let sessionCount = 0;
  try {
    const row = db.prepare('SELECT COUNT(*) as cnt FROM sessions').get();
    sessionCount = row?.cnt ?? 0;
  } catch { throw new Error('sessions table not found in mind.db'); }
  return `Brain ready: ${presentKeys.join(', ')} configured, ${sessionCount} past sessions`;
});

// 3. Tools check
const testTools = () => runTest('tools', async () => {
  if (!existsSync(TOOLS_DIR)) throw new Error(`Tools directory not found: ${TOOLS_DIR}`);
  const categories = readdirSync(TOOLS_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory()).map(e => e.name);
  if (categories.length === 0) throw new Error('No tool categories found');
  const indexFiles = categories.filter(cat =>
    existsSync(join(TOOLS_DIR, cat, 'index.ts')) || existsSync(join(TOOLS_DIR, cat, 'index.js'))
  );
  return `${categories.length} tool categories found, ${indexFiles.length} with index files`;
});

// 4. Skills check
const testSkills = () => runTest('skills', async () => {
  if (!existsSync(SKILLS_DIR)) return 'Skills directory not found — no custom skills yet (OK)';
  const skillFiles = readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter(e => e.isFile() && (e.name.endsWith('.ts') || e.name.endsWith('.js')))
    .map(e => e.name);
  let trackedCount = 0;
  try {
    const row = db.prepare('SELECT COUNT(*) as cnt FROM skills').get();
    trackedCount = row?.cnt ?? 0;
  } catch {}
  return `${skillFiles.length} skill files, ${trackedCount} tracked in DB`;
});

// 5. Consciousness check
const testConsciousness = () => runTest('consciousness', async () => {
  const cPath = DB_PATHS.consciousness;
  if (!existsSync(cPath)) throw new Error('consciousness.db not found');
  const cdb = new Database(cPath, { readonly: true });
  let thoughtCount = 0;
  let recentMs = null;
  try {
    for (const tbl of ['thoughts', 'consciousness_stream', 'cognitive_stream']) {
      try {
        const row = cdb.prepare(`SELECT COUNT(*) as cnt FROM ${tbl}`).get();
        if (row !== undefined) {
          thoughtCount = row.cnt;
          try {
            const last = cdb.prepare(`SELECT created_at FROM ${tbl} ORDER BY id DESC LIMIT 1`).get();
            if (last?.created_at) recentMs = Date.now() - new Date(last.created_at).getTime();
          } catch {}
          break;
        }
      } catch {}
    }
  } finally { cdb.close(); }
  if (thoughtCount === 0) return 'Consciousness DB exists but no thoughts generated yet';
  const ageStr = recentMs !== null ? `last thought ${Math.round(recentMs / 1000)}s ago` : 'age unknown';
  return `Consciousness active: ${thoughtCount} thoughts, ${ageStr}`;
});

// 6. Channels check
const testChannels = () => runTest('channels', async () => {
  const results = [];
  const hbFile = join(DATA_DIR, 'heartbeat-state.json');
  if (existsSync(hbFile)) {
    try {
      const hb = JSON.parse(readFileSync(hbFile, 'utf8'));
      const staleMs = hb.lastPoll ? Date.now() - new Date(hb.lastPoll).getTime() : null;
      results.push(`Telegram: ${hb.polling ? 'polling' : 'idle'}, ${staleMs !== null ? `last poll ${Math.round(staleMs / 1000)}s ago` : 'no timestamp'}`);
    } catch { results.push('Telegram: heartbeat file unreadable'); }
  } else { results.push('Telegram: heartbeat file absent (polling not started)'); }
  results.push('Web API: port 3000 (check via external probe)');
  return results.join(' | ');
});

// 7. Memory check
const testMemory = () => runTest('memory', async () => {
  const issues = [];
  const stats = [];
  try {
    const row = db.prepare('SELECT COUNT(*) as cnt FROM messages').get();
    stats.push(`${row.cnt} messages`);
  } catch { issues.push('messages table missing'); }
  try {
    const row = db.prepare('SELECT COUNT(*) as cnt FROM chunks').get();
    stats.push(`${row.cnt} memory chunks`);
  } catch { issues.push('chunks table missing'); }
  if (existsSync(DB_PATHS.knowledge)) stats.push('knowledge.db accessible');
  else issues.push('knowledge.db missing');
  if (issues.length > 0) throw new Error(`Memory issues: ${issues.join(', ')}`);
  return `Memory OK: ${stats.join(', ')}`;
});

// 8. Health check
const testHealth = () => runTest('health', async () => {
  const checks = [];
  try {
    const out = execSync(`df -h "${DATA_DIR}" 2>/dev/null | tail -1`, { encoding: 'utf8', timeout: 5000 });
    const pct = out.match(/(\d+)%/)?.[1];
    if (pct) {
      const used = parseInt(pct, 10);
      if (used > 90) throw new Error(`Disk usage critical: ${used}%`);
      checks.push(`disk ${used}% used`);
    }
  } catch (err) {
    if (err.message?.includes('critical')) throw err;
    checks.push('disk: check skipped');
  }
  const usedPct = Math.round((1 - os.freemem() / os.totalmem()) * 100);
  if (usedPct > 90) throw new Error(`RAM usage critical: ${usedPct}%`);
  checks.push(`RAM ${usedPct}% used`);
  const keyCount = Object.values(PROVIDER_ENV_KEYS).filter(k => !!process.env[k]?.trim()).length;
  checks.push(`${keyCount}/${Object.keys(PROVIDER_ENV_KEYS).length} API keys set`);
  return `Health OK: ${checks.join(', ')}`;
});

// Run all
const start = Date.now();
const results = await Promise.allSettled([
  testDatabase(), testBrain(), testTools(), testSkills(),
  testConsciousness(), testChannels(), testMemory(), testHealth(),
]);

const tests = results.map(r => r.status === 'fulfilled' ? r.value : { name: 'unknown', passed: false, duration: 0, error: r.reason?.message });

console.log('');
console.log('═══════════════════════════════════════════════════════════');
console.log('  SUDO-AI v3 — FULL SELF-TEST REPORT');
console.log('  ' + new Date().toISOString());
console.log('═══════════════════════════════════════════════════════════');
console.log('');

let passed = 0, failed = 0;
for (const t of tests) {
  const icon = t.passed ? 'PASS' : 'FAIL';
  const detail = t.passed ? t.output : t.error;
  if (t.passed) passed++; else failed++;
  console.log(`  [${icon}] ${t.name.toUpperCase()}`);
  console.log(`         ${detail}`);
  console.log(`         ${t.duration}ms`);
  console.log('');
}

const totalMs = Date.now() - start;
console.log('═══════════════════════════════════════════════════════════');
console.log(`  RESULT: ${passed} PASSED / ${failed} FAILED / ${passed + failed} TOTAL`);
console.log(`  TIME:   ${totalMs}ms`);
console.log('═══════════════════════════════════════════════════════════');

db.close();
process.exit(failed > 0 ? 1 : 0);
