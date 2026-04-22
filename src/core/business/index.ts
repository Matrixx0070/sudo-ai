/**
 * Business Engine barrel export.
 *
 * All public classes, interfaces, and types for the SUDO-AI Business module
 * are re-exported from this single entry point.
 */

export type {
  Contact,
  Interaction,
  Invoice,
  InvoiceItem,
  CalendarEvent,
  BusinessMetrics,
  RevenueTrendPoint,
  ClientReport,
} from './types.js';

export { CRM } from './crm.js';
export { InvoiceManager } from './invoicing.js';
export { EmailClient } from './email.js';
export type { SendOptions, EmailMessage } from './email.js';
export { CalendarClient } from './calendar.js';
export { BusinessAnalytics } from './analytics.js';
export { ReportGenerator } from './reports.js';
export type { ReportData } from './reports.js';

export type { Sponsor, SponsorStatus } from './sponsor-manager.js';
export { SponsorManager } from './sponsor-manager.js';
