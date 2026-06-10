/**
 * @file types.ts
 * @description Type definitions for the Files API.
 *
 * Mirrors Anthropic /v1/files resource structure.
 * All inputs are validated before reaching the store.
 */

import { SudoError } from '../shared/errors.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum upload size per file (10 MB). */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Maximum number of active (non-deleted) files per session scope. */
export const MAX_FILES_PER_SESSION = 100;

/** Prefix length for on-disk fanout directory (hex chars of sha256). */
export const STORAGE_PREFIX_LEN = 2;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class FileStoreError extends SudoError {
  constructor(
    message: string,
    code: `file_${string}`,
    details?: Record<string, unknown>,
  ) {
    super(message, code, details);
    Object.setPrototypeOf(this, new.target.prototype);
    (this as unknown as { name: string }).name = 'FileStoreError';
  }
}

// ---------------------------------------------------------------------------
// Database row shape
// ---------------------------------------------------------------------------

export interface FileRow {
  id:           string;
  filename:     string;
  mime:         string;
  size_bytes:   number;
  sha256:       string;
  scope_id:     string;
  storage_path: string;
  uploaded_at:  string;
  deleted_at:   string | null;
}

// ---------------------------------------------------------------------------
// Public API shapes
// ---------------------------------------------------------------------------

/** Metadata returned in list/get responses (never includes storage_path). */
export interface FileMetadata {
  id:          string;
  filename:    string;
  mime:        string;
  size_bytes:  number;
  sha256:      string;
  scope_id:    string;
  uploaded_at: string;
}

/** Input to FileStore.create() after upload validation. */
export interface CreateFileInput {
  filename:    string;
  mime:        string;
  size_bytes:  number;
  sha256:      string;
  scope_id:    string;
  storage_path: string;
}

/** Options for FileStore.list(). */
export interface ListFilesOptions {
  scope_id?: string;
  limit?:    number;
  offset?:   number;
}

// ---------------------------------------------------------------------------
// MIME magic-byte signatures
// ---------------------------------------------------------------------------

export interface MimeSignature {
  mime:      string;
  offset:    number;
  bytes:     number[];
}

export const MIME_SIGNATURES: MimeSignature[] = [
  { mime: 'application/pdf',  offset: 0, bytes: [0x25, 0x50, 0x44, 0x46] },          // %PDF
  { mime: 'image/png',        offset: 0, bytes: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] },
  { mime: 'image/jpeg',       offset: 0, bytes: [0xFF, 0xD8, 0xFF] },
  { mime: 'application/zip',  offset: 0, bytes: [0x50, 0x4B, 0x03, 0x04] },           // PK
];

/**
 * Normalise a MIME type for comparison.
 * Strips parameters (e.g. `application/pdf; charset=utf-8` → `application/pdf`).
 */
export function normaliseMime(mime: string): string {
  return mime.split(';')[0]!.trim().toLowerCase();
}

/**
 * Detect MIME type from buffer magic bytes.
 * Returns the matched MIME string or null if unknown.
 */
export function detectMime(buf: Buffer): string | null {
  for (const sig of MIME_SIGNATURES) {
    if (buf.length < sig.offset + sig.bytes.length) continue;
    const match = sig.bytes.every(
      (b, i) => buf[sig.offset + i] === b,
    );
    if (match) return sig.mime;
  }
  return null;
}

/**
 * Validate that the declared MIME type matches the actual magic bytes.
 * Only enforced for types we can detect (PDF/PNG/JPEG/ZIP).
 * Returns null on pass, error string on mismatch.
 */
export function validateMimeMagic(
  declared: string,
  buf: Buffer,
): string | null {
  const normDeclared = normaliseMime(declared);
  const detected = detectMime(buf);

  // If we can detect the magic bytes, they must match the declaration.
  if (detected !== null && detected !== normDeclared) {
    return `MIME mismatch: declared "${normDeclared}" but magic bytes indicate "${detected}"`;
  }
  // If declared type is one we check but bytes don't match the signature, reject.
  const checkable = MIME_SIGNATURES.map(s => s.mime);
  if (checkable.includes(normDeclared) && detected === null) {
    return `MIME mismatch: declared "${normDeclared}" but magic bytes do not match`;
  }
  return null;
}

/**
 * Validate filename against path-traversal attacks.
 * Returns sanitised basename or null if rejected.
 *
 * Rejection rules (reject outright, do not silently strip):
 *  - null bytes
 *  - any path separator (/ or \)
 *  - any segment equal to .. or .
 *  - empty or whitespace-only string
 */
export function validateFilename(raw: string): string | null {
  if (!raw || typeof raw !== 'string') return null;
  // Reject null bytes
  if (raw.includes('\0')) return null;
  // Reject if the input contains any path separators
  if (raw.includes('/') || raw.includes('\\')) return null;
  // Must not be empty or a dot-only name
  if (raw === '.' || raw === '..') return null;
  // Reject whitespace-only
  if (!raw.trim()) return null;
  // Reject double-quote (would break Content-Disposition header injection)
  if (raw.includes('"')) return null;
  // Reject any character outside printable ASCII (controls \x00-\x1f, DEL \x7f, non-ASCII)
  if (/[^\x20-\x7E]/.test(raw)) return null;
  return raw;
}
