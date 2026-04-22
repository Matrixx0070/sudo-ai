/**
 * @file cli/commands/init.ts
 * @description sudo-ai init [--preset coding|research|chat] — apply recipe preset.
 *
 * Wave 10 — Builder 3 (Config + Ops + UX)
 *
 * Without --preset: lists available presets with descriptions.
 * With --preset X: loads workspace/recipes/X.toml, applies Config5Pillar overlay,
 *   activates declared operators, prints summary of changes applied.
 *
 * Prompts for confirmation before overwriting existing TOML config.
 * Exit 0 on success.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export interface InitOptions {
  preset?: string;
  force?: boolean;
}

const PRESET_DESCRIPTIONS: Record<string, string> = {
  coding:   'Developer assistant — code review, debugging, and architecture advice',
  research: 'Research assistant — literature review, summarisation, and fact-checking',
  chat:     'General chat assistant — balanced model for conversational interactions',
};

// ---------------------------------------------------------------------------
// Readline helper
// ---------------------------------------------------------------------------

async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} [y/N]: `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Apply a preset recipe or list available presets.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param opts        - { preset?: string; force?: boolean }
 * @returns Exit code: 0 on success, 1 on failure.
 */
export async function runInit(projectRoot: string, opts: InitOptions = {}): Promise<number> {
  if (!opts.preset) {
    // List available presets
    console.log('\n  Available presets:\n');
    for (const [name, desc] of Object.entries(PRESET_DESCRIPTIONS)) {
      const recipePath = path.join(projectRoot, 'workspace', 'recipes', `${name}.toml`);
      const exists = fs.existsSync(recipePath) ? '' : ' (recipe file not found)';
      console.log(`    ${name.padEnd(12)} — ${desc}${exists}`);
    }
    console.log('\n  Usage: sudo-ai init --preset <name>\n');
    return 0;
  }

  const preset = opts.preset.toLowerCase();

  if (!PRESET_DESCRIPTIONS[preset]) {
    console.error(
      `[init] Unknown preset: ${preset}. Available: ${Object.keys(PRESET_DESCRIPTIONS).join(', ')}`,
    );
    return 1;
  }

  // Load recipe via RecipeComposer
  let RecipeComposer: typeof import('../../core/recipes/recipe-composer.js').RecipeComposer;
  try {
    const mod = await import('../../core/recipes/recipe-composer.js');
    RecipeComposer = mod.RecipeComposer;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[init] Failed to load recipe composer: ${msg}`);
    return 1;
  }

  const composer = new RecipeComposer(projectRoot);
  let recipe: Awaited<ReturnType<typeof composer.load>>;

  try {
    recipe = await composer.load(preset);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[init] Failed to load recipe '${preset}': ${msg}`);
    return 1;
  }

  // Determine TOML output path
  const tomlPath = path.join(projectRoot, 'config', 'sudo-ai.toml');
  const configDir = path.join(projectRoot, 'config');

  // Confirm overwrite if file exists
  if (fs.existsSync(tomlPath) && !opts.force) {
    console.log(`\n  TOML config already exists at: ${tomlPath}`);
    const proceed = await confirm('  Overwrite with preset values?');
    if (!proceed) {
      console.log('  Aborted. No changes made.\n');
      return 0;
    }
  }

  // Apply recipe to empty base
  const result = composer.apply(recipe);

  // Build TOML content from Config5Pillar
  const tomlContent = buildTomlFromPillar(recipe);

  // Write config directory and TOML file
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  try {
    fs.writeFileSync(tomlPath, tomlContent, 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[init] Failed to write TOML config: ${msg}`);
    return 1;
  }

  // Print summary
  console.log(`\n  Applied preset: ${recipe.name} (${recipe.id})`);
  console.log(`  Description: ${recipe.description}`);
  console.log(`  Config written to: ${tomlPath}`);

  if (result.appliedSections.length > 0) {
    console.log(`\n  Config sections applied: ${result.appliedSections.join(', ')}`);
  }
  if (result.activatedOperators.length > 0) {
    console.log(`  Operators activated: ${result.activatedOperators.join(', ')}`);
  }
  if (result.channels.length > 0) {
    console.log(`  Channels enabled: ${result.channels.join(', ')}`);
  }

  console.log('\n  Restart SUDO-AI to apply changes: sudo-ai stop && sudo-ai start\n');
  return 0;
}

// ---------------------------------------------------------------------------
// TOML builder
// ---------------------------------------------------------------------------

/**
 * Build TOML content from a recipe's Config5Pillar.
 * Uses simple string generation — no external TOML library needed for writing.
 */
function buildTomlFromPillar(recipe: import('../../core/shared/wave10-types.js').Recipe): string {
  const lines: string[] = [
    `# SUDO-AI TOML overlay — generated by 'sudo-ai init --preset ${recipe.id}'`,
    `# Recipe: ${recipe.name} v${recipe.version}`,
    `# ${recipe.description}`,
    `# Edit this file to customise. Restart SUDO-AI to apply changes.`,
    '',
  ];

  const cfg = recipe.config;

  if (cfg.intelligence) {
    lines.push('[intelligence]');
    if (cfg.intelligence.default_model)  lines.push(`default_model = "${cfg.intelligence.default_model}"`);
    if (cfg.intelligence.fallback_model) lines.push(`fallback_model = "${cfg.intelligence.fallback_model}"`);
    if (cfg.intelligence.temperature !== undefined) lines.push(`temperature = ${cfg.intelligence.temperature}`);
    if (cfg.intelligence.max_tokens !== undefined)  lines.push(`max_tokens = ${cfg.intelligence.max_tokens}`);
    lines.push('');
  }

  if (cfg.agent) {
    lines.push('[agent]');
    if (cfg.agent.max_iterations !== undefined)   lines.push(`max_iterations = ${cfg.agent.max_iterations}`);
    if (cfg.agent.system_prompt_append)           lines.push(`system_prompt_append = ${JSON.stringify(cfg.agent.system_prompt_append)}`);
    lines.push('');
  }

  if (cfg.tools) {
    lines.push('[tools]');
    if (cfg.tools.disabled && cfg.tools.disabled.length > 0) {
      lines.push(`disabled = [${cfg.tools.disabled.map((d) => `"${d}"`).join(', ')}]`);
    } else {
      lines.push('disabled = []');
    }
    if (cfg.tools.mcp_servers && cfg.tools.mcp_servers.length > 0) {
      lines.push(`mcp_servers = [${cfg.tools.mcp_servers.map((s) => `"${s}"`).join(', ')}]`);
    }
    lines.push('');
  }

  if (cfg.engine) {
    lines.push('[engine]');
    if (cfg.engine.runtime)       lines.push(`runtime = "${cfg.engine.runtime}"`);
    if (cfg.engine.host)          lines.push(`host = "${cfg.engine.host}"`);
    if (cfg.engine.prefer_local !== undefined) lines.push(`prefer_local = ${cfg.engine.prefer_local}`);
    lines.push('');
  }

  if (cfg.learning) {
    const l = cfg.learning;
    if (l.routing?.policy)      lines.push(`[learning.routing]`, `policy = "${l.routing.policy}"`);
    if (l.intelligence?.policy) lines.push(`[learning.intelligence]`, `policy = "${l.intelligence.policy}"`);
    if (l.agent?.policy)        lines.push(`[learning.agent]`, `policy = "${l.agent.policy}"`);
    if (l.weights) {
      lines.push('[learning.weights]');
      if (l.weights.accuracy   !== undefined) lines.push(`accuracy = ${l.weights.accuracy}`);
      if (l.weights.latency    !== undefined) lines.push(`latency = ${l.weights.latency}`);
      if (l.weights.cost       !== undefined) lines.push(`cost = ${l.weights.cost}`);
      if (l.weights.efficiency !== undefined) lines.push(`efficiency = ${l.weights.efficiency}`);
    }
    if (l.min_quality   !== undefined) lines.push(`min_quality = ${l.min_quality}`);
    if (l.min_sft_pairs !== undefined) lines.push(`min_sft_pairs = ${l.min_sft_pairs}`);
    lines.push('');
  }

  return lines.join('\n');
}
