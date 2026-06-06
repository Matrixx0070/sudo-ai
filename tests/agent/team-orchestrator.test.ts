/**
 * Tests for TeamOrchestrator — team lifecycle, membership, messaging,
 * and shutdown.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TeamOrchestrator } from '../../src/core/agent/team/team-orchestrator.js';
import type { TeamMember, TeamStatusSnapshot } from '../../src/core/agent/team/team-orchestrator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLeader() {
  return { name: 'commander', model: 'claude-sonnet-4-20250514', prompt: 'Lead the team.', color: '#ff0000' };
}

function makeWorker(n: number) {
  return { name: `worker-${n}`, model: 'claude-haiku-3-20250514', prompt: `Do work ${n}.`, color: `#00ff${n}` };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TeamOrchestrator', () => {
  let orch: TeamOrchestrator;

  beforeEach(() => {
    orch = new TeamOrchestrator('test-team');
  });

  // -----------------------------------------------------------------------
  // spawnTeam
  // -----------------------------------------------------------------------

  it('spawnTeam creates an active team with a leader', () => {
    orch.spawnTeam([makeLeader()]);
    const status = orch.getTeamStatus();
    expect(status.status).toBe('active');
    expect(status.leaderId).not.toBeNull();
    expect(status.memberCount).toBe(1);
    const leader = status.members[0];
    expect(leader.agentType).toBe('leader');
    expect(leader.name).toBe('commander');
  });

  it('spawnTeam elects the first member as leader and the rest as workers', () => {
    orch.spawnTeam([makeLeader(), makeWorker(1), makeWorker(2)]);
    const status = orch.getTeamStatus();
    expect(status.memberCount).toBe(3);
    const types = status.members.map((m) => m.agentType);
    expect(types[0]).toBe('leader');
    expect(types[1]).toBe('worker');
    expect(types[2]).toBe('worker');
  });

  it('spawnTeam with no members stays idle with no leader', () => {
    orch.spawnTeam([]);
    const status = orch.getTeamStatus();
    expect(status.status).toBe('idle');
    expect(status.leaderId).toBeNull();
    expect(status.memberCount).toBe(0);
  });

  it('spawnTeam throws if called twice on the same instance', () => {
    orch.spawnTeam([makeLeader()]);
    expect(() => orch.spawnTeam([makeLeader()])).toThrow('already spawned');
  });

  // -----------------------------------------------------------------------
  // addTeammate / removeTeammate
  // -----------------------------------------------------------------------

  it('addTeammate adds a worker to an active team', () => {
    orch.spawnTeam([makeLeader()]);
    const member = orch.addTeammate(makeWorker(1));
    expect(member.agentType).toBe('worker');
    expect(member.name).toBe('worker-1');
    expect(orch.getTeamStatus().memberCount).toBe(2);
  });

  it('addTeammate emits member:added event', () => {
    orch.spawnTeam([makeLeader()]);
    let emitted = false;
    orch.on('member:added', () => { emitted = true; });
    orch.addTeammate(makeWorker(1));
    expect(emitted).toBe(true);
  });

  it('removeTeammate removes a worker and returns true', () => {
    orch.spawnTeam([makeLeader()]);
    const worker = orch.addTeammate(makeWorker(1));
    const result = orch.removeTeammate(worker.agentId);
    expect(result).toBe(true);
    expect(orch.getTeamStatus().memberCount).toBe(1);
  });

  it('removeTeammate returns false for unknown agentId', () => {
    orch.spawnTeam([makeLeader()]);
    expect(orch.removeTeammate('nonexistent')).toBe(false);
  });

  it('removeTeammate throws when trying to remove the leader', () => {
    orch.spawnTeam([makeLeader()]);
    const leader = orch.getTeamStatus().members[0];
    expect(() => orch.removeTeammate(leader.agentId)).toThrow('cannot remove leader');
  });

  it('addTeammate throws when team is terminated', () => {
    orch.spawnTeam([makeLeader()]);
    const leader = orch.getTeamStatus().members[0];
    orch.requestShutdown(leader.agentId);
    orch.confirmShutdown();
    expect(() => orch.addTeammate(makeWorker(1))).toThrow('terminated');
  });

  it('addTeammate throws when team is shutting down', () => {
    orch.spawnTeam([makeLeader()]);
    const leader = orch.getTeamStatus().members[0];
    orch.requestShutdown(leader.agentId);
    expect(() => orch.addTeammate(makeWorker(1))).toThrow('shutting down');
  });

  // -----------------------------------------------------------------------
  // getTeamStatus / getMember / setMemberStatus / touchMember
  // -----------------------------------------------------------------------

  it('getMember returns a member by agentId', () => {
    orch.spawnTeam([makeLeader()]);
    const status = orch.getTeamStatus();
    const leader = status.members[0];
    const found = orch.getMember(leader.agentId);
    expect(found).toBeDefined();
    expect(found!.name).toBe('commander');
  });

  it('getMember returns undefined for unknown agentId', () => {
    expect(orch.getMember('bogus')).toBeUndefined();
  });

  it('setMemberStatus changes a member status and emits event', () => {
    orch.spawnTeam([makeLeader()]);
    const leader = orch.getTeamStatus().members[0];
    let emitted = false;
    orch.on('member:status', () => { emitted = true; });
    orch.setMemberStatus(leader.agentId, 'idle');
    expect(orch.getMember(leader.agentId)!.status).toBe('idle');
    expect(emitted).toBe(true);
  });

  it('touchMember updates lastActiveAt', () => {
    orch.spawnTeam([makeLeader()]);
    const leader = orch.getTeamStatus().members[0];
    const before = leader.lastActiveAt;
    // Small delay so timestamp differs
    orch.touchMember(leader.agentId);
    const after = orch.getMember(leader.agentId)!.lastActiveAt;
    // After should be >= before (same or newer)
    expect(after >= before).toBe(true);
  });

  // -----------------------------------------------------------------------
  // broadcastMessage
  // -----------------------------------------------------------------------

  it('broadcastMessage emits a broadcast event with content', () => {
    orch.spawnTeam([makeLeader()]);
    const leader = orch.getTeamStatus().members[0];
    let received: any = null;
    orch.on('broadcast', (payload) => { received = payload; });
    orch.broadcastMessage(leader.agentId, 'Hello team!');
    expect(received).not.toBeNull();
    expect(received.content).toBe('Hello team!');
    expect(received.from).toBe(leader.agentId);
    expect(received.fromName).toBe('commander');
  });

  it('broadcastMessage throws for unknown agentId', () => {
    orch.spawnTeam([makeLeader()]);
    expect(() => orch.broadcastMessage('nobody', 'hi')).toThrow('not found');
  });

  // -----------------------------------------------------------------------
  // Shutdown
  // -----------------------------------------------------------------------

  it('requestShutdown transitions team to shutting_down', () => {
    orch.spawnTeam([makeLeader()]);
    const leader = orch.getTeamStatus().members[0];
    orch.requestShutdown(leader.agentId);
    expect(orch.getTeamStatus().status).toBe('shutting_down');
  });

  it('requestShutdown emits shutdown:requested event', () => {
    orch.spawnTeam([makeLeader()]);
    const leader = orch.getTeamStatus().members[0];
    let emitted = false;
    orch.on('shutdown:requested', () => { emitted = true; });
    orch.requestShutdown(leader.agentId);
    expect(emitted).toBe(true);
  });

  it('requestShutdown throws when called by a worker', () => {
    orch.spawnTeam([makeLeader()]);
    const worker = orch.addTeammate(makeWorker(1));
    expect(() => orch.requestShutdown(worker.agentId)).toThrow('only the leader');
  });

  it('requestShutdown is idempotent when already shutting_down', () => {
    orch.spawnTeam([makeLeader()]);
    const leader = orch.getTeamStatus().members[0];
    orch.requestShutdown(leader.agentId);
    // Second call should not throw
    expect(() => orch.requestShutdown(leader.agentId)).not.toThrow();
  });

  it('requestShutdown throws when team is terminated', () => {
    orch.spawnTeam([makeLeader()]);
    const leader = orch.getTeamStatus().members[0];
    orch.requestShutdown(leader.agentId);
    orch.confirmShutdown();
    expect(() => orch.requestShutdown(leader.agentId)).toThrow('already terminated');
  });

  it('confirmShutdown terminates all members and the team', () => {
    orch.spawnTeam([makeLeader(), makeWorker(1)]);
    const leader = orch.getTeamStatus().members.find((m) => m.agentType === 'leader')!;
    orch.requestShutdown(leader.agentId);
    orch.confirmShutdown();
    const status = orch.getTeamStatus();
    expect(status.status).toBe('terminated');
    for (const member of status.members) {
      expect(member.status).toBe('terminated');
    }
  });

  it('confirmShutdown throws when not in shutting_down state', () => {
    orch.spawnTeam([makeLeader()]);
    expect(() => orch.confirmShutdown()).toThrow('not in shutting_down');
  });

  it('confirmShutdown emits shutdown:complete event', () => {
    orch.spawnTeam([makeLeader()]);
    const leader = orch.getTeamStatus().members[0];
    orch.requestShutdown(leader.agentId);
    let emitted = false;
    orch.on('shutdown:complete', () => { emitted = true; });
    orch.confirmShutdown();
    expect(emitted).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Removing all workers reverts team to idle
  // -----------------------------------------------------------------------

  it('removing all workers leaves leader alone (team stays active)', () => {
    orch.spawnTeam([makeLeader()]);
    const worker = orch.addTeammate(makeWorker(1));
    orch.removeTeammate(worker.agentId);
    // Leader still present, so still active
    expect(orch.getTeamStatus().status).toBe('active');
    expect(orch.getTeamStatus().memberCount).toBe(1);
  });
});