/**
 * @file tests/onboard/onboard.test.ts
 * @description BO12 / scorecard-S12 — unit tests for the deterministic,
 * ZERO-SPEND `sudo-ai onboard` planner + executor. All I/O is against a TEMP
 * dir created per-test; the real workspace is never touched.
 *
 * Coverage:
 *   (a) ZERO LLM / network on the onboard path (source-graph assertion + a live
 *       run with global fetch stubbed to throw).
 *   (b) idempotent — re-running never overwrites existing files.
 *   (c) never touches frozen identity/constitution surfaces.
 *   (d) config writes are hash-audited (before/after hash + .bak + ledger line).
 *   (e) --dry-run writes nothing.
 *   (f) gateway-token generation is well-formed (48 hex).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildPlan,
  executeOnboard,
  scanMachine,
  defaultDeps,
  type OnboardOptions,
  type OnboardDeps,
} from '../../src/core/onboard/onboard.js';
import { SEED_SPECS } from '../../src/core/onboard/seeds.js';

function baseOpts(over: Partial<OnboardOptions> = {}): OnboardOptions {
  return {
    nonInteractive: true,
    acceptRisk: true,
    dryRun: false,
    skipChannels: false,
    skipHealth: false,
    json: false,
    reset: false,
    resetScope: 'config',
    ...over,
  };
}

describe('BO12 onboard — deterministic zero-spend setup', () => {
  let tmp: string;
  let deps: OnboardDeps;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bo12-onboard-'));
    deps = defaultDeps(tmp, path.join(tmp, 'data'), {} as NodeJS.ProcessEnv);
    // Deterministic token for assertions unless a test overrides.
    deps.genToken = () => 'a'.repeat(48);
    deps.now = () => '2026-07-19T00:00:00.000Z';
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // (f) gateway token
  it('(f) generates a well-formed 48-hex gateway token', () => {
    const real = defaultDeps(tmp, path.join(tmp, 'data'), {} as NodeJS.ProcessEnv);
    const token = real.genToken();
    expect(token).toMatch(/^[0-9a-f]{48}$/);
  });

  it('scan reports nothing detected on a clean temp env', () => {
    const scan = scanMachine(deps);
    expect(scan.anyCredDetected).toBe(false);
    expect(scan.gateway.tokenConfigured).toBe(false);
    expect(scan.defaultModel).toContain('no spend');
  });

  it('seeds the 7 workspace guidance files + writes the gateway token', () => {
    const res = executeOnboard(baseOpts(), deps);
    expect(res.seeded.sort()).toEqual(SEED_SPECS.map((s) => s.relPath).sort());
    for (const spec of SEED_SPECS) {
      expect(fs.existsSync(path.join(tmp, spec.relPath))).toBe(true);
    }
    const envFile = path.join(tmp, 'config/.env');
    expect(fs.existsSync(envFile)).toBe(true);
    expect(fs.readFileSync(envFile, 'utf-8')).toContain('GATEWAY_TOKEN=' + 'a'.repeat(48));
    expect(res.gatewayTokenGenerated).toBe(true);
  });

  // (b) idempotent
  it('(b) is idempotent — re-running overwrites nothing', () => {
    executeOnboard(baseOpts(), deps);
    // Mutate a seeded file; a second run must NOT clobber it.
    const soul = path.join(tmp, 'workspace/SOUL.md');
    fs.writeFileSync(soul, 'USER EDITED', 'utf-8');
    const res2 = executeOnboard(baseOpts(), deps);
    expect(res2.seeded).toEqual([]);
    expect(res2.skipped).toContain('workspace/SOUL.md');
    expect(fs.readFileSync(soul, 'utf-8')).toBe('USER EDITED');
    // Token already configured → not rewritten.
    expect(res2.records.some((r) => r.op === 'config-write')).toBe(false);
  });

  // (c) frozen surfaces
  it('(c) never creates a frozen identity/constitution surface', () => {
    executeOnboard(baseOpts(), deps);
    for (const frozen of ['config/core-identity.md', 'config/values.json', 'config/hard-prohibitions.yaml']) {
      expect(fs.existsSync(path.join(tmp, frozen))).toBe(false);
    }
    // No seed spec targets a frozen path.
    for (const spec of SEED_SPECS) expect(spec.relPath.startsWith('workspace/')).toBe(true);
  });

  it('(c) full reset never lists or removes a frozen surface', () => {
    const plan = buildPlan(baseOpts({ reset: true, resetScope: 'full' }), deps);
    expect(plan.reset).not.toBeNull();
    for (const t of plan.reset!.targets) {
      expect(t).not.toMatch(/core-identity|values\.json|hard-prohibitions/);
    }
  });

  // (d) hash-audited
  it('(d) records before/after hash + .bak + append-only ledger line', () => {
    // Pre-existing config/.env so the config-write produces a .bak + before-hash.
    fs.mkdirSync(path.join(tmp, 'config'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'config/.env'), 'FOO=bar\n', 'utf-8');

    const res = executeOnboard(baseOpts(), deps);
    // Ledger exists and has one JSONL line per record.
    const ledger = deps.auditPath;
    expect(fs.existsSync(ledger)).toBe(true);
    const lines = fs.readFileSync(ledger, 'utf-8').trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(res.records.length);
    const parsed = lines.map((l) => JSON.parse(l));
    for (const rec of parsed) {
      expect(rec.configHashBefore).toMatch(/^[0-9a-f]{64}$/);
      expect(rec.configHashAfter).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof rec.bytesBefore).toBe('number');
      expect(typeof rec.bytesAfter).toBe('number');
    }
    // The config-write had prior bytes → a .bak was written.
    const cfg = parsed.find((r) => r.op === 'config-write');
    expect(cfg.bakPath).toBe(path.join(tmp, 'config/.env') + '.bak');
    expect(fs.existsSync(cfg.bakPath)).toBe(true);
    expect(fs.readFileSync(cfg.bakPath, 'utf-8')).toBe('FOO=bar\n');
    // Preserved the prior line + appended the token.
    const envNow = fs.readFileSync(path.join(tmp, 'config/.env'), 'utf-8');
    expect(envNow).toContain('FOO=bar');
    expect(envNow).toContain('GATEWAY_TOKEN=');
  });

  // (e) dry-run
  it('(e) --dry-run writes nothing (no files, no ledger)', () => {
    const res = executeOnboard(baseOpts({ dryRun: true }), deps);
    expect(res.records).toEqual([]);
    expect(res.seeded).toEqual([]);
    for (const spec of SEED_SPECS) {
      expect(fs.existsSync(path.join(tmp, spec.relPath))).toBe(false);
    }
    expect(fs.existsSync(deps.auditPath)).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'config/.env'))).toBe(false);
  });

  it('refuses to write without --accept-risk', () => {
    expect(() => executeOnboard(baseOpts({ acceptRisk: false }), deps)).toThrow(/accept-risk/);
    // Nothing written.
    expect(fs.existsSync(path.join(tmp, 'workspace/SOUL.md'))).toBe(false);
  });

  it('does not regenerate the token when GATEWAY_TOKEN is already in env', () => {
    deps.env = { GATEWAY_TOKEN: 'preexisting' } as unknown as NodeJS.ProcessEnv;
    const res = executeOnboard(baseOpts(), deps);
    expect(res.gatewayTokenGenerated).toBe(false);
    expect(res.records.some((r) => r.op === 'config-write')).toBe(false);
  });

  // (a) zero LLM / network — live run with fetch stubbed to throw.
  it('(a) issues zero network calls (fetch stubbed to throw)', () => {
    const fetchSpy = vi.fn(() => { throw new Error('network call attempted on onboard path'); });
    const orig = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = fetchSpy;
    try {
      const res = executeOnboard(baseOpts(), deps);
      expect(res.seeded.length).toBeGreaterThan(0);
    } finally {
      (globalThis as { fetch: unknown }).fetch = orig;
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// (a) source-graph assertion: no onboard module imports the llm client.
describe('BO12 onboard — zero-LLM source invariant', () => {
  it('(a) no onboard/*.ts imports src/llm or a chat client', () => {
    const dir = path.resolve(__dirname, '../../src/core/onboard');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const src = fs.readFileSync(path.join(dir, f), 'utf-8');
      expect(src).not.toMatch(/from ['"].*\/llm/);
      expect(src).not.toMatch(/chatIR|callSingleModel|_callSingleModel/);
    }
  });
});
