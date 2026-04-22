/**
 * @file economy/wallet.ts
 * @description AgentWallet — SQLite-backed ledger for SUDO-AI token economy.
 *
 * Provides credit/debit operations with full balance tracking and transaction
 * history. Uses WAL mode for concurrent read safety.
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createLogger } from '../shared/logger.js';

const log = createLogger('economy:wallet');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface WalletTransaction {
  id: string;
  type: 'credit' | 'debit';
  amount: number;
  currency: string;
  reason: string;
  balanceAfter: number;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// AgentWallet
// ---------------------------------------------------------------------------

export class AgentWallet {
  private readonly db: Database.Database;

  constructor(dbPath: string = path.resolve(process.cwd(), 'data/economy.db')) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_wallet (
        id          TEXT PRIMARY KEY,
        type        TEXT NOT NULL,
        amount      REAL NOT NULL,
        currency    TEXT NOT NULL DEFAULT 'USD',
        reason      TEXT NOT NULL DEFAULT '',
        balance_after REAL NOT NULL,
        created_at  TEXT NOT NULL
      )
    `);
    log.info({ dbPath }, 'AgentWallet initialized');
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  credit(amount: number, reason: string, currency = 'USD'): WalletTransaction {
    if (amount <= 0) throw new Error(`Credit amount must be positive, got: ${amount}`);
    if (!reason) throw new Error('Credit reason is required');

    const balance = this.getBalance(currency);
    const newBalance = balance + amount;

    const tx: WalletTransaction = {
      id: randomUUID(),
      type: 'credit',
      amount,
      currency,
      reason,
      balanceAfter: newBalance,
      createdAt: new Date().toISOString(),
    };

    this._insertTransaction(tx);
    log.info({ txId: tx.id, amount, currency, balanceAfter: newBalance }, 'Wallet credit');
    return tx;
  }

  debit(amount: number, reason: string, currency = 'USD'): WalletTransaction {
    if (amount <= 0) throw new Error(`Debit amount must be positive, got: ${amount}`);
    if (!reason) throw new Error('Debit reason is required');

    const balance = this.getBalance(currency);
    if (balance < amount) {
      throw new Error(`Insufficient balance: have ${balance} ${currency}, need ${amount}`);
    }

    const newBalance = balance - amount;

    const tx: WalletTransaction = {
      id: randomUUID(),
      type: 'debit',
      amount,
      currency,
      reason,
      balanceAfter: newBalance,
      createdAt: new Date().toISOString(),
    };

    this._insertTransaction(tx);
    log.info({ txId: tx.id, amount, currency, balanceAfter: newBalance }, 'Wallet debit');
    return tx;
  }

  getBalance(currency = 'USD'): number {
    const row = this.db.prepare(
      'SELECT balance_after FROM agent_wallet WHERE currency = ? ORDER BY created_at DESC LIMIT 1',
    ).get(currency) as { balance_after: number } | undefined;
    return row?.balance_after ?? 0;
  }

  getLedger(limit = 50): WalletTransaction[] {
    const rows = this.db.prepare(
      'SELECT * FROM agent_wallet ORDER BY created_at DESC LIMIT ?',
    ).all(limit) as Array<{
      id: string; type: string; amount: number; currency: string;
      reason: string; balance_after: number; created_at: string;
    }>;

    return rows.map(r => ({
      id: r.id,
      type: r.type as 'credit' | 'debit',
      amount: r.amount,
      currency: r.currency,
      reason: r.reason,
      balanceAfter: r.balance_after,
      createdAt: r.created_at,
    }));
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _insertTransaction(tx: WalletTransaction): void {
    this.db.prepare(
      'INSERT INTO agent_wallet (id, type, amount, currency, reason, balance_after, created_at) VALUES (?,?,?,?,?,?,?)',
    ).run(tx.id, tx.type, tx.amount, tx.currency, tx.reason, tx.balanceAfter, tx.createdAt);
  }
}
