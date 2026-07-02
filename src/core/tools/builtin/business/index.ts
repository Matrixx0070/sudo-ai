/**
 * Business toolkit — registers 6 business tools into the ToolRegistry.
 *
 * Each tool wraps the corresponding business class from src/core/business/.
 * Class instances are created fresh per-call so there are no shared-state
 * races across concurrent agent sessions. The SQLite WAL mode used by the
 * underlying classes makes concurrent reads safe.
 *
 * Tools registered:
 *   business.crm        — Contact management: add, update, search, log interactions
 *   business.invoicing  — Invoice lifecycle: create, update, mark-paid, overdue list
 *   business.email      — Send email via SMTP / Gmail
 *   business.calendar   — Google Calendar events: list, create, update, delete
 *   business.analytics  — KPI dashboard and revenue trend reports
 *   business.reports    — Generate weekly, monthly, or custom markdown reports
 */

import type { ToolRegistry } from '../../registry.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';

const logger = createLogger('business-builtin');

// ---------------------------------------------------------------------------
// business.crm
// ---------------------------------------------------------------------------

const crmTool: ToolDefinition = {
  name: 'business.crm',
  description:
    'Manage contacts and interactions in the CRM. Add/update contacts, search by name/company/email, log interactions, get follow-up reminders.',
  category: 'business',
  timeout: 15_000,
  parameters: {
    action: {
      type: 'string',
      required: true,
      description: 'Operation to perform.',
      enum: ['add-contact', 'update-contact', 'get-contact', 'search', 'log-interaction', 'get-history', 'follow-ups', 'stats'],
    },
    name: { type: 'string', description: 'Contact full name (required for add-contact).' },
    contactId: { type: 'string', description: 'Contact ID (required for update-contact, get-contact, log-interaction, get-history).' },
    email: { type: 'string', description: 'Contact email address.' },
    phone: { type: 'string', description: 'Contact phone number.' },
    company: { type: 'string', description: 'Contact company name.' },
    notes: { type: 'string', description: 'Free-form notes about the contact.' },
    query: { type: 'string', description: 'Search query (used for search action).' },
    interactionType: {
      type: 'string',
      description: 'Type of interaction to log.',
      enum: ['call', 'email', 'meeting', 'message', 'note'],
    },
    summary: { type: 'string', description: 'Summary of the interaction (required for log-interaction).' },
    limit: { type: 'number', description: 'Max number of results to return (default: 20).', default: 20 },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = params['action'] as string;
    logger.info({ session: ctx.sessionId, action }, 'business.crm invoked');

    try {
      const { CRM } = await import('../../../business/crm.js');
      const crm = new CRM();

      try {
        switch (action) {
          case 'add-contact': {
            const name = params['name'] as string | undefined;
            if (!name?.trim()) return { success: false, output: 'name is required for add-contact.' };
            const contact = crm.addContact({
              name,
              email: params['email'] as string | undefined,
              phone: params['phone'] as string | undefined,
              company: params['company'] as string | undefined,
              notes: (params['notes'] as string | undefined) ?? '',
              tags: [],
            });
            return { success: true, output: `Contact added: ${contact.name} (id: ${contact.id})`, data: contact };
          }

          case 'update-contact': {
            const contactId = params['contactId'] as string | undefined;
            if (!contactId?.trim()) return { success: false, output: 'contactId is required.' };
            const patch: Record<string, unknown> = {};
            if (params['name']) patch['name'] = params['name'];
            if (params['email']) patch['email'] = params['email'];
            if (params['phone']) patch['phone'] = params['phone'];
            if (params['company']) patch['company'] = params['company'];
            if (params['notes']) patch['notes'] = params['notes'];
            const updated = crm.updateContact(contactId, patch);
            return { success: true, output: `Contact updated: ${updated.name}`, data: updated };
          }

          case 'get-contact': {
            const contactId = params['contactId'] as string | undefined;
            if (!contactId?.trim()) return { success: false, output: 'contactId is required.' };
            const contact = crm.getContact(contactId);
            return { success: true, output: `Contact: ${contact.name} (${contact.email ?? 'no email'})`, data: contact };
          }

          case 'search': {
            const query = params['query'] as string | undefined;
            if (!query?.trim()) return { success: false, output: 'query is required for search.' };
            const limit = (params['limit'] as number | undefined) ?? 20;
            const contacts = crm.searchContacts(query, limit);
            return {
              success: true,
              output: contacts.length > 0
                ? `Found ${contacts.length} contact(s): ${contacts.map((c) => c.name).join(', ')}`
                : 'No contacts matched.',
              data: contacts,
            };
          }

          case 'log-interaction': {
            const contactId = params['contactId'] as string | undefined;
            const summary = params['summary'] as string | undefined;
            if (!contactId?.trim()) return { success: false, output: 'contactId is required.' };
            if (!summary?.trim()) return { success: false, output: 'summary is required.' };
            const interaction = crm.logInteraction({
              contactId,
              type: (params['interactionType'] as 'call' | 'email' | 'meeting' | 'message' | 'note' | undefined) ?? 'note',
              summary,
              channel: undefined,
            });
            return { success: true, output: `Interaction logged (id: ${interaction.id})`, data: interaction };
          }

          case 'get-history': {
            const contactId = params['contactId'] as string | undefined;
            if (!contactId?.trim()) return { success: false, output: 'contactId is required.' };
            const limit = (params['limit'] as number | undefined) ?? 50;
            const history = crm.getHistory(contactId, limit);
            return {
              success: true,
              output: `${history.length} interaction(s) found.`,
              data: history,
            };
          }

          case 'follow-ups': {
            const due = crm.getDueFollowUps();
            return {
              success: true,
              output: due.length > 0
                ? `${due.length} contact(s) need follow-up: ${due.slice(0, 5).map((c) => c.name).join(', ')}`
                : 'No follow-ups due.',
              data: due,
            };
          }

          case 'stats': {
            const stats = crm.getStats();
            return {
              success: true,
              output: `CRM: ${stats.totalContacts} contacts, ${stats.totalInteractions} interactions (${stats.recentInteractions} in last 7d).`,
              data: stats,
            };
          }

          default:
            return { success: false, output: `Unknown action: ${action}` };
        }
      } finally {
        crm.close();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ action, err: msg }, 'business.crm error');
      return { success: false, output: `CRM error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// business.invoicing
// ---------------------------------------------------------------------------

const invoicingTool: ToolDefinition = {
  name: 'business.invoicing',
  description:
    'Manage invoices: create drafts, update details, mark paid/sent, list overdue, generate markdown invoice documents, view stats.',
  category: 'business',
  timeout: 15_000,
  parameters: {
    action: {
      type: 'string',
      required: true,
      description: 'Operation to perform.',
      enum: ['create', 'update', 'mark-paid', 'mark-sent', 'get-overdue', 'generate-markdown', 'stats'],
    },
    invoiceId: { type: 'string', description: 'Invoice ID (required for update, mark-paid, mark-sent, generate-markdown).' },
    clientName: { type: 'string', description: 'Client full name (required for create).' },
    clientEmail: { type: 'string', description: 'Client email address.' },
    currency: { type: 'string', description: 'ISO currency code (default: USD).', default: 'USD' },
    dueDate: { type: 'string', description: 'Due date in YYYY-MM-DD format (required for create).' },
    items: {
      type: 'array',
      description: 'Line items array (required for create). Each item: { description, quantity, unitPrice }.',
      items: {
        type: 'object',
        description: 'Invoice line item.',
        properties: {
          description: { type: 'string', description: 'Item description.', required: true },
          quantity: { type: 'number', description: 'Item quantity.', required: true },
          unitPrice: { type: 'number', description: 'Unit price.', required: true },
        },
      },
    },
    paidDate: { type: 'string', description: 'Date paid in YYYY-MM-DD format (optional for mark-paid).' },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = params['action'] as string;
    logger.info({ session: ctx.sessionId, action }, 'business.invoicing invoked');

    try {
      const { InvoiceManager } = await import('../../../business/invoicing.js');
      const mgr = new InvoiceManager();

      try {
        switch (action) {
          case 'create': {
            const clientName = params['clientName'] as string | undefined;
            const dueDate = params['dueDate'] as string | undefined;
            if (!clientName?.trim()) return { success: false, output: 'clientName is required.' };
            if (!dueDate?.trim()) return { success: false, output: 'dueDate is required.' };
            const rawItems = (params['items'] as Array<Record<string, unknown>> | undefined) ?? [];
            if (rawItems.length === 0) return { success: false, output: 'At least one item is required.' };
            const items = rawItems.map((i) => ({
              description: String(i['description'] ?? ''),
              quantity: Number(i['quantity'] ?? 1),
              unitPrice: Number(i['unitPrice'] ?? 0),
              total: Number(i['quantity'] ?? 1) * Number(i['unitPrice'] ?? 0),
            }));
            const invoice = mgr.create({
              clientName,
              clientEmail: params['clientEmail'] as string | undefined,
              currency: (params['currency'] as string | undefined) ?? 'USD',
              status: 'draft',
              dueDate,
              items,
            });
            return { success: true, output: `Invoice created: ${invoice.id} for ${invoice.clientName}`, data: invoice };
          }

          case 'update': {
            const invoiceId = params['invoiceId'] as string | undefined;
            if (!invoiceId?.trim()) return { success: false, output: 'invoiceId is required.' };
            const patch: Record<string, unknown> = {};
            if (params['clientName']) patch['clientName'] = params['clientName'];
            if (params['clientEmail']) patch['clientEmail'] = params['clientEmail'];
            if (params['dueDate']) patch['dueDate'] = params['dueDate'];
            if (params['currency']) patch['currency'] = params['currency'];
            const updated = mgr.update(invoiceId, patch);
            return { success: true, output: `Invoice ${invoiceId} updated.`, data: updated };
          }

          case 'mark-paid': {
            const invoiceId = params['invoiceId'] as string | undefined;
            if (!invoiceId?.trim()) return { success: false, output: 'invoiceId is required.' };
            const paid = mgr.markPaid(invoiceId, params['paidDate'] as string | undefined);
            return { success: true, output: `Invoice ${invoiceId} marked as paid on ${paid.paidDate}.`, data: paid };
          }

          case 'mark-sent': {
            const invoiceId = params['invoiceId'] as string | undefined;
            if (!invoiceId?.trim()) return { success: false, output: 'invoiceId is required.' };
            const sent = mgr.markSent(invoiceId);
            return { success: true, output: `Invoice ${invoiceId} marked as sent.`, data: sent };
          }

          case 'get-overdue': {
            const overdue = mgr.getOverdue();
            return {
              success: true,
              output: overdue.length > 0
                ? `${overdue.length} overdue invoice(s).`
                : 'No overdue invoices.',
              data: overdue,
            };
          }

          case 'generate-markdown': {
            const invoiceId = params['invoiceId'] as string | undefined;
            if (!invoiceId?.trim()) return { success: false, output: 'invoiceId is required.' };
            const md = mgr.generateMarkdown(invoiceId);
            return { success: true, output: md, data: { invoiceId, markdown: md } };
          }

          case 'stats': {
            const stats = mgr.getStats();
            return {
              success: true,
              output: `Revenue: $${stats.totalRevenue.toFixed(2)} | Pending: ${stats.pendingCount} | Overdue: ${stats.overdueCount}`,
              data: stats,
            };
          }

          default:
            return { success: false, output: `Unknown action: ${action}` };
        }
      } finally {
        mgr.close();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ action, err: msg }, 'business.invoicing error');
      return { success: false, output: `Invoicing error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// business.email
// ---------------------------------------------------------------------------

const businessEmailTool: ToolDefinition = {
  name: 'business.email',
  description:
    'Send business emails via SMTP or Gmail. Supports plain text and HTML bodies. Requires SMTP_HOST/SMTP_USER/SMTP_PASS or GMAIL_USER/GMAIL_APP_PASSWORD env vars.',
  category: 'business',
  timeout: 30_000,
  parameters: {
    to: { type: 'string', required: true, description: 'Recipient email address (or comma-separated list).' },
    subject: { type: 'string', required: true, description: 'Email subject line.' },
    body: { type: 'string', required: true, description: 'Plain-text email body.' },
    html: { type: 'string', description: 'Optional HTML version of the email body.' },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const to = params['to'] as string | undefined;
    const subject = params['subject'] as string | undefined;
    const body = params['body'] as string | undefined;

    logger.info({ session: ctx.sessionId, to, subject }, 'business.email invoked');

    if (!to?.trim()) return { success: false, output: 'to is required.' };
    if (!subject?.trim()) return { success: false, output: 'subject is required.' };
    if (!body?.trim()) return { success: false, output: 'body is required.' };

    try {
      const { EmailClient } = await import('../../../business/email.js');
      const client = new EmailClient();
      const messageId = await client.send({
        to,
        subject,
        body,
        html: params['html'] as string | undefined,
      });
      await client.close();
      return { success: true, output: `Email sent to ${to}. Message ID: ${messageId}`, data: { messageId, to, subject } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ to, err: msg }, 'business.email error');
      return { success: false, output: `Email error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// business.calendar
// ---------------------------------------------------------------------------

const calendarTool: ToolDefinition = {
  name: 'business.calendar',
  description:
    'Manage Google Calendar events: list upcoming events, create new events, update or delete existing events. Requires GOOGLE_CALENDAR_CREDENTIALS env var.',
  category: 'business',
  timeout: 30_000,
  parameters: {
    action: {
      type: 'string',
      required: true,
      description: 'Operation to perform.',
      enum: ['list', 'create', 'update', 'delete'],
    },
    eventId: { type: 'string', description: 'Event ID (required for update, delete).' },
    title: { type: 'string', description: 'Event title (required for create).' },
    start: { type: 'string', description: 'Event start as ISO 8601 datetime (required for create).' },
    end: { type: 'string', description: 'Event end as ISO 8601 datetime (required for create).' },
    description: { type: 'string', description: 'Optional event description.' },
    location: { type: 'string', description: 'Optional event location.' },
    startDate: { type: 'string', description: 'Start date for list query (YYYY-MM-DD, required for list).' },
    endDate: { type: 'string', description: 'End date for list query (YYYY-MM-DD, required for list).' },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = params['action'] as string;
    logger.info({ session: ctx.sessionId, action }, 'business.calendar invoked');

    try {
      const { CalendarClient } = await import('../../../business/calendar.js');
      const client = new CalendarClient();

      switch (action) {
        case 'list': {
          const startDate = params['startDate'] as string | undefined;
          const endDate = params['endDate'] as string | undefined;
          if (!startDate) return { success: false, output: 'startDate is required for list.' };
          if (!endDate) return { success: false, output: 'endDate is required for list.' };
          const events = await client.listEvents(startDate, endDate);
          return {
            success: true,
            output: events.length > 0
              ? `Found ${events.length} event(s): ${events.slice(0, 5).map((e) => e.title).join(', ')}`
              : 'No events found in that range.',
            data: events,
          };
        }

        case 'create': {
          const title = params['title'] as string | undefined;
          const start = params['start'] as string | undefined;
          const end = params['end'] as string | undefined;
          if (!title?.trim()) return { success: false, output: 'title is required.' };
          if (!start) return { success: false, output: 'start datetime is required.' };
          if (!end) return { success: false, output: 'end datetime is required.' };
          const event = await client.createEvent({
            title,
            start,
            end,
            description: params['description'] as string | undefined,
            location: params['location'] as string | undefined,
          });
          return { success: true, output: `Event created: "${event.title}" on ${event.start}`, data: event };
        }

        case 'update': {
          const eventId = params['eventId'] as string | undefined;
          if (!eventId?.trim()) return { success: false, output: 'eventId is required.' };
          const patch: Record<string, unknown> = {};
          if (params['title']) patch['title'] = params['title'];
          if (params['start']) patch['start'] = params['start'];
          if (params['end']) patch['end'] = params['end'];
          if (params['description']) patch['description'] = params['description'];
          if (params['location']) patch['location'] = params['location'];
          const updated = await client.updateEvent(eventId, patch);
          return { success: true, output: `Event ${eventId} updated.`, data: updated };
        }

        case 'delete': {
          const eventId = params['eventId'] as string | undefined;
          if (!eventId?.trim()) return { success: false, output: 'eventId is required.' };
          await client.deleteEvent(eventId);
          return { success: true, output: `Event ${eventId} deleted.` };
        }

        default:
          return { success: false, output: `Unknown action: ${action}` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ action, err: msg }, 'business.calendar error');
      return { success: false, output: `Calendar error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// business.analytics
// ---------------------------------------------------------------------------

const analyticsToolDef: ToolDefinition = {
  name: 'business.analytics',
  description:
    'View business KPI dashboards: total revenue, pending/overdue invoices, contact counts, revenue trends by month, and per-client reports.',
  category: 'business',
  timeout: 15_000,
  parameters: {
    action: {
      type: 'string',
      required: true,
      description: 'Report to generate.',
      enum: ['dashboard', 'revenue-trend', 'client-report'],
    },
    period: {
      type: 'string',
      description: 'Lookback period for dashboard (default: 7d).',
      enum: ['7d', '30d', '90d', '1y'],
      default: '7d',
    },
    months: { type: 'number', description: 'Number of months for revenue trend (1–24, default: 6).', default: 6 },
    contactId: { type: 'string', description: 'Contact ID for client-report action.' },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = params['action'] as string;
    logger.info({ session: ctx.sessionId, action }, 'business.analytics invoked');

    try {
      const { BusinessAnalytics } = await import('../../../business/analytics.js');
      const analytics = new BusinessAnalytics();

      switch (action) {
        case 'dashboard': {
          const period = ((params['period'] as string | undefined) ?? '7d') as '7d' | '30d' | '90d' | '1y';
          const metrics = analytics.getDashboard(period);
          return {
            success: true,
            output: [
              `Revenue: $${metrics.totalRevenue.toFixed(2)}`,
              `Pending invoices: ${metrics.pendingInvoices}`,
              `Overdue invoices: ${metrics.overdueInvoices}`,
              `Contacts: ${metrics.totalContacts}`,
              `Recent interactions (7d): ${metrics.recentInteractions}`,
            ].join(' | '),
            data: metrics,
          };
        }

        case 'revenue-trend': {
          const months = Math.min(24, Math.max(1, (params['months'] as number | undefined) ?? 6));
          const trend = analytics.getRevenueTrend(months);
          const lines = trend.map((p) => `${p.month}: $${p.revenue.toFixed(2)} (${p.invoiceCount} invoices)`);
          return { success: true, output: lines.join('\n'), data: trend };
        }

        case 'client-report': {
          const contactId = params['contactId'] as string | undefined;
          if (!contactId?.trim()) return { success: false, output: 'contactId is required for client-report.' };
          const report = analytics.getClientReport(contactId);
          return {
            success: true,
            output: `Client: ${report.contact.name} | Spent: $${report.totalSpent.toFixed(2)} | Invoices: ${report.invoiceCount} | Last contact: ${report.lastInteraction ?? 'never'}`,
            data: report,
          };
        }

        default:
          return { success: false, output: `Unknown action: ${action}` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ action, err: msg }, 'business.analytics error');
      return { success: false, output: `Analytics error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// business.reports
// ---------------------------------------------------------------------------

const reportsTool: ToolDefinition = {
  name: 'business.reports',
  description:
    'Generate comprehensive markdown business reports: weekly summary, monthly summary, or a custom template with business data injected via {{variable}} placeholders.',
  category: 'business',
  timeout: 30_000,
  parameters: {
    action: {
      type: 'string',
      required: true,
      description: 'Report type to generate.',
      enum: ['weekly', 'monthly', 'custom'],
    },
    template: { type: 'string', description: 'Markdown template with {{variable}} placeholders (required for custom).' },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = params['action'] as string;
    logger.info({ session: ctx.sessionId, action }, 'business.reports invoked');

    try {
      const { ReportGenerator } = await import('../../../business/reports.js');
      const gen = new ReportGenerator();

      switch (action) {
        case 'weekly': {
          const report = await gen.weekly();
          return { success: true, output: report, data: { type: 'weekly', chars: report.length } };
        }

        case 'monthly': {
          const report = await gen.monthly();
          return { success: true, output: report, data: { type: 'monthly', chars: report.length } };
        }

        case 'custom': {
          const template = params['template'] as string | undefined;
          if (!template?.trim()) return { success: false, output: 'template is required for custom reports.' };
          // Provide minimal ReportData so custom renders correctly.
          const { BusinessAnalytics } = await import('../../../business/analytics.js');
          const analytics = new BusinessAnalytics();
          const metrics = analytics.getDashboard('30d');
          const report = gen.custom(template, { metrics });
          return { success: true, output: report, data: { type: 'custom', chars: report.length } };
        }

        default:
          return { success: false, output: `Unknown action: ${action}` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ action, err: msg }, 'business.reports error');
      return { success: false, output: `Reports error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const BUSINESS_TOOLS: ToolDefinition[] = [
  crmTool,
  invoicingTool,
  businessEmailTool,
  calendarTool,
  analyticsToolDef,
  reportsTool,
];

/**
 * Register all business tools with the given registry.
 * Called automatically by the built-in tool loader.
 *
 * @param registry - The application's central {@link ToolRegistry}.
 */
export function registerBusinessTools(registry: ToolRegistry): void {
  // Persona/business tools are quarantined by default (SUDO_ENABLE_PERSONA_TOOLS=1).
  if (process.env['SUDO_ENABLE_PERSONA_TOOLS'] !== '1') {
    logger.info('Business tools quarantined — set SUDO_ENABLE_PERSONA_TOOLS=1 to enable');
    return;
  }
  logger.info({ count: BUSINESS_TOOLS.length }, 'Registering business tools');
  for (const tool of BUSINESS_TOOLS) {
    registry.register(tool);
  }
  logger.info({ count: BUSINESS_TOOLS.length }, 'Business tools registered');
}

// Upgrade 61: Commerce / Shopping (Bazaar)
export { searchProducts, compareProducts } from './shopping.js';
export type { Product, ShoppingResult } from './shopping.js';
