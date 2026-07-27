/**
 * Uploads TTL GC — data/uploads/ sweep.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, utimesSync, lutimesSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { runUploadsSweep } from '../../src/core/health/uploads-sweep.js';

let dir: string;

/** Backdate a file's mtime by `days`. */
function age(fp: string, days: number): void {
  const t = (Date.now() - days * 86_400_000) / 1000;
  utimesSync(fp, t, t);
}

beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'uploads-gc-')); });
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env['SUDO_UPLOADS_TTL_DAYS'];
});

describe('runUploadsSweep', () => {
  it('deletes files older than the TTL and reports bytes freed', () => {
    const old = path.join(dir, 'photo-old.jpg');
    writeFileSync(old, 'x'.repeat(1024));
    age(old, 45);

    const report = runUploadsSweep(dir);
    expect(report.skipped).toBe(false);
    expect(report.deleted).toBe(1);
    expect(report.bytesFreed).toBe(1024);
    expect(existsSync(old)).toBe(false);
  });

  it('keeps files younger than the TTL', () => {
    const fresh = path.join(dir, 'photo-fresh.jpg');
    writeFileSync(fresh, 'fresh');
    const nearMiss = path.join(dir, 'photo-29d.jpg');
    writeFileSync(nearMiss, 'near');
    age(nearMiss, 29);

    const report = runUploadsSweep(dir);
    expect(report.deleted).toBe(0);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(nearMiss)).toBe(true);
  });

  it('honors a custom SUDO_UPLOADS_TTL_DAYS', () => {
    process.env['SUDO_UPLOADS_TTL_DAYS'] = '7';
    const old = path.join(dir, 'doc-10d.pdf');
    writeFileSync(old, 'old');
    age(old, 10);

    const report = runUploadsSweep(dir);
    expect(report.deleted).toBe(1);
    expect(existsSync(old)).toBe(false);
  });

  it('TTL 0 disables the sweep entirely', () => {
    process.env['SUDO_UPLOADS_TTL_DAYS'] = '0';
    const old = path.join(dir, 'photo-ancient.jpg');
    writeFileSync(old, 'x');
    age(old, 400);

    const report = runUploadsSweep(dir);
    expect(report.skipped).toBe(true);
    expect(report.deleted).toBe(0);
    expect(existsSync(old)).toBe(true);
  });

  it('negative TTL also disables', () => {
    process.env['SUDO_UPLOADS_TTL_DAYS'] = '-1';
    const report = runUploadsSweep(dir);
    expect(report.skipped).toBe(true);
  });

  it('tolerates a missing uploads dir (ENOENT)', () => {
    const report = runUploadsSweep(path.join(dir, 'does-not-exist'));
    expect(report.skipped).toBe(false);
    expect(report.deleted).toBe(0);
  });

  it('tolerates a file vanishing mid-sweep (dangling symlink hits lstat/unlink races)', () => {
    // A dangling symlink exercises the per-entry error path: lstat succeeds,
    // it is not a regular file → skipped, never followed.
    symlinkSync(path.join(dir, 'gone-target'), path.join(dir, 'dangling'));
    const report = runUploadsSweep(dir);
    expect(report.deleted).toBe(0);
  });

  it('does not recurse into subdirectories and does not delete symlinks', () => {
    const sub = path.join(dir, 'subdir');
    mkdirSync(sub);
    const nested = path.join(sub, 'nested-old.jpg');
    writeFileSync(nested, 'nested');
    age(nested, 400);
    age(sub, 400);

    const target = path.join(dir, 'link-target.jpg');
    writeFileSync(target, 'target'); // fresh target
    const link = path.join(dir, 'old-link.jpg');
    symlinkSync(target, link);
    // Backdate the LINK itself (lutimes does not follow) — an old symlink must
    // still be skipped, and its fresh target must never be deleted through it.
    const t = (Date.now() - 400 * 86_400_000) / 1000;
    lutimesSync(link, t, t);

    const report = runUploadsSweep(dir);
    expect(report.deleted).toBe(0);
    expect(existsSync(nested)).toBe(true);
    expect(existsSync(link)).toBe(true);
    expect(existsSync(target)).toBe(true);
  });
});
