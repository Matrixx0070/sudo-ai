/**
 * Security regression for `sudo-ai grok files download`: the download
 * metadata's `fileName` is untrusted remote data. When no --out is given, the
 * CLI must write ONLY a sanitised basename inside the working directory — a
 * crafted `../../..` fileName must never steer the write out of cwd. This test
 * fails on the pre-fix code (which path.resolve()'d the raw fileName) and passes
 * on the sanitised version.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const FID = '4fdff36b-73d1-4e99-b744-f1c308b1f34b';
const CONTENT = Buffer.from('downloaded bytes');

vi.mock('../../src/llm/grok-files.js', () => ({
  downloadGrokFile: async () => ({
    file: { fileMetadataId: FID, fileName: '../../../../tmp-evil-grok-files.txt' },
    content: CONTENT,
  }),
}));

const { runGrokFilesDownload } = await import('../../src/cli/commands/grok-files.js');

let origCwd: string;
let dir: string;
beforeEach(async () => {
  origCwd = process.cwd();
  dir = await mkdtemp(path.join(tmpdir(), 'grok-files-cli-'));
  process.chdir(dir);
});
afterEach(async () => {
  process.chdir(origCwd);
  await rm(dir, { recursive: true, force: true });
});

describe('grok files download — path traversal defense', () => {
  it('writes a malicious server fileName only as a basename in cwd', async () => {
    const code = await runGrokFilesDownload(FID, {});
    expect(code).toBe(0);
    const written = path.join(dir, 'tmp-evil-grok-files.txt');
    expect(existsSync(written)).toBe(true); // sanitised basename, inside cwd
    expect((await readFile(written)).equals(CONTENT)).toBe(true);
  });

  it('honours an explicit --out path verbatim', async () => {
    const out = path.join(dir, 'chosen.bin');
    const code = await runGrokFilesDownload(FID, { out });
    expect(code).toBe(0);
    expect((await readFile(out)).equals(CONTENT)).toBe(true);
  });
});
