/**
 * @file tests/rewind/rewind.test.ts
 * @description Rewind — automatic file checkpoints + restore (Claude Code's
 * `/rewind`, which sudo-ai lacked). The important test is end-to-end THROUGH
 * the ToolRegistry: it proves the choke-point hook actually fires, which is the
 * whole design (one interception covers every file-mutating tool).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

import { __resetRewindStore } from '../../src/core/rewind/store.js';
import {
  snapshotBeforeTool,
  restoreCheckpoint,
  listCheckpoints,
  pathsForTool,
  rewindEnabled,
  checkpointDiffers,
} from '../../src/core/rewind/index.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(os.tmpdir(), 'rewind-test-'));
  __resetRewindStore(join(tmp, 'store'));
  delete process.env['SUDO_REWIND'];
});

afterEach(() => {
  __resetRewindStore();
  delete process.env['SUDO_REWIND'];
  rmSync(tmp, { recursive: true, force: true });
});

describe('path extraction', () => {
  it('only picks absolute paths from known mutating tools', () => {
    expect(pathsForTool('coder.write-file', { path: '/tmp/a.txt' })).toEqual(['/tmp/a.txt']);
    expect(pathsForTool('coder.write-file', { path: 'relative.txt' })).toEqual([]); // relative ignored
    expect(pathsForTool('coder.read-file', { path: '/tmp/a.txt' })).toEqual([]); // read is not mutating
    expect(pathsForTool('unknown.tool', { path: '/tmp/a.txt' })).toEqual([]);
  });
});

describe('snapshot + restore', () => {
  it('restores a modified file to its previous contents', () => {
    const f = join(tmp, 'code.ts');
    writeFileSync(f, 'ORIGINAL');

    const id = snapshotBeforeTool('coder.write-file', { path: f }, 'sess-1');
    expect(id).not.toBeNull();

    writeFileSync(f, 'MUTATED'); // the tool does its thing
    expect(readFileSync(f, 'utf8')).toBe('MUTATED');
    expect(checkpointDiffers(id!)).toBe(true);

    const r = restoreCheckpoint(id!);
    expect(r.restored).toEqual([f]);
    expect(readFileSync(f, 'utf8')).toBe('ORIGINAL');
    expect(checkpointDiffers(id!)).toBe(false);
  });

  it('undoing a file CREATE deletes the file', () => {
    const f = join(tmp, 'new.ts');
    const id = snapshotBeforeTool('coder.write-file', { path: f }, 'sess-1'); // does not exist yet
    expect(id).not.toBeNull();

    writeFileSync(f, 'created by the tool');
    expect(existsSync(f)).toBe(true);

    const r = restoreCheckpoint(id!);
    expect(r.deleted).toEqual([f]);
    expect(existsSync(f)).toBe(false);
  });

  it('lists checkpoints newest-first, scoped to the session', () => {
    const f = join(tmp, 'a.txt');
    writeFileSync(f, 'x');
    snapshotBeforeTool('coder.write-file', { path: f }, 'sess-A');
    snapshotBeforeTool('coder.edit-file', { path: f }, 'sess-A');
    snapshotBeforeTool('coder.write-file', { path: f }, 'sess-B');

    const a = listCheckpoints('sess-A');
    expect(a).toHaveLength(2);
    expect(a[0]!.id).toBeGreaterThan(a[1]!.id); // newest first
    expect(a[0]!.tool).toBe('coder.edit-file');
    expect(listCheckpoints('sess-B')).toHaveLength(1);
  });

  it('dedupes identical contents into one blob but keeps separate checkpoints', () => {
    const f = join(tmp, 'dupe.txt');
    writeFileSync(f, 'SAME');
    const id1 = snapshotBeforeTool('coder.write-file', { path: f }, 's');
    const id2 = snapshotBeforeTool('coder.write-file', { path: f }, 's');
    expect(id1).not.toBe(id2);
    // Both restore the same bytes.
    writeFileSync(f, 'changed');
    restoreCheckpoint(id2!);
    expect(readFileSync(f, 'utf8')).toBe('SAME');
  });

  it('SUDO_REWIND=0 disables snapshotting entirely', () => {
    process.env['SUDO_REWIND'] = '0';
    expect(rewindEnabled()).toBe(false);
    const f = join(tmp, 'off.txt');
    writeFileSync(f, 'x');
    expect(snapshotBeforeTool('coder.write-file', { path: f }, 's')).toBeNull();
  });

  it('is fail-open: an unreadable path never throws', () => {
    const id = snapshotBeforeTool('coder.write-file', { path: '/proc/1/mem' }, 's');
    // Either it captured nothing or recorded a null blob — but it must not throw.
    expect(id === null || typeof id === 'number').toBe(true);
  });
});

describe('end-to-end through the ToolRegistry choke point', () => {
  it('a tool call is checkpointed by the registry before the tool runs', async () => {
    const { ToolRegistry } = await import('../../src/core/tools/registry.js');

    const target = join(tmp, 'live.txt');
    writeFileSync(target, 'BEFORE');

    // A minimal tool registered under the REAL mutating-tool name: what is
    // under test is the registry hook (keyed by tool name + params), not any
    // one tool's implementation.
    const registry = new ToolRegistry();
    registry.register({
      name: 'coder.write-file',
      description: 'test double that writes a file',
      category: 'system',
      parameters: {
        path: { type: 'string', required: true, description: 'path' },
        content: { type: 'string', required: true, description: 'content' },
      },
      async execute(params: Record<string, unknown>) {
        writeFileSync(String(params['path']), String(params['content']));
        return { success: true, output: 'written' };
      },
    } as never);

    await registry.execute(
      'coder.write-file',
      { path: target, content: 'AFTER' },
      { sessionId: 'e2e-session', workingDir: tmp } as never,
    );
    expect(readFileSync(target, 'utf8')).toBe('AFTER');

    // The hook fired with no cooperation from the tool itself.
    const ckpts = listCheckpoints('e2e-session');
    expect(ckpts.length).toBeGreaterThan(0);
    expect(ckpts[0]!.tool).toBe('coder.write-file');

    restoreCheckpoint(ckpts[0]!.id);
    expect(readFileSync(target, 'utf8')).toBe('BEFORE');
  });
});
