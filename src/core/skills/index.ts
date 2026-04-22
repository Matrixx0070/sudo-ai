/**
 * Public barrel for the SUDO-AI skill system.
 *
 * Import from here rather than individual files:
 * ```ts
 * import { SkillCompiler, loadCompiledSkills, type SkillDefinition } from '@core/skills/index.js';
 * import { SkillRegistry, registerSkillRoutes } from '@core/skills/index.js';
 * ```
 */

export { SkillCompiler, type SkillDefinition, type SkillRecord } from './compiler.js';
export { loadCompiledSkills } from './loader.js';
export { SkillVersioning, type SkillVersion, type SkillDiff } from './versioning.js';

// Wave 5 P2 — versioned registry + HTTP routes
export { SkillRegistry, SkillRegistryError } from './registry.js';
export type { SkillMeta, SkillFull, AttachedSkill } from './registry-types.js';
export { registerSkillRoutes } from './routes.js';
export { registerRegistryRoutes } from './registry-routes.js';
