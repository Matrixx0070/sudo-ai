/**
 * @file recipes/recipe-composer.ts
 * @description Loads TOML recipe files from workspace/recipes/ and applies
 * preset configuration overlays.
 *
 * Usage:
 *   const composer = new RecipeComposer('/path/to/project-root');
 *   const recipe = await composer.load('coding');
 *   const result = composer.apply(recipe, existingPillar);
 */

import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../shared/logger.js';
import type { Recipe, Config5Pillar } from '../shared/wave10-types.js';
import type { RecipeLoadResult, RecipeApplyResult } from './recipe-types.js';

const log = createLogger('recipes:composer');

const RECIPES_DIR = 'workspace/recipes';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validateRecipe(raw: Record<string, unknown>, filePath: string): Recipe {
  const id = typeof raw['id'] === 'string' ? raw['id'] : '';
  if (!id) throw new Error(`Missing required field 'id' in ${filePath}`);

  const name = typeof raw['name'] === 'string' ? raw['name'] : id;
  const description = typeof raw['description'] === 'string' ? raw['description'] : '';
  const author = typeof raw['author'] === 'string' ? raw['author'] : 'unknown';
  const version = typeof raw['version'] === 'string' ? raw['version'] : '1.0.0';

  // config section — Config5Pillar shape
  const rawConfig = isObject(raw['config']) ? raw['config'] : {};
  const config: Config5Pillar = {};

  if (isObject(rawConfig['intelligence'])) {
    config.intelligence = rawConfig['intelligence'] as Config5Pillar['intelligence'];
  }
  if (isObject(rawConfig['agent'])) {
    config.agent = rawConfig['agent'] as Config5Pillar['agent'];
  }
  if (isObject(rawConfig['tools'])) {
    config.tools = rawConfig['tools'] as Config5Pillar['tools'];
  }
  if (isObject(rawConfig['engine'])) {
    config.engine = rawConfig['engine'] as Config5Pillar['engine'];
  }
  if (isObject(rawConfig['learning'])) {
    config.learning = rawConfig['learning'] as Config5Pillar['learning'];
  }

  // operators array
  const operators = Array.isArray(raw['operators'])
    ? (raw['operators'] as unknown[])
        .filter(isObject)
        .map((o) => ({
          name: String(o['name'] ?? ''),
          enabled: typeof o['enabled'] === 'boolean' ? o['enabled'] : undefined,
        }))
        .filter((o) => o.name.length > 0)
    : undefined;

  const channels = Array.isArray(raw['channels'])
    ? (raw['channels'] as unknown[]).filter((c) => typeof c === 'string') as string[]
    : undefined;

  const tags = Array.isArray(raw['tags'])
    ? (raw['tags'] as unknown[]).filter((t) => typeof t === 'string') as string[]
    : undefined;

  return { id, name, description, author, version, config, operators, channels, tags };
}

// ---------------------------------------------------------------------------
// RecipeComposer
// ---------------------------------------------------------------------------

export class RecipeComposer {
  private readonly recipesDir: string;

  /**
   * @param projectRoot - Absolute path to the project root.
   */
  constructor(projectRoot: string = process.cwd()) {
    this.recipesDir = path.resolve(projectRoot, RECIPES_DIR);
  }

  /**
   * Load a recipe by preset name (looks for <preset>.toml in recipes dir).
   *
   * @param preset - Preset name, e.g. 'coding', 'research', 'chat'.
   * @returns The loaded Recipe.
   * @throws Error if the recipe file does not exist or fails to parse.
   */
  async load(preset: string): Promise<Recipe> {
    const filePath = path.join(this.recipesDir, `${preset}.toml`);
    const result = await this.loadFile(filePath);
    if (!result.recipe) {
      throw new Error(`Failed to load recipe '${preset}': ${result.error ?? 'unknown error'}`);
    }
    return result.recipe;
  }

  /**
   * Load all .toml files from the recipes directory.
   *
   * @returns Array of successfully parsed recipes.
   */
  async loadAll(): Promise<Recipe[]> {
    if (!fs.existsSync(this.recipesDir)) {
      log.warn({ dir: this.recipesDir }, 'Recipes directory not found');
      return [];
    }

    const entries = fs.readdirSync(this.recipesDir).filter((f) => f.endsWith('.toml'));
    const results = await Promise.all(
      entries.map((e) => this.loadFile(path.join(this.recipesDir, e))),
    );

    return results
      .filter((r): r is RecipeLoadResult & { recipe: Recipe } => r.recipe !== null)
      .map((r) => r.recipe);
  }

  /**
   * Apply a recipe's Config5Pillar overlay on top of an existing pillar.
   * Recipe fields win over existing; missing recipe fields leave existing intact.
   *
   * @param recipe   - Recipe to apply.
   * @param existing - Existing Config5Pillar (may be empty {}).
   * @returns Merged Config5Pillar and metadata about what changed.
   */
  apply(recipe: Recipe, existing: Config5Pillar = {}): RecipeApplyResult {
    const merged: Config5Pillar = { ...existing };
    const appliedSections: string[] = [];

    if (recipe.config.intelligence) {
      merged.intelligence = { ...existing.intelligence, ...recipe.config.intelligence };
      appliedSections.push('intelligence');
    }
    if (recipe.config.agent) {
      merged.agent = { ...existing.agent, ...recipe.config.agent };
      appliedSections.push('agent');
    }
    if (recipe.config.tools) {
      merged.tools = { ...existing.tools, ...recipe.config.tools };
      appliedSections.push('tools');
    }
    if (recipe.config.engine) {
      merged.engine = { ...existing.engine, ...recipe.config.engine };
      appliedSections.push('engine');
    }
    if (recipe.config.learning) {
      merged.learning = { ...existing.learning, ...recipe.config.learning };
      appliedSections.push('learning');
    }

    const activatedOperators = (recipe.operators ?? [])
      .filter((o) => o.enabled !== false)
      .map((o) => o.name);

    const channels = recipe.channels ?? [];

    log.info(
      { recipe: recipe.id, appliedSections, activatedOperators, channels },
      'Recipe applied',
    );

    return { recipe, merged, appliedSections, activatedOperators, channels };
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private async loadFile(filePath: string): Promise<RecipeLoadResult> {
    if (!fs.existsSync(filePath)) {
      const error = `Recipe file not found: ${filePath}`;
      log.warn({ filePath }, error);
      return { filePath, recipe: null, error };
    }

    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.error({ filePath, error }, 'Failed to read recipe TOML');
      return { filePath, recipe: null, error };
    }

    let parsed: Record<string, unknown>;
    try {
      const { parse } = await import('smol-toml');
      parsed = parse(raw) as Record<string, unknown>;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.error({ filePath, error }, 'TOML parse error in recipe');
      return { filePath, recipe: null, error };
    }

    try {
      const recipe = validateRecipe(parsed, filePath);
      log.debug({ id: recipe.id, filePath }, 'Recipe loaded');
      return { filePath, recipe };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.error({ filePath, error }, 'Recipe validation failed');
      return { filePath, recipe: null, error };
    }
  }
}
