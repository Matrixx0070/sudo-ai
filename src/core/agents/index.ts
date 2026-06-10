/**
 * @file index.ts
 * @description Public barrel export for the SUDO-AI multi-agent orchestration system.
 *
 * Import from this module rather than individual files:
 *   import { MultiAgentOrchestrator, AgentSpawner } from '../agents/index.js';
 */

// Types
export type {
  AgentRoleName,
  AgentRole,
  SpawnConfig,
  AgentInstance,
  AgentStatus,
  AgentMessage,
  AgentMessageType,
  Wave,
  WaveResult,
  PipelineResult,
} from './types.js';

// Roles
export { AGENT_ROLES, ROLE_NAMES, getRole } from './roles.js';

// Messenger
export { AgentMessenger } from './messenger.js';

// Spawner
export { AgentSpawner } from './spawner.js';

// Orchestrator + tool factory
export { MultiAgentOrchestrator, createMultiAgentTool } from './orchestrator.js';

// Upgrade 30: Specialized Agent Types
export { AGENT_TYPE_CONFIGS, getAgentConfig } from './specialized-types.js';
export type { SpecializedAgentType, AgentTypeConfig } from './specialized-types.js';

// Upgrade 52: Team Management
export {
  createTeam,
  deleteTeam,
  getTeam,
  listTeams,
  addMember,
  removeMember,
  setMemberStatus,
  getMembersByStatus,
} from './team-manager.js';
export type { Team, TeamMember } from './team-manager.js';

// Versioned Agent Config REST resource
export { AgentConfigStore } from './store.js';
export { registerAgentRoutes } from './routes.js';
export type {
  AgentConfig,
  CreateAgentInput,
  UpdateAgentInput,
  ListAgentsOptions,
  AgentRow,
  ToolDefinition,
  SkillRef,
  McpServerRef,
} from './config-types.js';
export { AgentConfigStoreError } from './config-types.js';
