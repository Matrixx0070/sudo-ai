/**
 * Type definitions for the SUDO-AI Business Engine.
 *
 * Covers CRM contacts, interaction history, invoicing, calendar events,
 * and aggregated business metrics. All timestamps are ISO-8601 strings.
 */

// ---------------------------------------------------------------------------
// CRM
// ---------------------------------------------------------------------------

/** A contact tracked by the CRM. */
export interface Contact {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  company?: string;
  /** Freeform labels e.g. ['client', 'vip']. Stored as JSON in SQLite. */
  tags: string[];
  notes: string;
  createdAt: string;
  updatedAt: string;
}

/** A single logged interaction with a contact. */
export interface Interaction {
  id: string;
  contactId: string;
  type: 'email' | 'call' | 'meeting' | 'message' | 'note';
  summary: string;
  /** Platform or medium e.g. 'gmail', 'whatsapp'. */
  channel?: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Invoicing
// ---------------------------------------------------------------------------

/** A single line-item on an invoice. */
export interface InvoiceItem {
  description: string;
  quantity: number;
  unitPrice: number;
  /** Computed: quantity * unitPrice. */
  total: number;
}

/** An invoice sent to a client. */
export interface Invoice {
  id: string;
  clientName: string;
  clientEmail?: string;
  items: InvoiceItem[];
  /** ISO-4217 currency code e.g. 'USD'. */
  currency: string;
  status: 'draft' | 'sent' | 'paid' | 'overdue';
  dueDate: string;
  paidDate?: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

/** A calendar event. */
export interface CalendarEvent {
  id: string;
  title: string;
  /** ISO-8601 datetime string. */
  start: string;
  /** ISO-8601 datetime string. */
  end: string;
  description?: string;
  location?: string;
  /** List of attendee email addresses. */
  attendees?: string[];
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

/** High-level business KPIs returned by the analytics dashboard. */
export interface BusinessMetrics {
  /** Sum of all paid invoice amounts. */
  totalRevenue: number;
  /** Count of invoices with status 'draft' or 'sent'. */
  pendingInvoices: number;
  /** Count of invoices with status 'overdue'. */
  overdueInvoices: number;
  /** Total number of contacts in the CRM. */
  totalContacts: number;
  /** Interactions logged in the last 7 days. */
  recentInteractions: number;
}

/** Revenue data point for trend charts. */
export interface RevenueTrendPoint {
  /** Format: 'YYYY-MM'. */
  month: string;
  revenue: number;
  invoiceCount: number;
}

/** Per-client report returned by analytics. */
export interface ClientReport {
  contact: Contact;
  totalSpent: number;
  invoiceCount: number;
  lastInteraction?: string;
  interactions: Interaction[];
}
