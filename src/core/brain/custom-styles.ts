/**
 * @file custom-styles.ts
 * @description User-defined output styles loaded from disk.
 *
 * sudo-ai already had swappable output styles: the `personas` registry supplies
 * a system block + temperature per style, `assembleSystemPrompt` injects it, and
 * `/persona <name>` switches it. The gap versus Claude Code's output styles was
 * that ours are hardcoded in TypeScript — you could not add one without editing
 * code and redeploying.
 *
 * This adds a disk layer: drop `workspace/styles/<name>.md` and it becomes a
 * selectable style immediately. Built-ins always win on name collision, so a
 * bad file can never shadow (or break) a shipped persona.
 *
 * File format — optional YAML-ish frontmatter, then the system block:
 *
 *   ---
 *   label: Explanatory
 *   temperature: 0.6
 *   ---
 *   Explain your reasoning as you go...
 *
 * Disable with SUDO_CUSTOM_STYLES=0.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../shared/logger.js';
import { PROJECT_ROOT } from '../shared/paths.js';

const log = createLogger('brain:custom-styles');

/** Styles larger than this are ignored — a system block is not a document. */
const MAX_STYLE_BYTES = 32 * 1024;
/** Names must be simple so they are safe as slash-command arguments. */
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export interface CustomStyle {
  name: string;
  label: string;
  systemBlock: string;
  temperature: number;
}

export function customStylesEnabled(): boolean {
  return process.env['SUDO_CUSTOM_STYLES'] !== '0';
}

export function stylesDir(): string {
  return process.env['SUDO_STYLES_DIR'] ?? join(PROJECT_ROOT, 'workspace', 'styles');
}

/** Parse one style file. Returns null when unusable (never throws). */
export function parseStyleFile(name: string, raw: string): CustomStyle | null {
  if (!NAME_RE.test(name)) return null;
  let body = raw;
  let label = name;
  let temperature = 0.7;

  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (fm) {
    body = raw.slice(fm[0].length);
    for (const line of (fm[1] ?? '').split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_]+)\s*:\s*(.+?)\s*$/.exec(line);
      if (!m) continue;
      const key = m[1]!.toLowerCase();
      const val = m[2]!.replace(/^["']|["']$/g, '');
      if (key === 'label' && val !== '') label = val;
      if (key === 'temperature') {
        const t = Number(val);
        // Out-of-range temperatures would silently change model behaviour.
        if (Number.isFinite(t) && t >= 0 && t <= 1.5) temperature = t;
      }
    }
  }

  const systemBlock = body.trim();
  if (systemBlock === '') return null;
  return { name, label, systemBlock, temperature };
}

/**
 * Load every valid style from disk. Never throws — a broken styles directory
 * must not take down prompt assembly.
 */
export function loadCustomStyles(): CustomStyle[] {
  if (!customStylesEnabled()) return [];
  const dir = stylesDir();
  try {
    if (!existsSync(dir)) return [];
    const out: CustomStyle[] = [];
    for (const entry of readdirSync(dir)) {
      if (!entry.toLowerCase().endsWith('.md')) continue;
      const full = join(dir, entry);
      try {
        const st = statSync(full);
        if (!st.isFile() || st.size > MAX_STYLE_BYTES) continue;
        const name = entry.replace(/\.md$/i, '').toLowerCase();
        const parsed = parseStyleFile(name, readFileSync(full, 'utf8'));
        if (parsed) out.push(parsed);
        else log.debug({ entry }, 'custom style skipped (bad name or empty body)');
      } catch (err) {
        log.debug({ entry, err: String(err) }, 'custom style unreadable — skipped');
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    log.warn({ err: String(err), dir }, 'custom styles directory unreadable (ignoring)');
    return [];
  }
}

/** Look up one custom style by name (case-insensitive). */
export function getCustomStyle(name: string): CustomStyle | null {
  const wanted = name.trim().toLowerCase();
  return loadCustomStyles().find((s) => s.name === wanted) ?? null;
}
