/**
 * @file index.ts
 * @description Public barrel export for the kanban module.
 */

// Phase 5: Kanban Dispatcher
export { KanbanDispatcher } from './dispatcher.js';
export type { DispatcherConfig, DispatcherState, DispatcherStats } from './dispatcher.js';

// Phase 5: Worker Protocol
export { WorkerProtocolManager } from './worker-protocol.js';
export type { WorkerHeartbeat, WorkerCompletion, WorkerBlock, CircuitState, CircuitBreaker, WorkerProtocolConfig } from './worker-protocol.js';