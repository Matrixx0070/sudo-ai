/**
 * creative-schema.ts — Interfaces, DDL, row shapes, and conversion helpers
 * for the CreativeEngine.
 *
 * Kept separate so creative-engine.ts stays within the 300-line boundary.
 */

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface MusicComposition {
  id: string;
  title: string;
  mood: string;        // 'epic' | 'suspense' | 'uplifting' | 'dark' | 'playful'
  tempo: number;       // BPM
  key: string;         // e.g. 'C_major', 'A_minor'
  structure: string[]; // ['intro', 'buildup', 'climax', 'resolution']
  description: string; // detailed description for AI music generation
  duration: number;    // seconds
  createdAt: string;   // ISO-8601
}

export interface ArtStyle {
  id: string;
  name: string;
  description: string;
  colorPalette: string[];  // hex strings e.g. '#1a1a2e'
  typography: string;
  moodBoard: string[];     // descriptive keywords
  rules: string[];         // style rules to follow
  version: number;
  isCurrent: boolean;
  createdAt: string;       // ISO-8601
}

export interface StoryFramework {
  id: string;
  title: string;
  hook: string;
  emotionalArc: string[];  // ['curiosity', 'tension', 'revelation', 'satisfaction']
  sceneCount: number;
  structure: Array<{ scene: number; beat: string; emotion: string; duration: number }>;
  targetAudience: string;
  createdAt: string;       // ISO-8601
}

export interface ContentFormat {
  id: string;
  name: string;
  description: string;
  template: string;            // structural template text
  bestFor: string[];           // topic categories
  estimatedViralScore: number; // 0-100
  inspiration: string;
  status: 'concept' | 'tested' | 'proven' | 'retired';
  createdAt: string;           // ISO-8601
}

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------

export const DDL_MUSIC_COMPOSITIONS = `
  CREATE TABLE IF NOT EXISTS music_compositions (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    mood        TEXT NOT NULL,
    tempo       INTEGER NOT NULL,
    key         TEXT NOT NULL,
    structure   TEXT NOT NULL,
    description TEXT NOT NULL,
    duration    INTEGER NOT NULL,
    created_at  TEXT NOT NULL
                  DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )
`;

export const DDL_ART_STYLES = `
  CREATE TABLE IF NOT EXISTS art_styles (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL UNIQUE,
    description   TEXT NOT NULL,
    color_palette TEXT NOT NULL,
    typography    TEXT NOT NULL,
    mood_board    TEXT NOT NULL,
    rules         TEXT NOT NULL,
    version       INTEGER NOT NULL DEFAULT 1,
    is_current    INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL
                    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )
`;

export const DDL_STORY_FRAMEWORKS = `
  CREATE TABLE IF NOT EXISTS story_frameworks (
    id              TEXT PRIMARY KEY,
    title           TEXT NOT NULL,
    hook            TEXT NOT NULL,
    emotional_arc   TEXT NOT NULL,
    scene_count     INTEGER NOT NULL,
    structure       TEXT NOT NULL,
    target_audience TEXT NOT NULL,
    created_at      TEXT NOT NULL
                      DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )
`;

export const DDL_CONTENT_FORMATS = `
  CREATE TABLE IF NOT EXISTS content_formats (
    id                   TEXT PRIMARY KEY,
    name                 TEXT NOT NULL UNIQUE,
    description          TEXT NOT NULL,
    template             TEXT NOT NULL,
    best_for             TEXT NOT NULL,
    estimated_viral_score INTEGER NOT NULL DEFAULT 50,
    inspiration          TEXT NOT NULL,
    status               TEXT NOT NULL DEFAULT 'concept',
    created_at           TEXT NOT NULL
                           DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )
`;

export const DDL_IDX_MUSIC_MOOD = `CREATE INDEX IF NOT EXISTS idx_music_mood ON music_compositions(mood)`;
export const DDL_IDX_STYLES_CURRENT = `CREATE INDEX IF NOT EXISTS idx_styles_current ON art_styles(is_current)`;
export const DDL_IDX_FORMATS_STATUS = `CREATE INDEX IF NOT EXISTS idx_formats_status ON content_formats(status)`;

// ---------------------------------------------------------------------------
// Row shapes returned by better-sqlite3
// ---------------------------------------------------------------------------

export interface MusicRow {
  id: string;
  title: string;
  mood: string;
  tempo: number;
  key: string;
  structure: string;    // JSON array
  description: string;
  duration: number;
  created_at: string;
}

export interface ArtStyleRow {
  id: string;
  name: string;
  description: string;
  color_palette: string;  // JSON array
  typography: string;
  mood_board: string;     // JSON array
  rules: string;          // JSON array
  version: number;
  is_current: number;     // SQLite stores boolean as 0/1
  created_at: string;
}

export interface StoryRow {
  id: string;
  title: string;
  hook: string;
  emotional_arc: string;  // JSON array
  scene_count: number;
  structure: string;      // JSON array
  target_audience: string;
  created_at: string;
}

export interface FormatRow {
  id: string;
  name: string;
  description: string;
  template: string;
  best_for: string;              // JSON array
  estimated_viral_score: number;
  inspiration: string;
  status: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------

function parseJson<T>(raw: string, fallback: T): T {
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

export function rowToMusic(r: MusicRow): MusicComposition {
  return {
    id: r.id,
    title: r.title,
    mood: r.mood,
    tempo: r.tempo,
    key: r.key,
    structure: parseJson<string[]>(r.structure, []),
    description: r.description,
    duration: r.duration,
    createdAt: r.created_at,
  };
}

export function rowToArtStyle(r: ArtStyleRow): ArtStyle {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    colorPalette: parseJson<string[]>(r.color_palette, []),
    typography: r.typography,
    moodBoard: parseJson<string[]>(r.mood_board, []),
    rules: parseJson<string[]>(r.rules, []),
    version: r.version,
    isCurrent: r.is_current === 1,
    createdAt: r.created_at,
  };
}

export function rowToStory(r: StoryRow): StoryFramework {
  return {
    id: r.id,
    title: r.title,
    hook: r.hook,
    emotionalArc: parseJson<string[]>(r.emotional_arc, []),
    sceneCount: r.scene_count,
    structure: parseJson<StoryFramework['structure']>(r.structure, []),
    targetAudience: r.target_audience,
    createdAt: r.created_at,
  };
}

export function rowToFormat(r: FormatRow): ContentFormat {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    template: r.template,
    bestFor: parseJson<string[]>(r.best_for, []),
    estimatedViralScore: r.estimated_viral_score,
    inspiration: r.inspiration,
    status: r.status as ContentFormat['status'],
    createdAt: r.created_at,
  };
}

// ---------------------------------------------------------------------------
// Seed vocabulary (exported so creative-engine.ts stays within 300 lines)
// ---------------------------------------------------------------------------

export const MUSIC_STRUCTURES: Record<string, string[]> = {
  epic:      ['intro', 'buildup', 'climax', 'drop', 'resolution'],
  suspense:  ['silence', 'low-drone', 'staccato', 'peak', 'fade'],
  uplifting: ['intro', 'verse', 'chorus', 'bridge', 'outro'],
  dark:      ['ambient', 'creep', 'tension', 'break', 'decay'],
  playful:   ['bounce', 'hook', 'melody', 'variation', 'tag'],
};

export const MUSIC_KEYS: Record<string, string> = {
  epic: 'D_minor', suspense: 'B_minor', uplifting: 'G_major',
  dark: 'C_minor', playful: 'F_major',
};

export const MUSIC_TEMPOS: Record<string, [number, number]> = {
  epic: [90, 130], suspense: [60, 90], uplifting: [110, 140],
  dark: [50, 80], playful: [120, 160],
};

export const DEFAULT_PALETTE = ['#1a1a2e', '#16213e', '#0f3460', '#e94560', '#533483'];

export const EMOTION_TO_ARC: Record<string, string[]> = {
  curiosity:    ['question', 'exploration', 'discovery', 'satisfaction'],
  tension:      ['setup', 'complication', 'confrontation', 'resolution'],
  inspiration:  ['ordinary', 'challenge', 'transformation', 'triumph'],
  nostalgia:    ['memory', 'longing', 'reflection', 'acceptance'],
  excitement:   ['anticipation', 'buildup', 'peak', 'afterglow'],
  default:      ['curiosity', 'tension', 'revelation', 'satisfaction'],
};

export interface FormatTemplate { template: string; bestFor: string[]; inspiration: string }

export const FORMAT_TEMPLATES: Record<string, FormatTemplate> = {
  'versus-battle': {
    template: '[A] vs [B]: Who Wins? → Criteria reveal → Round-by-round → Shock verdict',
    bestFor: ['tech', 'ai-tools', 'comparison'],
    inspiration: 'Gap analysis: viewers crave decisive comparisons with drama',
  },
  'timeline-explainer': {
    template: '5 years ago → 3 years ago → Now → Future prediction',
    bestFor: ['history', 'tech-evolution', 'industry'],
    inspiration: 'Time travel narrative creates emotional investment',
  },
  'myth-busting': {
    template: 'Common belief → Evidence against → Hidden truth → What to do instead',
    bestFor: ['education', 'science', 'finance'],
    inspiration: 'Cognitive dissonance drives high completion rates',
  },
  'challenge-solved': {
    template: 'Impossible problem → Failed attempts → Breakthrough moment → Results',
    bestFor: ['coding', 'productivity', 'life-hacks'],
    inspiration: 'Problem-solution arc satisfies the viewers completion instinct',
  },
};
