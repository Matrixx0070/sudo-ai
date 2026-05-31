/**
 * @file index.ts
 * @description Public barrel export for the workspace module.
 */

export type { WorkspaceFileName, WorkspaceFile, BootstrapState } from './types.js';
export { WorkspaceManager } from './files.js';
export { BootstrapRunner } from './bootstrap.js';
export type { BootstrapSendFn, BootstrapReceiveFn } from './bootstrap.js';
export { DailyLogManager } from './daily-log.js';
export { injectWorkspaceContext } from './injector.js';
export type { WorkspaceInjectorConfig, WorkspaceInjectorDeps } from './injector.js';
