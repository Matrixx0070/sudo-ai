/**
 * ReportGenerator — produce human-readable markdown business reports.
 *
 * Aggregates data from CRM, InvoiceManager, and CalendarClient to produce
 * weekly, monthly, and custom-template reports.
 */

import { createLogger } from '../shared/logger.js';
import { BusinessError } from '../shared/errors.js';
import { CRM } from './crm.js';
import { InvoiceManager } from './invoicing.js';
import { CalendarClient } from './calendar.js';
import { BusinessAnalytics } from './analytics.js';
import type { BusinessMetrics, RevenueTrendPoint } from './types.js';

const log = createLogger('business');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReportData {
  metrics: BusinessMetrics;
  revenueTrend?: RevenueTrendPoint[];
  overdueList?: string[];
  followUpList?: string[];
  upcomingEvents?: string[];
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function heading(level: number, text: string): string {
  return `${'#'.repeat(level)} ${text}`;
}

function bulletList(items: string[]): string {
  if (items.length === 0) return '_None_';
  return items.map((i) => `- ${i}`).join('\n');
}

function kpiTable(metrics: BusinessMetrics): string {
  return [
    '| Metric | Value |',
    '|---|---|',
    `| Total Revenue | $${metrics.totalRevenue.toFixed(2)} |`,
    `| Pending Invoices | ${metrics.pendingInvoices} |`,
    `| Overdue Invoices | ${metrics.overdueInvoices} |`,
    `| Total Contacts | ${metrics.totalContacts} |`,
    `| Recent Interactions (7d) | ${metrics.recentInteractions} |`,
  ].join('\n');
}

function trendTable(points: RevenueTrendPoint[]): string {
  if (points.length === 0) return '_No data_';
  const header = '| Month | Revenue | Invoices |\n|---|---|---|';
  const rows = points.map((p) => `| ${p.month} | $${p.revenue.toFixed(2)} | ${p.invoiceCount} |`);
  return [header, ...rows].join('\n');
}

function isoNow(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function weekRange(): { start: string; end: string } {
  const now = new Date();
  const end = now.toISOString().slice(0, 10);
  const start = new Date(now.getTime() - 7 * 86_400_000).toISOString().slice(0, 10);
  return { start, end };
}

function monthRange(): { start: string; end: string } {
  const now = new Date();
  const end = now.toISOString().slice(0, 10);
  const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  return { start, end };
}

// ---------------------------------------------------------------------------
// ReportGenerator
// ---------------------------------------------------------------------------

export class ReportGenerator {
  private readonly crm: CRM;
  private readonly invoicing: InvoiceManager;
  private readonly calendar: CalendarClient;
  private readonly analytics: BusinessAnalytics;

  constructor(crm?: CRM, invoicing?: InvoiceManager, calendar?: CalendarClient) {
    this.crm = crm ?? new CRM();
    this.invoicing = invoicing ?? new InvoiceManager();
    this.calendar = calendar ?? new CalendarClient();
    this.analytics = new BusinessAnalytics(this.crm, this.invoicing);
    log.info('ReportGenerator initialised');
  }

  // -------------------------------------------------------------------------
  // Weekly report
  // -------------------------------------------------------------------------

  async weekly(): Promise<string> {
    const { start, end } = weekRange();
    log.info({ start, end }, 'Generating weekly report');

    const metrics = this.analytics.getDashboard('7d');
    const overdue = this.invoicing.getOverdue();
    const followUps = this.crm.getDueFollowUps();
    const events = await this.calendar.listEvents(end, new Date(
      new Date(end).getTime() + 7 * 86_400_000
    ).toISOString().slice(0, 10)).catch(() => []);

    const sections: string[] = [
      heading(1, 'Weekly Business Report'),
      `_Generated: ${isoNow()} | Period: ${start} → ${end}_`,
      '',
      heading(2, 'KPI Summary'),
      kpiTable(metrics),
      '',
      heading(2, 'Revenue Trend (4 weeks)'),
      trendTable(this.analytics.getRevenueTrend(4)),
      '',
      heading(2, 'Overdue Invoices'),
      bulletList(overdue.map((inv) => `[${inv.id}] ${inv.clientName} — due ${inv.dueDate}`)),
      '',
      heading(2, 'Follow-ups Due'),
      bulletList(followUps.slice(0, 10).map((c) => `${c.name}${c.email ? ` <${c.email}>` : ''}`)),
      '',
      heading(2, 'Upcoming Events (next 7 days)'),
      bulletList(events.slice(0, 10).map((ev) => `${ev.start.slice(0, 10)} — ${ev.title}`)),
    ];

    const report = sections.join('\n');
    log.info({ chars: report.length }, 'Weekly report generated');
    return report;
  }

  // -------------------------------------------------------------------------
  // Monthly report
  // -------------------------------------------------------------------------

  async monthly(): Promise<string> {
    const { start, end } = monthRange();
    log.info({ start, end }, 'Generating monthly report');

    const metrics = this.analytics.getDashboard('30d');
    const trend = this.analytics.getRevenueTrend(3);
    const overdue = this.invoicing.getOverdue();
    const followUps = this.crm.getDueFollowUps();
    const events = await this.calendar.listEvents(end, new Date(
      new Date(end).getTime() + 30 * 86_400_000
    ).toISOString().slice(0, 10)).catch(() => []);

    const sections: string[] = [
      heading(1, 'Monthly Business Report'),
      `_Generated: ${isoNow()} | Period: ${start} → ${end}_`,
      '',
      heading(2, 'KPI Summary'),
      kpiTable(metrics),
      '',
      heading(2, 'Revenue Trend (3 months)'),
      trendTable(trend),
      '',
      heading(2, 'Overdue Invoices'),
      bulletList(overdue.map((inv) => `[${inv.id}] ${inv.clientName} — due ${inv.dueDate} (${inv.currency})`)),
      '',
      heading(2, 'Contacts Requiring Follow-up'),
      bulletList(followUps.slice(0, 20).map((c) => `${c.name}${c.company ? ` @ ${c.company}` : ''}`)),
      '',
      heading(2, 'Upcoming Events (next 30 days)'),
      bulletList(events.slice(0, 20).map((ev) => `${ev.start.slice(0, 10)} — ${ev.title}`)),
    ];

    const report = sections.join('\n');
    log.info({ chars: report.length }, 'Monthly report generated');
    return report;
  }

  // -------------------------------------------------------------------------
  // Custom report
  // -------------------------------------------------------------------------

  /**
   * Render a custom markdown template with data interpolation.
   *
   * Template variables use `{{key}}` syntax.  The available keys are the
   * properties of ReportData (all values are JSON-stringified if not a string).
   *
   * @param template - Markdown string with `{{variable}}` placeholders.
   * @param data     - Data to inject into the template.
   */
  custom(template: string, data: ReportData): string {
    if (!template?.trim()) {
      throw new BusinessError('Template is required', 'invalid_input');
    }

    const rendered = template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
      const value = data[key];
      if (value === undefined || value === null) return '';
      if (typeof value === 'string') return value;
      return JSON.stringify(value, null, 2);
    });

    log.info({ keys: Object.keys(data).length }, 'Custom report rendered');
    return rendered;
  }
}
