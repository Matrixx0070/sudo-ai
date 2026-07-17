/**
 * @file gdrive/ocr.ts
 * @description F15 — Drive's import conversion as a zero-model-cost OCR path.
 *
 * Upload the image / scanned PDF with conversion to a temporary Google Doc
 * (ocrLanguage set) -> export text/plain -> trash the temp Doc. Vision
 * subagent stays out of the pipeline unless actual visual REASONING is
 * needed (that routing lives with the caller).
 */

import { Readable } from 'node:stream';
import { createLogger } from '../shared/logger.js';
import type { DriveClient } from './client.js';
import type { FolderIdMap } from './types.js';

const log = createLogger('gdrive:ocr');

export const OCR_CONVERTIBLE_MIMES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/bmp',
  'image/webp',
  'image/tiff',
]);

export interface OcrResult {
  text: string;
  /** True when the OCR path produced usable text; false = caller falls back. */
  ok: boolean;
}

/** Heuristic: garbage/empty exports mean the conversion failed. */
export function looksLikeUsableText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 8) return false;
  const printable = trimmed.replace(/[^\p{L}\p{N}\p{P}\s]/gu, '').length;
  return printable / trimmed.length > 0.7;
}

/**
 * OCR via Drive import conversion. The temp Doc is created inside the
 * quarantine folder (it is derived from untrusted input) and trashed in a
 * finally block — a crash never leaves readable converted copies around.
 */
export async function ocrViaDriveImport(
  client: DriveClient,
  folders: FolderIdMap,
  name: string,
  content: Buffer,
  mimeType: string,
  ocrLanguage = 'en',
): Promise<OcrResult> {
  const qFolder = folders['knowledge/quarantine'];
  if (!qFolder) throw new Error('gdrive ocr: knowledge/quarantine folder id missing');

  const temp = await client.filesImportAsGoogleDoc(
    `.ocr-temp-${name}`,
    qFolder,
    { mimeType, body: Readable.from(content) },
    ocrLanguage,
  );
  try {
    const text = await client.filesExport(temp.id, 'text/plain');
    const ok = looksLikeUsableText(text);
    if (!ok) log.warn({ name, bytes: content.length }, 'OCR export empty/garbage — caller should fall back');
    return { text, ok };
  } finally {
    try {
      await client.filesUpdate(temp.id, { trashed: true });
    } catch (err) {
      log.warn({ err: String(err), tempId: temp.id }, 'failed to trash OCR temp doc');
    }
  }
}
