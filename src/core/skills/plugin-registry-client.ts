/**
 * @file plugin-registry-client.ts
 * @description Remote PLUGIN-registry client — the fetch half of SUDO's
 * Directory "Plugins" tab. Sibling of registry-client.ts (skills) and
 * connector-registry-client.ts (connectors).
 *
 * A SUDO plugin is a ROLE BUNDLE: a named set of skills + connectors that give
 * the agent role-level expertise in one install (mirrors claude.ai's plugins).
 * The catalog (plugins.json) lists bundles; plugin.install fans out to
 * skill.install + connector.install for the referenced members.
 *
 * Registry resolution order mirrors the other clients:
 *   1. SUDO_PLUGIN_REGISTRY_URL (operator override; http(s) URL or local path)
 *   2. https://sudoapi.shop/plugins.json                    (canonical)
 *   3. raw.githubusercontent.com/Matrixx0070/sudo-skills…   (fallback)
 *
 * Kill-switch: SUDO_PLUGIN_REGISTRY=0 disables the client entirely.
 */

import { readFileSync } from 'node:fs';
import { createLogger } from '../shared/logger.js';
import { toolFetch } from '../security/guarded-fetch.js';

const log = createLogger('plugins:registry-client');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RegistryPluginEntry {
  name: string;
  displayName?: string;
  description?: string;
  category?: string;
  /** Skill names (in the skill registry) this bundle installs. */
  skills?: string[];
  /** Connector names (in the connector catalog) this bundle installs. */
  connectors?: string[];
  tags?: string[];
}

export interface PluginRegistryIndex {
  registry?: string;
  schema: number;
  updated?: string;
  plugins: RegistryPluginEntry[];
}

/** Hard cap on the catalog size — metadata, not payloads. */
export const MAX_PLUGIN_INDEX_BYTES = 512 * 1024;

const DEFAULT_REGISTRY_URLS = [
  'https://sudoapi.shop/plugins.json',
  'https://raw.githubusercontent.com/Matrixx0070/sudo-skills/main/docs/plugins.json',
];

const NAME_RE = /^[a-z0-9][a-z0-9.-]{0,63}$/i;

// ---------------------------------------------------------------------------
// Env gates
// ---------------------------------------------------------------------------

/** Default ON per repo policy; SUDO_PLUGIN_REGISTRY=0 disables. */
export function isPluginRegistryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['SUDO_PLUGIN_REGISTRY'] !== '0';
}

/** Ordered candidate catalog URLs (operator override first). */
export function pluginRegistryUrls(env: NodeJS.ProcessEnv = process.env): string[] {
  const override = env['SUDO_PLUGIN_REGISTRY_URL']?.trim();
  if (override) return [override, ...DEFAULT_REGISTRY_URLS.filter((u) => u !== override)];
  return [...DEFAULT_REGISTRY_URLS];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isLocalRef(ref: string): boolean {
  return ref.startsWith('/') || ref.startsWith('file://');
}

function localPathOf(ref: string): string {
  return ref.startsWith('file://') ? new URL(ref).pathname : ref;
}

/** Validate one catalog entry; returns the reasons it is malformed (empty = ok). */
export function validatePluginEntry(e: unknown): string[] {
  const reasons: string[] = [];
  const entry = e as Partial<RegistryPluginEntry> | null;
  if (!entry || typeof entry !== 'object') return ['entry is not an object'];
  if (typeof entry.name !== 'string' || !NAME_RE.test(entry.name)) reasons.push('invalid name');
  if (entry.skills !== undefined && (!Array.isArray(entry.skills) || entry.skills.some((s) => typeof s !== 'string'))) {
    reasons.push('skills must be an array of strings');
  }
  if (entry.connectors !== undefined && (!Array.isArray(entry.connectors) || entry.connectors.some((c) => typeof c !== 'string'))) {
    reasons.push('connectors must be an array of strings');
  }
  const skills = Array.isArray(entry.skills) ? entry.skills : [];
  const connectors = Array.isArray(entry.connectors) ? entry.connectors : [];
  if (skills.length === 0 && connectors.length === 0) reasons.push('bundle is empty (needs at least one skill or connector)');
  return reasons;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class PluginRegistryClient {
  private readonly urls: string[];

  constructor(urls?: string[]) {
    this.urls = urls && urls.length > 0 ? urls : pluginRegistryUrls();
  }

  /** Fetch and validate the first reachable catalog; remembers its source URL. */
  async fetchIndex(): Promise<{ index: PluginRegistryIndex; sourceUrl: string }> {
    if (!isPluginRegistryEnabled()) {
      throw new Error('Plugin registry is disabled (SUDO_PLUGIN_REGISTRY=0).');
    }
    const errors: string[] = [];
    for (const url of this.urls) {
      try {
        const raw = await this.readRef(url, MAX_PLUGIN_INDEX_BYTES);
        const parsed = JSON.parse(raw) as PluginRegistryIndex;
        if (parsed?.schema !== 1 || !Array.isArray(parsed.plugins)) {
          throw new Error('unsupported catalog shape (want schema:1 with plugins[])');
        }
        const bad = parsed.plugins.flatMap((p) =>
          validatePluginEntry(p).map((r) => `${(p as { name?: string })?.name ?? '?'}: ${r}`),
        );
        if (bad.length > 0) throw new Error(`malformed entries — ${bad.join('; ')}`);
        log.info({ sourceUrl: url, pluginCount: parsed.plugins.length }, 'Plugin catalog fetched');
        return { index: parsed, sourceUrl: url };
      } catch (err) {
        errors.push(`${url}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    throw new Error(`No plugin registry reachable:\n- ${errors.join('\n- ')}`);
  }

  /** Find a catalog entry by name (case-insensitive). */
  async resolve(name: string): Promise<{ entry: RegistryPluginEntry; sourceUrl: string } | undefined> {
    const { index, sourceUrl } = await this.fetchIndex();
    const entry = index.plugins.find((p) => p.name.toLowerCase() === name.toLowerCase());
    return entry ? { entry, sourceUrl } : undefined;
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
    const res = await toolFetch(ref, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error(`content exceeds ${maxBytes} byte cap`);
    return text;
  }
}
