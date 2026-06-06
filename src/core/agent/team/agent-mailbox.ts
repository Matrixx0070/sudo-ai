/**
 * AgentMailbox provides persistent, file-based message delivery for
 * team agents. Each agent gets an inbox JSON file at:
 *
 *   data/teams/<teamName>/<agentName>/inbox.json
 *
 * Messages are appended to the file and can be read back with optional
 * filtering by type or read-status. The mailbox supports marking
 * individual messages as read so agents can track what they have
 * processed.
 *
 * Supported message types:
 *  - text                  : plain text communication
 *  - permission_request    : worker asks leader for permission
 *  - permission_response  : leader approves/denies a request
 *  - shutdown_request     : leader proposes team shutdown
 *  - shutdown_approved    : member acknowledges shutdown
 *  - shutdown_rejected    : member vetoes shutdown
 *  - idle_notification    : member signals it has no work
 *  - task_assignment      : leader assigns a task to a member
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { createLogger } from '../../shared/logger.js';
import { genId } from '../../shared/utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** All supported mailbox message types. */
export type MailboxMessageType =
  | 'text'
  | 'permission_request'
  | 'permission_response'
  | 'shutdown_request'
  | 'shutdown_approved'
  | 'shutdown_rejected'
  | 'idle_notification'
  | 'task_assignment';

/** A single message in an agent's inbox. */
export interface MailboxMessage {
  /** Unique message identifier. */
  id: string;
  /** Type discriminator for routing and filtering. */
  type: MailboxMessageType;
  /** AgentId of the sender. */
  from: string;
  /** AgentId of the intended recipient. */
  to: string;
  /** Message payload — meaning depends on type. */
  content: string;
  /** ISO timestamp when the message was created. */
  timestamp: string;
  /** Whether the recipient has read (consumed) the message. */
  read: boolean;
}

/** Filter options when reading a mailbox. */
export interface MailboxReadOptions {
  /** If set, only return messages of this type. */
  type?: MailboxMessageType;
  /** If set, only return unread messages. */
  unreadOnly?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const log = createLogger('agent-mailbox');

/**
 * Resolve the inbox file path for a given team + agent.
 */
export function inboxPath(dataRoot: string, teamName: string, agentName: string): string {
  return path.join(dataRoot, 'teams', teamName, agentName, 'inbox.json');
}

/**
 * Ensure the directory containing the inbox file exists. Creates it
 * recursively if missing.
 */
function ensureInboxDir(inboxFile: string): void {
  const dir = path.dirname(inboxFile);
  mkdirSync(dir, { recursive: true });
}

/**
 * Read the raw inbox array from disk. Returns an empty array if the file
 * does not exist or is corrupt.
 */
function loadInbox(inboxFile: string): MailboxMessage[] {
  if (!existsSync(inboxFile)) {
    return [];
  }
  try {
    const raw = readFileSync(inboxFile, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as MailboxMessage[];
  } catch {
    log.warn({ inboxFile }, 'Corrupt inbox file — resetting to empty');
    return [];
  }
}

/**
 * Persist the inbox array to disk. Overwrites the entire file.
 */
function saveInbox(inboxFile: string, messages: MailboxMessage[]): void {
  ensureInboxDir(inboxFile);
  writeFileSync(inboxFile, JSON.stringify(messages, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// AgentMailbox
// ---------------------------------------------------------------------------

/**
 * AgentMailbox provides per-agent persistent message delivery backed by
 * a JSON file on disk.
 *
 * The constructor receives a `dataRoot` (e.g. 'data') which determines
 * where team data is stored. All operations are synchronous because the
 * inbox files are small and local.
 */
export class AgentMailbox {
  private readonly dataRoot: string;

  constructor(dataRoot: string = 'data') {
    this.dataRoot = dataRoot;
  }

  /**
   * Write a message to an agent's inbox.
   *
   * @param teamName  - Name of the team.
   * @param agentName - Name of the recipient agent.
   * @param type      - Message type discriminator.
   * @param from      - AgentId of the sender.
   * @param content   - Message body.
   * @returns The newly created MailboxMessage.
   */
  writeToMailbox(
    teamName: string,
    agentName: string,
    type: MailboxMessageType,
    from: string,
    content: string,
  ): MailboxMessage {
    const file = inboxPath(this.dataRoot, teamName, agentName);
    const inbox = loadInbox(file);

    const message: MailboxMessage = {
      id: genId(),
      type,
      from,
      to: agentName,
      content,
      timestamp: new Date().toISOString(),
      read: false,
    };

    inbox.push(message);
    saveInbox(file, inbox);

    log.info(
      { teamName, agentName, type, from, msgId: message.id },
      'Message written to mailbox',
    );

    return message;
  }

  /**
   * Read messages from an agent's inbox, optionally filtering by type
   * and/or read-status.
   *
   * @param teamName  - Name of the team.
   * @param agentName - Name of the agent whose inbox to read.
   * @param options   - Optional filter (type, unreadOnly).
   * @returns Array of matching MailboxMessage objects.
   */
  readMailbox(
    teamName: string,
    agentName: string,
    options: MailboxReadOptions = {},
  ): MailboxMessage[] {
    const file = inboxPath(this.dataRoot, teamName, agentName);
    const inbox = loadInbox(file);

    let result = inbox;

    if (options.type) {
      result = result.filter((m) => m.type === options.type);
    }
    if (options.unreadOnly) {
      result = result.filter((m) => !m.read);
    }

    return result;
  }

  /**
   * Mark one or more messages as read by their ids.
   *
   * @param teamName   - Name of the team.
   * @param agentName  - Name of the agent whose inbox to update.
   * @param messageIds - One or more message ids to mark as read.
   * @returns The number of messages that were actually marked (i.e. found
   *          and previously unread).
   */
  markAsRead(teamName: string, agentName: string, messageIds: string[]): number {
    const file = inboxPath(this.dataRoot, teamName, agentName);
    const inbox = loadInbox(file);

    const idSet = new Set(messageIds);
    let marked = 0;

    for (const msg of inbox) {
      if (idSet.has(msg.id) && !msg.read) {
        msg.read = true;
        marked++;
      }
    }

    if (marked > 0) {
      saveInbox(file, inbox);
      log.info({ teamName, agentName, marked }, 'Messages marked as read');
    }

    return marked;
  }

  /**
   * Remove all messages from an agent's inbox.
   *
   * @returns The number of messages that were cleared.
   */
  clearMailbox(teamName: string, agentName: string): number {
    const file = inboxPath(this.dataRoot, teamName, agentName);
    const inbox = loadInbox(file);
    const count = inbox.length;
    if (count > 0) {
      saveInbox(file, []);
    }
    return count;
  }

  /**
   * Count unread messages in an agent's inbox, optionally filtered by type.
   */
  countUnread(teamName: string, agentName: string, type?: MailboxMessageType): number {
    const file = inboxPath(this.dataRoot, teamName, agentName);
    const inbox = loadInbox(file);
    return inbox.filter((m) => !m.read && (!type || m.type === type)).length;
  }
}