/**
 * @file operators/operator-loader.ts
 * @description Loads OperatorManifest[] from workspace/operators/*.toml files.
 *
 * Usage:
 *   const loader = new OperatorLoader('/path/to/project-root');
 *   const manifests = await loader.loadAll();
 */

import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../shared/logger.js';
import type { OperatorManifest } from '../shared/wave10-types.js';
import type { OperatorLoadResult } from './operator-types.js';

const log = createLogger('operators:loader');

const OPERATORS_DIR = 'workspace/operators';

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function validateManifest(raw: Record<string, unknown>, filePath: string): OperatorManifest {
  const name = typeof raw['name'] === 'string' ? raw['name'] : '';
  if (!name) throw new Error(`Missing required field 'name' in ${filePath}`);

  const version = typeof raw['version'] === 'string' ? raw['version'] : '1.0.0';
  const description = typeof raw['description'] === 'string' ? raw['description'] : '';
  const enabled = typeof raw['enabled'] === 'boolean' ? raw['enabled'] : true;

  // agent section
  const rawAgent = (raw['agent'] ?? {}) as Record<string, unknown>;
  const agent = {
    max_turns: typeof rawAgent['max_turns'] === 'number' ? rawAgent['max_turns'] : undefined,
    temperature: typeof rawAgent['temperature'] === 'number' ? rawAgent['temperature'] : undefined,
    tools: Array.isArray(rawAgent['tools'])
      ? (rawAgent['tools'] as unknown[]).filter((t) => typeof t === 'string') as string[]
      : undefined,
    prompt_path: typeof rawAgent['prompt_path'] === 'string' ? rawAgent['prompt_path'] : undefined,
    prompt: typeof rawAgent['prompt'] === 'string' ? rawAgent['prompt'] : undefined,
  };

  // schedule section
  const rawSchedule = raw['schedule'] as Record<string, unknown> | undefined;
  if (!rawSchedule) throw new Error(`Missing required field 'schedule' in ${filePath}`);

  const scheduleType = rawSchedule['type'];
  if (scheduleType !== 'interval' && scheduleType !== 'cron') {
    throw new Error(`schedule.type must be 'interval' or 'cron' in ${filePath}`);
  }
  const scheduleValue = rawSchedule['value'];
  if (typeof scheduleValue !== 'string' && typeof scheduleValue !== 'number') {
    throw new Error(`schedule.value must be string or number in ${filePath}`);
  }

  const tags = Array.isArray(raw['tags'])
    ? (raw['tags'] as unknown[]).filter((t) => typeof t === 'string') as string[]
    : undefined;

  return {
    name,
    version,
    description,
    enabled,
    agent,
    schedule: { type: scheduleType, value: scheduleValue },
    tags,
  };
}

// ---------------------------------------------------------------------------
// OperatorLoader
// ---------------------------------------------------------------------------

export class OperatorLoader {
  private readonly operatorsDir: string;

  /**
   * @param projectRoot - Absolute path to the project root.
   */
  constructor(projectRoot: string = process.cwd()) {
    this.operatorsDir = path.resolve(projectRoot, OPERATORS_DIR);
  }

  /**
   * Load all *.toml files from workspace/operators/.
   * Files that fail to parse are logged and skipped.
   * Disabled operators (enabled: false) are included in results but filtered
   * by the scheduler.
   *
   * @returns Array of OperatorManifest for all successfully parsed operators.
   */
  async loadAll(): Promise<OperatorManifest[]> {
    if (!fs.existsSync(this.operatorsDir)) {
      log.warn({ dir: this.operatorsDir }, 'Operators directory not found — no operators loaded');
      return [];
    }

    const entries = fs.readdirSync(this.operatorsDir).filter((f) => f.endsWith('.toml'));
    if (entries.length === 0) {
      log.info({ dir: this.operatorsDir }, 'No TOML operator files found');
      return [];
    }

    const results = await Promise.all(
      entries.map((entry) => this.loadOne(path.join(this.operatorsDir, entry))),
    );

    const manifests = results
      .filter((r): r is OperatorLoadResult & { manifest: OperatorManifest } => r.manifest !== null)
      .map((r) => r.manifest);

    log.info(
      { total: entries.length, loaded: manifests.length, dir: this.operatorsDir },
      'Operators loaded',
    );
    return manifests;
  }

  /**
   * Load and parse a single TOML operator file.
   *
   * @param filePath - Absolute path to the .toml file.
   */
  async loadOne(filePath: string): Promise<OperatorLoadResult> {
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.error({ filePath, error }, 'Failed to read operator TOML file');
      return { filePath, manifest: null, error };
    }

    let parsed: Record<string, unknown>;
    try {
      const { parse } = await import('smol-toml');
      parsed = parse(raw) as Record<string, unknown>;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.error({ filePath, error }, 'Failed to parse operator TOML');
      return { filePath, manifest: null, error };
    }

    try {
      const manifest = validateManifest(parsed, filePath);
      log.debug({ name: manifest.name, filePath }, 'Operator manifest loaded');
      return { filePath, manifest };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.error({ filePath, error }, 'Operator manifest validation failed');
      return { filePath, manifest: null, error };
    }
  }
}
