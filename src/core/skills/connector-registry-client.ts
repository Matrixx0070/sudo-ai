/**
 * @file connector-registry-client.ts
 * @description Remote CONNECTOR-registry client — the fetch half of SUDO's
 * Directory "Connectors" tab. Sibling of registry-client.ts (skills).
 *
 * Reads a static catalog (connectors.json) listing MCP servers. Each entry is
 * either LIVE (has a Streamable-HTTP url or a stdio command, so it can be wired
 * up on demand via the proven mcp.connect path) or catalog-only (requiresOAuth:
 * browsable but connected out-of-band). Consumed by the connector.search /
 * connector.install tools and the Directory API.
 *
 * Registry resolution order mirrors the skill client:
 *   1. SUDO_CONNECTOR_REGISTRY_URL (operator override; http(s) URL or local path)
 *   2. https://sudoapi.shop/connectors.json                 (canonical)
 *   3. raw.githubusercontent.com/Matrixx0070/sudo-skills…   (fallback)
 *
 * http(s) fetches go through toolFetch (SSRF-guarded). No secrets ever live in
 * the catalog — connectors reference a bearer token by env-var NAME only.
 *
 * Kill-switch: SUDO_CONNECTOR_REGISTRY=0 disables the client entirely.
 */

import { readFileSync } from 'node:fs';
import { createLogger } from '../shared/logger.js';
import { toolFetch } from '../security/guarded-fetch.js';

const log = createLogger('connectors:registry-client');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RegistryConnectorEntry {
  name: string;
  displayName?: string;
  description?: string;
  category?: string;
  /** LIVE connectors carry a transport; catalog-only (requiresOAuth) may omit it. */
  transport?: 'http' | 'stdio';
  /** http: Streamable HTTP MCP endpoint URL. */
  url?: string;
  /** stdio: executable to spawn. */
  command?: string;
  /** stdio: arguments. */
  args?: string[];
  /** NAME of the env var holding a bearer token (http). Never the value. */
  authEnvKey?: string;
  /** True when the connector can be wired up automatically (has url/command). */
  live?: boolean;
  /** True when connecting needs interactive OAuth — catalog-only here. */
  requiresOAuth?: boolean;
  /** Curated/verified by the registry owner. */
  verified?: boolean;
  tags?: string[];
}

export interface ConnectorRegistryIndex {
  registry?: string;
  schema: number;
  updated?: string;
  connectors: RegistryConnectorEntry[];
}

/** Hard cap on the catalog size — metadata, not payloads. */
export const MAX_CONNECTOR_INDEX_BYTES = 512 * 1024;

const DEFAULT_REGISTRY_URLS = [
  'https://sudoapi.shop/connectors.json',
  'https://raw.githubusercontent.com/Matrixx0070/sudo-skills/main/docs/connectors.json',
];

const NAME_RE = /^[a-z0-9][a-z0-9.-]{0,63}$/i;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ---------------------------------------------------------------------------
// Env gates
// ---------------------------------------------------------------------------

/** Default ON per repo policy; SUDO_CONNECTOR_REGISTRY=0 disables. */
export function isConnectorRegistryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['SUDO_CONNECTOR_REGISTRY'] !== '0';
}

/** Ordered candidate catalog URLs (operator override first). */
export function connectorRegistryUrls(env: NodeJS.ProcessEnv = process.env): string[] {
  const override = env['SUDO_CONNECTOR_REGISTRY_URL']?.trim();
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
export function validateConnectorEntry(e: unknown): string[] {
  const reasons: string[] = [];
  const entry = e as Partial<RegistryConnectorEntry> | null;
  if (!entry || typeof entry !== 'object') return ['entry is not an object'];
  if (typeof entry.name !== 'string' || !NAME_RE.test(entry.name)) reasons.push('invalid name');
  const live = entry.live === true;
  if (live) {
    if (entry.transport !== 'http' && entry.transport !== 'stdio') {
      reasons.push('live connector needs transport "http" or "stdio"');
    } else if (entry.transport === 'http') {
      if (typeof entry.url !== 'string' || !/^https:\/\//i.test(entry.url)) reasons.push('http connector needs an https url');
    } else if (typeof entry.command !== 'string' || entry.command.trim() === '') {
      reasons.push('stdio connector needs a command');
    }
  }
  if (entry.authEnvKey !== undefined && (typeof entry.authEnvKey !== 'string' || !ENV_KEY_RE.test(entry.authEnvKey))) {
    reasons.push('authEnvKey must be a valid env-var NAME (never a token value)');
  }
  if (entry.args !== undefined && (!Array.isArray(entry.args) || entry.args.some((a) => typeof a !== 'string'))) {
    reasons.push('args must be an array of strings');
  }
  return reasons;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class ConnectorRegistryClient {
  private readonly urls: string[];

  constructor(urls?: string[]) {
    this.urls = urls && urls.length > 0 ? urls : connectorRegistryUrls();
  }

  /** Fetch and validate the first reachable catalog; remembers its source URL. */
  async fetchIndex(): Promise<{ index: ConnectorRegistryIndex; sourceUrl: string }> {
    if (!isConnectorRegistryEnabled()) {
      throw new Error('Connector registry is disabled (SUDO_CONNECTOR_REGISTRY=0).');
    }
    const errors: string[] = [];
    for (const url of this.urls) {
      try {
        const raw = await this.readRef(url, MAX_CONNECTOR_INDEX_BYTES);
        const parsed = JSON.parse(raw) as ConnectorRegistryIndex;
        if (parsed?.schema !== 1 || !Array.isArray(parsed.connectors)) {
          throw new Error('unsupported catalog shape (want schema:1 with connectors[])');
        }
        const bad = parsed.connectors.flatMap((c) =>
          validateConnectorEntry(c).map((r) => `${(c as { name?: string })?.name ?? '?'}: ${r}`),
        );
        if (bad.length > 0) throw new Error(`malformed entries — ${bad.join('; ')}`);
        log.info({ sourceUrl: url, connectorCount: parsed.connectors.length }, 'Connector catalog fetched');
        return { index: parsed, sourceUrl: url };
      } catch (err) {
        errors.push(`${url}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    throw new Error(`No connector registry reachable:\n- ${errors.join('\n- ')}`);
  }

  /** Find a catalog entry by name (case-insensitive). */
  async resolve(name: string): Promise<{ entry: RegistryConnectorEntry; sourceUrl: string } | undefined> {
    const { index, sourceUrl } = await this.fetchIndex();
    const entry = index.connectors.find((c) => c.name.toLowerCase() === name.toLowerCase());
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
