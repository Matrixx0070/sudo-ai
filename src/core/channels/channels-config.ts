/**
 * @file channels-config.ts
 * @description Loader for config/channels.json5 → ChannelAccessConfig (Feature 1
 * gateway config). Secrets never live here — the file references env KEY NAMES
 * for tokens; this loader only extracts the access-policy shape (owners /
 * allowedPeers / open / defaultDeny). Missing/malformed file → null (the gateway
 * then installs a permissive no-op policy, preserving current behaviour).
 */

import { readFileSync, existsSync } from 'node:fs';
import JSON5 from 'json5';
import { projectPath } from '../shared/paths.js';
import { createLogger } from '../shared/logger.js';
import type { ChannelAccessConfig, ChannelPolicy } from './access-policy.js';
import type { ChannelType } from './types.js';

const log = createLogger('channels:config');

const CONFIG_PATH = projectPath('config', 'channels.json5');

/** Raw per-channel block as it appears in channels.json5 (superset of policy). */
interface RawChannelBlock {
  enabled?: boolean;
  tokenEnv?: string;
  owners?: unknown;
  allowedPeers?: unknown;
  open?: boolean;
  auth?: string;
}

function toStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim());
  return out.length ? out : undefined;
}

/**
 * Load + normalize config/channels.json5 into the access-policy shape.
 * Returns null when the file is absent or unparseable (fail-open to permissive).
 */
export function loadChannelsConfig(path: string = CONFIG_PATH): ChannelAccessConfig | null {
  if (!existsSync(path)) {
    log.info({ path }, 'no channels.json5 — gateway access policy inactive (permissive)');
    return null;
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON5.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  } catch (err) {
    log.error({ path, err: err instanceof Error ? err.message : String(err) }, 'channels.json5 parse failed — gateway access policy inactive');
    return null;
  }

  const channels: Partial<Record<ChannelType, ChannelPolicy>> = {};
  const rawChannels = (raw['channels'] && typeof raw['channels'] === 'object') ? raw['channels'] as Record<string, unknown> : raw;
  for (const [key, val] of Object.entries(rawChannels)) {
    if (key === 'channels' || key === 'defaultDeny') continue;
    if (!val || typeof val !== 'object') continue;
    const block = val as RawChannelBlock;
    const policy: ChannelPolicy = {};
    const owners = toStringArray(block.owners);
    const allowed = toStringArray(block.allowedPeers);
    if (owners) policy.owners = owners;
    if (allowed) policy.allowedPeers = allowed;
    // Capture `open` as a boolean — `open:false` is meaningful (locks a channel:
    // deny-by-default with no owners). Only capturing `=== true` silently dropped
    // locked blocks, leaving those channels admitting everyone.
    if (typeof block.open === 'boolean') policy.open = block.open;
    // Only register a policy block if it actually constrains/decides admission.
    if (policy.owners || policy.allowedPeers || policy.open !== undefined) {
      channels[key as ChannelType] = policy;
    }
  }

  const cfg: ChannelAccessConfig = { defaultDeny: raw['defaultDeny'] === true, channels };
  log.info({ gatedChannels: Object.keys(channels), defaultDeny: cfg.defaultDeny }, 'channels.json5 loaded');
  return cfg;
}
