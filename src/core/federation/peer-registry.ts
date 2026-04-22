/**
 * @file core/federation/peer-registry.ts
 * @description In-memory registry of federation peers, populated from env at bootstrap.
 *
 * Env vars:
 *   SUDO_FEDERATION_PEERS            — JSON array: [{"name":"peer-a","url":"https://...","token":"sk_..."}]
 *   SUDO_FEDERATION_INBOUND_TOKENS   — JSON array: ["sk_...", "sk_..."]
 *
 * Peers must have distinct names.
 * Missing/malformed env → empty registry, fail-open.
 *
 * Wave 7E — federation MVP.
 */

import { timingSafeEqual } from 'node:crypto';
import { createLogger } from '../shared/logger.js';

const log = createLogger('federation:peer-registry');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PeerConfig {
  /** Unique short name for this peer (e.g. "peer-a"). */
  name: string;
  /** Full base URL of the peer (e.g. "https://peer-a:18900"). */
  url: string;
  /** Bearer token to present when sending to this peer. */
  token: string;
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

function parsePeers(raw: string | undefined): PeerConfig[] {
  if (!raw || raw.trim() === '') return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) {
      log.warn('SUDO_FEDERATION_PEERS: expected a JSON array — ignoring');
      return [];
    }
    const seen = new Set<string>();
    const result: PeerConfig[] = [];
    for (const item of arr) {
      if (typeof item !== 'object' || item === null) continue;
      const { name, url, token } = item as Record<string, unknown>;
      if (typeof name !== 'string' || name.trim() === '') {
        log.warn({ item }, 'SUDO_FEDERATION_PEERS: skipping peer with missing name');
        continue;
      }
      if (typeof url !== 'string' || url.trim() === '') {
        log.warn({ name }, 'SUDO_FEDERATION_PEERS: skipping peer with missing url');
        continue;
      }
      if (typeof token !== 'string' || token.trim() === '') {
        log.warn({ name }, 'SUDO_FEDERATION_PEERS: skipping peer with missing token');
        continue;
      }
      if (seen.has(name)) {
        log.warn({ name }, 'SUDO_FEDERATION_PEERS: duplicate peer name — skipping');
        continue;
      }
      // Validate URL is parseable and uses http(s) scheme only (MEDIUM-1: SSRF via file://, ftp://, etc.)
      try {
        const parsedUrl = new URL(url);
        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
          log.warn({ name, url, protocol: parsedUrl.protocol }, 'SUDO_FEDERATION_PEERS: non-HTTP(S) scheme rejected — skipping');
          continue;
        }
      } catch {
        log.warn({ name, url }, 'SUDO_FEDERATION_PEERS: peer url is not a valid URL — skipping');
        continue;
      }
      seen.add(name);
      result.push({ name: name.trim(), url: url.trim(), token: token.trim() });
    }
    return result;
  } catch (err) {
    log.warn({ err: String(err) }, 'SUDO_FEDERATION_PEERS: JSON parse failed — empty peer list');
    return [];
  }
}

function parseInboundTokens(raw: string | undefined): Buffer[] {
  if (!raw || raw.trim() === '') return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) {
      log.warn('SUDO_FEDERATION_INBOUND_TOKENS: expected a JSON array — ignoring');
      return [];
    }
    const result: Buffer[] = [];
    for (const item of arr) {
      if (typeof item !== 'string' || item.trim() === '') continue;
      result.push(Buffer.from(item, 'utf8'));
    }
    return result;
  } catch (err) {
    log.warn({ err: String(err) }, 'SUDO_FEDERATION_INBOUND_TOKENS: JSON parse failed — empty token list');
    return [];
  }
}

// ---------------------------------------------------------------------------
// PeerRegistry class
// ---------------------------------------------------------------------------

export class PeerRegistry {
  private readonly peers: Map<string, PeerConfig>;
  private readonly inboundTokenBufs: Buffer[];

  constructor(peersEnv?: string, inboundTokensEnv?: string) {
    const peerList = parsePeers(peersEnv);
    this.peers = new Map(peerList.map(p => [p.name, p]));
    this.inboundTokenBufs = parseInboundTokens(inboundTokensEnv);

    log.info(
      { peersConfigured: this.peers.size, inboundTokensConfigured: this.inboundTokenBufs.length },
      'PeerRegistry initialised',
    );
  }

  /** Returns all configured peers. */
  getPeers(): PeerConfig[] {
    return Array.from(this.peers.values());
  }

  /** Returns a peer by name, or undefined if not found. */
  getPeer(name: string): PeerConfig | undefined {
    return this.peers.get(name);
  }

  /**
   * Timing-safe comparison of a candidate inbound bearer token.
   * Returns false if no inbound tokens are configured (fail-closed for inbound).
   */
  isInboundTokenValid(candidate: string): boolean {
    if (this.inboundTokenBufs.length === 0) return false;
    const candidateBuf = Buffer.from(candidate, 'utf8');
    for (const tokenBuf of this.inboundTokenBufs) {
      if (candidateBuf.length === tokenBuf.length && timingSafeEqual(candidateBuf, tokenBuf)) {
        return true;
      }
    }
    return false;
  }

  /** Static factory — reads from process.env. */
  static fromEnv(): PeerRegistry {
    return new PeerRegistry(
      process.env['SUDO_FEDERATION_PEERS'],
      process.env['SUDO_FEDERATION_INBOUND_TOKENS'],
    );
  }
}
