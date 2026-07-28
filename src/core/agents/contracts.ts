/**
 * @file contracts.ts
 * @description AL5.2 role contracts — what each agent role MAY do, enforced
 * at spawn/message time rather than merely documented.
 *
 * A contract declares four things per role:
 *   capabilities      — tool allowlist (the role's preferredTools, promoted
 *                       from "advisory, not enforced" to an enforceable list)
 *   knowledgeScope    — memory tiers the role may read/write via the memory
 *                       API (invariant 5: ALL cross-agent knowledge flows
 *                       through the memory API with tier+category; agent
 *                       messages are transient signals, never storage)
 *   delegationRights  — which roles it may spawn and which it may message
 *   budget            — iteration cap (from the role) + optional token cap
 *                       (enforced by the AL4.5 governor when wired)
 *
 * Enforcement primitives throw with ACTIONABLE errors (what was attempted,
 * what the contract allows). AgentSpawner enforces spawn rights + the global
 * spawn-depth cap; AgentMessenger enforces message rights when role metadata
 * is supplied.
 */

import type { AgentRoleName } from './types.js';
import { getRole } from './roles.js';

/**
 * Global spawn-depth ceiling (root orchestrator = depth 0). The Campaign-0
 * audit found only COUNT caps (4 active / 100 swarm / hop≤3) and no depth
 * limit — this closes the recursion exposure by construction.
 */
export const GLOBAL_MAX_SPAWN_DEPTH = 3;

export interface RoleContract {
  role: AgentRoleName;
  /** Tool allowlist — exact tool names the role may invoke. */
  capabilities: string[];
  /** Memory-API tier names (by convention) the role may read/write. */
  knowledgeScope: { read: string[]; write: string[] };
  /** Delegation: roles this role may spawn, and message ('all' = unrestricted). */
  delegationRights: { spawn: AgentRoleName[]; message: AgentRoleName[] | 'all' };
  budget: { maxIterations: number; maxSpendTokens?: number };
}

/**
 * Per-role deviations from the conservative default (no spawn rights,
 * message-all, read all tiers / write only 'working'). Delegation is granted
 * deliberately and minimally: an architect may commission research; a
 * debugger may commission a verifying test run.
 */
const OVERRIDES: Partial<
  Record<AgentRoleName, Partial<Pick<RoleContract, 'knowledgeScope' | 'delegationRights' | 'budget'>>>
> = {
  architect: { delegationRights: { spawn: ['researcher'], message: 'all' } },
  debugger: { delegationRights: { spawn: ['tester'], message: 'all' } },
  // Testers report to the build chain — they have no business messaging
  // outward-facing roles (writer/marketing) and may not spawn.
  tester: { delegationRights: { spawn: [], message: ['debugger', 'coder', 'architect', 'reviewer'] } },
};

const DEFAULT_READ_TIERS = ['working', 'episodic', 'semantic'];
const DEFAULT_WRITE_TIERS = ['working'];

/** Build the enforceable contract for a role (role definition + overrides). */
export function getContract(role: AgentRoleName): RoleContract {
  const def = getRole(role);
  const o = OVERRIDES[role];
  return {
    role,
    capabilities: [...def.preferredTools],
    knowledgeScope: o?.knowledgeScope ?? { read: [...DEFAULT_READ_TIERS], write: [...DEFAULT_WRITE_TIERS] },
    delegationRights: o?.delegationRights ?? { spawn: [], message: 'all' },
    budget: { maxIterations: def.maxIterations, ...(o?.budget ?? {}) },
  };
}

// ---------------------------------------------------------------------------
// Enforcement primitives — throw with actionable messages
// ---------------------------------------------------------------------------

/**
 * May `parent` (at `depth`, root orchestrator = 0) spawn `childRole`?
 * Checks the global depth ceiling first, then the parent's delegation rights.
 */
export function assertSpawnAllowed(
  parent: { role: AgentRoleName; depth: number },
  childRole: AgentRoleName,
): void {
  if (parent.depth + 1 > GLOBAL_MAX_SPAWN_DEPTH) {
    throw new Error(
      `Role "${parent.role}" at depth ${parent.depth} may not spawn "${childRole}": ` +
        `global spawn-depth ceiling is ${GLOBAL_MAX_SPAWN_DEPTH}. Restructure the task so the ` +
        'work happens higher in the tree instead of recursing deeper.',
    );
  }
  const rights = getContract(parent.role).delegationRights.spawn;
  if (!rights.includes(childRole)) {
    throw new Error(
      `Role "${parent.role}" has no delegation right to spawn "${childRole}". ` +
        (rights.length > 0
          ? `It may spawn: ${rights.join(', ')}.`
          : 'It may not spawn any role.') +
        ' Route the request through the orchestrator or grant the right in contracts.ts.',
    );
  }
}

/** May `fromRole` message `toRole`? */
export function assertMessageAllowed(fromRole: AgentRoleName, toRole: AgentRoleName): void {
  const rights = getContract(fromRole).delegationRights.message;
  if (rights !== 'all' && !rights.includes(toRole)) {
    throw new Error(
      `Role "${fromRole}" may not message "${toRole}". It may message: ${rights.join(', ')}. ` +
        'Route through an allowed role or grant the right in contracts.ts.',
    );
  }
}

/** May `role` invoke `toolName`? Capabilities are the enforced tool allowlist. */
export function assertToolAllowed(role: AgentRoleName, toolName: string): void {
  const caps = getContract(role).capabilities;
  if (!caps.includes(toolName)) {
    throw new Error(
      `Role "${role}" capability list does not include tool "${toolName}". ` +
        `Allowed: ${caps.join(', ')}.`,
    );
  }
}

/** May `role` perform a memory-API `op` on `tier`? */
export function assertKnowledgeScope(
  role: AgentRoleName,
  op: 'read' | 'write',
  tier: string,
): void {
  const scope = getContract(role).knowledgeScope[op];
  if (!scope.includes(tier)) {
    throw new Error(
      `Role "${role}" may not ${op} memory tier "${tier}". Its ${op} scope: ${scope.join(', ')}. ` +
        'Cross-agent knowledge flows through the memory API within contract scope (invariant 5).',
    );
  }
}
