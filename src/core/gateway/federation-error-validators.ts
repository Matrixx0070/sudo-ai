/**
 * @file gateway/federation-error-validators.ts
 * @description Request validators for federation error routes.
 *
 * Wave 2 — Federation Error Protocol.
 */

import type {
  FederationErrorReport,
  FederationFixNotify,
  FederationTokenContribution,
  TokenProvider,
} from './federation-error-types.js';

// Valid severities
const VALID_SEVERITIES: Set<string> = new Set(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);

// Valid providers for token contribution
const VALID_PROVIDERS: Set<TokenProvider> = new Set(['openai', 'anthropic', 'google', 'xai', 'deepseek', 'ollama', 'sudo-mosaic', 'cascade']);

// Token contribution validation limits
const MAX_TOKEN_LENGTH = 4096;
const MAX_PEER_ID_LENGTH = 256;
const MAX_PROVIDER_LENGTH = 64;
const PRINTABLE_ASCII_REGEX = /^[\x20-\x7E]+$/;

export function validateErrorReport(raw: unknown): { valid: boolean; report?: FederationErrorReport; error?: string } {
  if (typeof raw !== 'object' || raw === null) {
    return { valid: false, error: 'Body must be a JSON object' };
  }

  const ev = raw as Record<string, unknown>;

  // Required fields
  if (typeof ev['errorSignature'] !== 'string' || ev['errorSignature'].trim() === '') {
    return { valid: false, error: 'errorSignature is required and must be a non-empty string' };
  }
  if (ev['errorSignature'].length > 500) {
    return { valid: false, error: 'errorSignature must not exceed 500 characters' };
  }
  if (typeof ev['botVersion'] !== 'string' || ev['botVersion'].trim() === '') {
    return { valid: false, error: 'botVersion is required and must be a non-empty string' };
  }
  if (typeof ev['peerId'] !== 'string' || ev['peerId'].trim() === '') {
    return { valid: false, error: 'peerId is required and must be a non-empty string' };
  }
  if (typeof ev['timestamp'] !== 'number' || !Number.isFinite(ev['timestamp'])) {
    return { valid: false, error: 'timestamp must be a number' };
  }
  if (typeof ev['severity'] !== 'string' || !VALID_SEVERITIES.has(ev['severity'])) {
    return { valid: false, error: `severity must be one of: ${Array.from(VALID_SEVERITIES).join(', ')}` };
  }

  // Optional fields with type checks
  if (ev['stackTrace'] !== undefined && typeof ev['stackTrace'] !== 'string') {
    return { valid: false, error: 'stackTrace must be a string' };
  }
  if (ev['toolName'] !== undefined && typeof ev['toolName'] !== 'string') {
    return { valid: false, error: 'toolName must be a string' };
  }
  if (ev['sessionId'] !== undefined && typeof ev['sessionId'] !== 'string') {
    return { valid: false, error: 'sessionId must be a string' };
  }
  if (ev['phase'] !== undefined && typeof ev['phase'] !== 'string') {
    return { valid: false, error: 'phase must be a string' };
  }
  if (ev['meta'] !== undefined && (typeof ev['meta'] !== 'object' || ev['meta'] === null)) {
    return { valid: false, error: 'meta must be an object' };
  }

  const report: FederationErrorReport = {
    errorSignature: ev['errorSignature'] as string,
    botVersion: ev['botVersion'] as string,
    peerId: ev['peerId'] as string,
    timestamp: ev['timestamp'] as number,
    severity: ev['severity'] as FederationErrorReport['severity'],
    stackTrace: typeof ev['stackTrace'] === 'string' ? ev['stackTrace'] : undefined,
    toolName: typeof ev['toolName'] === 'string' ? ev['toolName'] : undefined,
    sessionId: typeof ev['sessionId'] === 'string' ? ev['sessionId'] : undefined,
    phase: typeof ev['phase'] === 'string' ? ev['phase'] : undefined,
    meta: ev['meta'] as Record<string, unknown> | undefined,
  };

  return { valid: true, report };
}

export function validateFixNotify(raw: unknown): { valid: boolean; fix?: FederationFixNotify; error?: string } {
  if (typeof raw !== 'object' || raw === null) {
    return { valid: false, error: 'Body must be a JSON object' };
  }

  const ev = raw as Record<string, unknown>;

  // Required fields
  if (typeof ev['fixCommitHash'] !== 'string' || ev['fixCommitHash'].trim() === '') {
    return { valid: false, error: 'fixCommitHash is required and must be a non-empty string' };
  }
  if (typeof ev['affectedErrorSignature'] !== 'string' || ev['affectedErrorSignature'].trim() === '') {
    return { valid: false, error: 'affectedErrorSignature is required and must be a non-empty string' };
  }
  if (typeof ev['newVersionTag'] !== 'string' || ev['newVersionTag'].trim() === '') {
    return { valid: false, error: 'newVersionTag is required and must be a non-empty string' };
  }

  // Optional fields
  if (ev['updateCommand'] !== undefined && typeof ev['updateCommand'] !== 'string') {
    return { valid: false, error: 'updateCommand must be a string' };
  }
  if (ev['releaseNotes'] !== undefined && typeof ev['releaseNotes'] !== 'string') {
    return { valid: false, error: 'releaseNotes must be a string' };
  }

  const fix: FederationFixNotify = {
    fixCommitHash: ev['fixCommitHash'] as string,
    affectedErrorSignature: ev['affectedErrorSignature'] as string,
    newVersionTag: ev['newVersionTag'] as string,
    updateCommand: typeof ev['updateCommand'] === 'string' ? ev['updateCommand'] : undefined,
    releaseNotes: typeof ev['releaseNotes'] === 'string' ? ev['releaseNotes'] : undefined,
  };

  return { valid: true, fix };
}

export function validateTokenContribution(raw: unknown): { valid: boolean; contribution?: FederationTokenContribution; error?: string } {
  if (typeof raw !== 'object' || raw === null) {
    return { valid: false, error: 'Body must be a JSON object' };
  }

  const ev = raw as Record<string, unknown>;

  // Required fields
  if (typeof ev['peerId'] !== 'string' || ev['peerId'].trim() === '') {
    return { valid: false, error: 'peerId is required and must be a non-empty string' };
  }
  if (typeof ev['provider'] !== 'string' || !VALID_PROVIDERS.has(ev['provider'] as TokenProvider)) {
    return { valid: false, error: `provider must be one of: ${Array.from(VALID_PROVIDERS).join(', ')}` };
  }
  if (typeof ev['token'] !== 'string' || ev['token'].trim() === '') {
    return { valid: false, error: 'token is required and must be a non-empty string' };
  }
  if (ev['expiresAt'] !== undefined && typeof ev['expiresAt'] !== 'string') {
    return { valid: false, error: 'expiresAt must be a string' };
  }

  // Defense-in-depth: validate token contribution constraints
  if (ev['peerId'].length > MAX_PEER_ID_LENGTH) {
    return { valid: false, error: `peerId must not exceed ${MAX_PEER_ID_LENGTH} characters` };
  }
  if (ev['provider'].length > MAX_PROVIDER_LENGTH) {
    return { valid: false, error: `provider must not exceed ${MAX_PROVIDER_LENGTH} characters` };
  }
  if (ev['token'].length > MAX_TOKEN_LENGTH) {
    return { valid: false, error: `token must not exceed ${MAX_TOKEN_LENGTH} characters` };
  }
  if (!PRINTABLE_ASCII_REGEX.test(ev['token'] as string)) {
    return { valid: false, error: 'token must contain only printable ASCII characters' };
  }

  const contribution: FederationTokenContribution = {
    peerId: ev['peerId'] as string,
    provider: ev['provider'] as TokenProvider,
    token: ev['token'] as string,
    expiresAt: typeof ev['expiresAt'] === 'string' ? ev['expiresAt'] : undefined,
  };

  return { valid: true, contribution };
}
