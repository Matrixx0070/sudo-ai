/**
 * Skill Loader — loads compiled skills from mind.db at startup and registers
 * each as a ToolDefinition in the ToolRegistry.
 *
 * Pattern mirrors `loadBuiltinTools` in src/core/tools/loader.ts:
 *   1. Read enabled skills from mind.db skills table.
 *   2. For each, dynamically import the entry_path module.
 *   3. Call the module's exported `registerSkill(registry)` function.
 *   4. Log a summary.
 *
 * Individual skill load failures are isolated — a broken skill does not
 * block other skills or built-in tools from loading.
 */

import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createLogger } from '../shared/logger.js';
import type { ToolRegistry } from '../tools/registry.js';
import { DEFAULT_TIER_CAPS } from '../shared/wave10-types.js';
import type { SkillTrustTier } from '../shared/wave10-types.js';
import { intersectCapabilities } from './trust-policy.js';

const logger = createLogger('skill-loader');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_DB_PATH = resolve(process.cwd(), 'data', 'mind.db');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SkillDbRow {
  name: string;
  version: string;
  description: string | null;
  entry_path: string;
  input_schema: string;
  output_schema: string;
  // Optional trust tier and caps columns (may not exist in older DBs)
  trust_tier?: string;
  caps_json?: string;
}

// ---------------------------------------------------------------------------
// Capability enforcement at load time
// ---------------------------------------------------------------------------

/**
 * Enforce the DEFAULT_TIER_CAPS policy for a skill at load time.
 * Returns only the capabilities that are permitted for the given trust tier.
 * Skills with caps outside their tier are trimmed (not rejected) at load —
 * rejection happens at attach/import time for strict mode.
 *
 * @param claimed - Capability strings from the skill's caps_json.
 * @param tier    - Trust tier assigned to the skill.
 * @returns Permitted subset of claimed capabilities.
 */
export function enforceCapabilityPolicy(
  claimed: string[],
  tier: SkillTrustTier,
): string[] {
  if (claimed.length === 0) return [];
  const permitted = intersectCapabilities(claimed, tier);
  if (permitted.length < claimed.length) {
    const blocked = claimed.filter((c) => !permitted.includes(c));
    logger.warn({ tier, blocked }, 'Capability enforcement: blocked caps above tier policy');
  }
  return permitted;
}

/**
 * Parse and enforce capabilities for a DB row at load time.
 * Returns the permitted cap list. Unknown tiers default to 'unreviewed'.
 */
export function parseAndEnforceCaps(row: SkillDbRow): string[] {
  const validTiers = new Set<string>(['bundled', 'indexed', 'unreviewed', 'workspace']);
  const tierRaw = row.trust_tier ?? 'unreviewed';
  const tier: SkillTrustTier = validTiers.has(tierRaw)
    ? (tierRaw as SkillTrustTier)
    : 'unreviewed';

  let claimed: string[] = [];
  if (row.caps_json) {
    try {
      claimed = JSON.parse(row.caps_json) as string[];
    } catch {
      claimed = [];
    }
  }
  return enforceCapabilityPolicy(claimed, tier);
}

/**
 * Exported for use by tools and the REST import endpoint.
 * Re-exports the full DEFAULT_TIER_CAPS policy for inspection.
 */
export { DEFAULT_TIER_CAPS };

/** Expected export shape of a compiled skill module. */
type SkillModuleExports = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function openDb(dbPath: string): Database.Database | null {
  if (!existsSync(dbPath)) {
    logger.warn({ dbPath }, 'mind.db not found — skipping skill load');
    return null;
  }
  try {
    const db = new Database(dbPath, { readonly: true });
    db.pragma('journal_mode = WAL');
    return db;
  } catch (err) {
    logger.error({ dbPath, err }, 'Failed to open mind.db for skill loading');
    return null;
  }
}

function fetchEnabledSkills(db: Database.Database): SkillDbRow[] {
  try {
    return db
      .prepare<[], SkillDbRow>(
        'SELECT name, version, description, entry_path, input_schema, output_schema FROM skills WHERE enabled = 1 ORDER BY name',
      )
      .all();
  } catch (err) {
    logger.error({ err }, 'Failed to query skills table — table may not exist yet');
    return [];
  }
}

async function invokeRegisterFunction(
  exports: SkillModuleExports,
  registry: ToolRegistry,
  skillName: string,
): Promise<boolean> {
  const registerFn = exports['registerSkill'];
  if (typeof registerFn !== 'function') {
    // Also accept default export with a register property
    const def = exports['default'];
    if (def && typeof def === 'object' && 'name' in def && 'execute' in def) {
      // It's a raw ToolDefinition — register directly
      registry.register(def as Parameters<ToolRegistry['register']>[0]);
      logger.debug({ skillName }, 'Registered skill via default ToolDefinition export');
      return true;
    }
    logger.warn({ skillName }, 'Skill module has no registerSkill() export and no default ToolDefinition — skipping');
    return false;
  }

  await Promise.resolve(registerFn(registry));
  logger.debug({ skillName }, 'Registered skill via registerSkill()');
  return true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load all enabled compiled skills and register them with the tool registry.
 *
 * @param registry - The ToolRegistry to register skills into.
 * @param dbPath   - Absolute path to mind.db (defaults to data/mind.db).
 */
export async function loadCompiledSkills(
  registry: ToolRegistry,
  dbPath: string = DEFAULT_DB_PATH,
): Promise<void> {
  logger.info({ dbPath }, 'Loading compiled skills');

  const db = openDb(dbPath);
  if (!db) return;

  const rows = fetchEnabledSkills(db);
  db.close();

  if (rows.length === 0) {
    logger.info('No enabled skills found in mind.db');
    return;
  }

  logger.info({ count: rows.length }, 'Found enabled skills, loading modules');

  let loaded = 0;
  let failed = 0;

  for (const row of rows) {
    const entryPath = row.entry_path;

    if (!existsSync(entryPath)) {
      logger.error({ skillName: row.name, entryPath }, 'Skill entry_path does not exist on disk — skipping');
      failed++;
      continue;
    }

    const entryUrl = pathToFileURL(entryPath).href;

    try {
      logger.debug({ skillName: row.name, entryPath }, 'Importing skill module');

      let exports: SkillModuleExports;
      try {
        exports = (await import(entryUrl)) as SkillModuleExports;
      } catch (importErr: unknown) {
        // ESM loader can't handle .ts files at runtime — try CJS require via tsx
        if (importErr instanceof TypeError && String(importErr).includes('Unknown file extension')) {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          exports = require(entryPath) as SkillModuleExports;
        } else {
          throw importErr;
        }
      }

      const countBefore = registry.size;
      const registered = await invokeRegisterFunction(exports, registry, row.name);
      const delta = registry.size - countBefore;

      if (registered) {
        loaded++;
        logger.info({ skillName: row.name, version: row.version, toolsAdded: delta }, 'Skill loaded');
      } else {
        failed++;
      }
    } catch (err) {
      failed++;
      logger.error({ skillName: row.name, entryPath, err }, 'Failed to import skill module — skipping');
    }
  }

  logger.info(
    { totalFound: rows.length, loaded, failed, totalToolsNow: registry.size },
    'Compiled skill loading complete',
  );
}
