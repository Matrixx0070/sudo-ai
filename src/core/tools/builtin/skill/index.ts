/**
 * @file skill/index.ts
 * @description Skill meta-cognition toolkit — registers all skill.* tools into
 * the ToolRegistry. These tools let SUDO-AI reflect on its own tool use,
 * propose refinements, compose tool chains, and federate skill events.
 *
 * Tools registered:
 *   skill.usage-stats — Aggregate per-tool call statistics from audit/calibration DBs
 *   skill.refine      — Generate structured refinement proposals from mistake patterns
 *   skill.federate    — Publish/fetch skill refinement events via federation layer
 *   skill.compose     — Propose a tool chain to achieve a goal (keyword matching)
 *   skill.explain     — Emit a rich markdown explanation for any registered tool
 *   skill.search      — Browse the public skill registry (sudoapi.shop)
 *   skill.install     — Install a registry skill through the Workshop gate
 *   skill.eval        — Prove a skill helps: with/without baseline + blind judge
 *   skill.trigger-eval — Measure/optimize trigger phrases vs the real matcher
 *   skill.init        — Scaffold a versioned skill package (SKILL.md + manifest.json)
 *   skill.pack        — Validate + pack a skill into a .tgz with a SHA-256 pin
 *   skill.publish     — Publish a packed skill into a registry working copy
 *   skill.update      — Check/apply newer registry versions (transactional per skill)
 *   skill.changelog   — Version history: lockfile pin, registry latest, local rows
 */

import type { ToolRegistry } from '../../registry.js';
import { createLogger } from '../../../shared/logger.js';
import { usageStatsTool } from './tools/usage-stats.js';
import { refineTool } from './tools/refine.js';
import { federateTool } from './tools/federate.js';
import { composeTool } from './tools/compose.js';
import { explainTool } from './tools/explain.js';
import { applyTool } from './tools/apply.js';
import { rollbackTool } from './tools/rollback.js';
import { searchTool } from './tools/search.js';
import { installTool } from './tools/install.js';
import { evalTool } from './tools/eval.js';
import { triggerEvalTool } from './tools/trigger-eval.js';
import { initTool } from './tools/init.js';
import { packTool } from './tools/pack.js';
import { publishTool } from './tools/publish.js';
import { updateTool } from './tools/update.js';
import { changelogTool } from './tools/changelog.js';

const logger = createLogger('skill-builtin');

const SKILL_TOOLS = [
  usageStatsTool,
  refineTool,
  federateTool,
  composeTool,
  explainTool,
  applyTool,
  rollbackTool,
  searchTool,
  installTool,
  evalTool,
  triggerEvalTool,
  initTool,
  packTool,
  publishTool,
  updateTool,
  changelogTool,
];

/**
 * Register all skill meta-cognition tools with the given registry.
 * Called automatically by the built-in tool loader.
 *
 * @param registry - The application's central {@link ToolRegistry}.
 */
export function registerSkillTools(registry: ToolRegistry): void {
  logger.info({ count: SKILL_TOOLS.length }, 'Registering skill tools');
  for (const tool of SKILL_TOOLS) {
    registry.register(tool);
  }
  logger.info({ count: SKILL_TOOLS.length }, 'Skill tools registered');
}
