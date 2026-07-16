import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// DATA_DIR is captured at module load by shared/paths.ts, so it must be set
// BEFORE the gdrive modules are imported — hence the dynamic imports below.
const tmp = mkdtempSync(join(tmpdir(), 'gdrive-bootstrap-'));
process.env['DATA_DIR'] = tmp;

type BootstrapModule = typeof import('../../src/core/gdrive/bootstrap.js');
let bootstrap: BootstrapModule;

/**
 * Mock DriveClient covering exactly what ensureFolderTree touches:
 * listChildren + createFolder, backed by an in-memory tree.
 */
class FakeDrive {
  folders = new Map<string, { name: string; parent: string }>();
  private seq = 0;
  calls = { list: 0, create: 0 };

  async listChildren(folderId: string) {
    this.calls.list++;
    return [...this.folders.entries()]
      .filter(([, f]) => f.parent === folderId)
      .map(([id, f]) => ({ id, name: f.name, mimeType: 'application/vnd.google-apps.folder' }));
  }

  async createFolder(name: string, parentId: string) {
    this.calls.create++;
    const id = `f${++this.seq}`;
    this.folders.set(id, { name, parent: parentId });
    return { id, name, mimeType: 'application/vnd.google-apps.folder' };
  }
}

beforeAll(async () => {
  bootstrap = await import('../../src/core/gdrive/bootstrap.js');
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('ensureFolderTree', () => {
  it('creates the full canonical tree and caches the ids', async () => {
    const drive = new FakeDrive();
    const map = await bootstrap.ensureFolderTree(
      drive as never,
      'ROOT',
    );
    for (const logical of bootstrap.CANONICAL_FOLDERS) {
      expect(map[logical], logical).toBeTruthy();
    }
    // Nested paths are parented correctly.
    const blobs = drive.folders.get(map['memory/blobs']!)!;
    expect(blobs.parent).toBe(map['memory']);
    expect(drive.calls.create).toBe(bootstrap.CANONICAL_FOLDERS.length);
    expect(existsSync(bootstrap.folderIdCachePath())).toBe(true);
  });

  it('is idempotent: warm cache costs zero Drive calls', async () => {
    const drive = new FakeDrive();
    await bootstrap.ensureFolderTree(drive as never, 'ROOT');
    const callsAfterFirst = { ...drive.calls };
    const again = await bootstrap.ensureFolderTree(drive as never, 'ROOT');
    expect(drive.calls).toEqual(callsAfterFirst);
    expect(Object.keys(again).length).toBe(bootstrap.CANONICAL_FOLDERS.length);
  });

  it('force re-resolve finds existing folders instead of duplicating', async () => {
    const drive = new FakeDrive();
    // Distinct root so the warm cache from earlier tests can't satisfy this run.
    const first = await bootstrap.ensureFolderTree(drive as never, 'ROOT-FORCE');
    const creates = drive.calls.create;
    const second = await bootstrap.ensureFolderTree(drive as never, 'ROOT-FORCE', { force: true });
    expect(drive.calls.create).toBe(creates); // no duplicates created
    expect(second).toEqual(first);
  });

  it('ignores a cache written for a different root folder', async () => {
    const driveA = new FakeDrive();
    await bootstrap.ensureFolderTree(driveA as never, 'ROOT-A');
    const driveB = new FakeDrive();
    await bootstrap.ensureFolderTree(driveB as never, 'ROOT-B');
    // Tree B was actually built (cache for A not reused).
    expect(driveB.calls.create).toBe(bootstrap.CANONICAL_FOLDERS.length);
  });
});
