/**
 * @file obsidian.ts
 * @description ObsidianVault — read/write Obsidian-flavoured Markdown files
 * with YAML frontmatter parsing, wikilink resolution, full-text search,
 * and backlink indexing.
 *
 * Default vault path: /root/obsidian-vault/
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { resolve, join, relative, extname, basename } from 'node:path';
import { createLogger } from '../shared/logger.js';
import type { ObsidianNote } from './types.js';

const log = createLogger('obsidian-vault');

// ---------------------------------------------------------------------------
// Frontmatter parser (no external YAML dep required)
// ---------------------------------------------------------------------------

const FM_DELIMITER = /^---\s*$/m;

function parseFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  const lines = raw.split('\n');
  if (lines[0]?.trim() !== '---') {
    return { frontmatter: {}, body: raw };
  }

  const closeIdx = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (closeIdx === -1) {
    return { frontmatter: {}, body: raw };
  }

  const fmLines = lines.slice(1, closeIdx);
  const body = lines.slice(closeIdx + 1).join('\n').trimStart();
  const frontmatter: Record<string, unknown> = {};

  for (const line of fmLines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const rawVal = line.slice(colonIdx + 1).trim();
    // Parse arrays like [a, b, c]
    if (rawVal.startsWith('[') && rawVal.endsWith(']')) {
      frontmatter[key] = rawVal.slice(1, -1).split(',').map((v) => v.trim()).filter(Boolean);
    } else {
      frontmatter[key] = rawVal;
    }
  }

  return { frontmatter, body };
}

function stringifyFrontmatter(fm: Record<string, unknown>): string {
  const lines = ['---'];
  for (const [key, val] of Object.entries(fm)) {
    if (Array.isArray(val)) {
      lines.push(`${key}: [${val.join(', ')}]`);
    } else {
      lines.push(`${key}: ${String(val)}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

function extractWikilinks(text: string): string[] {
  const matches = text.matchAll(/\[\[([^\]|#]+?)(?:[|#][^\]]*?)?\]\]/g);
  return Array.from(matches, (m) => m[1]!.trim());
}

// ---------------------------------------------------------------------------
// ObsidianVault
// ---------------------------------------------------------------------------

export class ObsidianVault {
  private readonly vaultPath: string;

  constructor(vaultPath = '/root/obsidian-vault') {
    this.vaultPath = resolve(vaultPath);
    if (!existsSync(this.vaultPath)) {
      mkdirSync(this.vaultPath, { recursive: true });
      log.info({ vaultPath: this.vaultPath }, 'Vault directory created');
    }
  }

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  /** Parse and return a single note. Returns null if not found. */
  readNote(name: string): ObsidianNote | null {
    const notePath = this._resolvePath(name);
    if (!existsSync(notePath)) return null;

    try {
      const raw = readFileSync(notePath, 'utf-8');
      const { frontmatter, body } = parseFrontmatter(raw);
      const stat = statSync(notePath);

      return {
        path: notePath,
        name: basename(notePath, '.md'),
        frontmatter,
        body,
        wikilinks: extractWikilinks(body),
        modifiedAt: stat.mtime.toISOString(),
      };
    } catch (err) {
      log.error({ err, notePath }, 'Failed to read note');
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Write
  // -------------------------------------------------------------------------

  /**
   * Write or overwrite a note. Creates parent directories as needed.
   * Frontmatter is serialised as YAML and prepended automatically.
   */
  writeNote(
    name: string,
    body: string,
    frontmatter: Record<string, unknown> = {},
  ): string {
    const notePath = this._resolvePath(name);
    mkdirSync(resolve(notePath, '..'), { recursive: true });

    const fm = Object.keys(frontmatter).length > 0
      ? stringifyFrontmatter(frontmatter) + '\n'
      : '';
    const content = `${fm}${body}`;

    writeFileSync(notePath, content, 'utf-8');
    log.info({ notePath }, 'Note written');
    return notePath;
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  /**
   * Case-insensitive full-text search across all .md files.
   * Returns notes where the body or title contains the query.
   */
  search(query: string, limit = 20): ObsidianNote[] {
    const lower = query.toLowerCase();
    const results: ObsidianNote[] = [];

    for (const notePath of this._allNotePaths()) {
      try {
        const raw = readFileSync(notePath, 'utf-8');
        if (!raw.toLowerCase().includes(lower)) continue;
        const { frontmatter, body } = parseFrontmatter(raw);
        const stat = statSync(notePath);
        results.push({
          path: notePath,
          name: basename(notePath, '.md'),
          frontmatter,
          body,
          wikilinks: extractWikilinks(body),
          modifiedAt: stat.mtime.toISOString(),
        });
        if (results.length >= limit) break;
      } catch (err) {
        log.error({ err, notePath }, 'Search read error');
      }
    }

    log.info({ query, found: results.length }, 'Vault search complete');
    return results;
  }

  // -------------------------------------------------------------------------
  // Backlinks
  // -------------------------------------------------------------------------

  /**
   * Find all notes that link to the given note name via [[wikilinks]].
   */
  getBacklinks(name: string): string[] {
    const backlinks: string[] = [];
    const targetName = basename(name, '.md').toLowerCase();

    for (const notePath of this._allNotePaths()) {
      try {
        const raw = readFileSync(notePath, 'utf-8');
        const wikilinks = extractWikilinks(raw).map((l) => l.toLowerCase());
        if (wikilinks.includes(targetName)) {
          backlinks.push(relative(this.vaultPath, notePath));
        }
      } catch {
        // Skip unreadable files
      }
    }

    return backlinks;
  }

  // -------------------------------------------------------------------------
  // List
  // -------------------------------------------------------------------------

  /** Return all note names (relative paths within vault, without .md). */
  listNotes(): string[] {
    return this._allNotePaths().map((p) =>
      relative(this.vaultPath, p).replace(/\.md$/, ''),
    );
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _resolvePath(name: string): string {
    const withExt = name.endsWith('.md') ? name : `${name}.md`;
    return join(this.vaultPath, withExt);
  }

  private _allNotePaths(): string[] {
    const paths: string[] = [];
    this._walk(this.vaultPath, paths);
    return paths;
  }

  private _walk(dir: string, acc: string[]): void {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        this._walk(full, acc);
      } else if (extname(entry) === '.md') {
        acc.push(full);
      }
    }
  }
}

void FM_DELIMITER; // suppress unused warning
