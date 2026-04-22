/**
 * @file state-export.ts
 * @description Upgrade 68 — Export / Import Agent State.
 *
 * Serialises the current agent workspace and structured-memory to a single
 * JSON snapshot, and restores it from such a snapshot.  All paths are
 * resolved relative to the process cwd so the module is portable.
 */

import { createLogger } from '../shared/logger.js';
import { writeFile, readFile, mkdir, readdir } from 'fs/promises';
import path from 'path';

const log = createLogger('persistence:export');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentState {
  version: string;
  exportedAt: string;
  workspace: Record<string, string>;
  memory: Record<string, unknown>;
  config: Record<string, unknown>;
  consciousness?: Record<string, unknown>;
}

export interface ImportResult {
  imported: number;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATE_VERSION   = '5.0';
const WORKSPACE_DIR   = 'workspace';
const MEMORY_DIR      = path.join('data', 'structured-memory');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Export the current agent state to a JSON file at `outputPath`.
 *
 * Collects:
 *  - All `.md` files under `workspace/`
 *  - All `.json` files under `data/structured-memory/`
 *
 * @returns Resolved absolute path to the written file.
 */
export async function exportState(outputPath: string): Promise<string> {
  if (!outputPath) throw new TypeError('outputPath is required');

  const state: AgentState = {
    version:    STATE_VERSION,
    exportedAt: new Date().toISOString(),
    workspace:  {},
    memory:     {},
    config:     {},
  };

  // ---- Workspace files -------------------------------------------------------
  const wsFiles = await safeReaddir(WORKSPACE_DIR);
  for (const f of wsFiles.filter(f => f.endsWith('.md'))) {
    try {
      state.workspace[f] = await readFile(path.join(WORKSPACE_DIR, f), 'utf8');
    } catch (err) {
      log.warn({ file: f, err }, 'Could not read workspace file');
    }
  }

  // ---- Structured memory -----------------------------------------------------
  const memFiles = await safeReaddir(MEMORY_DIR);
  for (const f of memFiles.filter(f => f.endsWith('.json'))) {
    try {
      state.memory[f] = JSON.parse(await readFile(path.join(MEMORY_DIR, f), 'utf8')) as unknown;
    } catch (err) {
      log.warn({ file: f, err }, 'Could not read memory file');
    }
  }

  // ---- Write snapshot --------------------------------------------------------
  const absPath = path.resolve(outputPath);
  await mkdir(path.dirname(absPath), { recursive: true });
  await writeFile(absPath, JSON.stringify(state, null, 2), 'utf8');

  log.info(
    { path: absPath, workspaceFiles: Object.keys(state.workspace).length, memoryFiles: Object.keys(state.memory).length },
    'Agent state exported',
  );
  return absPath;
}

/**
 * Restore agent state from a previously exported snapshot.
 *
 * @returns Count of successfully imported entries and any error messages.
 */
export async function importState(inputPath: string): Promise<ImportResult> {
  if (!inputPath) throw new TypeError('inputPath is required');

  const raw    = await readFile(path.resolve(inputPath), 'utf8');
  const state  = JSON.parse(raw) as AgentState;
  const errors: string[] = [];
  let imported = 0;

  // ---- Restore workspace files -----------------------------------------------
  await mkdir(WORKSPACE_DIR, { recursive: true });
  for (const [name, content] of Object.entries(state.workspace)) {
    try {
      await writeFile(path.join(WORKSPACE_DIR, name), content, 'utf8');
      imported++;
    } catch (err) {
      errors.push(`workspace/${name}: ${(err as Error).message}`);
      log.error({ file: name, err }, 'Failed to restore workspace file');
    }
  }

  // ---- Restore memory --------------------------------------------------------
  await mkdir(MEMORY_DIR, { recursive: true });
  for (const [name, data] of Object.entries(state.memory)) {
    try {
      await writeFile(path.join(MEMORY_DIR, name), JSON.stringify(data, null, 2), 'utf8');
      imported++;
    } catch (err) {
      errors.push(`memory/${name}: ${(err as Error).message}`);
      log.error({ file: name, err }, 'Failed to restore memory file');
    }
  }

  log.info({ imported, errorCount: errors.length }, 'Agent state imported');
  return { imported, errors };
}
