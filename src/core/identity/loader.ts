/**
 * @file identity/loader.ts
 * @description Factory that reads operator identity config files and exposes
 *              an advisory-only pre-tool hook.
 *
 * The loader is pure transport — it reads files, validates structure, and
 * makes content available. It NEVER editorialises, enforces, or semantically
 * validates file content. The verify() method ALWAYS returns { ok: true }.
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { createLogger } from '../shared/logger.js';
import type { AuditTrail } from '../security/audit-trail.js';
import type {
  IdentityAnchor,
  ValuesShape,
  ProhibitionsShape,
  HookResult,
  ToolCallDescriptor,
  HookContext,
} from './types.js';

const log = createLogger('identity:loader');

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Read a UTF-8 file and return its trimmed content.
 * Returns null when the file is absent, empty, or contains a NUL byte.
 */
function readTextFile(filePath: string, label: string): string | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const raw = fs.readFileSync(filePath, 'utf-8');
    if (raw.includes('\x00')) {
      log.warn({ file: label }, 'NUL byte detected in file — ignoring');
      return null;
    }
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      log.debug({ file: label }, 'File is empty — treating as absent');
      return null;
    }
    return trimmed;
  } catch (err) {
    log.warn({ file: label, err: String(err) }, 'Failed to read file — treating as absent');
    return null;
  }
}

/**
 * Load and validate core-identity.md — returns the raw text or null.
 */
function loadIdentity(configDir: string): string | null {
  const filePath = path.join(configDir, 'core-identity.md');
  const content = readTextFile(filePath, 'core-identity.md');
  if (content !== null) {
    log.info({ bytes: content.length }, 'Loaded core-identity.md (%d bytes)', content.length);
  }
  return content;
}

/**
 * Load and validate values.json — returns a plain object or null.
 */
function loadValues(configDir: string): ValuesShape | null {
  const filePath = path.join(configDir, 'values.json');
  const content = readTextFile(filePath, 'values.json');
  if (content === null) return null;

  try {
    const parsed: unknown = JSON.parse(content);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      log.info('Loaded values.json successfully');
      return parsed as ValuesShape;
    }
    log.warn('values.json root must be a non-array object — ignoring');
    return null;
  } catch (err) {
    log.warn({ err: String(err) }, 'Failed to parse values.json — ignoring');
    return null;
  }
}

/**
 * Load and validate hard-prohibitions.yaml — returns a string[] or null.
 */
function loadProhibitions(configDir: string): ProhibitionsShape | null {
  const filePath = path.join(configDir, 'hard-prohibitions.yaml');
  const content = readTextFile(filePath, 'hard-prohibitions.yaml');
  if (content === null) return null;

  try {
    const parsed: unknown = yaml.load(content);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
      log.info({ count: parsed.length }, 'Loaded hard-prohibitions.yaml (%d entries)', parsed.length);
      return parsed as ProhibitionsShape;
    }
    log.warn('hard-prohibitions.yaml must be a YAML array of strings — ignoring');
    return null;
  } catch (err) {
    log.warn({ err: String(err) }, 'Failed to parse hard-prohibitions.yaml — ignoring');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Instance interface for the identity loader.
 * verify() is ALWAYS advisory — it never returns ok:false.
 */
export interface IdentityLoaderInstance {
  /** Resolved operator identity anchor (populated at construction time). */
  readonly anchor: IdentityAnchor;
  /**
   * Advisory pre-tool hook.
   * ALWAYS returns { ok: true }. If the tool name appears in the prohibitions
   * list, an advisory note is included — callers may log it but must not block.
   */
  verify(call: ToolCallDescriptor, ctx: HookContext): HookResult;
}

/**
 * Create an IdentityLoader that reads operator config from configDir.
 *
 * @param configDir   - Absolute path to the operator config directory.
 * @param auditTrail  - Optional AuditTrail reference (reserved for future use).
 */
export function createIdentityLoader(
  configDir: string,
  auditTrail?: AuditTrail,
): IdentityLoaderInstance {
  if (!configDir || typeof configDir !== 'string') {
    throw new TypeError('createIdentityLoader: configDir must be a non-empty string');
  }

  // Suppress unused-variable warning — parameter is part of the public API
  // and will be wired by a future builder.
  void auditTrail;

  log.info({ configDir }, 'Initialising identity loader');

  const anchor: IdentityAnchor = {
    identity: loadIdentity(configDir),
    values: loadValues(configDir),
    prohibitions: loadProhibitions(configDir),
  };

  log.info(
    {
      hasIdentity: anchor.identity !== null,
      hasValues: anchor.values !== null,
      hasProhibitions: anchor.prohibitions !== null,
    },
    'Identity anchor resolved',
  );

  return {
    anchor,

    verify(call: ToolCallDescriptor, ctx: HookContext): HookResult {
      if (anchor.prohibitions !== null && anchor.prohibitions.includes(call.name)) {
        const advisory = `Tool '${call.name}' appears in operator prohibitions list`;
        log.debug(
          { tool: call.name, sessionId: ctx.sessionId, actor: ctx.actor },
          advisory,
        );
        return { ok: true, advisory };
      }
      return { ok: true };
    },
  };
}
