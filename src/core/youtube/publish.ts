/**
 * @file publish.ts
 * @description The ONLY sanctioned path from a finished video to YouTube.
 *
 * Closes the gap that made GAP-03 half-done: `policy-gate.ts` shipped as a
 * library with **no callers**, and there was **no store of published scripts**,
 * so its cross-video similarity check — the one that actually maps to YouTube's
 * inauthentic-content policy — had nothing to compare against and would score 0
 * and pass everything. A gate nobody calls, checking against a corpus that does
 * not exist, is not a gate.
 *
 * This module provides both halves:
 *   1. {@link PublishStore} — the corpus of already-published scripts.
 *   2. {@link publishVideo} — assess, then upload ONLY on an explicit `pass`,
 *      then record so the next video is checked against this one.
 *
 * ## The invariant
 *
 * There is no code path here from a candidate to the uploader that skips
 * `assessPublishCandidate`. The uploader is an injected dependency called at
 * exactly one site, guarded by `verdict === 'pass'`. That is asserted by test,
 * because production-readiness gate 3 in `audit/04-ROADMAP.md` requires a test
 * proving the bypass does not exist — not a comment claiming it.
 *
 * Layered defences, outermost first:
 *   - `SUDO_YT_PUBLISH_ENABLED` kill switch (inside the upload tool, default OFF)
 *   - quota reservation (GAP-02, inside the upload tool)
 *   - this policy gate (fails closed: judge error ⇒ `hold` ⇒ no upload)
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createLogger } from '../shared/logger.js';
import {
  assessPublishCandidate,
  type PolicyAssessment,
  type PolicyGateOptions,
  type PublishCandidate,
  type PublishedVideo,
} from './policy-gate.js';

const log = createLogger('youtube:publish');

/** How many prior videos the similarity check compares against. */
const DEFAULT_CORPUS_SIZE = 50;

// ---------------------------------------------------------------------------
// Corpus store
// ---------------------------------------------------------------------------

/**
 * Persistent record of what this channel has already published.
 *
 * Without this the policy gate is decorative: `similarity()` against an empty
 * corpus is always 0, so every templated script passes.
 */
export class PublishStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      const dir = dirname(dbPath);
      if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS published_videos (
        video_id     TEXT PRIMARY KEY,
        title        TEXT NOT NULL,
        script       TEXT NOT NULL,
        published_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX IF NOT EXISTS idx_pub_at ON published_videos(published_at DESC);
    `);
  }

  /** Record a published video so future candidates are compared against it. */
  record(video: PublishedVideo): void {
    this.db
      .prepare<[string, string, string]>(
        `INSERT INTO published_videos (video_id, title, script) VALUES (?, ?, ?)
         ON CONFLICT(video_id) DO UPDATE SET title = excluded.title, script = excluded.script`,
      )
      .run(video.videoId, video.title, video.script);
  }

  /**
   * Most recent published videos, newest first.
   *
   * Ordered by `rowid` as a tiebreaker: `published_at` has millisecond
   * resolution, so two videos recorded in the same millisecond would otherwise
   * come back in arbitrary order — which silently changes *which* prior videos
   * the similarity check sees once the corpus exceeds the limit.
   */
  recent(limit = DEFAULT_CORPUS_SIZE): PublishedVideo[] {
    return this.db
      .prepare<[number], { video_id: string; title: string; script: string }>(
        `SELECT video_id, title, script FROM published_videos
         ORDER BY published_at DESC, rowid DESC LIMIT ?`,
      )
      .all(Math.max(1, limit))
      .map((r) => ({ videoId: r.video_id, title: r.title, script: r.script }));
  }

  count(): number {
    return this.db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM published_videos`).get()!.n;
  }

  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/** What the orchestrator needs from an uploader. Keeps YouTube I/O injectable. */
export type Uploader = (input: {
  videoPath: string;
  title: string;
  description: string;
  tags: string[];
  privacyStatus: string;
}) => Promise<{ success: boolean; videoId?: string; output: string }>;

export interface PublishRequest extends PublishCandidate {
  videoPath: string;
  tags?: string[];
  /** Defaults to `private` — publishing public is an explicit act. */
  privacyStatus?: 'public' | 'private' | 'unlisted';
}

export type PublishOutcome =
  | { status: 'published'; videoId: string; assessment: PolicyAssessment }
  | { status: 'blocked'; reasons: string[]; assessment: PolicyAssessment }
  | { status: 'held'; reasons: string[]; assessment: PolicyAssessment }
  | { status: 'upload_failed'; error: string; assessment: PolicyAssessment };

export interface PublishOptions {
  store: PublishStore;
  upload: Uploader;
  gate?: PolicyGateOptions;
  corpusSize?: number;
}

/**
 * The real uploader: `social.youtube-upload`.
 *
 * Kept behind a lazy import so this module stays usable (and testable) without
 * pulling in the tool registry, and so the layered guards inside the tool —
 * `SUDO_YT_PUBLISH_ENABLED` (default OFF) and the GAP-02 quota reservation —
 * remain the outermost defences rather than being duplicated here.
 */
export function realUploader(sessionId = 'youtube-publish'): Uploader {
  return async (input) => {
    const { youtubeUploadTool } = await import('../tools/builtin/social/youtube-tools.js');
    const res = await youtubeUploadTool.execute(
      { ...input, madeForKids: false },
      { sessionId } as Parameters<typeof youtubeUploadTool.execute>[1],
    );
    const videoId = (res.data as { videoId?: string } | undefined)?.videoId;
    return { success: res.success, ...(videoId ? { videoId } : {}), output: res.output };
  };
}

/**
 * Assess a candidate and publish it only if the policy gate returns `pass`.
 *
 * Never throws for a policy outcome — a block is a normal result, not an error.
 * A `hold` (judge unavailable) is also non-publishing: the gate fails closed.
 *
 * @returns the outcome, always carrying the assessment for audit.
 */
export async function publishVideo(
  req: PublishRequest,
  opts: PublishOptions,
): Promise<PublishOutcome> {
  const corpus = opts.store.recent(opts.corpusSize ?? DEFAULT_CORPUS_SIZE);

  const assessment = await assessPublishCandidate(
    { title: req.title, script: req.script, ...(req.description ? { description: req.description } : {}) },
    corpus,
    opts.gate ?? {},
  );

  if (assessment.verdict !== 'pass') {
    log.warn(
      { verdict: assessment.verdict, similarity: assessment.similarityScore, reasons: assessment.reasons },
      'Publish refused by the policy gate — uploader NOT invoked',
    );
    return assessment.verdict === 'hold'
      ? { status: 'held', reasons: assessment.reasons, assessment }
      : { status: 'blocked', reasons: assessment.reasons, assessment };
  }

  // Sole upload site. Reachable only with an explicit `pass` above.
  const result = await opts.upload({
    videoPath: req.videoPath,
    title: req.title,
    description: req.description ?? '',
    tags: req.tags ?? [],
    privacyStatus: req.privacyStatus ?? 'private',
  });

  if (!result.success || !result.videoId) {
    log.error({ output: result.output }, 'Upload failed after passing the policy gate');
    return { status: 'upload_failed', error: result.output, assessment };
  }

  // Record only on confirmed publish, so the corpus reflects what is actually
  // live — a failed upload must not poison future similarity checks.
  opts.store.record({ videoId: result.videoId, title: req.title, script: req.script });
  log.info({ videoId: result.videoId, corpusSize: opts.store.count() }, 'Published and recorded');

  return { status: 'published', videoId: result.videoId, assessment };
}
