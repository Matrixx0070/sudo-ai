/**
 * @file tests/beat-openclaw/guidance-io.test.ts
 * @description BO10 / S10 — unit tests for the fs + hash-audit guidance writer,
 * exercised against a TEMP root (never the real workspace). Asserts:
 *  - a non-frozen write is hash-audited: before/after sha256 recorded, .bak
 *    written with prior bytes, ledger line appended;
 *  - a round-trip read returns the written content + matching sha256;
 *  - a FROZEN write is REJECTED (throws) even though the writer is called directly;
 *  - a path-escape is rejected by the path guard.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  readGuidance,
  writeGuidanceAudited,
  resolveWithinRoot,
  sha256,
} from '../../src/core/api/admin/guidance-io.js';
import {
  GUIDANCE_CATALOG,
  type GuidanceFileSpec,
} from '../../src/core/workspace/guidance-registry.js';

function specFor(name: string): GuidanceFileSpec {
  const s = GUIDANCE_CATALOG.find((x) => x.name === name);
  if (!s) throw new Error(`no spec ${name}`);
  return s;
}

let root: string;
let auditPath: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bo10-guidance-'));
  auditPath = path.join(root, 'audit', 'guidance-audit.jsonl');
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('guidance-io — audited write of a non-frozen file', () => {
  it('records before/after hash, writes .bak, appends the ledger, round-trips', () => {
    const soul = specFor('SOUL');
    // Seed an existing file so a .bak is exercised.
    const before = '# SOUL v1\n';
    const abs = path.join(root, soul.relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, before);

    const next = '# SOUL v2\nkinder, sharper.\n';
    const audit = writeGuidanceAudited({ spec: soul, content: next, rootDir: root, auditPath });

    // Hash audit before/after.
    expect(audit.ok).toBe(true);
    expect(audit.configHashBefore).toBe(createHash('sha256').update(before).digest('hex'));
    expect(audit.configHashAfter).toBe(createHash('sha256').update(next).digest('hex'));
    expect(audit.configHashBefore).not.toBe(audit.configHashAfter);

    // .bak preserved the prior bytes.
    expect(audit.bakPath).toBe(abs + '.bak');
    expect(fs.readFileSync(abs + '.bak', 'utf-8')).toBe(before);

    // New bytes landed.
    expect(fs.readFileSync(abs, 'utf-8')).toBe(next);

    // Ledger line appended with the hashes.
    const ledger = fs.readFileSync(auditPath, 'utf-8').trim().split('\n');
    expect(ledger.length).toBe(1);
    const rec = JSON.parse(ledger[0]!);
    expect(rec.op).toBe('write');
    expect(rec.name).toBe('SOUL');
    expect(rec.configHashBefore).toBe(audit.configHashBefore);
    expect(rec.configHashAfter).toBe(audit.configHashAfter);

    // Round-trip read matches.
    const r = readGuidance(soul, root);
    expect(r.exists).toBe(true);
    expect(r.content).toBe(next);
    expect(r.sha256).toBe(sha256(next));
    expect(r.frozen).toBe(false);
  });

  it('creates the file (no .bak) when none existed', () => {
    const mem = specFor('MEMORY');
    const audit = writeGuidanceAudited({ spec: mem, content: 'hello', rootDir: root, auditPath });
    expect(audit.bakPath).toBeNull();
    expect(audit.bytesBefore).toBe(0);
    expect(fs.readFileSync(path.join(root, mem.relPath), 'utf-8')).toBe('hello');
  });
});

describe('guidance-io — invariant 4: frozen writes rejected', () => {
  it('throws on every constitution/frozen spec (no bytes written)', () => {
    for (const name of ['core-identity', 'values', 'hard-prohibitions']) {
      const spec = specFor(name);
      expect(() => writeGuidanceAudited({ spec, content: 'HACK', rootDir: root, auditPath }))
        .toThrow(/read-only/);
      // Nothing was written.
      expect(fs.existsSync(path.join(root, spec.relPath))).toBe(false);
    }
    // Ledger never created by a rejected write.
    expect(fs.existsSync(auditPath)).toBe(false);
  });

  it('still reads a frozen file (view is allowed)', () => {
    const spec = specFor('core-identity');
    const abs = path.join(root, spec.relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, '# constitution\n');
    const r = readGuidance(spec, root);
    expect(r.frozen).toBe(true);
    expect(r.exists).toBe(true);
    expect(r.content).toBe('# constitution\n');
  });
});

describe('guidance-io — path guard', () => {
  it('rejects a relPath that escapes the root', () => {
    expect(() => resolveWithinRoot(root, '../../etc/passwd')).toThrow(/escapes root/);
    expect(() => resolveWithinRoot(root, 'workspace/../../out.md')).toThrow(/escapes root/);
  });
  it('accepts a relPath inside the root', () => {
    const abs = resolveWithinRoot(root, 'workspace/SOUL.md');
    expect(abs.startsWith(path.resolve(root) + path.sep)).toBe(true);
  });
});
