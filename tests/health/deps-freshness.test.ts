/**
 * @file deps-freshness.test.ts
 * @description checkDepsFreshness — stale-node_modules detector. Deploys are
 * ff-only; a merged dependency change without `pnpm install` broke pptx.create
 * live (2026-07-31). The check byte-hashes pnpm-lock.yaml against pnpm's own
 * installed copy (node_modules/.pnpm/lock.yaml).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { checkDepsFreshness } from '../../src/core/health/checks.js';

let tmp: string;
const lockfile = () => path.join(tmp, 'pnpm-lock.yaml');
const copy = () => path.join(tmp, 'lock-copy.yaml');

beforeEach(() => {
  tmp = path.join(os.tmpdir(), `deps-fresh-${randomUUID()}`);
  mkdirSync(tmp, { recursive: true });
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('checkDepsFreshness', () => {
  it('healthy when the installed copy byte-matches the lockfile', async () => {
    writeFileSync(lockfile(), 'lockfileVersion: 9\n');
    writeFileSync(copy(), 'lockfileVersion: 9\n');
    const c = await checkDepsFreshness(lockfile(), copy());
    expect(c.status).toBe('healthy');
  });

  it('CRITICAL with an actionable message when the copy diverges', async () => {
    writeFileSync(lockfile(), 'lockfileVersion: 9\nnew-dep: 1.0\n');
    writeFileSync(copy(), 'lockfileVersion: 9\n');
    const c = await checkDepsFreshness(lockfile(), copy());
    expect(c.status).toBe('critical');
    expect(c.message).toContain('pnpm install --frozen-lockfile');
  });

  it('degraded (not critical) when the installed copy is absent', async () => {
    writeFileSync(lockfile(), 'lockfileVersion: 9\n');
    const c = await checkDepsFreshness(lockfile(), path.join(tmp, 'nope.yaml'));
    expect(c.status).toBe('degraded');
  });

  it('degraded when the repo lockfile itself is missing', async () => {
    writeFileSync(copy(), 'x\n');
    const c = await checkDepsFreshness(path.join(tmp, 'nope.yaml'), copy());
    expect(c.status).toBe('degraded');
  });

  it('the real environment is never reported stale right after an install', async () => {
    // CI installs with --frozen-lockfile immediately before tests; locally the
    // pair matches too. 'degraded' is tolerated (some layouts omit the pnpm
    // lock copy) — 'critical' here would mean a false staleness alarm.
    const c = await checkDepsFreshness();
    expect(c.status).not.toBe('critical');
  });
});
