/**
 * @file grok-extraction-boundary.test.ts
 * @description Enforces the Grok-seat extraction boundary
 * (docs/GROK_SDK_EXTRACTION_PLAN.md step 1). Mirrors the gdrive hot-path
 * isolation test: an architectural invariant is only real if a test fails when
 * someone breaks it.
 *
 * INVARIANT: every `src/llm/grok-*.ts` reaches host services (logging, storage
 * paths, atomic writes) through `grok-runtime.ts` and nowhere else.
 *
 * Why it matters: these modules are destined for a standalone npm package. Each
 * direct `../core/**` import is one more thing to rewrite at extraction time, and
 * they accumulate invisibly — there were 49 such imports across 30 files before
 * the seam existed. With this test, extraction cost stays "reimplement one file"
 * instead of "audit thirty".
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const LLM_DIR = path.join(process.cwd(), 'src', 'llm');

/** The seam itself — the ONE file allowed to import sudo-ai internals. */
const SEAM = 'grok-runtime.ts';

/**
 * Known, DOCUMENTED exceptions: browser stealth for the cookie lane. These are
 * Lane-B-only (see the extraction plan §4) and whether they travel at all is part
 * of the unresolved scope decision — so they are recorded here rather than
 * silently tolerated. Shrinking this list is progress; growing it needs a reason.
 */
const ALLOWED_CORE_IMPORTERS = new Set([
  'grok-web-capture.ts',
  'grok-warm-browser.ts',
  'grok-statsig-oracle.ts',
]);

function grokSources(): string[] {
  return readdirSync(LLM_DIR).filter(
    (f) => f.startsWith('grok-') && f.endsWith('.ts') && !f.endsWith('.test.ts'),
  );
}

/** Every `from '../core/...'` specifier in a file. */
function coreImports(file: string): string[] {
  const src = readFileSync(path.join(LLM_DIR, file), 'utf8');
  return [...src.matchAll(/from '(\.\.\/core\/[^']+)'/g)].map((m) => m[1]!);
}

describe('grok extraction boundary', () => {
  it('has grok modules to check (guards against a vacuous pass)', () => {
    expect(grokSources().length).toBeGreaterThan(20);
  });

  it('no grok module imports sudo-ai internals except through the seam', () => {
    const offenders = grokSources()
      .filter((f) => f !== SEAM && !ALLOWED_CORE_IMPORTERS.has(f))
      .map((f) => ({ file: f, imports: coreImports(f) }))
      .filter((r) => r.imports.length > 0);

    // Named so a failure tells you exactly which file and which import to move.
    expect(
      offenders.map((o) => `${o.file} -> ${o.imports.join(', ')}`),
      'import host services from ./grok-runtime.js, or add the dependency to the seam',
    ).toEqual([]);
  });

  it('the documented exceptions are only the browser-stealth trio', () => {
    // If one of these stops importing core, tighten the list — do not leave it
    // stale, or the boundary silently permits more than it should.
    for (const f of ALLOWED_CORE_IMPORTERS) {
      expect(grokSources(), `${f} is listed as an exception but no longer exists`).toContain(f);
      expect(coreImports(f).length, `${f} no longer imports core — remove it from the allowlist`)
        .toBeGreaterThan(0);
    }
  });

  it('the seam exposes exactly the host services the modules need', () => {
    const seam = readFileSync(path.join(LLM_DIR, SEAM), 'utf8');
    for (const sym of ['createLogger', 'writeFileAtomic', 'DATA_DIR', 'PROJECT_ROOT']) {
      expect(seam).toContain(sym);
    }
  });
});
