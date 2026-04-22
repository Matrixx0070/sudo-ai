/**
 * @file economy/index.ts
 * @description Barrel export for the SUDO-AI economy subsystem.
 *
 * Exports:
 *  - AgentWallet     — SQLite-backed token ledger
 *  - AgentIdentity   — Decentralized identifier (DID)
 *  - MicropaymentEngine — Per-operation payment processing
 */

export { AgentWallet } from './wallet.js';
export type { WalletTransaction } from './wallet.js';

export { AgentIdentity } from './did.js';
export type { AgentProfile } from './did.js';

export { MicropaymentEngine } from './micropayments.js';
export type { PaymentResult } from './micropayments.js';
