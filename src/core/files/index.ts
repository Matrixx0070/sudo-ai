/**
 * @file index.ts
 * @description Public API for the Files module (Wave 5 P2).
 *
 * Usage:
 *   import { registerFileRoutes, FileStore, mountFilesForSession } from './core/files/index.js';
 */

export { FileStore, computeSha256 } from './store.js';
export { registerFileRoutes } from './routes.js';
export {
  FileStoreError,
  MAX_FILE_BYTES,
  MAX_FILES_PER_SESSION,
  validateMimeMagic,
  validateFilename,
  detectMime,
  normaliseMime,
  type FileRow,
  type FileMetadata,
  type CreateFileInput,
  type ListFilesOptions,
} from './types.js';

/**
 * Convenience re-export of the mount function via FileStore.
 * Callers should prefer constructing a FileStore and calling
 * store.mountFilesForSession(sessionId, targetDir) directly.
 */
export type { FileStore as IFileStore } from './store.js';
