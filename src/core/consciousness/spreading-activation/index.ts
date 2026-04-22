/**
 * @file index.ts
 * @description Barrel export for the spreading-activation module.
 *
 * Re-exports the SpreadingActivationNetwork class and all public types.
 * Consumers import exclusively from this file.
 */

export { SpreadingActivationNetwork } from './network.js';
export { flushActivations, loadActiveNodes } from './store.js';
export type { ActivationResult, ConceptEdge, ConceptNode } from './types.js';
