/**
 * @file agents/team-manager.ts
 * @description Upgrade 52 — In-memory agent team management.
 *
 * Provides lightweight CRUD operations for named teams and their members.
 * Teams are held in memory only and are not persisted to disk. Each team
 * member can have a status (idle | busy | offline) that reflects the current
 * state of the underlying agent process.
 *
 * This module is intentionally simple: it is a data store, not a scheduler.
 * Integration with AgentSpawner / MultiAgentOrchestrator is the caller's
 * responsibility.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('agents:team');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TeamMember {
  /** Unique identifier generated at insertion time. */
  id: string;
  /** Display name of the team member. */
  name: string;
  /** Role label, e.g. "builder", "reviewer", "architect". */
  role: string;
  /** Optional agent type key matching SpecializedAgentType values. */
  agentType?: string;
  /** Current execution status of the member. */
  status: 'idle' | 'busy' | 'offline';
}

export interface Team {
  /** Unique identifier generated at creation time. */
  id: string;
  /** Human-readable name for the team. */
  name: string;
  /** Ordered list of team members. */
  members: TeamMember[];
  /** ISO timestamp when the team was created. */
  createdAt: string;
}

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

const teams: Map<string, Team> = new Map();

// ---------------------------------------------------------------------------
// Team CRUD
// ---------------------------------------------------------------------------

/**
 * Create a new empty team.
 *
 * @param name - Human-readable team name (must be non-empty).
 * @returns The newly created {@link Team}.
 */
export function createTeam(name: string): Team {
  if (!name || typeof name !== 'string' || name.trim() === '') {
    throw new Error('team-manager: team name must be a non-empty string');
  }

  const id = `team-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const team: Team = {
    id,
    name: name.trim(),
    members: [],
    createdAt: new Date().toISOString(),
  };

  teams.set(id, team);
  log.info({ id, name: team.name }, 'Team created');
  return team;
}

/**
 * Delete a team and all its member records.
 *
 * @returns `true` when the team existed; `false` otherwise.
 */
export function deleteTeam(id: string): boolean {
  if (!id) return false;
  const deleted = teams.delete(id);
  if (deleted) {
    log.info({ id }, 'Team deleted');
  } else {
    log.warn({ id }, 'team-manager: deleteTeam — team not found');
  }
  return deleted;
}

/**
 * Retrieve a team by ID.
 */
export function getTeam(id: string): Team | undefined {
  return teams.get(id);
}

/**
 * List all teams.
 */
export function listTeams(): Team[] {
  return Array.from(teams.values());
}

// ---------------------------------------------------------------------------
// Member CRUD
// ---------------------------------------------------------------------------

/**
 * Add a member to a team.
 *
 * @param teamId    - ID of the target team.
 * @param name      - Member display name.
 * @param role      - Role label.
 * @param agentType - Optional specialised agent type key.
 * @returns The new {@link TeamMember}, or `null` when the team does not exist.
 */
export function addMember(
  teamId: string,
  name: string,
  role: string,
  agentType?: string,
): TeamMember | null {
  const team = teams.get(teamId);
  if (!team) {
    log.warn({ teamId }, 'team-manager: addMember — team not found');
    return null;
  }

  if (!name || typeof name !== 'string' || name.trim() === '') {
    throw new Error('team-manager: member name must be a non-empty string');
  }
  if (!role || typeof role !== 'string' || role.trim() === '') {
    throw new Error('team-manager: member role must be a non-empty string');
  }

  const member: TeamMember = {
    id: `member-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: name.trim(),
    role: role.trim(),
    agentType: agentType?.trim(),
    status: 'idle',
  };

  team.members.push(member);
  log.info({ teamId, memberId: member.id, name: member.name, role: member.role }, 'Team member added');
  return member;
}

/**
 * Remove a member from a team.
 *
 * @returns `true` when the member existed and was removed; `false` otherwise.
 */
export function removeMember(teamId: string, memberId: string): boolean {
  const team = teams.get(teamId);
  if (!team) {
    log.warn({ teamId }, 'team-manager: removeMember — team not found');
    return false;
  }

  const idx = team.members.findIndex((m) => m.id === memberId);
  if (idx < 0) {
    log.warn({ teamId, memberId }, 'team-manager: removeMember — member not found');
    return false;
  }

  team.members.splice(idx, 1);
  log.info({ teamId, memberId }, 'Team member removed');
  return true;
}

/**
 * Update the status of a team member.
 *
 * No-op when either the team or the member does not exist.
 */
export function setMemberStatus(
  teamId: string,
  memberId: string,
  status: TeamMember['status'],
): void {
  const team = teams.get(teamId);
  if (!team) {
    log.warn({ teamId }, 'team-manager: setMemberStatus — team not found');
    return;
  }

  const member = team.members.find((m) => m.id === memberId);
  if (!member) {
    log.warn({ teamId, memberId }, 'team-manager: setMemberStatus — member not found');
    return;
  }

  member.status = status;
  log.info({ teamId, memberId, status }, 'Team member status updated');
}

/**
 * Return all members of a team with a given status.
 */
export function getMembersByStatus(
  teamId: string,
  status: TeamMember['status'],
): TeamMember[] {
  const team = teams.get(teamId);
  if (!team) return [];
  return team.members.filter((m) => m.status === status);
}
