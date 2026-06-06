/**
 * Tests for AgentMailbox — file-based per-agent message delivery.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import path from 'path';
import { AgentMailbox, inboxPath } from '../../src/core/agent/team/agent-mailbox.js';
import type { MailboxMessage, MailboxMessageType } from '../../src/core/agent/team/agent-mailbox.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEST_DATA_ROOT = path.resolve('data/__test_mailbox');

function cleanup() {
  if (existsSync(TEST_DATA_ROOT)) {
    rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentMailbox', () => {
  let mailbox: AgentMailbox;

  beforeEach(() => {
    cleanup();
    mailbox = new AgentMailbox(TEST_DATA_ROOT);
  });

  afterEach(() => {
    cleanup();
  });

  // -----------------------------------------------------------------------
  // inboxPath
  // -----------------------------------------------------------------------

  it('inboxPath returns the expected path structure', () => {
    const p = inboxPath('data', 'alpha-team', 'agent-1');
    expect(p).toContain('teams');
    expect(p).toContain('alpha-team');
    expect(p).toContain('agent-1');
    expect(p).toMatch(/inbox\.json$/);
  });

  // -----------------------------------------------------------------------
  // writeToMailbox
  // -----------------------------------------------------------------------

  it('writeToMailbox creates a message and persists it to disk', () => {
    const msg = mailbox.writeToMailbox('team-a', 'alice', 'text', 'bob', 'Hello Alice');
    expect(msg.id).toBeTruthy();
    expect(msg.type).toBe('text');
    expect(msg.from).toBe('bob');
    expect(msg.to).toBe('alice');
    expect(msg.content).toBe('Hello Alice');
    expect(msg.read).toBe(false);
    expect(msg.timestamp).toBeTruthy();

    // Verify file exists on disk.
    const file = inboxPath(TEST_DATA_ROOT, 'team-a', 'alice');
    expect(existsSync(file)).toBe(true);
    const raw = JSON.parse(readFileSync(file, 'utf-8'));
    expect(raw).toHaveLength(1);
    expect(raw[0].id).toBe(msg.id);
  });

  it('writeToMailbox creates the directory structure if missing', () => {
    mailbox.writeToMailbox('new-team', 'newbie', 'text', 'sender', 'Welcome');
    const file = inboxPath(TEST_DATA_ROOT, 'new-team', 'newbie');
    expect(existsSync(file)).toBe(true);
  });

  it('writeToMailbox appends to an existing inbox', () => {
    mailbox.writeToMailbox('team-a', 'alice', 'text', 'bob', 'First');
    mailbox.writeToMailbox('team-a', 'alice', 'text', 'carol', 'Second');
    const messages = mailbox.readMailbox('team-a', 'alice');
    expect(messages).toHaveLength(2);
  });

  it('writeToMailbox supports all message types', () => {
    const types: MailboxMessageType[] = [
      'text',
      'permission_request',
      'permission_response',
      'shutdown_request',
      'shutdown_approved',
      'shutdown_rejected',
      'idle_notification',
      'task_assignment',
    ];
    for (const type of types) {
      mailbox.writeToMailbox('team-t', 'agent', type, 'sender', `msg-${type}`);
    }
    const all = mailbox.readMailbox('team-t', 'agent');
    expect(all).toHaveLength(types.length);
    const writtenTypes = all.map((m) => m.type);
    expect(writtenTypes).toEqual(expect.arrayContaining(types));
  });

  // -----------------------------------------------------------------------
  // readMailbox
  // -----------------------------------------------------------------------

  it('readMailbox returns empty array for non-existent inbox', () => {
    const messages = mailbox.readMailbox('no-team', 'nobody');
    expect(messages).toEqual([]);
  });

  it('readMailbox filters by message type', () => {
    mailbox.writeToMailbox('team-f', 'agent', 'text', 'a', 'txt-1');
    mailbox.writeToMailbox('team-f', 'agent', 'task_assignment', 'a', 'task-1');
    mailbox.writeToMailbox('team-f', 'agent', 'text', 'a', 'txt-2');

    const textOnly = mailbox.readMailbox('team-f', 'agent', { type: 'text' });
    expect(textOnly).toHaveLength(2);
    expect(textOnly.every((m) => m.type === 'text')).toBe(true);
  });

  it('readMailbox filters by unreadOnly', () => {
    const msg1 = mailbox.writeToMailbox('team-u', 'agent', 'text', 'a', 'first');
    const msg2 = mailbox.writeToMailbox('team-u', 'agent', 'text', 'a', 'second');

    // Mark first as read.
    mailbox.markAsRead('team-u', 'agent', [msg1.id]);

    const unread = mailbox.readMailbox('team-u', 'agent', { unreadOnly: true });
    expect(unread).toHaveLength(1);
    expect(unread[0].id).toBe(msg2.id);
  });

  it('readMailbox combines type and unreadOnly filters', () => {
    const msg1 = mailbox.writeToMailbox('team-c', 'agent', 'text', 'a', 'txt');
    mailbox.writeToMailbox('team-c', 'agent', 'task_assignment', 'a', 'task');
    mailbox.markAsRead('team-c', 'agent', [msg1.id]);

    // Only unread task_assignment messages.
    const result = mailbox.readMailbox('team-c', 'agent', {
      type: 'task_assignment',
      unreadOnly: true,
    });
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('task_assignment');
  });

  // -----------------------------------------------------------------------
  // markAsRead
  // -----------------------------------------------------------------------

  it('markAsRead marks specified messages as read', () => {
    const msg1 = mailbox.writeToMailbox('team-r', 'agent', 'text', 'a', 'm1');
    const msg2 = mailbox.writeToMailbox('team-r', 'agent', 'text', 'a', 'm2');

    const marked = mailbox.markAsRead('team-r', 'agent', [msg1.id, msg2.id]);
    expect(marked).toBe(2);

    const all = mailbox.readMailbox('team-r', 'agent');
    expect(all.every((m) => m.read)).toBe(true);
  });

  it('markAsRead returns 0 for already-read messages', () => {
    const msg1 = mailbox.writeToMailbox('team-rr', 'agent', 'text', 'a', 'm1');
    mailbox.markAsRead('team-rr', 'agent', [msg1.id]);
    // Mark again — should return 0.
    const marked = mailbox.markAsRead('team-rr', 'agent', [msg1.id]);
    expect(marked).toBe(0);
  });

  it('markAsRead ignores unknown message ids', () => {
    mailbox.writeToMailbox('team-ri', 'agent', 'text', 'a', 'm1');
    const marked = mailbox.markAsRead('team-ri', 'agent', ['bogus-id']);
    expect(marked).toBe(0);
  });

  // -----------------------------------------------------------------------
  // clearMailbox
  // -----------------------------------------------------------------------

  it('clearMailbox removes all messages from the inbox', () => {
    mailbox.writeToMailbox('team-clr', 'agent', 'text', 'a', 'm1');
    mailbox.writeToMailbox('team-clr', 'agent', 'text', 'a', 'm2');
    const cleared = mailbox.clearMailbox('team-clr', 'agent');
    expect(cleared).toBe(2);
    const remaining = mailbox.readMailbox('team-clr', 'agent');
    expect(remaining).toHaveLength(0);
  });

  it('clearMailbox returns 0 for non-existent inbox', () => {
    const cleared = mailbox.clearMailbox('no-team', 'nobody');
    expect(cleared).toBe(0);
  });

  // -----------------------------------------------------------------------
  // countUnread
  // -----------------------------------------------------------------------

  it('countUnread returns the correct count', () => {
    const msg1 = mailbox.writeToMailbox('team-cu', 'agent', 'text', 'a', 'm1');
    mailbox.writeToMailbox('team-cu', 'agent', 'text', 'a', 'm2');
    mailbox.markAsRead('team-cu', 'agent', [msg1.id]);
    const count = mailbox.countUnread('team-cu', 'agent');
    expect(count).toBe(1);
  });

  it('countUnread filters by type', () => {
    mailbox.writeToMailbox('team-cut', 'agent', 'text', 'a', 'm1');
    mailbox.writeToMailbox('team-cut', 'agent', 'task_assignment', 'a', 'm2');
    const count = mailbox.countUnread('team-cut', 'agent', 'task_assignment');
    expect(count).toBe(1);
  });

  // -----------------------------------------------------------------------
  // Persistence / corrupt file recovery
  // -----------------------------------------------------------------------

  it('readMailbox recovers gracefully from a corrupt inbox file', () => {
    const file = inboxPath(TEST_DATA_ROOT, 'team-corrupt', 'agent');
    mkdirSync(path.dirname(file), { recursive: true });
    // Write invalid JSON.
    const { writeFileSync } = require('fs');
    writeFileSync(file, 'NOT VALID JSON {{{', 'utf-8');

    const messages = mailbox.readMailbox('team-corrupt', 'agent');
    expect(messages).toEqual([]);
  });
});