/**
 * @file admin/guidance-io.ts
 * @description BO10 / scorecard-S10 — filesystem + hash-audit layer for the
 * guidance-file viewer and its gated, audited writer.
 *
 * Reads are unconditional (frozen files are shown, never written). Writes are:
 *   1. FROZEN-REJECTED — `writeGuidanceAudited` throws before any I/O if the spec
 *      is frozen (defense in depth; the handler also rejects earlier).
 *   2. PATH-GUARDED — the resolved absolute path must stay inside the root dir.
 *   3. HASH-AUDITED — sha256(before)/sha256(after) + byte counts are appended to
 *      `data/guidance-audit.jsonl`, and the prior content is preserved as a
 *      sibling `.bak` before the new bytes land. Mirrors the settings GUI's
 *      `.bak` discipline; does NOT invent a parallel unaudited writer.
 *
 * `rootDir` and `auditPath` are injectable so tests exercise the audited write
 * against a temp copy without ever touching the real prod workspace.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PROJECT_ROOT, DATA_DIR } from '../../shared/paths.js';
import { createLogger } from '../../shared/logger.js';
import {
  isFrozenGuidanceSpec,
  type GuidanceFileSpec,
} from '../../workspace/guidance-registry.js';

const log = createLogger('api:admin:guidance-io');

/** Default audit ledger path (append-only JSONL). */
export const GUIDANCE_AUDIT_PATH = path.join(DATA_DIR, 'guidance-audit.jsonl');

/** Max editable content size accepted by a write (defensive cap). */
export const MAX_GUIDANCE_BYTES = 256 * 1024;

/** Hex sha256 of a UTF-8 string. */
export function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** Read shape returned to the viewer. */
export interface GuidanceReadResult {
  name: string;
  relPath: string;
  label: string;
  category: GuidanceFileSpec['category'];
  frozen: boolean;
  exists: boolean;
  content: string;
  bytes: number;
  sha256: string;
  lastModified: string | null;
}

/** Audit record returned by a successful write (also appended to the ledger). */
export interface GuidanceWriteAudit {
  ok: true;
  name: string;
  relPath: string;
  configHashBefore: string;
  configHashAfter: string;
  bytesBefore: number;
  bytesAfter: number;
  bakPath: string | null;
  ts: string;
}

/**
 * Resolve `relPath` against `rootDir` and assert it does not escape. Any result
 * outside the root (via `..`, absolute smuggling, symlink-style prefixes) throws.
 */
export function resolveWithinRoot(rootDir: string, relPath: string): string {
  const root = path.resolve(rootDir);
  const abs = path.resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`path escapes root: ${relPath}`);
  }
  return abs;
}

/** Read a guidance file (frozen or not). Missing file → exists:false, empty content. */
export function readGuidance(spec: GuidanceFileSpec, rootDir: string = PROJECT_ROOT): GuidanceReadResult {
  const frozen = isFrozenGuidanceSpec(spec);
  const abs = resolveWithinRoot(rootDir, spec.relPath);
  let content = '';
  let exists = false;
  let lastModified: string | null = null;
  try {
    if (fs.existsSync(abs)) {
      const raw = fs.readFileSync(abs, 'utf-8');
      // NUL-byte guard: treat binary junk as absent rather than surfacing it.
      if (!raw.includes('\x00')) {
        content = raw;
        exists = true;
        lastModified = fs.statSync(abs).mtime.toISOString();
      }
    }
  } catch (err) {
    log.warn({ err: String(err), relPath: spec.relPath }, 'readGuidance failed — treating as absent');
  }
  return {
    name: spec.name,
    relPath: spec.relPath,
    label: spec.label,
    category: spec.category,
    frozen,
    exists,
    content,
    bytes: Buffer.byteLength(content, 'utf8'),
    sha256: sha256(content),
    lastModified,
  };
}

/** Options for an audited guidance write. */
export interface GuidanceWriteOpts {
  spec: GuidanceFileSpec;
  content: string;
  actor?: string;
  rootDir?: string;
  auditPath?: string;
}

/**
 * Perform a gated, hash-audited write of a NON-FROZEN guidance file.
 *
 * Throws (never writes) when:
 *   - the spec is frozen (invariant 4 — defense in depth),
 *   - content is not a string / exceeds MAX_GUIDANCE_BYTES,
 *   - the resolved path escapes `rootDir`.
 *
 * On success: writes a `.bak` of the prior bytes (when the file existed), writes
 * the new content, appends a hash-audited record to the ledger, returns the audit.
 */
export function writeGuidanceAudited(opts: GuidanceWriteOpts): GuidanceWriteAudit {
  const { spec, content, actor = 'admin' } = opts;
  const rootDir = opts.rootDir ?? PROJECT_ROOT;
  const auditPath = opts.auditPath ?? GUIDANCE_AUDIT_PATH;

  // 1. Invariant 4 — frozen files have NO write path. Reject before any I/O.
  if (isFrozenGuidanceSpec(spec)) {
    throw new Error(`frozen file is read-only: ${spec.relPath}`);
  }
  // 2. Content validation.
  if (typeof content !== 'string') {
    throw new TypeError('content must be a string');
  }
  const bytesAfter = Buffer.byteLength(content, 'utf8');
  if (bytesAfter > MAX_GUIDANCE_BYTES) {
    throw new Error(`content exceeds ${MAX_GUIDANCE_BYTES} bytes`);
  }
  if (content.includes('\x00')) {
    throw new Error('content contains a NUL byte');
  }

  // 3. Path guard.
  const abs = resolveWithinRoot(rootDir, spec.relPath);

  // 4. Read prior content for the before-hash + backup.
  let before = '';
  let existed = false;
  if (fs.existsSync(abs)) {
    before = fs.readFileSync(abs, 'utf-8');
    existed = true;
  }
  const configHashBefore = sha256(before);
  const configHashAfter = sha256(content);

  // Ensure the parent dir exists (workspace/ may be bare in a fresh checkout).
  fs.mkdirSync(path.dirname(abs), { recursive: true });

  // 5. Backup prior bytes before overwriting.
  let bakPath: string | null = null;
  if (existed) {
    bakPath = abs + '.bak';
    fs.writeFileSync(bakPath, before, 'utf-8');
  }

  // 6. Write the new content.
  fs.writeFileSync(abs, content, 'utf-8');

  // 7. Hash-audit record (append-only JSONL).
  const record: GuidanceWriteAudit & { op: 'write'; actor: string } = {
    ok: true,
    op: 'write',
    actor,
    name: spec.name,
    relPath: spec.relPath,
    configHashBefore,
    configHashAfter,
    bytesBefore: Buffer.byteLength(before, 'utf8'),
    bytesAfter,
    bakPath,
    ts: new Date().toISOString(),
  };
  try {
    fs.mkdirSync(path.dirname(auditPath), { recursive: true });
    fs.appendFileSync(auditPath, JSON.stringify(record) + '\n', 'utf-8');
  } catch (err) {
    log.error({ err: String(err), auditPath }, 'guidance audit append failed (write already applied)');
  }
  log.info(
    { name: spec.name, configHashBefore, configHashAfter, bytesAfter },
    'guidance file written (hash-audited)',
  );

  return {
    ok: true,
    name: spec.name,
    relPath: spec.relPath,
    configHashBefore,
    configHashAfter,
    bytesBefore: record.bytesBefore,
    bytesAfter,
    bakPath,
    ts: record.ts,
  };
}
