/**
 * Custom tools index — registers all hot-deployed and manually created skills.
 */
import type { ToolRegistry } from '../../registry.js';
import { custom_pingTool } from './custom-ping.js';
import { claudeSkillTool } from './claude-skill.js';
import { codexTool } from './codex.js';

export function registerCustomTools(registry: ToolRegistry): void {
  registry.register(custom_pingTool);
  registry.register(claudeSkillTool);
  registry.register(codexTool);
}
