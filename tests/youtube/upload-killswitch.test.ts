/**
 * The publish kill switch (roadmap gate 16) and the quota guard on the upload path.
 *
 * Uploading is irreversible and, on a monetised channel, spends real money. It
 * must be off unless an operator turned it on, and it must refuse before it
 * starts rather than after a long PUT.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { youtubeUploadTool } from '../../src/core/tools/builtin/social/youtube-tools.js';
import { QuotaLedger } from '../../src/core/youtube/quota-ledger.js';
import type { ToolContext } from '../../src/core/tools/types.js';

const ctx = { sessionId: 'test-session' } as ToolContext;

let dir: string;
let videoPath: string;
const saved: Record<string, string | undefined> = {};

const ENV_KEYS = ['SUDO_YT_PUBLISH_ENABLED', 'SUDO_YT_QUOTA_DB', 'YOUTUBE_OAUTH_TOKEN',
  'YOUTUBE_OAUTH_CLIENT_ID', 'YOUTUBE_OAUTH_CLIENT_SECRET', 'YOUTUBE_OAUTH_REFRESH_TOKEN'];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yt-upload-'));
  videoPath = join(dir, 'clip.mp4');
  writeFileSync(videoPath, Buffer.alloc(64));
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env['SUDO_YT_QUOTA_DB'] = join(dir, 'quota.db');
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

const ARGS = () => ({ videoPath, title: 'A test upload' });

describe('publish kill switch', () => {
  it('refuses to upload when the flag is unset — the default', async () => {
    const res = await youtubeUploadTool.execute(ARGS(), ctx);
    expect(res.success).toBe(false);
    expect(res.output).toMatch(/SUDO_YT_PUBLISH_ENABLED/);
    expect((res.data as { blockedBy?: string })?.blockedBy).toBe('SUDO_YT_PUBLISH_ENABLED');
  });

  it('refuses for any value other than an explicit 1', async () => {
    for (const v of ['0', 'true', 'yes', '']) {
      process.env['SUDO_YT_PUBLISH_ENABLED'] = v;
      const res = await youtubeUploadTool.execute(ARGS(), ctx);
      expect(res.success, `value ${JSON.stringify(v)} must not enable publishing`).toBe(false);
      expect((res.data as { blockedBy?: string })?.blockedBy).toBe('SUDO_YT_PUBLISH_ENABLED');
    }
  });

  it('reports what it would have done, without touching the network', async () => {
    const res = await youtubeUploadTool.execute({ ...ARGS(), privacyStatus: 'public' }, ctx);
    expect((res.data as { wouldUpload?: { privacyStatus?: string } })?.wouldUpload?.privacyStatus).toBe('public');
  });

  it('does not spend quota while disabled', async () => {
    await youtubeUploadTool.execute(ARGS(), ctx);
    const q = new QuotaLedger({ dbPath: process.env['SUDO_YT_QUOTA_DB']! });
    expect(q.spent()).toBe(0);
    q.close();
  });
});

describe('upload guards, once publishing is enabled', () => {
  beforeEach(() => {
    process.env['SUDO_YT_PUBLISH_ENABLED'] = '1';
  });

  it('still validates arguments before anything else', async () => {
    expect((await youtubeUploadTool.execute({ title: 'x' }, ctx)).output).toMatch(/videoPath is required/);
    expect((await youtubeUploadTool.execute({ videoPath }, ctx)).output).toMatch(/title is required/);
  });

  it('fails on a missing credential rather than attempting an upload', async () => {
    const res = await youtubeUploadTool.execute(ARGS(), ctx);
    expect(res.success).toBe(false);
    expect(res.output).toMatch(/YOUTUBE_OAUTH_REFRESH_TOKEN|not set|Missing/i);
  });

  it('refuses before uploading when the daily quota is already gone', async () => {
    process.env['YOUTUBE_OAUTH_TOKEN'] = 'legacy-token';

    // Burn the whole allowance, reserve included.
    const q = new QuotaLedger({ dbPath: process.env['SUDO_YT_QUOTA_DB']! });
    for (let i = 0; i < 6; i++) q.spend('videos.insert');
    q.close();

    const res = await youtubeUploadTool.execute(ARGS(), ctx);
    expect(res.success).toBe(false);
    expect((res.data as { blockedBy?: string })?.blockedBy).toBe('quota');
    expect(res.output).toMatch(/quota exhausted/i);
  });
});
