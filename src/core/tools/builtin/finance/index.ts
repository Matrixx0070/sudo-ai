/**
 * Finance toolkit — registers 4 finance tools into the ToolRegistry.
 *
 * Tools registered:
 *   finance.bookkeeper        — Double-entry bookkeeping with SQLite ledger
 *   finance.tax-calculator    — Tax calculation with deduction optimisation (LLM)
 *   finance.financial-report  — Generate P&L, balance sheet, cash flow (LLM + ledger)
 *   finance.payment-processor — Process payments via Stripe API
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { ToolRegistry } from '../../registry.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';
import { DATA_DIR } from '../../../shared/paths.js';

const logger = createLogger('finance-builtin');

const LEDGER_FILE = path.join(DATA_DIR, 'finance-ledger.json');

// ---------------------------------------------------------------------------
// Shared LLM helper
// ---------------------------------------------------------------------------

interface BrainLike {
  chat(messages: Array<{ role: string; content: string }>): Promise<{ content: string }>;
}

interface ConfigLike { brain?: BrainLike; }

async function askBrain(ctx: ToolContext, system: string, user: string): Promise<string> {
  const config = ctx.config as ConfigLike | undefined;
  if (!config?.brain) throw new Error('Brain (LLM) is not available. Ensure the brain module is configured.');
  const response = await config.brain.chat([
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]);
  return response.content.trim();
}

// ---------------------------------------------------------------------------
// Ledger helpers
// ---------------------------------------------------------------------------

interface LedgerEntry {
  id: string;
  date: string;
  description: string;
  debitAccount: string;
  creditAccount: string;
  amount: number;
  currency: string;
  tags: string[];
  createdAt: string;
}

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function loadLedger(): LedgerEntry[] {
  try {
    if (!existsSync(LEDGER_FILE)) return [];
    return JSON.parse(readFileSync(LEDGER_FILE, 'utf8')) as LedgerEntry[];
  } catch {
    return [];
  }
}

function saveLedger(entries: LedgerEntry[]): void {
  ensureDataDir();
  writeFileSync(LEDGER_FILE, JSON.stringify(entries, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// finance.bookkeeper
// ---------------------------------------------------------------------------

const bookkeeperTool: ToolDefinition = {
  name: 'finance.bookkeeper',
  description:
    'Double-entry bookkeeping: record journal entries, list transactions, get account balances, and view trial balance. Persists to data/finance-ledger.json.',
  category: 'finance',
  timeout: 15_000,
  parameters: {
    action: {
      type: 'string',
      required: true,
      description: 'Operation to perform.',
      enum: ['record', 'list', 'balance', 'trial-balance', 'stats'],
    },
    date: { type: 'string', description: 'Transaction date in YYYY-MM-DD format (required for record, defaults to today).' },
    description: { type: 'string', description: 'Transaction description (required for record).' },
    debitAccount: { type: 'string', description: 'Account to debit (e.g. Cash, Expenses:Marketing). Required for record.' },
    creditAccount: { type: 'string', description: 'Account to credit (e.g. Revenue:Sales, Liabilities:Loans). Required for record.' },
    amount: { type: 'number', description: 'Transaction amount (positive number, required for record).' },
    currency: { type: 'string', description: 'ISO currency code (default: USD).', default: 'USD' },
    tags: { type: 'string', description: 'Comma-separated tags for categorisation.' },
    account: { type: 'string', description: 'Account name filter for list or balance action.' },
    limit: { type: 'number', description: 'Max entries to return for list (default: 50).', default: 50 },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = params['action'] as string;
    logger.info({ session: ctx.sessionId, action }, 'finance.bookkeeper invoked');

    try {
      const ledger = loadLedger();

      switch (action) {
        case 'record': {
          const description = params['description'] as string | undefined;
          const debitAccount = params['debitAccount'] as string | undefined;
          const creditAccount = params['creditAccount'] as string | undefined;
          const amount = params['amount'] as number | undefined;
          if (!description?.trim()) return { success: false, output: 'description is required.' };
          if (!debitAccount?.trim()) return { success: false, output: 'debitAccount is required.' };
          if (!creditAccount?.trim()) return { success: false, output: 'creditAccount is required.' };
          if (amount === undefined || amount <= 0) return { success: false, output: 'amount must be a positive number.' };

          const entry: LedgerEntry = {
            id: crypto.randomUUID(),
            date: (params['date'] as string | undefined) ?? new Date().toISOString().split('T')[0]!,
            description,
            debitAccount,
            creditAccount,
            amount,
            currency: (params['currency'] as string | undefined) ?? 'USD',
            tags: ((params['tags'] as string | undefined) ?? '').split(',').map(t => t.trim()).filter(Boolean),
            createdAt: new Date().toISOString(),
          };
          ledger.push(entry);
          saveLedger(ledger);
          return {
            success: true,
            output: `Entry recorded: DR ${debitAccount} / CR ${creditAccount} — ${amount} ${entry.currency} (${description})`,
            data: entry,
          };
        }

        case 'list': {
          const account = params['account'] as string | undefined;
          const limit = (params['limit'] as number | undefined) ?? 50;
          const filtered = account
            ? ledger.filter(e => e.debitAccount.includes(account) || e.creditAccount.includes(account))
            : ledger;
          const results = filtered.slice(-limit);
          return {
            success: true,
            output: results.length > 0
              ? `${results.length} entries:\n${results.map(e => `${e.date} | DR:${e.debitAccount} CR:${e.creditAccount} | ${e.amount} ${e.currency} | ${e.description}`).join('\n')}`
              : 'No entries found.',
            data: results,
          };
        }

        case 'balance': {
          const account = params['account'] as string | undefined;
          if (!account?.trim()) return { success: false, output: 'account is required for balance.' };
          const debits = ledger.filter(e => e.debitAccount === account).reduce((s, e) => s + e.amount, 0);
          const credits = ledger.filter(e => e.creditAccount === account).reduce((s, e) => s + e.amount, 0);
          return {
            success: true,
            output: `Account "${account}": Debits=${debits.toFixed(2)} Credits=${credits.toFixed(2)} Net=${(debits - credits).toFixed(2)}`,
            data: { account, debits, credits, net: debits - credits },
          };
        }

        case 'trial-balance': {
          const accounts = new Map<string, { debits: number; credits: number }>();
          for (const e of ledger) {
            const dr = accounts.get(e.debitAccount) ?? { debits: 0, credits: 0 };
            dr.debits += e.amount;
            accounts.set(e.debitAccount, dr);
            const cr = accounts.get(e.creditAccount) ?? { debits: 0, credits: 0 };
            cr.credits += e.amount;
            accounts.set(e.creditAccount, cr);
          }
          const lines = [...accounts.entries()].map(([acc, bal]) =>
            `${acc.padEnd(30)} DR:${bal.debits.toFixed(2).padStart(12)} CR:${bal.credits.toFixed(2).padStart(12)}`
          );
          return {
            success: true,
            output: lines.length > 0 ? `Trial Balance:\n${lines.join('\n')}` : 'No accounts in ledger.',
            data: Object.fromEntries(accounts),
          };
        }

        case 'stats': {
          const totalEntries = ledger.length;
          const totalDebits = ledger.reduce((s, e) => s + e.amount, 0);
          return {
            success: true,
            output: `Ledger: ${totalEntries} entries | Total debits: ${totalDebits.toFixed(2)}`,
            data: { totalEntries, totalDebits },
          };
        }

        default:
          return { success: false, output: `Unknown action: ${action}` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ action, err: msg }, 'finance.bookkeeper error');
      return { success: false, output: `Bookkeeper error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// finance.tax-calculator
// ---------------------------------------------------------------------------

const taxCalculatorTool: ToolDefinition = {
  name: 'finance.tax-calculator',
  description:
    'Calculate tax liability for a given income profile with deduction optimisation. Supports individual, sole trader, and small business scenarios.',
  category: 'finance',
  timeout: 60_000,
  parameters: {
    income: { type: 'number', required: true, description: 'Gross income in the period (USD or local currency).' },
    entityType: { type: 'string', description: 'Entity type.', enum: ['individual', 'sole-trader', 'llc', 'corporation'], default: 'individual' },
    country: { type: 'string', description: 'Country for tax rules (default: US).', default: 'US' },
    deductions: { type: 'string', description: 'Known deductions (comma-separated list, e.g. "home office 2000, health insurance 5000").' },
    expenses: { type: 'string', description: 'Business expenses description for deductibility analysis.' },
    filingStatus: { type: 'string', description: 'Filing status (individual only).', enum: ['single', 'married-jointly', 'married-separately', 'head-of-household'], default: 'single' },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const income = params['income'] as number | undefined;
    const entityType = (params['entityType'] as string | undefined) ?? 'individual';
    const country = (params['country'] as string | undefined) ?? 'US';
    const deductions = (params['deductions'] as string | undefined) ?? '';
    const expenses = (params['expenses'] as string | undefined) ?? '';
    const filingStatus = (params['filingStatus'] as string | undefined) ?? 'single';
    logger.info({ session: ctx.sessionId, income, entityType }, 'finance.tax-calculator invoked');

    if (income === undefined || income < 0) return { success: false, output: 'income must be a non-negative number.' };

    try {
      const system = `You are a certified tax advisor (CPA) for ${country}. Provide accurate tax estimates with optimisation advice. Always note this is for estimation purposes and professional advice should be sought for filing.`;
      const user = `Calculate tax liability and optimisation for:
Income: ${income} | Entity: ${entityType} | Country: ${country} | Filing: ${filingStatus}
${deductions ? `Known deductions: ${deductions}` : ''}
${expenses ? `Business expenses: ${expenses}` : ''}

Provide:
1. TAX BRACKET BREAKDOWN (marginal rates applied)
2. ESTIMATED TAX LIABILITY (federal + state/local estimate)
3. CURRENT DEDUCTIONS APPLIED (itemised)
4. MISSED DEDUCTION OPPORTUNITIES (with estimated savings)
5. OPTIMISATION STRATEGIES (legal tax reduction strategies)
6. EFFECTIVE TAX RATE
7. QUARTERLY PAYMENT SCHEDULE (if applicable)`;

      const output = await askBrain(ctx, system, user);
      logger.info({ income, entityType, country }, 'Tax calculation complete');
      return { success: true, output, data: { income, entityType, country } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ income, err: msg }, 'finance.tax-calculator error');
      return { success: false, output: `Tax calculator error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// finance.financial-report
// ---------------------------------------------------------------------------

const financialReportTool: ToolDefinition = {
  name: 'finance.financial-report',
  description:
    'Generate P&L, balance sheet, or cash flow statement from ledger data or a provided financial summary.',
  category: 'finance',
  timeout: 60_000,
  parameters: {
    reportType: { type: 'string', required: true, description: 'Report to generate.', enum: ['profit-loss', 'balance-sheet', 'cash-flow', 'full'] },
    period: { type: 'string', description: 'Reporting period (e.g. "2026-Q1", "2026-03", "2026"). Defaults to current month.' },
    summary: { type: 'string', description: 'Optional financial data summary to include (revenue, expenses, assets, liabilities).' },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const reportType = params['reportType'] as string | undefined;
    const period = (params['period'] as string | undefined) ?? new Date().toISOString().slice(0, 7);
    const summary = (params['summary'] as string | undefined) ?? '';
    logger.info({ session: ctx.sessionId, reportType, period }, 'finance.financial-report invoked');

    if (!reportType) return { success: false, output: 'reportType is required.' };

    try {
      const ledger = loadLedger();
      const ledgerSummary = ledger.length > 0
        ? `Ledger has ${ledger.length} entries. Total credits: ${ledger.reduce((s, e) => s + e.amount, 0).toFixed(2)}.`
        : 'No ledger data available.';

      const system = 'You are a CFO and financial reporting expert. Generate clear, professional financial statements.';
      const user = `Generate a ${reportType} report for period: ${period}
${ledgerSummary}
${summary ? `Additional data: ${summary}` : ''}

Format the report professionally with:
1. Report header (company, period, prepared date)
2. Appropriate sections for ${reportType}:
   - P&L: Revenue, COGS, Gross Profit, Operating Expenses, EBITDA, Net Income
   - Balance Sheet: Assets, Liabilities, Equity
   - Cash Flow: Operating, Investing, Financing activities
3. Key ratios and metrics
4. Year-over-year comparison (estimate if data unavailable)
5. Executive summary with 3 key insights`;

      const output = await askBrain(ctx, system, user);
      logger.info({ reportType, period }, 'Financial report generated');
      return { success: true, output, data: { reportType, period, ledgerEntries: ledger.length } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ reportType, err: msg }, 'finance.financial-report error');
      return { success: false, output: `Financial report error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// finance.payment-processor
// ---------------------------------------------------------------------------

const paymentProcessorTool: ToolDefinition = {
  name: 'finance.payment-processor',
  description:
    'Process payments and manage customers via Stripe. Requires STRIPE_SECRET_KEY environment variable. Supports charge creation, customer management, and payment status checks.',
  category: 'finance',
  timeout: 30_000,
  requiresConfirmation: true,
  parameters: {
    action: {
      type: 'string',
      required: true,
      description: 'Stripe operation.',
      enum: ['create-payment-intent', 'create-customer', 'list-payments', 'get-balance', 'create-invoice'],
    },
    amount: { type: 'number', description: 'Amount in cents (e.g. 1000 = $10.00). Required for create-payment-intent.' },
    currency: { type: 'string', description: 'ISO currency code (default: usd).', default: 'usd' },
    customerId: { type: 'string', description: 'Stripe customer ID (cus_xxx). Used for create-payment-intent and create-invoice.' },
    email: { type: 'string', description: 'Customer email. Required for create-customer.' },
    name: { type: 'string', description: 'Customer name. Used for create-customer.' },
    description: { type: 'string', description: 'Payment or invoice description.' },
    limit: { type: 'number', description: 'Max records for list-payments (default: 10).', default: 10 },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = params['action'] as string;
    logger.info({ session: ctx.sessionId, action }, 'finance.payment-processor invoked');

    const stripeKey = process.env['STRIPE_SECRET_KEY'];
    if (!stripeKey) {
      return { success: false, output: 'STRIPE_SECRET_KEY environment variable is not set. Configure it to use payment processing.' };
    }

    // Use Stripe REST API directly via fetch to avoid requiring the stripe npm package.
    const stripeBase = 'https://api.stripe.com/v1';
    const authHeader = `Basic ${Buffer.from(`${stripeKey}:`).toString('base64')}`;

    async function stripePost(endpoint: string, body: Record<string, string | number | boolean>): Promise<Record<string, unknown>> {
      const formBody = Object.entries(body).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
      const resp = await fetch(`${stripeBase}${endpoint}`, {
        method: 'POST',
        headers: { 'Authorization': authHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody,
      });
      const json = await resp.json() as Record<string, unknown>;
      if (!resp.ok) throw new Error((json['error'] as Record<string, string> | undefined)?.['message'] ?? `Stripe error ${resp.status}`);
      return json;
    }

    async function stripeGet(endpoint: string, query?: Record<string, string>): Promise<Record<string, unknown>> {
      const qs = query ? '?' + new URLSearchParams(query).toString() : '';
      const resp = await fetch(`${stripeBase}${endpoint}${qs}`, {
        headers: { 'Authorization': authHeader },
      });
      const json = await resp.json() as Record<string, unknown>;
      if (!resp.ok) throw new Error((json['error'] as Record<string, string> | undefined)?.['message'] ?? `Stripe error ${resp.status}`);
      return json;
    }

    try {
      switch (action) {
        case 'create-payment-intent': {
          const amount = params['amount'] as number | undefined;
          if (!amount || amount <= 0) return { success: false, output: 'amount (in cents) is required and must be positive.' };
          const currency = (params['currency'] as string | undefined) ?? 'usd';
          const body: Record<string, string | number> = { amount, currency };
          if (params['customerId']) body['customer'] = params['customerId'] as string;
          if (params['description']) body['description'] = params['description'] as string;
          const pi = await stripePost('/payment_intents', body);
          return { success: true, output: `Payment intent created: ${pi['id']} | Amount: ${(amount / 100).toFixed(2)} ${currency.toUpperCase()} | Status: ${pi['status']}`, data: { id: pi['id'], status: pi['status'], clientSecret: pi['client_secret'] } };
        }

        case 'create-customer': {
          const email = params['email'] as string | undefined;
          if (!email?.trim()) return { success: false, output: 'email is required for create-customer.' };
          const body: Record<string, string> = { email };
          if (params['name']) body['name'] = params['name'] as string;
          if (params['description']) body['description'] = params['description'] as string;
          const customer = await stripePost('/customers', body);
          return { success: true, output: `Customer created: ${customer['id']} (${email})`, data: { id: customer['id'], email } };
        }

        case 'list-payments': {
          const limit = Math.min(100, (params['limit'] as number | undefined) ?? 10);
          const result = await stripeGet('/payment_intents', { limit: String(limit) });
          const data = (result['data'] as Array<Record<string, unknown>>) ?? [];
          const lines = data.map(p => `${p['id']} | ${((p['amount'] as number) / 100).toFixed(2)} ${String(p['currency']).toUpperCase()} | ${p['status']} | ${new Date((p['created'] as number) * 1000).toISOString().split('T')[0]}`);
          return { success: true, output: lines.length > 0 ? `${lines.length} payments:\n${lines.join('\n')}` : 'No payments found.', data };
        }

        case 'get-balance': {
          const balance = await stripeGet('/balance');
          const available = ((balance['available'] as Array<{ amount: number; currency: string }>) ?? []).map(b => `${(b.amount / 100).toFixed(2)} ${b.currency.toUpperCase()}`).join(', ');
          const pending = ((balance['pending'] as Array<{ amount: number; currency: string }>) ?? []).map(b => `${(b.amount / 100).toFixed(2)} ${b.currency.toUpperCase()}`).join(', ');
          return { success: true, output: `Balance — Available: ${available} | Pending: ${pending}`, data: balance };
        }

        case 'create-invoice': {
          const customerId = params['customerId'] as string | undefined;
          if (!customerId?.trim()) return { success: false, output: 'customerId is required for create-invoice.' };
          const body: Record<string, string | boolean> = { customer: customerId, auto_advance: false };
          if (params['description']) body['description'] = params['description'] as string;
          const invoice = await stripePost('/invoices', body);
          return { success: true, output: `Invoice created: ${invoice['id']} | Customer: ${customerId} | Status: ${invoice['status']}`, data: { id: invoice['id'], status: invoice['status'] } };
        }

        default:
          return { success: false, output: `Unknown action: ${action}` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ action, err: msg }, 'finance.payment-processor error');
      return { success: false, output: `Payment processor error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const FINANCE_TOOLS: ToolDefinition[] = [
  bookkeeperTool,
  taxCalculatorTool,
  financialReportTool,
  paymentProcessorTool,
];

/**
 * Register all finance tools with the given registry.
 * Called automatically by the built-in tool loader.
 *
 * @param registry - The application's central {@link ToolRegistry}.
 */
export function registerFinanceTools(registry: ToolRegistry): void {
  // Persona/business tools are quarantined by default (SUDO_ENABLE_PERSONA_TOOLS=1).
  if (process.env['SUDO_ENABLE_PERSONA_TOOLS'] !== '1') {
    logger.info('Finance tools quarantined — set SUDO_ENABLE_PERSONA_TOOLS=1 to enable');
    return;
  }
  logger.info({ count: FINANCE_TOOLS.length }, 'Registering finance tools');
  for (const tool of FINANCE_TOOLS) {
    registry.register(tool);
  }
  logger.info({ count: FINANCE_TOOLS.length }, 'Finance tools registered');
}
