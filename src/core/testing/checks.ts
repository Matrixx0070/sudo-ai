/**
 * @file checks.ts
 * @description Individual self-test check implementations for the TestHarness.
 *
 * Each exported function performs one specific health assertion.
 * Kept separate from test-harness.ts to stay under the 300-line file limit.
 * Only imported by test-harness.ts.
 */

import Database from 'better-sqlite3';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../shared/paths.js';

// ---------------------------------------------------------------------------
// Shared path constants
// ---------------------------------------------------------------------------

const ROOT       = PROJECT_ROOT;
export const DATA_DIR   = join(ROOT, 'data');
export const TOOLS_DIR  = join(ROOT, 'src/core/tools/builtin');
export const SKILLS_DIR = join(ROOT, 'src/core/tools/builtin/custom');

export const DB_PATHS: Record<string, string> = {
  mind:          join(DATA_DIR, 'mind.db'),
  knowledge:     join(DATA_DIR, 'knowledge.db'),
  consciousness: join(DATA_DIR, 'consciousness.db'),
};

export const PROVIDER_ENV_KEYS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  xai:       'XAI_API_KEY',
  google:    'GEMINI_API_KEY',
  openai:    'OPENAI_API_KEY',
  groq:      'GROQ_API_KEY',
};

// ---------------------------------------------------------------------------
// Check: tools directory
// ---------------------------------------------------------------------------

export function checkToolsDirectory(): string {
  if (!existsSync(TOOLS_DIR)) {
    throw new Error(`Tools directory not found: ${TOOLS_DIR}`);
  }
  const categories = readdirSync(TOOLS_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name);

  if (categories.length === 0) throw new Error('No tool categories found');

  const indexFiles = categories.filter(cat =>
    existsSync(join(TOOLS_DIR, cat, 'index.ts')) ||
    existsSync(join(TOOLS_DIR, cat, 'index.js'))
  );

  return `${categories.length} tool categories found, ${indexFiles.length} with index files`;
}

// ---------------------------------------------------------------------------
// Check: skills directory
// ---------------------------------------------------------------------------

export function checkSkillsDirectory(db: Database.Database): string {
  if (!existsSync(SKILLS_DIR)) {
    return 'Skills directory not found — no custom skills yet (OK)';
  }
  const skillFiles = readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter(e => e.isFile() && (e.name.endsWith('.ts') || e.name.endsWith('.js')))
    .map(e => e.name);

  let trackedCount = 0;
  try {
    const row = db.prepare('SELECT COUNT(*) as cnt FROM skills').get() as { cnt: number } | undefined;
    trackedCount = row?.cnt ?? 0;
  } catch { /* skills table may not exist */ }

  return `${skillFiles.length} skill files, ${trackedCount} tracked in DB`;
}

// ---------------------------------------------------------------------------
// Check: consciousness DB
// ---------------------------------------------------------------------------

export function checkConsciousnessDb(): string {
  const cPath = DB_PATHS['consciousness']!;
  if (!existsSync(cPath)) throw new Error('consciousness.db not found');

  const cdb = new Database(cPath, { readonly: true });
  let thoughtCount = 0;
  let recentMs: number | null = null;

  try {
    for (const tbl of ['thoughts', 'consciousness_stream', 'cognitive_stream']) {
      try {
        const row = cdb.prepare(`SELECT COUNT(*) as cnt FROM ${tbl}`).get() as { cnt: number } | undefined;
        if (row !== undefined) {
          thoughtCount = row.cnt;
          try {
            const last = cdb.prepare(
              `SELECT created_at FROM ${tbl} ORDER BY id DESC LIMIT 1`
            ).get() as { created_at: string } | undefined;
            if (last?.created_at) {
              recentMs = Date.now() - new Date(last.created_at).getTime();
            }
          } catch { /* column name may differ */ }
          break;
        }
      } catch { /* table doesn't exist, try next */ }
    }
  } finally {
    cdb.close();
  }

  if (thoughtCount === 0) return 'Consciousness DB exists but no thoughts generated yet';

  const ageStr = recentMs !== null
    ? `last thought ${Math.round(recentMs / 1000)}s ago`
    : 'age unknown';
  return `Consciousness active: ${thoughtCount} thoughts, ${ageStr}`;
}

// ---------------------------------------------------------------------------
// Check: channels (Telegram heartbeat)
// ---------------------------------------------------------------------------

export function checkChannels(): string {
  const results: string[] = [];
  const heartbeatFile = join(DATA_DIR, 'heartbeat-state.json');

  if (existsSync(heartbeatFile)) {
    try {
      const raw = readFileSync(heartbeatFile, 'utf8');
      const hb = JSON.parse(raw) as { lastPoll?: string; polling?: boolean };
      const staleMs = hb.lastPoll
        ? Date.now() - new Date(hb.lastPoll).getTime()
        : null;
      results.push(
        `Telegram: ${hb.polling ? 'polling' : 'idle'}, ` +
        `${staleMs !== null ? `last poll ${Math.round(staleMs / 1000)}s ago` : 'no timestamp'}`
      );
    } catch {
      results.push('Telegram: heartbeat file unreadable');
    }
  } else {
    results.push('Telegram: heartbeat file absent (polling not started)');
  }

  results.push('Web API: port 3000 (check via external probe)');
  return results.join(' | ');
}

// ---------------------------------------------------------------------------
// Check: system health (disk + RAM + API keys)
// ---------------------------------------------------------------------------

export async function checkSystemHealth(): Promise<string> {
  const checks: string[] = [];

  // Disk space
  try {
    const { execSync } = await import('node:child_process');
    const out = execSync(`df -h "${DATA_DIR}" 2>/dev/null | tail -1`, { encoding: 'utf8', timeout: 5000 });
    const pct = out.match(/(\d+)%/)?.[1];
    if (pct) {
      const used = parseInt(pct, 10);
      if (used > 90) throw new Error(`Disk usage critical: ${used}%`);
      checks.push(`disk ${used}% used`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('critical')) throw err;
    checks.push('disk: check skipped');
  }

  // RAM
  const os = await import('node:os');
  const usedPct = Math.round((1 - os.freemem() / os.totalmem()) * 100);
  if (usedPct > 90) throw new Error(`RAM usage critical: ${usedPct}%`);
  checks.push(`RAM ${usedPct}% used`);

  // API keys
  const keyCount = Object.values(PROVIDER_ENV_KEYS)
    .filter(k => !!process.env[k]?.trim()).length;
  checks.push(`${keyCount}/${Object.keys(PROVIDER_ENV_KEYS).length} API keys set`);

  return `Health OK: ${checks.join(', ')}`;
}
