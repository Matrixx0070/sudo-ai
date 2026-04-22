/** InvoiceManager — invoices + line-items backed by better-sqlite3. */

import Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import path from 'path';
import { mkdirSync } from 'fs';
import { createLogger } from '../shared/logger.js';
import { BusinessError } from '../shared/errors.js';
import type { Invoice, InvoiceItem } from './types.js';

const log = createLogger('business');
const DB_PATH = path.resolve('data/business.db');

// Row shapes
interface InvoiceRow {
  id: string;
  client_name: string;
  client_email: string | null;
  currency: string;
  status: string;
  due_date: string;
  paid_date: string | null;
  created_at: string;
}

interface ItemRow {
  invoice_id: string;
  description: string;
  quantity: number;
  unit_price: number;
  total: number;
}

// Helpers
function calcTotal(items: InvoiceItem[]): number {
  return items.reduce((sum, i) => sum + i.total, 0);
}

function rowToInvoice(row: InvoiceRow, items: ItemRow[]): Invoice {
  return {
    id: row.id,
    clientName: row.client_name,
    clientEmail: row.client_email ?? undefined,
    currency: row.currency,
    status: row.status as Invoice['status'],
    dueDate: row.due_date,
    paidDate: row.paid_date ?? undefined,
    createdAt: row.created_at,
    items: items.map((it) => ({
      description: it.description,
      quantity: it.quantity,
      unitPrice: it.unit_price,
      total: it.total,
    })),
  };
}

function validateItems(items: InvoiceItem[]): InvoiceItem[] {
  if (!Array.isArray(items) || items.length === 0) {
    throw new BusinessError('Invoice must have at least one item', 'invalid_input');
  }
  return items.map((item) => {
    if (!item.description?.trim()) throw new BusinessError('Item description required', 'invalid_input');
    if (item.quantity <= 0) throw new BusinessError('Item quantity must be positive', 'invalid_input');
    if (item.unitPrice < 0) throw new BusinessError('Item unit price cannot be negative', 'invalid_input');
    return {
      description: item.description.trim(),
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      total: parseFloat((item.quantity * item.unitPrice).toFixed(2)),
    };
  });
}

export class InvoiceManager {
  private readonly db: Database.Database;

  constructor(dbPath: string = DB_PATH) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this._migrate();
    log.info({ dbPath }, 'InvoiceManager initialised');
  }

  private _migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS invoices (
        id           TEXT PRIMARY KEY,
        client_name  TEXT NOT NULL,
        client_email TEXT,
        currency     TEXT NOT NULL DEFAULT 'USD',
        status       TEXT NOT NULL DEFAULT 'draft',
        due_date     TEXT NOT NULL,
        paid_date    TEXT,
        created_at   TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
      CREATE INDEX IF NOT EXISTS idx_invoices_due    ON invoices(due_date);

      CREATE TABLE IF NOT EXISTS invoice_items (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        invoice_id  TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
        description TEXT NOT NULL,
        quantity    REAL NOT NULL,
        unit_price  REAL NOT NULL,
        total       REAL NOT NULL
      );
    `);
  }

  private _loadItems(invoiceId: string): ItemRow[] {
    return this.db.prepare(
      'SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id'
    ).all(invoiceId) as ItemRow[];
  }

  private _loadInvoice(id: string): Invoice {
    const row = this.db.prepare('SELECT * FROM invoices WHERE id = ?').get(id) as InvoiceRow | undefined;
    if (!row) throw new BusinessError(`Invoice not found: ${id}`, 'not_found', { id });
    return rowToInvoice(row, this._loadItems(id));
  }

  create(input: Omit<Invoice, 'id' | 'createdAt'>): Invoice {
    if (!input.clientName?.trim()) throw new BusinessError('clientName is required', 'invalid_input');
    if (!input.dueDate?.trim()) throw new BusinessError('dueDate is required', 'invalid_input');
    const items = validateItems(input.items);
    const now = new Date().toISOString();
    const id = nanoid();

    const insertInvoice = this.db.prepare(`
      INSERT INTO invoices (id, client_name, client_email, currency, status, due_date, paid_date, created_at)
      VALUES (@id, @clientName, @clientEmail, @currency, @status, @dueDate, @paidDate, @createdAt)
    `);

    const insertItem = this.db.prepare(`
      INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, total)
      VALUES (@invoiceId, @description, @quantity, @unitPrice, @total)
    `);

    const tx = this.db.transaction(() => {
      insertInvoice.run({
        id,
        clientName: input.clientName.trim(),
        clientEmail: input.clientEmail?.trim() ?? null,
        currency: input.currency ?? 'USD',
        status: input.status ?? 'draft',
        dueDate: input.dueDate,
        paidDate: input.paidDate ?? null,
        createdAt: now,
      });
      for (const item of items) {
        insertItem.run({ invoiceId: id, ...item });
      }
    });
    tx();

    log.info({ invoiceId: id, client: input.clientName, total: calcTotal(items) }, 'Invoice created');
    return this._loadInvoice(id);
  }

  update(id: string, patch: Partial<Omit<Invoice, 'id' | 'createdAt'>>): Invoice {
    const existing = this._loadInvoice(id);
    const items = patch.items ? validateItems(patch.items) : existing.items;

    const tx = this.db.transaction(() => {
      this.db.prepare(`
        UPDATE invoices SET client_name=?, client_email=?, currency=?, status=?, due_date=?, paid_date=? WHERE id=?
      `).run(
        patch.clientName ?? existing.clientName,
        patch.clientEmail ?? existing.clientEmail ?? null,
        patch.currency ?? existing.currency,
        patch.status ?? existing.status,
        patch.dueDate ?? existing.dueDate,
        patch.paidDate ?? existing.paidDate ?? null,
        id,
      );
      if (patch.items) {
        this.db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(id);
        const ins = this.db.prepare(
          'INSERT INTO invoice_items (invoice_id, description, quantity, unit_price, total) VALUES (?,?,?,?,?)'
        );
        for (const item of items) ins.run(id, item.description, item.quantity, item.unitPrice, item.total);
      }
    });
    tx();
    log.info({ invoiceId: id }, 'Invoice updated');
    return this._loadInvoice(id);
  }

  markPaid(id: string, paidDate?: string): Invoice {
    const date = paidDate ?? new Date().toISOString().slice(0, 10);
    this.db.prepare("UPDATE invoices SET status='paid', paid_date=? WHERE id=?").run(date, id);
    log.info({ invoiceId: id, paidDate: date }, 'Invoice marked paid');
    return this._loadInvoice(id);
  }

  markSent(id: string): Invoice {
    this.db.prepare("UPDATE invoices SET status='sent' WHERE id=?").run(id);
    log.info({ invoiceId: id }, 'Invoice marked sent');
    return this._loadInvoice(id);
  }

  getOverdue(): Invoice[] {
    const today = new Date().toISOString().slice(0, 10);
    // Also auto-flip status to overdue for sent invoices past due
    this.db.prepare(
      "UPDATE invoices SET status='overdue' WHERE status='sent' AND due_date < ?"
    ).run(today);
    const rows = this.db.prepare(
      "SELECT * FROM invoices WHERE status='overdue' ORDER BY due_date ASC"
    ).all() as InvoiceRow[];
    return rows.map((r) => rowToInvoice(r, this._loadItems(r.id)));
  }

  generateMarkdown(id: string): string {
    const inv = this._loadInvoice(id);
    const total = calcTotal(inv.items);
    const lines: string[] = [
      `# Invoice ${inv.id}`,
      `**Client:** ${inv.clientName}${inv.clientEmail ? ` <${inv.clientEmail}>` : ''}`,
      `**Status:** ${inv.status}  **Due:** ${inv.dueDate}`,
      `**Currency:** ${inv.currency}`,
      '',
      '| Description | Qty | Unit Price | Total |',
      '|---|---|---|---|',
      ...inv.items.map(
        (i) => `| ${i.description} | ${i.quantity} | ${i.unitPrice.toFixed(2)} | ${i.total.toFixed(2)} |`
      ),
      '',
      `**Total: ${inv.currency} ${total.toFixed(2)}**`,
    ];
    if (inv.paidDate) lines.push(`\n_Paid on ${inv.paidDate}_`);
    return lines.join('\n');
  }

  getStats(): { totalRevenue: number; pendingCount: number; overdueCount: number } {
    this.getOverdue();
    const r = (this.db.prepare("SELECT COALESCE(SUM(ii.total),0) as r FROM invoice_items ii JOIN invoices inv ON inv.id=ii.invoice_id WHERE inv.status='paid'").get() as { r: number }).r;
    const p = (this.db.prepare("SELECT COUNT(*) as n FROM invoices WHERE status IN ('draft','sent')").get() as { n: number }).n;
    const o = (this.db.prepare("SELECT COUNT(*) as n FROM invoices WHERE status='overdue'").get() as { n: number }).n;
    return { totalRevenue: r, pendingCount: p, overdueCount: o };
  }

  close(): void {
    this.db.close();
    log.info('InvoiceManager database closed');
  }
}
