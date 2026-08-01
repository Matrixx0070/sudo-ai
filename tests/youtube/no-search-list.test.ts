/**
 * GAP-08 + roadmap gate 9: **`search.list` is not called. Verified by grep in CI.**
 *
 * `search.list` costs 100 quota units against a 10,000/day allowance — ~100 calls
 * exhausts the day and the only symptom is a 403 on the next upload, hours later,
 * with no obvious cause. `feedback/youtube-api.ts` used to paginate it up to 400
 * units per invocation on its default path.
 *
 * An architectural rule is only real if a test fails when someone breaks it, so
 * this scans the source rather than trusting a comment.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const SRC = path.join(process.cwd(), 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * Files allowed to mention the endpoint, and why:
 *  - `quota-ledger.ts` defines its cost and denies it by default — it must name it.
 */
const ALLOWED = new Set(['quota-ledger.ts']);

describe('GAP-08 — the 100-unit search.list endpoint is never called', () => {
  const files = walk(SRC);

  it('finds source to scan (guards against a vacuous pass)', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('no source file builds a youtube/v3/search request URL', () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (ALLOWED.has(path.basename(f))) continue;
      const src = readFileSync(f, 'utf8');
      // Matches googleapis.com/youtube/v3/search in any string form.
      if (/youtube\/v3\/search|\/search\?part=/.test(src)) {
        offenders.push(path.relative(process.cwd(), f));
      }
    }
    expect(
      offenders,
      `these files call search.list (100 quota units each) — use the channel RSS feed ` +
        `(0 units) or playlistItems.list (1 unit/50) instead`,
    ).toEqual([]);
  });

  it('the replacement uses playlistItems, and derives the uploads playlist id', async () => {
    const { uploadsPlaylistId } = await import('../../src/core/feedback/youtube-api.js');
    expect(uploadsPlaylistId('UCuAXFkgsw1L7xaCfnd5JJOw')).toBe('UUuAXFkgsw1L7xaCfnd5JJOw');
    // Non-UC ids (already a playlist, or a handle-resolved id) pass through untouched.
    expect(uploadsPlaylistId('PLabc123')).toBe('PLabc123');

    const src = readFileSync(path.join(SRC, 'core/feedback/youtube-api.ts'), 'utf8');
    expect(src).toContain('playlistItems?part=contentDetails');
    expect(src).toContain('feeds/videos.xml');
  });
});
