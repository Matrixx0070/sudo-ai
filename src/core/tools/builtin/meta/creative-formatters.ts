/**
 * creative-formatters.ts — Human-readable formatting helpers for meta.creative tool output.
 * Extracted to keep creative.ts within the 300-line file boundary.
 */

import type { MusicComposition, ArtStyle, StoryFramework, ContentFormat }
  from '../../../creative/creative-schema.js';

export function formatMusic(c: MusicComposition): string {
  return [
    `[${c.id.slice(0, 8)}] "${c.title}"`,
    `  Mood: ${c.mood} | Key: ${c.key} | Tempo: ${c.tempo} BPM | Duration: ${c.duration}s`,
    `  Structure: ${c.structure.join(' → ')}`,
    `  Desc: ${c.description.slice(0, 100)}...`,
  ].join('\n');
}

export function formatStyle(s: ArtStyle): string {
  return [
    `[${s.id.slice(0, 8)}] "${s.name}" v${s.version}${s.isCurrent ? ' [CURRENT]' : ''}`,
    `  Palette: ${s.colorPalette.join(', ')} | Typography: ${s.typography.slice(0, 50)}`,
    `  Mood board: ${s.moodBoard.join(', ')} | Rules: ${s.rules.length} defined`,
  ].join('\n');
}

export function formatFramework(f: StoryFramework): string {
  return [
    `[${f.id.slice(0, 8)}] "${f.title}"`,
    `  Hook: ${f.hook.slice(0, 100)}`,
    `  Arc: ${f.emotionalArc.join(' → ')} (${f.sceneCount} scenes)`,
  ].join('\n');
}

export function formatFormat(f: ContentFormat): string {
  return [
    `[${f.id.slice(0, 8)}] "${f.name}" [${f.status.toUpperCase()}]`,
    `  Best for: ${f.bestFor.join(', ')}`,
    `  Template: ${f.template.slice(0, 90)}...`,
  ].join('\n');
}
