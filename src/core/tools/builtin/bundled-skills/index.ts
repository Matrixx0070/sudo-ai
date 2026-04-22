/**
 * Bundled Skills — tool registration bridge.
 *
 * Exposes the 5 bundled SKILL.md skills as callable ToolDefinitions so the
 * agent can invoke them by their canonical IDs (e.g. "intelligence.daily-brief").
 *
 * Each skill already ships a complete ToolDefinition (with execute function) in
 * its own src/core/skills/<category>/<slug>/index.ts.  This module re-exports
 * them under the register*Tools naming convention so the builtin tool loader
 * discovers them automatically — zero changes to cli.ts required.
 *
 * Kill-switch: SUDO_BUNDLED_SKILLS_DISABLE=1 skips all registrations.
 *
 * Naming convention: registerBundledSkillTools — matches /^register.+Tools$/
 * pattern checked by src/core/tools/loader.ts.
 */

import { createLogger } from '../../../shared/logger.js';
import type { ToolRegistry } from '../../registry.js';

import { registerSkill as registerCronHealth } from '../../../skills/automation/cron-health/index.js';
import { registerSkill as registerDailyBrief } from '../../../skills/intelligence/daily-brief/index.js';
import { registerSkill as registerWebSummary } from '../../../skills/research/web-summary/index.js';
import { registerSkill as registerSelfDiagnostic } from '../../../skills/system/self-diagnostic/index.js';
import { registerSkill as registerViralHook } from '../../../skills/content/viral-hook/index.js';

const logger = createLogger('tool-loader.bundled-skills');

/**
 * Register all 5 bundled skills as executable tools.
 * Called automatically by the builtin tool loader at startup.
 *
 * @param registry - The live ToolRegistry to populate.
 */
export function registerBundledSkillTools(registry: ToolRegistry): void {
  if (process.env['SUDO_BUNDLED_SKILLS_DISABLE'] === '1') {
    logger.info('SUDO_BUNDLED_SKILLS_DISABLE=1 — skipping bundled skill registration');
    return;
  }

  const registrars = [
    { name: 'automation.cron-health', fn: registerCronHealth },
    { name: 'intelligence.daily-brief', fn: registerDailyBrief },
    { name: 'research.web-summary', fn: registerWebSummary },
    { name: 'system.self-diagnostic', fn: registerSelfDiagnostic },
    { name: 'content.viral-hook', fn: registerViralHook },
  ];

  let registered = 0;
  for (const { name, fn } of registrars) {
    try {
      fn(registry);
      registered++;
      logger.debug({ name }, 'Bundled skill registered as tool');
    } catch (err) {
      logger.error({ name, err }, 'Failed to register bundled skill — skipping');
    }
  }

  logger.info({ registered, total: registrars.length }, 'Bundled skill tools registered');
}
