/**
 * @file acp/index.ts
 * @description Public surface of the ACP (Agent Client Protocol) agent.
 */

export * from './types.js';
export { JsonRpcConnection, AcpRpcError, JsonRpcErrorCode } from './jsonrpc.js';
export type { RequestHandler, NotificationHandler } from './jsonrpc.js';
export { AcpServer, extractText } from './acp-server.js';
export type { AcpBackend, AcpServerOptions } from './acp-server.js';
export { BrainAcpBackend } from './brain-backend.js';
export type { AcpBrain } from './brain-backend.js';
