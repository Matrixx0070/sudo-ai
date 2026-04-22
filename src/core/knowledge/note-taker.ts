/**
 * @file note-taker.ts
 * @description generateNotes(text, format) — convert raw text into structured
 * notes in one of three formats: zettelkasten, outline, or cornell.
 *
 * All formats return Note[] so callers can treat them uniformly.
 */

import type { Note } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a Zettelkasten-style ID based on current time: YYYYMMDDHHmm */
function zettelId(): string {
  const now = new Date();
  const pad = (n: number, len = 2): string => String(n).padStart(len, '0');
  return (
    String(now.getFullYear()) +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) +
    pad(now.getHours()) +
    pad(now.getMinutes())
  );
}

/** Extract candidate tags by finding capitalised words and common keywords. */
function extractTags(text: string): string[] {
  const words = text.match(/\b[A-Z][a-z]{3,}\b/g) ?? [];
  const freq = new Map<string, number>();
  for (const w of words) {
    freq.set(w, (freq.get(w) ?? 0) + 1);
  }
  return Array.from(freq.entries())
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([word]) => word.toLowerCase());
}

/** Split text into sentences (rough heuristic). */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 10);
}

/** Extract a title from the first meaningful line or sentence. */
function extractTitle(text: string): string {
  const first = text.split('\n').find((l) => l.trim().length > 5)?.trim() ?? '';
  return first.length > 80 ? first.slice(0, 77) + '...' : first;
}

// ---------------------------------------------------------------------------
// Format generators
// ---------------------------------------------------------------------------

function makeZettelkasten(text: string): Note[] {
  const sentences = splitSentences(text);
  const tags = extractTags(text);

  // Each atomic note = one sentence or short group of related sentences
  const chunks: string[][] = [];
  let current: string[] = [];

  for (const sentence of sentences) {
    current.push(sentence);
    if (current.length >= 3 || sentence.endsWith('?')) {
      chunks.push(current);
      current = [];
    }
  }
  if (current.length > 0) chunks.push(current);

  return chunks.map((chunk, i) => {
    const id = `${zettelId()}-${String(i + 1).padStart(3, '0')}`;
    const body = chunk.join(' ');
    const title = extractTitle(body);
    return {
      format: 'zettelkasten' as const,
      title,
      zettelId: id,
      tags,
      content: [
        `---`,
        `id: ${id}`,
        `tags: [${tags.join(', ')}]`,
        `---`,
        ``,
        `# ${title}`,
        ``,
        body,
        ``,
        `## References`,
        `<!-- Add [[wikilinks]] here -->`,
      ].join('\n'),
    };
  });
}

function makeOutline(text: string): Note[] {
  const sentences = splitSentences(text);
  const tags = extractTags(text);
  const title = extractTitle(text);

  // Group sentences into clusters of 4 as outline sections
  const sections: string[][] = [];
  for (let i = 0; i < sentences.length; i += 4) {
    sections.push(sentences.slice(i, i + 4));
  }

  const lines = [`# ${title}`, ''];
  sections.forEach((section, i) => {
    lines.push(`## Section ${i + 1}`);
    section.forEach((sentence) => lines.push(`- ${sentence}`));
    lines.push('');
  });

  return [{
    format: 'outline',
    title,
    tags,
    content: lines.join('\n'),
  }];
}

function makeCornell(text: string): Note[] {
  const sentences = splitSentences(text);
  const tags = extractTags(text);
  const title = extractTitle(text);

  const half = Math.ceil(sentences.length / 2);
  const notesSide = sentences.slice(0, half).map((s) => `- ${s}`).join('\n');
  const cuesSide = sentences
    .slice(half)
    .filter((_, i) => i % 3 === 0)
    .map((s) => `? ${s}`)
    .join('\n');
  const summary = sentences.slice(-3).join(' ');

  const content = [
    `# ${title}`,
    '',
    `## Notes`,
    notesSide,
    '',
    `## Cues / Questions`,
    cuesSide || '<!-- Add questions here -->',
    '',
    `## Summary`,
    summary || text.slice(0, 200),
  ].join('\n');

  return [{
    format: 'cornell',
    title,
    tags,
    content,
  }];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate structured notes from raw text.
 *
 * @param text   - Source text to process.
 * @param format - Output format: zettelkasten | outline | cornell.
 * @returns      Array of Note objects (zettelkasten may produce multiple).
 */
export function generateNotes(
  text: string,
  format: 'zettelkasten' | 'outline' | 'cornell' = 'zettelkasten',
): Note[] {
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return [];
  }

  switch (format) {
    case 'zettelkasten': return makeZettelkasten(text);
    case 'outline':      return makeOutline(text);
    case 'cornell':      return makeCornell(text);
  }
}
