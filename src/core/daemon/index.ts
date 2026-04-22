/**
 * @file index.ts
 * @description Public API for the SUDO-AI Event Daemon module.
 *
 * Exports:
 *   EventDaemon    — always-on process that reacts to real-time events
 *   DaemonEvent    — event record type
 *   EventPriority  — priority level type
 *   EventStats     — stats shape
 *   EventHandler   — handler registration type
 */

export { EventDaemon } from './event-daemon.js';
export type { DaemonEvent, EventPriority, EventStats, EventHandler } from './event-daemon.js';
