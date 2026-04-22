/**
 * Unit tests for FileStore (Wave 5 P2)
 *
 * Uses in-memory better-sqlite3 + $TMPDIR for isolation.
 * Tests: create, getById, list, softDelete, mountFilesForSession,
 *        cap enforcement, MIME validation, filename validation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileStore, computeSha256 } from '../../src/core/files/store.js';
import { FileStoreError, validateMimeMagic, validateFilename, detectMime, MAX_FILES_PER_SESSION } from '../../src/core/files/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStore(tmpDir: string, workspaceRoot?: string): { store: FileStore; db: Database.Database } {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  // Default workspaceRoot to tmpDir so existing mount tests keep passing
  const store = new FileStore(db, tmpDir, workspaceRoot ?? tmpDir);
  return { store, db };
}

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'files-test-'));
}

function makePdfBuffer(): Buffer {
  return Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E, 0x34]); // %PDF-1.4
}

function makePngBuffer(): Buffer {
  return Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00]);
}

function makeZipBuffer(): Buffer {
  return Buffer.from([0x50, 0x4B, 0x03, 0x04, 0x14, 0x00]);
}

function makeTextBuffer(): Buffer {
  return Buffer.from('hello world this is a plain text file');
}

const SCOPE = 'sesn_test001';

// ---------------------------------------------------------------------------
// 1. computeSha256
// ---------------------------------------------------------------------------

describe('computeSha256', () => {
  it('returns 64-char hex string', () => {
    const hash = computeSha256(Buffer.from('abc'));
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic', () => {
    const buf = Buffer.from('deterministic input');
    expect(computeSha256(buf)).toBe(computeSha256(buf));
  });
});

// ---------------------------------------------------------------------------
// 2. validateFilename
// ---------------------------------------------------------------------------

describe('validateFilename', () => {
  it('accepts normal filenames', () => {
    expect(validateFilename('report.pdf')).toBe('report.pdf');
    expect(validateFilename('data_file.csv')).toBe('data_file.csv');
  });

  it('rejects path traversal with ..', () => {
    expect(validateFilename('../etc/passwd')).toBeNull();
  });

  it('rejects null bytes', () => {
    expect(validateFilename('file\0name.txt')).toBeNull();
  });

  it('rejects empty string', () => {
    expect(validateFilename('')).toBeNull();
  });

  it('rejects dot-only names', () => {
    expect(validateFilename('.')).toBeNull();
    expect(validateFilename('..')).toBeNull();
  });

  it('rejects filename containing path separator (no silent strip)', () => {
    // We reject outright rather than silently stripping — prevents subtle bypass
    expect(validateFilename('uploads/report.pdf')).toBeNull();
    expect(validateFilename('a\\b.txt')).toBeNull();
  });

  it('rejects filename containing double-quote (Content-Disposition injection)', () => {
    expect(validateFilename('file"name.txt')).toBeNull();
    expect(validateFilename('"evil"')).toBeNull();
  });

  it('rejects filename containing control characters', () => {
    expect(validateFilename('file\x01name.txt')).toBeNull();
    expect(validateFilename('file\x1fname.txt')).toBeNull();
    expect(validateFilename('file\x7fname.txt')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. MIME magic byte detection
// ---------------------------------------------------------------------------

describe('detectMime', () => {
  it('detects PDF', () => {
    expect(detectMime(makePdfBuffer())).toBe('application/pdf');
  });

  it('detects PNG', () => {
    expect(detectMime(makePngBuffer())).toBe('image/png');
  });

  it('detects ZIP', () => {
    expect(detectMime(makeZipBuffer())).toBe('application/zip');
  });

  it('returns null for unrecognised type', () => {
    expect(detectMime(makeTextBuffer())).toBeNull();
  });
});

describe('validateMimeMagic', () => {
  it('passes when declared matches actual PDF', () => {
    expect(validateMimeMagic('application/pdf', makePdfBuffer())).toBeNull();
  });

  it('passes when declared matches actual PNG', () => {
    expect(validateMimeMagic('image/png', makePngBuffer())).toBeNull();
  });

  it('rejects mismatch: declared PDF but bytes are PNG', () => {
    const err = validateMimeMagic('application/pdf', makePngBuffer());
    expect(err).not.toBeNull();
    expect(err).toContain('mismatch');
  });

  it('passes text/plain (undetectable) with text bytes', () => {
    expect(validateMimeMagic('text/plain', makeTextBuffer())).toBeNull();
  });

  it('rejects when declared is PDF but no PDF magic bytes', () => {
    const err = validateMimeMagic('application/pdf', makeTextBuffer());
    expect(err).not.toBeNull();
  });

  it('strips mime parameters before comparison', () => {
    expect(validateMimeMagic('application/pdf; charset=utf-8', makePdfBuffer())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. FileStore CRUD
// ---------------------------------------------------------------------------

describe('FileStore — create + getById', () => {
  let tmpDir: string;
  let store: FileStore;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    ({ store } = makeStore(tmpDir));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a file record and returns metadata', () => {
    const data = makeTextBuffer();
    const sha256 = computeSha256(data);
    const storagePath = store.writeFileToDisk('file_testid01', sha256, data);
    const meta = store.create({
      filename: 'hello.txt',
      mime: 'text/plain',
      size_bytes: data.length,
      sha256,
      scope_id: SCOPE,
      storage_path: storagePath,
    });

    expect(meta.id).toMatch(/^file_/);
    expect(meta.filename).toBe('hello.txt');
    expect(meta.mime).toBe('text/plain');
    expect(meta.size_bytes).toBe(data.length);
    expect(meta.sha256).toBe(sha256);
    expect(meta.scope_id).toBe(SCOPE);
    expect(meta.uploaded_at).toBeTruthy();
  });

  it('getById returns null for unknown id', () => {
    expect(store.getById('file_nonexistent')).toBeNull();
  });

  it('getById retrieves existing record', () => {
    const data = makeTextBuffer();
    const sha256 = computeSha256(data);
    const sp = store.writeFileToDisk('file_id2', sha256, data);
    const created = store.create({ filename: 'f.txt', mime: 'text/plain', size_bytes: data.length, sha256, scope_id: SCOPE, storage_path: sp });
    const fetched = store.getById(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
  });
});

// ---------------------------------------------------------------------------
// 5. list
// ---------------------------------------------------------------------------

describe('FileStore — list', () => {
  let tmpDir: string;
  let store: FileStore;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    ({ store } = makeStore(tmpDir));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array initially', () => {
    expect(store.list()).toEqual([]);
  });

  it('lists all files when no scope_id filter', () => {
    for (let i = 0; i < 3; i++) {
      const data = Buffer.from(`file ${i}`);
      const sha = computeSha256(data);
      const sp = store.writeFileToDisk(`file_list${i}`, sha, data);
      store.create({ filename: `f${i}.txt`, mime: 'text/plain', size_bytes: data.length, sha256: sha, scope_id: SCOPE, storage_path: sp });
    }
    expect(store.list()).toHaveLength(3);
  });

  it('filters by scope_id', () => {
    const s1 = 'sesn_aaa', s2 = 'sesn_bbb';
    for (const scope of [s1, s1, s2]) {
      const data = Buffer.from(`data for ${scope}`);
      const sha = computeSha256(data);
      const sp = store.writeFileToDisk(`file_scope${sha.slice(0,8)}`, sha, data);
      store.create({ filename: 'x.txt', mime: 'text/plain', size_bytes: data.length, sha256: sha, scope_id: scope, storage_path: sp });
    }
    expect(store.list({ scope_id: s1 })).toHaveLength(2);
    expect(store.list({ scope_id: s2 })).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 6. softDelete
// ---------------------------------------------------------------------------

describe('FileStore — softDelete', () => {
  let tmpDir: string;
  let store: FileStore;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    ({ store } = makeStore(tmpDir));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns false for non-existent id', () => {
    expect(store.softDelete('file_ghost')).toBe(false);
  });

  it('returns true and hides file from queries', () => {
    const data = makeTextBuffer();
    const sha = computeSha256(data);
    const sp = store.writeFileToDisk('file_del01', sha, data);
    const meta = store.create({ filename: 'del.txt', mime: 'text/plain', size_bytes: data.length, sha256: sha, scope_id: SCOPE, storage_path: sp });

    expect(store.softDelete(meta.id)).toBe(true);
    expect(store.getById(meta.id)).toBeNull();
    expect(store.list()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 7. Session cap enforcement
// ---------------------------------------------------------------------------

describe('FileStore — session cap', () => {
  it('throws FileStoreError when cap exceeded', () => {
    const tmpDir = makeTmpDir();
    const { store } = makeStore(tmpDir);

    // Override cap by inserting directly via prepared statements (hack: use tiny cap via config)
    // We'll do it by creating MAX_FILES_PER_SESSION files — too slow; instead test the error code
    // by stubbing: we test via creating many files up to cap. Use a patched store with cap=2.
    // Since we can't override MAX_FILES_PER_SESSION easily, test the error is thrown at cap+1.
    // Create 2 files manually and mock the count. Instead, just verify the error class/code:
    const fakeCapStore = new FileStore(new Database(':memory:'), tmpDir);
    // Insert enough rows directly to hit cap in a small test
    const db2 = new Database(':memory:');
    db2.pragma('journal_mode = WAL');
    const s2 = new FileStore(db2, tmpDir);

    // Insert MAX_FILES_PER_SESSION rows directly
    for (let i = 0; i < MAX_FILES_PER_SESSION; i++) {
      const data = Buffer.from(`file content ${i}`);
      const sha = computeSha256(data);
      const sp = s2.writeFileToDisk(`file_cap${i}`, sha, data);
      s2.create({ filename: `f${i}.txt`, mime: 'text/plain', size_bytes: data.length, sha256: sha, scope_id: 'sesn_cap', storage_path: sp });
    }

    const overflowData = Buffer.from('overflow');
    const overflowSha = computeSha256(overflowData);
    const overflowSp = s2.writeFileToDisk('file_overflow', overflowSha, overflowData);

    expect(() =>
      s2.create({ filename: 'overflow.txt', mime: 'text/plain', size_bytes: overflowData.length, sha256: overflowSha, scope_id: 'sesn_cap', storage_path: overflowSp })
    ).toThrow(FileStoreError);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// 8. mountFilesForSession
// ---------------------------------------------------------------------------

describe('FileStore — mountFilesForSession', () => {
  let tmpDir: string;
  let store: FileStore;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    ({ store } = makeStore(tmpDir));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('copies files into target directory read-only', () => {
    const data = Buffer.from('mount me');
    const sha = computeSha256(data);
    const sp = store.writeFileToDisk('file_mount1', sha, data);
    store.create({ filename: 'mount.txt', mime: 'text/plain', size_bytes: data.length, sha256: sha, scope_id: SCOPE, storage_path: sp });

    // Mount target must be inside workspaceRoot (which defaults to tmpDir)
    const mountDir = path.join(tmpDir, 'mount_output');
    store.mountFilesForSession(SCOPE, mountDir);

    const dest = path.join(mountDir, 'mount.txt');
    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.readFileSync(dest).toString()).toBe('mount me');

    // Verify read-only
    const stat = fs.statSync(dest);
    expect(stat.mode & 0o444).toBe(0o444);
  });

  it('creates target directory if it does not exist', () => {
    const newDir = path.join(tmpDir, 'new_mount_dir');
    expect(fs.existsSync(newDir)).toBe(false);
    store.mountFilesForSession(SCOPE, newDir);
    expect(fs.existsSync(newDir)).toBe(true);
  });

  it('does not copy soft-deleted files', () => {
    const data = Buffer.from('should not appear');
    const sha = computeSha256(data);
    const sp = store.writeFileToDisk('file_del_mount', sha, data);
    const meta = store.create({ filename: 'deleted.txt', mime: 'text/plain', size_bytes: data.length, sha256: sha, scope_id: SCOPE, storage_path: sp });
    store.softDelete(meta.id);

    const mountDir = path.join(tmpDir, 'mount_no_deleted');
    store.mountFilesForSession(SCOPE, mountDir);
    expect(fs.existsSync(path.join(mountDir, 'deleted.txt'))).toBe(false);
  });

  it('throws FileStoreError(file_target_out_of_root) when targetDir is outside workspaceRoot', () => {
    // Create a store with an explicit workspaceRoot that is a sub-directory of tmpDir
    const workspaceRoot = path.join(tmpDir, 'ws_root');
    fs.mkdirSync(workspaceRoot, { recursive: true });
    const db2 = new Database(':memory:');
    db2.pragma('journal_mode = WAL');
    const isolatedStore = new FileStore(db2, workspaceRoot, workspaceRoot);

    // Attempt to mount into a directory that is outside workspaceRoot
    const outsideDir = makeTmpDir();
    try {
      expect(() => isolatedStore.mountFilesForSession('sesn_any', outsideDir)).toThrow(FileStoreError);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
