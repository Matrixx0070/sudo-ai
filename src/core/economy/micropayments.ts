/**
 * @file economy/micropayments.ts
 * @description MicropaymentEngine — thin convenience wrapper over AgentWallet
 * for processing per-operation micropayments.
 *
 * Provides a simple debit/credit API that returns transaction IDs and
 * post-transaction balances, suitable for pay-per-tool-call accounting.
 */

import { createLogger } from '../shared/logger.js';
import type { AgentWallet } from './wallet.js';

const log = createLogger('economy:micropayments');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PaymentResult {
  /** Transaction ID from the underlying wallet ledger. */
  txId: string;
  /** Wallet balance after this transaction. */
  balance: number;
}

// ---------------------------------------------------------------------------
// MicropaymentEngine
// ---------------------------------------------------------------------------

export class MicropaymentEngine {
  /**
   * @param wallet - Injected AgentWallet instance.
   */
  constructor(private readonly wallet: AgentWallet) {}

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Debit the agent wallet for a cost incurred (e.g. tool execution, API call).
   *
   * @param amount   - Positive numeric amount to debit.
   * @param reason   - Human-readable description (logged to ledger).
   * @param currency - Currency code (default: "USD").
   * @returns Transaction ID and remaining balance.
   * @throws {Error} when amount <= 0 or insufficient funds.
   */
  async processPayment(
    amount: number,
    reason: string,
    currency = 'USD',
  ): Promise<PaymentResult> {
    if (amount <= 0) {
      throw new RangeError(`processPayment: amount must be positive, got ${amount}`);
    }
    if (!reason) {
      throw new TypeError('processPayment: reason is required');
    }

    log.debug({ amount, currency, reason }, 'Processing outgoing micropayment');

    const tx = this.wallet.debit(amount, reason, currency);

    log.info(
      { txId: tx.id, amount, currency, balanceAfter: tx.balanceAfter, reason },
      'Micropayment processed (debit)',
    );

    return { txId: tx.id, balance: tx.balanceAfter };
  }

  /**
   * Credit the agent wallet when receiving a payment (e.g. task completed,
   * service rendered).
   *
   * @param amount   - Positive numeric amount to credit.
   * @param reason   - Human-readable description (logged to ledger).
   * @param currency - Currency code (default: "USD").
   * @returns Transaction ID and updated balance.
   * @throws {Error} when amount <= 0.
   */
  async receivePayment(
    amount: number,
    reason: string,
    currency = 'USD',
  ): Promise<PaymentResult> {
    if (amount <= 0) {
      throw new RangeError(`receivePayment: amount must be positive, got ${amount}`);
    }
    if (!reason) {
      throw new TypeError('receivePayment: reason is required');
    }

    log.debug({ amount, currency, reason }, 'Processing incoming micropayment');

    const tx = this.wallet.credit(amount, reason, currency);

    log.info(
      { txId: tx.id, amount, currency, balanceAfter: tx.balanceAfter, reason },
      'Micropayment received (credit)',
    );

    return { txId: tx.id, balance: tx.balanceAfter };
  }

  /**
   * Return current wallet balance for a given currency.
   *
   * @param currency - Currency code (default: "USD").
   */
  getBalance(currency = 'USD'): number {
    return this.wallet.getBalance(currency);
  }
}
