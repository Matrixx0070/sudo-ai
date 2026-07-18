/**
 * GW-10: generate the SUDO_* flag manifest — the set of flag names the code
 * actually reads. Run in CI + commit the output; boot compares live env against
 * it and WARNs on ghosts (flags nothing reads).
 *
 * Scans src/ for `SUDO_[A-Z0-9_]+` literals. Deliberately over-includes (any
 * literal mention counts) so we never falsely flag a real flag as a ghost.
 *
 *   npx tsx scripts/gen-flag-manifest.ts          # write src/core/config/flag-manifest.json
 *   npx tsx scripts/gen-flag-manifest.ts --check   # exit 1 if the committed file is stale
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'src');
const OUT = path.join(SRC, 'core', 'config', 'flag-manifest.json');
const FLAG_RE = /SUDO_[A-Z0-9_]+/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      walk(full, out);
    } else if (/\.(ts|tsx|mts|cts|js|cjs|mjs)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function collect(): string[] {
  const flags = new Set<string>();
  for (const file of walk(SRC)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(FLAG_RE)) flags.add(m[0]);
  }
  return [...flags].sort();
}

const flags = collect();
const json = JSON.stringify({ generated: 'scripts/gen-flag-manifest.ts', count: flags.length, flags }, null, 2) + '\n';

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(OUT, 'utf8');
  } catch {
    /* missing → stale */
  }
  if (current !== json) {
    console.error('flag-manifest.json is STALE — run: npx tsx scripts/gen-flag-manifest.ts');
    process.exit(1);
  }
  console.log(`flag-manifest.json up to date (${flags.length} flags)`);
} else {
  writeFileSync(OUT, json);
  console.log(`Wrote ${OUT} (${flags.length} flags)`);
}
