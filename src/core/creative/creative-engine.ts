/**
 * CreativeEngine — SUDO's creative identity that evolves and compounds.
 *
 * Four creative domains backed by better-sqlite3 (mind.db):
 *   - Music composition: generate soundscape descriptions and note sequences
 *   - Art style: maintain and evolve a unique visual style guide
 *   - Narrative engine: story structure from emotional frameworks
 *   - Format invention: propose new content formats based on gap analysis
 *
 * Seed vocabulary and schema helpers live in creative-schema.ts.
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createLogger } from '../shared/logger.js';
import {
  DDL_MUSIC_COMPOSITIONS, DDL_ART_STYLES, DDL_STORY_FRAMEWORKS, DDL_CONTENT_FORMATS,
  DDL_IDX_MUSIC_MOOD, DDL_IDX_STYLES_CURRENT, DDL_IDX_FORMATS_STATUS,
  rowToMusic, rowToArtStyle, rowToStory, rowToFormat,
  MUSIC_STRUCTURES, MUSIC_KEYS, MUSIC_TEMPOS, DEFAULT_PALETTE,
  EMOTION_TO_ARC, FORMAT_TEMPLATES,
  type MusicComposition, type ArtStyle, type StoryFramework, type ContentFormat,
  type MusicRow, type ArtStyleRow, type StoryRow, type FormatRow,
} from './creative-schema.js';

const logger = createLogger('creative-engine');

export class CreativeEngine {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    if (!dbPath?.trim()) throw new TypeError('CreativeEngine: dbPath must be a non-empty string');
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    for (const ddl of [
      DDL_MUSIC_COMPOSITIONS, DDL_ART_STYLES, DDL_STORY_FRAMEWORKS, DDL_CONTENT_FORMATS,
      DDL_IDX_MUSIC_MOOD, DDL_IDX_STYLES_CURRENT, DDL_IDX_FORMATS_STATUS,
    ]) this.db.exec(ddl);
    logger.info({ dbPath }, 'CreativeEngine initialised');
  }

  // -------------------------------------------------------------------------
  // Music composition
  // -------------------------------------------------------------------------

  composeMusic(mood: string, duration: number): MusicComposition {
    const validMoods = ['epic', 'suspense', 'uplifting', 'dark', 'playful'];
    const safeMood = validMoods.includes(mood) ? mood : 'uplifting';
    const safeDuration = Math.max(10, Math.min(600, Math.floor(duration)));
    const [minBpm, maxBpm] = MUSIC_TEMPOS[safeMood] ?? [90, 130];
    const tempo = minBpm + Math.floor(Math.random() * (maxBpm - minBpm + 1));
    const key = MUSIC_KEYS[safeMood] ?? 'C_major';
    const structure = MUSIC_STRUCTURES[safeMood] ?? ['intro', 'verse', 'outro'];

    const composition: MusicComposition = {
      id: randomUUID(),
      title: `SUDO-${safeMood.charAt(0).toUpperCase() + safeMood.slice(1)}-${Date.now()}`,
      mood: safeMood, tempo, key, structure,
      description: `A ${safeDuration}s ${safeMood} composition in ${key.replace('_', ' ')} `
        + `at ${tempo} BPM. Structure: ${structure.join(' → ')}. `
        + `Instrumentation: layered synthesizers, cinematic percussion, `
        + `atmospheric pads with dynamic tension-release arc.`,
      duration: safeDuration,
      createdAt: new Date().toISOString(),
    };

    this.db.prepare(`
      INSERT INTO music_compositions
        (id, title, mood, tempo, key, structure, description, duration, created_at)
      VALUES (@id, @title, @mood, @tempo, @key, @structure, @description, @duration, @createdAt)
    `).run({ ...composition, structure: JSON.stringify(composition.structure) });

    logger.info({ id: composition.id, mood: safeMood, duration: safeDuration }, 'Music composition stored');
    return composition;
  }

  getMusicLibrary(): MusicComposition[] {
    return (this.db.prepare(`SELECT * FROM music_compositions ORDER BY created_at DESC`)
      .all() as MusicRow[]).map(rowToMusic);
  }

  // -------------------------------------------------------------------------
  // Art style
  // -------------------------------------------------------------------------

  createArtStyle(name: string, description: string): ArtStyle {
    if (!name?.trim()) throw new TypeError('createArtStyle: name is required');
    if (!description?.trim()) throw new TypeError('createArtStyle: description is required');

    const style: ArtStyle = {
      id: randomUUID(), name: name.trim(), description: description.trim(),
      colorPalette: [...DEFAULT_PALETTE],
      typography: 'Bold geometric sans-serif headings, clean monospace body text',
      moodBoard: ['neon-noir', 'cyberpunk', 'minimalist', 'high-contrast', 'futuristic'],
      rules: [
        'Never use more than 5 colors in a single frame',
        'Typography must be legible at 720p minimum',
        'Use motion blur only on background elements',
        'Maintain 60% dark background ratio for AMOLED optimization',
        'Icons must be outlined, never filled',
      ],
      version: 1, isCurrent: false, createdAt: new Date().toISOString(),
    };

    this.db.prepare(`
      INSERT INTO art_styles
        (id, name, description, color_palette, typography, mood_board, rules,
         version, is_current, created_at)
      VALUES
        (@id, @name, @description, @colorPalette, @typography, @moodBoard, @rules,
         @version, @isCurrent, @createdAt)
    `).run({
      ...style,
      colorPalette: JSON.stringify(style.colorPalette),
      moodBoard: JSON.stringify(style.moodBoard),
      rules: JSON.stringify(style.rules),
      isCurrent: 0,
    });

    logger.info({ id: style.id, name: style.name }, 'Art style created');
    return style;
  }

  evolveStyle(styleId: string, feedback: string): ArtStyle {
    if (!styleId?.trim()) throw new TypeError('evolveStyle: styleId is required');
    if (!feedback?.trim()) throw new TypeError('evolveStyle: feedback is required');

    const existing = this.db.prepare(`SELECT * FROM art_styles WHERE id = ?`)
      .get(styleId) as ArtStyleRow | undefined;
    if (!existing) throw new Error(`evolveStyle: style not found: ${styleId}`);

    const base = rowToArtStyle(existing);
    const newVersion = base.version + 1;
    const evolvedId = randomUUID();
    const evolved: ArtStyle = {
      ...base, id: evolvedId,
      name: `${base.name} v${newVersion}`,
      description: `${base.description} [Evolved from v${base.version}: ${feedback.trim()}]`,
      version: newVersion, isCurrent: true,
      createdAt: new Date().toISOString(),
      rules: [...base.rules, `v${newVersion} evolution note: ${feedback.trim().slice(0, 120)}`],
      moodBoard: [...base.moodBoard, feedback.toLowerCase().split(/\s+/).slice(0, 3).join('-')],
    };

    this.db.transaction(() => {
      this.db.prepare(`UPDATE art_styles SET is_current = 0`).run();
      this.db.prepare(`
        INSERT INTO art_styles
          (id, name, description, color_palette, typography, mood_board, rules,
           version, is_current, created_at)
        VALUES
          (@id, @name, @description, @colorPalette, @typography, @moodBoard, @rules,
           @version, @isCurrent, @createdAt)
      `).run({
        ...evolved,
        colorPalette: JSON.stringify(evolved.colorPalette),
        moodBoard: JSON.stringify(evolved.moodBoard),
        rules: JSON.stringify(evolved.rules),
        isCurrent: 1,
      });
    })();

    logger.info({ id: evolvedId, fromId: styleId, version: newVersion }, 'Art style evolved');
    return evolved;
  }

  getCurrentStyle(): ArtStyle | null {
    const row = this.db.prepare(
      `SELECT * FROM art_styles WHERE is_current = 1 ORDER BY version DESC LIMIT 1`
    ).get() as ArtStyleRow | undefined;
    return row ? rowToArtStyle(row) : null;
  }

  // -------------------------------------------------------------------------
  // Narrative engine
  // -------------------------------------------------------------------------

  createStoryFramework(topic: string, emotion: string): StoryFramework {
    if (!topic?.trim()) throw new TypeError('createStoryFramework: topic is required');
    if (!emotion?.trim()) throw new TypeError('createStoryFramework: emotion is required');

    const safeEmotion = emotion.toLowerCase().trim();
    const arc = EMOTION_TO_ARC[safeEmotion] ?? EMOTION_TO_ARC['default']!;
    const sceneCount = arc.length;
    const structure = arc.map((beat, idx) => ({
      scene: idx + 1, beat, emotion: beat,
      duration: idx === 0 ? 15 : idx === sceneCount - 1 ? 30 : 20,
    }));

    const framework: StoryFramework = {
      id: randomUUID(),
      title: `${topic.trim().slice(0, 60)} — ${safeEmotion} arc`,
      hook: `What if everything you knew about "${topic.trim().slice(0, 40)}" was wrong?`,
      emotionalArc: arc, sceneCount, structure,
      targetAudience: 'tech-savvy viewers aged 18-35, the configured region, mobile-first',
      createdAt: new Date().toISOString(),
    };

    this.db.prepare(`
      INSERT INTO story_frameworks
        (id, title, hook, emotional_arc, scene_count, structure, target_audience, created_at)
      VALUES
        (@id, @title, @hook, @emotionalArc, @sceneCount, @structure, @targetAudience, @createdAt)
    `).run({
      ...framework,
      emotionalArc: JSON.stringify(framework.emotionalArc),
      structure: JSON.stringify(framework.structure),
    });

    logger.info({ id: framework.id, topic, emotion: safeEmotion }, 'Story framework created');
    return framework;
  }

  getFrameworks(): StoryFramework[] {
    return (this.db.prepare(`SELECT * FROM story_frameworks ORDER BY created_at DESC`)
      .all() as StoryRow[]).map(rowToStory);
  }

  // -------------------------------------------------------------------------
  // Format invention
  // -------------------------------------------------------------------------

  inventFormat(niche: string): ContentFormat {
    if (!niche?.trim()) throw new TypeError('inventFormat: niche is required');
    const safeNiche = niche.toLowerCase().trim();
    const candidates = Object.entries(FORMAT_TEMPLATES);
    let chosen = candidates[0]!;
    for (const entry of candidates) {
      if (entry[1].bestFor.some(t => safeNiche.includes(t) || t.includes(safeNiche))) {
        chosen = entry; break;
      }
    }
    const [formatName, tmpl] = chosen;
    const collision = this.db.prepare(
      `SELECT id FROM content_formats WHERE name = ?`
    ).get(`${formatName}-${safeNiche}`) as { id: string } | undefined;
    const uniqueName = collision
      ? `${formatName}-${safeNiche}-${Date.now()}`
      : `${formatName}-${safeNiche}`;

    const format: ContentFormat = {
      id: randomUUID(), name: uniqueName,
      description: `A "${formatName}" format adapted for the "${safeNiche}" niche.`,
      template: tmpl.template,
      bestFor: [...tmpl.bestFor, safeNiche],
      estimatedViralScore: 50 + Math.floor(Math.random() * 35),
      inspiration: tmpl.inspiration,
      status: 'concept', createdAt: new Date().toISOString(),
    };

    this.db.prepare(`
      INSERT INTO content_formats
        (id, name, description, template, best_for, estimated_viral_score,
         inspiration, status, created_at)
      VALUES
        (@id, @name, @description, @template, @bestFor, @estimatedViralScore,
         @inspiration, @status, @createdAt)
    `).run({ ...format, bestFor: JSON.stringify(format.bestFor) });

    logger.info({ id: format.id, name: uniqueName, niche: safeNiche }, 'Content format invented');
    return format;
  }

  getFormats(status?: string): ContentFormat[] {
    const validStatuses = ['concept', 'tested', 'proven', 'retired'];
    if (status && !validStatuses.includes(status)) {
      throw new TypeError(`getFormats: invalid status "${status}". Valid: ${validStatuses.join(', ')}`);
    }
    const rows = status
      ? (this.db.prepare(
          `SELECT * FROM content_formats WHERE status = ? ORDER BY estimated_viral_score DESC`
        ).all(status) as FormatRow[])
      : (this.db.prepare(
          `SELECT * FROM content_formats ORDER BY estimated_viral_score DESC`
        ).all() as FormatRow[]);
    return rows.map(rowToFormat);
  }

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  getCreativeStats(): { compositions: number; styles: number; frameworks: number; formats: number } {
    const cnt = (table: string) =>
      (this.db.prepare(`SELECT COUNT(*) AS cnt FROM ${table}`).get() as { cnt: number }).cnt;
    return {
      compositions: cnt('music_compositions'),
      styles:       cnt('art_styles'),
      frameworks:   cnt('story_frameworks'),
      formats:      cnt('content_formats'),
    };
  }
}
