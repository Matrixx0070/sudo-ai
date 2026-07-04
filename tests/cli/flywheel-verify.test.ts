/**
 * flywheel-verify CLI command — the gated live-A/B entry point. Exercises the DRY
 * path (free: guard-only accounting, no LLM) and error paths against a synthetic
 * traces.db. The live path (real tokens) is verified end-to-end by hand, not here.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

let tmp: string;
let runFlywheelVerify: (opts: { tool?: string; max?: string; confirm?: boolean; json?: boolean }) => Promise<number>;

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'flywheel-cli-'));
  const db = new Database(path.join(tmp, 'traces.db'));
  db.exec('CREATE TABLE traces (tool_name TEXT, success INTEGER, args_raw TEXT)');
  const ins = db.prepare('INSERT INTO traces (tool_name, success, args_raw) VALUES (?,?,?)');
  ins.run('system.exec', 0, JSON.stringify({ command: 'grep foo | cat', target: 'repo' })); // genuine refusal
  ins.run('system.exec', 0, JSON.stringify({ command: 'pm2 restart x', target: 'repo' }));   // genuine refusal
  ins.run('system.exec', 0, JSON.stringify({ command: 'rg ok', target: 'repo' }));            // already-ok
  ins.run('system.exec', 0, JSON.stringify({ command: 'rg ok' }));                            // out of scope
  ins.run('system.exec', 1, JSON.stringify({ command: 'rg ok', target: 'repo' }));            // success — ignored
  db.close();
  // DATA_DIR is read at module-import time in paths.js — set it BEFORE the dynamic import.
  process.env['DATA_DIR'] = tmp;
  delete process.env['SUDO_FLYWHEEL_LIVE_AB']; // ensure dry unless --confirm
  ({ runFlywheelVerify } = await import('../../src/cli/commands/flywheel-verify.js'));
});

afterAll(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('runFlywheelVerify (dry, no tokens)', () => {
  it('JSON dry run: guard-only accounting, no adoption', async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((m?: unknown) => { logs.push(String(m)); });
    const code = await runFlywheelVerify({ json: true });
    spy.mockRestore();
    expect(code).toBe(0);
    const out = JSON.parse(logs.join('\n')) as {
      live: boolean; applicable: number; alreadyOk: number; recovered: number; decision: string;
    };
    expect(out.live).toBe(false);
    expect(out.applicable).toBe(3);   // 3 repo-target failing rows (success=1 & no-target excluded)
    expect(out.alreadyOk).toBe(1);    // rg ok
    expect(out.recovered).toBe(0);    // dry: null rewrite recovers nothing
    expect(out.decision).toBe('insufficient-data'); // 2 genuine < 20 floor
  });

  it('unknown tool → exit 2', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const code = await runFlywheelVerify({ tool: 'does.not.exist' });
    spy.mockRestore();
    expect(code).toBe(2);
  });
});
