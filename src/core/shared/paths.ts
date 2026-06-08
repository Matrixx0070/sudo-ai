/**
 * Project path resolution.
 *
 * Historically many modules hard-coded the absolute path `/root/sudo-ai-v4`,
 * which made the project undeployable anywhere else (other users, Docker,
 * non-root accounts, CI runners). This module centralises root resolution so
 * the project is portable.
 *
 * Resolution order:
 *   1. `SUDO_AI_HOME` environment variable (matches ecosystem.config.cjs), if set.
 *   2. The current working directory (`process.cwd()`).
 *
 * On the original development machine, the process runs from `/root/sudo-ai-v4`,
 * so `process.cwd()` resolves to the same path the constants used to hard-code —
 * i.e. this change is behaviour-preserving there, while making every other
 * environment work by setting `SUDO_AI_HOME` or launching from the project dir.
 */
import path from 'node:path';

/** Absolute path to the project root. */
export const PROJECT_ROOT: string = process.env['SUDO_AI_HOME']
  ? path.resolve(process.env['SUDO_AI_HOME'])
  : process.cwd();

/** `<root>/data` — databases and runtime state. */
export const DATA_DIR: string = path.join(PROJECT_ROOT, 'data');

/** `<root>/workspace` — agent working area. */
export const WORKSPACE_DIR: string = path.join(PROJECT_ROOT, 'workspace');

/** `<root>/data/mind.db` — the primary SQLite database. */
export const MIND_DB: string = path.join(DATA_DIR, 'mind.db');

/** Join one or more segments onto the project root. */
export function projectPath(...segments: string[]): string {
  return path.join(PROJECT_ROOT, ...segments);
}

/** Join one or more segments onto the data directory. */
export function dataPath(...segments: string[]): string {
  return path.join(DATA_DIR, ...segments);
}
