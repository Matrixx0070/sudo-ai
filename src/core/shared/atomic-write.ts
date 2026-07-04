/**
 * @file shared/atomic-write.ts
 * @description Crash-safe file write: serialise to a temp file then rename over
 * the target. rename is atomic on POSIX, so a crash / disk-full mid-write leaves
 * either the previous complete file or the temp — NEVER a truncated target.
 *
 * Use for any critical state file where a torn write means data loss or a broken
 * daemon: credential/token stores, session indexes, config. For a secret file,
 * pass `mode` so the temp is created with the same restrictive permissions and
 * the secret is never briefly world-readable.
 */
import { writeFileSync, renameSync } from 'node:fs';

export function writeFileAtomic(
  filePath: string,
  data: string,
  options?: { mode?: number; encoding?: BufferEncoding },
): void {
  const tmp = `${filePath}.tmp`;
  const opts: { encoding: BufferEncoding; mode?: number } = {
    encoding: options?.encoding ?? 'utf8',
    ...(options?.mode !== undefined ? { mode: options.mode } : {}),
  };
  writeFileSync(tmp, data, opts);
  renameSync(tmp, filePath);
}
