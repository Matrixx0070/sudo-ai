/**
 * @file economy/did.ts
 * @description AgentIdentity — decentralized identifier (DID) for SUDO-AI agent.
 *
 * Generates a deterministic DID from the agent's environment, signs payloads
 * with HMAC-SHA256, and exposes a read-only public profile.
 */

import { createHash, createHmac } from 'node:crypto';
import { createLogger } from '../shared/logger.js';

const log = createLogger('economy:did');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AgentProfile {
  did: string;
  name: string;
  version: string;
  capabilities: string[];
  createdAt: string;
}

// ---------------------------------------------------------------------------
// AgentIdentity
// ---------------------------------------------------------------------------

export class AgentIdentity {
  private readonly did: string;
  private readonly secret: string;
  private readonly profile: AgentProfile;

  constructor(
    agentId: string,
    agentName: string = 'SUDO-AI',
    version: string = '5.0.0',
  ) {
    if (!agentId) throw new Error('agentId is required');

    this.secret = createHash('sha256')
      .update(`${agentId}:${process.env['HOME'] ?? ''}`)
      .digest('hex');

    this.did = `did:sudo:${this.secret.slice(0, 32)}`;

    this.profile = {
      did: this.did,
      name: agentName,
      version,
      capabilities: ['chat', 'code', 'browser', 'tools', 'earn', 'voice'],
      createdAt: new Date().toISOString(),
    };

    log.info({ did: this.did, name: agentName, version }, 'AgentIdentity created');
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  getDID(): string {
    return this.did;
  }

  getPublicProfile(): AgentProfile {
    return { ...this.profile };
  }

  /**
   * Sign an arbitrary payload string using HMAC-SHA256 with the agent secret.
   * Returns a hex digest.
   */
  sign(payload: string): string {
    if (!payload) throw new Error('Payload is required for signing');
    return createHmac('sha256', this.secret).update(payload).digest('hex');
  }

  /**
   * Verify that a signature was produced by this identity over the given payload.
   * Uses constant-time comparison to prevent timing oracle attacks.
   */
  verify(payload: string, signature: string): boolean {
    if (!payload || !signature) return false;
    const expected = this.sign(payload);
    // Constant-time comparison via XOR over equal-length strings.
    if (expected.length !== signature.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) {
      diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
    }
    return diff === 0;
  }
}
