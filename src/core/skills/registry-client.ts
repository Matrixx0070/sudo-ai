/**
 * @file registry-client.ts
 * @description Remote skill-registry client — the fetch half of the SUDO
 * skills ecosystem (the serving half is registry-routes.ts; the write gate is
 * workshop.ts).
 *
 * Reads a static registry index (index.json) listing single-file skills
 * (SKILL.md) with per-version SHA-256 pins, then fetches skill content and
 * verifies it against the pin. Consumed by the skill.search / skill.install
 * tools; skill.install feeds verified content into the SkillWorkshop gate so
 * registry installs pass the EXACT same scan+capability+path checks as
 * self-authored skills.
 *
 * Registry resolution order:
 *   1. SUDO_SKILL_REGISTRY_URL (operator override; http(s) URL or local path)
 *   2. https://sudoapi.shop/index.json            (canonical, GitHub Pages)
 *   3. raw.githubusercontent.com fallback          (same content, no DNS dep)
 *
 * http(s) fetches go through toolFetch (SSRF-guarded). Local paths (leading
 * "/" or file://) are operator-config only and are containment-checked: a
 * skill entry's relative path may not escape the index's directory.
 *
 * Kill-switch: SUDO_SKILL_REGISTRY=0 disables the client entirely.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createLogger } from '../shared/logger.js';
import { toolFetch } from '../security/guarded-fetch.js';

const log = createLogger('skills:registry-client');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RegistrySkillEntry {
  name: string;
  version: string;
  description?: string;
  author?: string;
  /** Path of the SKILL.md relative to the index location. */
  path: string;
  /** Lowercase hex SHA-256 of the exact SKILL.md bytes (utf-8). */
  sha256: string;
  capabilities?: string[];
  tags?: string[];
}

export interface RegistryIndex {
  registry?: string;
  schema: number;
  updated?: string;
  skills: RegistrySkillEntry[];
}

export interface FetchedSkill {
  entry: RegistrySkillEntry;
  markdown: string;
  /** The index URL/path the skill was resolved from. */
  sourceUrl: string;
}

/** Hard cap on fetched SKILL.md size — a skill is prose, not a payload. */
export const MAX_SKILL_BYTES = 256 * 1024;

const DEFAULT_REGISTRY_URLS = [
  'https://sudoapi.shop/index.json',
  'https://raw.githubusercontent.com/Matrixx0070/sudo-skills/main/docs/index.json',
];

const NAME_RE = /^[a-z0-9][a-z0-9.-]{0,63}$/i;
const SHA256_RE = /^[a-f0-9]{64}$/;

// ---------------------------------------------------------------------------
// Env gates
// ---------------------------------------------------------------------------

/** Default ON per repo policy; SUDO_SKILL_REGISTRY=0 disables. */
export function isSkillRegistryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['SUDO_SKILL_REGISTRY'] !== '0';
}

/** Ordered candidate index URLs (operator override first). */
export function registryUrls(env: NodeJS.ProcessEnv = process.env): string[] {
  const override = env['SUDO_SKILL_REGISTRY_URL']?.trim();
  if (override) return [override, ...DEFAULT_REGISTRY_URLS.filter((u) => u !== override)];
  return [...DEFAULT_REGISTRY_URLS];
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

function isLocalRef(ref: string): boolean {
  return ref.startsWith('/') || ref.startsWith('file://');
}

function localPathOf(ref: string): string {
  return ref.startsWith('file://') ? new URL(ref).pathname : ref;
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Validate one index entry; returns the reasons it is malformed (empty = ok). */
export function validateEntry(e: unknown): string[] {
  const reasons: string[] = [];
  const entry = e as Partial<RegistrySkillEntry> | null;
  if (!entry || typeof entry !== 'object') return ['entry is not an object'];
  if (typeof entry.name !== 'string' || !NAME_RE.test(entry.name)) reasons.push('invalid name');
  if (typeof entry.version !== 'string' || entry.version.trim() === '') reasons.push('invalid version');
  if (typeof entry.sha256 !== 'string' || !SHA256_RE.test(entry.sha256)) reasons.push('invalid sha256');
  if (
    typeof entry.path !== 'string'
    || entry.path.includes('..')
    || entry.path.startsWith('/')
    || /^[a-z][a-z0-9+.-]*:/i.test(entry.path) // no absolute URLs / schemes
  ) reasons.push('invalid path (must be relative, no "..", no scheme)');
  return reasons;
}

export class SkillRegistryClient {
  private readonly urls: string[];

  constructor(urls?: string[]) {
    this.urls = urls && urls.length > 0 ? urls : registryUrls();
  }

  /** Fetch and validate the first reachable index; remembers its source URL. */
  async fetchIndex(): Promise<{ index: RegistryIndex; sourceUrl: string }> {
    if (!isSkillRegistryEnabled()) {
      throw new Error('Skill registry is disabled (SUDO_SKILL_REGISTRY=0).');
    }
    const errors: string[] = [];
    for (const url of this.urls) {
      try {
        const raw = await this.readRef(url, MAX_SKILL_BYTES * 4);
        const parsed = JSON.parse(raw) as RegistryIndex;
        if (parsed?.schema !== 1 || !Array.isArray(parsed.skills)) {
          throw new Error('unsupported index shape (want schema:1 with skills[])');
        }
        const bad = parsed.skills.flatMap((s) => validateEntry(s).map((r) => `${(s as { name?: string })?.name ?? '?'}: ${r}`));
        if (bad.length > 0) throw new Error(`malformed entries — ${bad.join('; ')}`);
        log.info({ sourceUrl: url, skillCount: parsed.skills.length }, 'Skill registry index fetched');
        return { index: parsed, sourceUrl: url };
      } catch (err) {
        errors.push(`${url}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    throw new Error(`No skill registry reachable:\n- ${errors.join('\n- ')}`);
  }

  /** Find an entry by name (and optional exact version). */
  async resolve(name: string, version?: string): Promise<{ entry: RegistrySkillEntry; sourceUrl: string } | undefined> {
    const { index, sourceUrl } = await this.fetchIndex();
    const entry = index.skills.find(
      (s) => s.name.toLowerCase() === name.toLowerCase() && (!version || s.version === version),
    );
    return entry ? { entry, sourceUrl } : undefined;
  }

  /** Fetch a skill's SKILL.md and verify it against the index's SHA-256 pin. */
  async fetchSkill(name: string, version?: string): Promise<FetchedSkill> {
    const hit = await this.resolve(name, version);
    if (!hit) {
      throw new Error(`Skill "${name}"${version ? `@${version}` : ''} not found in the registry.`);
    }
    const { entry, sourceUrl } = hit;
    const contentRef = this.resolveContentRef(sourceUrl, entry.path);
    const markdown = await this.readRef(contentRef, MAX_SKILL_BYTES);
    const actual = sha256Hex(markdown);
    if (actual !== entry.sha256.toLowerCase()) {
      throw new Error(
        `Checksum mismatch for "${entry.name}"@${entry.version}: index pins ${entry.sha256.slice(0, 12)}…, `
        + `fetched content hashes ${actual.slice(0, 12)}… — refusing to install.`,
      );
    }
    log.info({ skill: entry.name, version: entry.version, sourceUrl }, 'Skill content fetched and checksum-verified');
    return { entry, markdown, sourceUrl };
  }

  /** Resolve an entry's relative path against the index location. */
  private resolveContentRef(indexRef: string, relPath: string): string {
    if (isLocalRef(indexRef)) {
      const indexDir = path.dirname(localPathOf(indexRef));
      const target = path.resolve(indexDir, relPath);
      if (target !== indexDir && !target.startsWith(indexDir + path.sep)) {
        throw new Error(`Skill path escapes the registry directory: ${relPath}`);
      }
      return target;
    }
    return new URL(relPath, indexRef).toString();
  }

  /** Read a URL or local path with a byte cap. */
  private async readRef(ref: string, maxBytes: number): Promise<string> {
    if (isLocalRef(ref)) {
      const p = localPathOf(ref);
      const text = readFileSync(p, 'utf8');
      if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error(`content exceeds ${maxBytes} byte cap`);
      return text;
    }
    if (!/^https?:\/\//i.test(ref)) throw new Error(`unsupported registry ref: ${ref}`);
    const res = await toolFetch(ref, { headers: { Accept: 'application/json, text/plain, text/markdown' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error(`content exceeds ${maxBytes} byte cap`);
    return text;
  }
}
