/**
 * Localizer — translate and dub content into multiple languages.
 * Target languages configurable via the language registry (see SUPPORTED_LANGUAGES).
 * Backed by better-sqlite3 (WAL mode).
 */

import Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import path from 'path';
import { mkdirSync } from 'fs';
import { createLogger } from '../shared/logger.js';
import { BusinessError } from '../shared/errors.js';
import { DATA_DIR } from '../shared/paths.js';

const log = createLogger('localizer');
const DEFAULT_DB_PATH = path.join(DATA_DIR, 'localization.db');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type LocalizationStatus = 'pending' | 'translating' | 'dubbing' | 'reviewing' | 'completed' | 'failed';

export interface LocalizationJob {
  id: string;
  sourceVideoId: string;
  sourceLanguage: string;
  targetLanguage: string;
  status: LocalizationStatus;
  translatedScript?: string;
  audioPath?: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Language catalogue
// ---------------------------------------------------------------------------

export const SUPPORTED_LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'hi', name: 'Hindi' },
  { code: 'ta', name: 'Tamil' },
  { code: 'te', name: 'Telugu' },
  { code: 'bn', name: 'Bengali' },
  { code: 'pa', name: 'Punjabi' },
  { code: 'ur', name: 'Urdu' },
] as const;

export type LanguageCode = (typeof SUPPORTED_LANGUAGES)[number]['code'];

const SUPPORTED_CODES = new Set<string>(SUPPORTED_LANGUAGES.map((l) => l.code));

/** Total addressable YouTube audience per language (millions). */
const LANG_REACH_M: Record<string, number> = {
  en: 1_500, hi: 600, ur: 110, bn: 230, ta: 80, te: 95, pa: 60,
};

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface JobRow {
  id: string;
  source_video_id: string;
  source_language: string;
  target_language: string;
  status: string;
  translated_script: string | null;
  audio_path: string | null;
  created_at: string;
  updated_at: string;
}

interface BrainLike {
  chat(messages: Array<{ role: string; content: string }>): Promise<{ content: string }>;
}

function rowToJob(row: JobRow): LocalizationJob {
  return {
    id: row.id,
    sourceVideoId: row.source_video_id,
    sourceLanguage: row.source_language,
    targetLanguage: row.target_language,
    status: row.status as LocalizationStatus,
    translatedScript: row.translated_script ?? undefined,
    audioPath: row.audio_path ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Localizer
// ---------------------------------------------------------------------------

export class Localizer {
  private readonly db: Database.Database;
  private brain?: BrainLike;

  constructor(dbPath: string = DEFAULT_DB_PATH, brain?: BrainLike) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.brain = brain;
    this._migrate();
    log.info({ dbPath }, 'Localizer initialised');
  }

  private _migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS localization_jobs (
        id                 TEXT PRIMARY KEY,
        source_video_id    TEXT NOT NULL,
        source_language    TEXT NOT NULL DEFAULT 'en',
        target_language    TEXT NOT NULL,
        status             TEXT NOT NULL DEFAULT 'pending',
        translated_script  TEXT,
        audio_path         TEXT,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_locjobs_source    ON localization_jobs(source_video_id);
      CREATE INDEX IF NOT EXISTS idx_locjobs_status    ON localization_jobs(status);
      CREATE INDEX IF NOT EXISTS idx_locjobs_lang      ON localization_jobs(target_language);
    `);
  }

  // -------------------------------------------------------------------------
  // Job lifecycle
  // -------------------------------------------------------------------------

  createJob(sourceVideoId: string, targetLanguage: string, sourceLanguage = 'en'): string {
    if (!sourceVideoId?.trim()) throw new BusinessError('sourceVideoId is required', 'invalid_input');
    if (!targetLanguage?.trim()) throw new BusinessError('targetLanguage is required', 'invalid_input');
    if (!SUPPORTED_CODES.has(targetLanguage)) {
      throw new BusinessError(
        `Unsupported target language: ${targetLanguage}. Supported: ${[...SUPPORTED_CODES].join(', ')}`,
        'invalid_input', { targetLanguage },
      );
    }
    const id = nanoid();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO localization_jobs
        (id, source_video_id, source_language, target_language, status, created_at, updated_at)
      VALUES (@id, @sourceVideoId, @sourceLanguage, @targetLanguage, 'pending', @now, @now)
    `).run({ id, sourceVideoId, sourceLanguage, targetLanguage, now });
    log.info({ id, sourceVideoId, targetLanguage }, 'Localization job created');
    return id;
  }

  async translateScript(jobId: string, sourceScript: string): Promise<string> {
    if (!jobId?.trim()) throw new BusinessError('jobId is required', 'invalid_input');
    if (!sourceScript?.trim()) throw new BusinessError('sourceScript is required', 'invalid_input');
    const job = this.getJob(jobId);
    if (!job) throw new BusinessError(`Job not found: ${jobId}`, 'not_found', { jobId });

    const langName = SUPPORTED_LANGUAGES.find((l) => l.code === job.targetLanguage)?.name ?? job.targetLanguage;
    this._updateJob(jobId, { status: 'translating' });
    log.info({ jobId, targetLanguage: job.targetLanguage }, 'Translation started');

    try {
      let translated: string;
      if (this.brain) {
        const res = await this.brain.chat([
          {
            role: 'system',
            content: `You are a professional YouTube script translator. Translate to ${langName} (code: ${job.targetLanguage}).
Rules: preserve formatting and paragraph breaks; maintain tone and energy; keep technical terms in English when no natural equivalent exists; return ONLY the translated text.`,
          },
          { role: 'user', content: sourceScript },
        ]);
        translated = res.content.trim();
      } else {
        log.warn({ jobId }, 'Brain unavailable — stub translation returned');
        translated = `[TRANSLATION STUB — ${langName}]\n${sourceScript}`;
      }
      this._updateJob(jobId, { status: 'completed', translatedScript: translated });
      log.info({ jobId }, 'Translation completed');
      return translated;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._updateJob(jobId, { status: 'failed' });
      log.error({ jobId, err: msg }, 'Translation failed');
      throw new BusinessError(`Translation failed: ${msg}`, 'translation_error', { jobId });
    }
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  getJob(jobId: string): LocalizationJob | null {
    if (!jobId?.trim()) return null;
    const row = this.db.prepare('SELECT * FROM localization_jobs WHERE id = ?').get(jobId) as JobRow | undefined;
    return row ? rowToJob(row) : null;
  }

  listJobs(filter?: { status?: string; language?: string }): LocalizationJob[] {
    if (filter?.status && filter?.language) {
      return (this.db.prepare('SELECT * FROM localization_jobs WHERE status = ? AND target_language = ? ORDER BY created_at DESC').all(filter.status, filter.language) as JobRow[]).map(rowToJob);
    }
    if (filter?.status) {
      return (this.db.prepare('SELECT * FROM localization_jobs WHERE status = ? ORDER BY created_at DESC').all(filter.status) as JobRow[]).map(rowToJob);
    }
    if (filter?.language) {
      return (this.db.prepare('SELECT * FROM localization_jobs WHERE target_language = ? ORDER BY created_at DESC').all(filter.language) as JobRow[]).map(rowToJob);
    }
    return (this.db.prepare('SELECT * FROM localization_jobs ORDER BY created_at DESC').all() as JobRow[]).map(rowToJob);
  }

  getSupportedLanguages(): typeof SUPPORTED_LANGUAGES { return SUPPORTED_LANGUAGES; }

  getStats(): { total: number; completed: number; byLanguage: Record<string, number> } {
    const total = (this.db.prepare('SELECT COUNT(*) as n FROM localization_jobs').get() as { n: number }).n;
    const completed = (this.db.prepare("SELECT COUNT(*) as n FROM localization_jobs WHERE status = 'completed'").get() as { n: number }).n;
    const langRows = this.db.prepare('SELECT target_language, COUNT(*) as n FROM localization_jobs GROUP BY target_language').all() as Array<{ target_language: string; n: number }>;
    const byLanguage: Record<string, number> = {};
    for (const r of langRows) byLanguage[r.target_language] = r.n;
    return { total, completed, byLanguage };
  }

  estimateReachMultiplier(languages: string[]): { multiplier: number; reasoning: string } {
    if (!Array.isArray(languages) || languages.length === 0) {
      return { multiplier: 1, reasoning: 'No additional languages specified.' };
    }
    const base = LANG_REACH_M['en'] ?? 1_500;
    let added = 0;
    const breakdown: string[] = [];
    for (const code of languages) {
      if (code === 'en') continue;
      const reach = LANG_REACH_M[code];
      if (reach !== undefined) {
        added += reach;
        const name = SUPPORTED_LANGUAGES.find((l) => l.code === code)?.name ?? code;
        breakdown.push(`${name}: +${reach}M`);
      }
    }
    const multiplier = Math.round(((base + added) / base) * 100) / 100;
    const reasoning = breakdown.length > 0
      ? `English base: ${base}M | Added: ${breakdown.join(', ')} | Total: ~${base + added}M | Multiplier: ${multiplier}x`
      : 'No supported extra languages found — multiplier stays 1x.';
    return { multiplier, reasoning };
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private _updateJob(id: string, patch: Partial<Pick<LocalizationJob, 'status' | 'translatedScript' | 'audioPath'>>): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE localization_jobs
      SET status = COALESCE(@status, status),
          translated_script = COALESCE(@ts, translated_script),
          audio_path = COALESCE(@ap, audio_path),
          updated_at = @now
      WHERE id = @id
    `).run({ id, status: patch.status ?? null, ts: patch.translatedScript ?? null, ap: patch.audioPath ?? null, now });
  }

  close(): void {
    this.db.close();
    log.info('Localizer closed');
  }
}
