/**
 * TeamOrchestrator manages the lifecycle of a multi-agent team.
 *
 * Responsibilities:
 * - Spawning teams with automatic leader election (first member becomes leader)
 * - Adding / removing teammates with name, model, prompt, and color
 * - Broadcasting messages to all members
 * - Coordinated shutdown with a request/confirm handshake
 * - Tracking per-member status (active / idle / shutting_down / terminated)
 *
 * Each team's data lives under `data/teams/<teamName>/`.
 */

import { EventEmitter } from 'events';
import { createLogger } from '../../shared/logger.js';
import { genId } from '../../shared/utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The type of agent — leader has elevated privileges. */
export type AgentType = 'leader' | 'worker';

/** Team-level status. */
export type TeamStatusEnum = 'active' | 'idle' | 'shutting_down' | 'terminated';

/** Status of an individual team member. */
export type MemberStatus = 'active' | 'idle' | 'shutting_down' | 'terminated';

/** Full description of a single team member. */
export interface TeamMember {
  /** Unique agent identifier (generated via genId). */
  agentId: string;
  /** Human-readable display name chosen at join time. */
  name: string;
  /** Whether this agent is the leader or a worker. */
  agentType: AgentType;
  /** LLM model the agent should use (e.g. 'claude-sonnet-4-20250514'). */
  model: string;
  /** System prompt / persona for the agent. */
  prompt: string;
  /** ANSI color code or CSS color string for terminal/UI display. */
  color: string;
  /** Current lifecycle status. */
  status: MemberStatus;
  /** ISO timestamp when the member joined the team. */
  joinedAt: string;
  /** ISO timestamp of the last activity from this member. */
  lastActiveAt: string;
}

/** Snapshot of the entire team's state. */
export interface TeamStatusSnapshot {
  teamName: string;
  status: TeamStatusEnum;
  leaderId: string | null;
  memberCount: number;
  members: TeamMember[];
}

// ---------------------------------------------------------------------------
// TeamOrchestrator
// ---------------------------------------------------------------------------

const log = createLogger('team-orchestrator');

export class TeamOrchestrator extends EventEmitter {
  private readonly teamName: string;
  private readonly members: Map<string, TeamMember> = new Map();
  private status: TeamStatusEnum = 'idle';
  private leaderId: string | null = null;

  constructor(teamName: string) {
    super();
    this.teamName = teamName;
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Spawn a new team with an initial set of members. The first member in
   * the list is automatically elected as the leader. If no members are
   * provided the team is created in 'idle' status with no leader.
   *
   * @param initialMembers - Descriptors for the founding team members.
   * @returns The fully initialized TeamOrchestrator (same instance).
   */
  spawnTeam(
    initialMembers: Array<{
      name: string;
      model: string;
      prompt: string;
      color: string;
    }>,
  ): this {
    if (this.status !== 'idle') {
      throw new Error(
        `spawnTeam: team "${this.teamName}" already spawned (status=${this.status})`,
      );
    }

    const now = new Date().toISOString();

    for (let i = 0; i < initialMembers.length; i++) {
      const desc = initialMembers[i];
      const agentId = genId();
      const agentType: AgentType = i === 0 ? 'leader' : 'worker';

      const member: TeamMember = {
        agentId,
        name: desc.name,
        agentType,
        model: desc.model,
        prompt: desc.prompt,
        color: desc.color,
        status: 'active',
        joinedAt: now,
        lastActiveAt: now,
      };

      this.members.set(agentId, member);

      if (agentType === 'leader') {
        this.leaderId = agentId;
      }
    }

    this.status = this.members.size > 0 ? 'active' : 'idle';
    log.info(
      { teamName: this.teamName, memberCount: this.members.size, leaderId: this.leaderId },
      'Team spawned',
    );
    this.emit('team:spawned', { teamName: this.teamName });

    return this;
  }

  // -----------------------------------------------------------------------
  // Membership
  // -----------------------------------------------------------------------

  /**
   * Add a new teammate to an existing team. Workers are always added as
   * agentType 'worker' — the leader is determined only at spawn time.
   *
   * @returns The newly created TeamMember.
   */
  addTeammate(desc: {
    name: string;
    model: string;
    prompt: string;
    color: string;
  }): TeamMember {
    if (this.status === 'terminated') {
      throw new Error(`addTeammate: team "${this.teamName}" is terminated`);
    }
    if (this.status === 'shutting_down') {
      throw new Error(`addTeammate: team "${this.teamName}" is shutting down`);
    }

    const now = new Date().toISOString();
    const agentId = genId();

    const member: TeamMember = {
      agentId,
      name: desc.name,
      agentType: 'worker',
      model: desc.model,
      prompt: desc.prompt,
      color: desc.color,
      status: 'active',
      joinedAt: now,
      lastActiveAt: now,
    };

    this.members.set(agentId, member);

    // If the team was idle (zero members), promote to active.
    if (this.status === 'idle') {
      this.status = 'active';
    }

    log.info({ teamName: this.teamName, agentId, name: desc.name }, 'Teammate added');
    this.emit('member:added', { teamName: this.teamName, member });

    return member;
  }

  /**
   * Remove a teammate by their agentId. The leader cannot be removed —
   * call `requestShutdown` to tear down the entire team instead.
   *
   * @returns `true` if the member was removed, `false` if not found.
   */
  removeTeammate(agentId: string): boolean {
    const member = this.members.get(agentId);
    if (!member) {
      return false;
    }
    if (member.agentType === 'leader') {
      throw new Error(
        `removeTeammate: cannot remove leader "${member.name}" — use requestShutdown to terminate the team`,
      );
    }

    this.members.delete(agentId);
    member.status = 'terminated';

    // If no members remain, revert to idle.
    if (this.members.size === 0) {
      this.status = 'idle';
    }

    log.info({ teamName: this.teamName, agentId, name: member.name }, 'Teammate removed');
    this.emit('member:removed', { teamName: this.teamName, agentId, name: member.name });

    return true;
  }

  // -----------------------------------------------------------------------
  // Status
  // -----------------------------------------------------------------------

  /**
   * Return a snapshot of the current team state including all members.
   */
  getTeamStatus(): TeamStatusSnapshot {
    return {
      teamName: this.teamName,
      status: this.status,
      leaderId: this.leaderId,
      memberCount: this.members.size,
      members: Array.from(this.members.values()),
    };
  }

  /**
   * Look up a single member by their agentId.
   */
  getMember(agentId: string): TeamMember | undefined {
    return this.members.get(agentId);
  }

  /**
   * Update a member's lastActiveAt timestamp to the current time.
   */
  touchMember(agentId: string): void {
    const member = this.members.get(agentId);
    if (member) {
      member.lastActiveAt = new Date().toISOString();
    }
  }

  /**
   * Set an individual member's status.
   */
  setMemberStatus(agentId: string, newStatus: MemberStatus): void {
    const member = this.members.get(agentId);
    if (!member) {
      throw new Error(`setMemberStatus: agent ${agentId} not found in team ${this.teamName}`);
    }
    const prev = member.status;
    member.status = newStatus;
    log.info(
      { teamName: this.teamName, agentId, name: member.name, prev, next: newStatus },
      'Member status changed',
    );
    this.emit('member:status', { teamName: this.teamName, agentId, prev, next: newStatus });
  }

  // -----------------------------------------------------------------------
  // Messaging
  // -----------------------------------------------------------------------

  /**
   * Broadcast a text message to all active team members. The message is
   * emitted on the 'broadcast' event which downstream consumers (e.g.
   * AgentMailbox) can persist to individual inboxes.
   */
  broadcastMessage(fromAgentId: string, content: string): void {
    const sender = this.members.get(fromAgentId);
    if (!sender) {
      throw new Error(
        `broadcastMessage: agent ${fromAgentId} not found in team ${this.teamName}`,
      );
    }

    const timestamp = new Date().toISOString();
    this.touchMember(fromAgentId);

    const payload = {
      teamName: this.teamName,
      from: fromAgentId,
      fromName: sender.name,
      content,
      timestamp,
    };

    log.info(
      { teamName: this.teamName, from: sender.name, content: content.slice(0, 80) },
      'Broadcast sent',
    );
    this.emit('broadcast', payload);
  }

  // -----------------------------------------------------------------------
  // Shutdown
  // -----------------------------------------------------------------------

  /**
   * Request a coordinated shutdown of the team. Only the leader can
   * initiate shutdown. The team transitions to 'shutting_down' status
   * and a 'shutdown:requested' event is emitted so that members can
   * perform cleanup. Call `confirmShutdown` to finalize.
   */
  requestShutdown(requesterAgentId: string): void {
    const requester = this.members.get(requesterAgentId);
    if (!requester) {
      throw new Error(
        `requestShutdown: agent ${requesterAgentId} not found in team ${this.teamName}`,
      );
    }
    if (requester.agentType !== 'leader') {
      throw new Error(
        `requestShutdown: only the leader can request shutdown (agent "${requester.name}" is a worker)`,
      );
    }
    if (this.status === 'terminated') {
      throw new Error(`requestShutdown: team "${this.teamName}" is already terminated`);
    }
    if (this.status === 'shutting_down') {
      // Idempotent — already shutting down.
      return;
    }

    this.status = 'shutting_down';
    log.info({ teamName: this.teamName }, 'Shutdown requested');
    this.emit('shutdown:requested', { teamName: this.teamName, requesterAgentId });
  }

  /**
   * Confirm (finalize) a shutdown that was previously requested. All
   * members are transitioned to 'terminated' and the team status is set
   * to 'terminated'.
   */
  confirmShutdown(): void {
    if (this.status !== 'shutting_down') {
      throw new Error(
        `confirmShutdown: team "${this.teamName}" is not in shutting_down state (current: ${this.status})`,
      );
    }

    for (const member of this.members.values()) {
      member.status = 'terminated';
    }
    this.status = 'terminated';

    log.info({ teamName: this.teamName }, 'Team terminated');
    this.emit('shutdown:complete', { teamName: this.teamName });
  }
}