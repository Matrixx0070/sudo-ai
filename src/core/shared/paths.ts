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
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Absolute path to the project root. */
export const PROJECT_ROOT: string = process.env['SUDO_AI_HOME']
  ? path.resolve(process.env['SUDO_AI_HOME'])
  : process.cwd();

/**
 * `<root>/data` — databases and runtime state.
 *
 * Honors the `DATA_DIR` env override — the same variable ecosystem.config.cjs
 * sets for prod/staging isolation and that runtime modules (cli.ts trackers,
 * agent/loop.ts, profiles) read at call time. Without this, modules
 * importing the constant would write into `<root>/data` even when a staging
 * instance points DATA_DIR elsewhere. Captured at module load: overrides set
 * later in-process (e.g. the TUI adapter's private dir) intentionally do not
 * move this constant.
 */
export const DATA_DIR: string = process.env['DATA_DIR']
  ? path.resolve(process.env['DATA_DIR'])
  : path.join(PROJECT_ROOT, 'data');

/** `<root>/workspace` — agent working area. */
export const WORKSPACE_DIR: string = path.join(PROJECT_ROOT, 'workspace');

/** `<root>/data/mind.db` — the primary SQLite database. */
export const MIND_DB: string = path.join(DATA_DIR, 'mind.db');

/** npm package name — used to recognise the package root when walking up. */
const PACKAGE_NAME = '@matrixx0070/sudo-ai';

/**
 * Resolve the PACKAGE root — the directory the installed/checked-out package
 * lives in (contains `package.json` and the shipped `dist/`). This is where
 * BUNDLED assets (e.g. the built renderer SPA) must be read from.
 *
 * This is deliberately distinct from PROJECT_ROOT: PROJECT_ROOT is the user's
 * working root (cwd / SUDO_AI_HOME) and owns user DATA (config, data/,
 * workspace/). In a repo checkout the two coincide; in an npm install the
 * daemon's cwd is the user's dir while the code + shipped assets live under
 * `node_modules/@matrixx0070/sudo-ai` — so shipped-asset reads must anchor on
 * the module's own location, never on cwd.
 *
 * Mechanism: start from THIS module's file (import.meta.url) and walk up to
 * the nearest directory whose `package.json` names this package, or failing
 * that, the nearest ancestor holding both `package.json` and a `dist/` dir.
 * No fixed `..` count — the module depth differs between the tsx run
 * (`src/core/shared/paths.ts`), the transpiled daemon graph
 * (`dist/src/core/shared/paths.js`), and the esbuild CLI bundle
 * (`dist/server/cli.js`); the upward walk lands on the same root in all three.
 */
function resolvePackageRoot(): string {
  let start: string | undefined;
  try {
    start = path.dirname(fileURLToPath(import.meta.url));
  } catch {
    start = undefined;
  }
  if (start) {
    // Pass 1: exact package.json name match.
    for (let dir = start; ; ) {
      const pkg = path.join(dir, 'package.json');
      try {
        if (fs.existsSync(pkg)) {
          const name = (JSON.parse(fs.readFileSync(pkg, 'utf-8')) as { name?: string }).name;
          if (name === PACKAGE_NAME) return dir;
        }
      } catch { /* unreadable/invalid package.json — keep walking */ }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    // Pass 2: nearest ancestor with package.json + dist/ (renamed forks).
    for (let dir = start; ; ) {
      if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'dist'))) {
        return dir;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  // Last resort: behave like the legacy cwd-based resolution.
  return PROJECT_ROOT;
}

/** Absolute path to the package install root (cached at module load). */
export const PACKAGE_ROOT: string = resolvePackageRoot();

/**
 * Join one or more segments onto the PACKAGE root. Use for assets the package
 * SHIPS (dist/renderer SPA, bundled templates) — never for user data.
 */
export function packagePath(...segments: string[]): string {
  return path.join(PACKAGE_ROOT, ...segments);
}

/** Join one or more segments onto the project root. */
export function projectPath(...segments: string[]): string {
  return path.join(PROJECT_ROOT, ...segments);
}

/** Join one or more segments onto the data directory. */
export function dataPath(...segments: string[]): string {
  return path.join(DATA_DIR, ...segments);
}
