/**
 * @file channels/gcalendar-connector.ts
 * @description Google Calendar connector via vault-stored OAuth token.
 *
 * Token storage: vault namespace 'gcalendar', mcp_server_url 'https://oauth2.googleapis.com/token'.
 *
 * Pre-requisites (operator must complete):
 *   1. Create Google Cloud project + OAuth 2.0 client credentials.
 *   2. Complete one-time browser consent to obtain refresh_token.
 *   3. Store in vault:
 *      POST /v1/vaults/gcalendar/credentials
 *      { type: 'mcp_oauth', mcp_server_url: 'https://oauth2.googleapis.com/token',
 *        access_token: '<initial>', refresh_token: '<refresh>', client_id: '<id>',
 *        client_secret: '<secret>', token_url: 'https://oauth2.googleapis.com/token' }
 *
 *   NO browser consent flow is initiated by this connector.
 *   If vault token is absent → returns {success:false, output:'...'}.
 *
 * @module channels/gcalendar-connector
 */

import { google } from 'googleapis';
import { createLogger } from '../shared/logger.js';
import { CredentialStore } from '../security/vault-credentials.js';

const log = createLogger('channels:gcalendar');

const GCAL_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GCAL_VAULT_NS = 'gcalendar';
const MISSING_CRED_MSG =
  'Google credentials not configured in vault. Store OAuth tokens via POST /v1/vaults/gcalendar/credentials';
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_EVENTS = 20;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CalendarEvent {
  id: string;
  summary: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
  description?: string;
  location?: string;
  htmlLink?: string;
}

export interface CalendarListResult {
  success: boolean;
  events?: CalendarEvent[];
  count?: number;
  output: string;
}

export interface CalendarCreateResult {
  success: boolean;
  eventId?: string;
  htmlLink?: string;
  output: string;
  dryRun?: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function buildOAuth2Client(signal?: AbortSignal) {
  const store = new CredentialStore(GCAL_VAULT_NS);
  const cred = await store.getCredential(GCAL_TOKEN_URL);
  if (!cred) return null;

  void signal; // signal is used at call sites; checked for abort before API calls

  if (!cred.client_id || !cred.client_secret || !cred.refresh_token) {
    log.warn({ credId: cred.id }, 'gcalendar credential missing client_id/client_secret/refresh_token');
    return null;
  }

  const auth = new google.auth.OAuth2(cred.client_id, cred.client_secret);
  auth.setCredentials({ refresh_token: cred.refresh_token });
  return auth;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * List calendar events for the next 7 days.
 *
 * @param calendarId - Calendar ID (defaults to 'primary').
 * @param signal     - Optional AbortSignal.
 * @returns Event list or not-configured error.
 */
export async function listCalendarEvents(
  calendarId = 'primary',
  signal?: AbortSignal,
): Promise<CalendarListResult> {
  const auth = await buildOAuth2Client(signal);
  if (!auth) {
    log.warn('gcalendar vault credential missing — listCalendarEvents unavailable');
    return { success: false, output: MISSING_CRED_MSG };
  }

  try {
    const calendar = google.calendar({ version: 'v3', auth });
    const now = new Date();
    const timeMin = now.toISOString();
    const timeMax = new Date(now.getTime() + SEVEN_DAYS_MS).toISOString();

    const resp = await calendar.events.list(
      {
        calendarId,
        timeMin,
        timeMax,
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: MAX_EVENTS,
      },
      { signal },
    );

    const rawEvents = resp.data.items ?? [];
    const events: CalendarEvent[] = rawEvents.map(e => ({
      id: e.id ?? '',
      summary: e.summary ?? '',
      start: {
        dateTime: e.start?.dateTime ?? undefined,
        date: e.start?.date ?? undefined,
      },
      end: {
        dateTime: e.end?.dateTime ?? undefined,
        date: e.end?.date ?? undefined,
      },
      description: e.description ?? undefined,
      location: e.location ?? undefined,
      htmlLink: e.htmlLink ?? undefined,
    }));

    const count = events.length;
    log.info({ calendarId, count }, 'gcalendar: events listed');
    return { success: true, events, count, output: `Listed ${count} events` };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg, calendarId }, 'gcalendar: listCalendarEvents failed');
    return { success: false, output: 'Calendar operation failed. Contact your administrator if this persists.' };
  }
}

/**
 * Create a calendar event.
 *
 * @param event   - Event details (summary, start, end required).
 * @param dryRun  - If true, validates the event but does not create it.
 * @param signal  - Optional AbortSignal.
 * @returns Create result with event ID or error.
 */
export async function createCalendarEvent(
  event: Partial<CalendarEvent>,
  dryRun = false,
  signal?: AbortSignal,
): Promise<CalendarCreateResult> {
  if (!event.summary) {
    return { success: false, output: 'gcalendar: event.summary is required' };
  }
  if (!event.start || !event.end) {
    return { success: false, output: 'gcalendar: event.start and event.end are required' };
  }

  if (dryRun) {
    log.info({ summary: event.summary, dryRun }, 'gcalendar: createEvent dry-run');
    return {
      success: true,
      dryRun: true,
      output: `Dry-run: event "${event.summary}" would be created`,
    };
  }

  const auth = await buildOAuth2Client(signal);
  if (!auth) {
    log.warn('gcalendar vault credential missing — createCalendarEvent unavailable');
    return { success: false, output: MISSING_CRED_MSG };
  }

  try {
    const calendar = google.calendar({ version: 'v3', auth });

    const resp = await calendar.events.insert(
      {
        calendarId: 'primary',
        requestBody: {
          summary: event.summary,
          description: event.description,
          location: event.location,
          start: event.start,
          end: event.end,
        },
      },
      { signal },
    );

    const eventId = resp.data.id ?? undefined;
    const htmlLink = resp.data.htmlLink ?? undefined;
    log.info({ summary: event.summary, eventId }, 'gcalendar: event created');
    return {
      success: true,
      eventId,
      htmlLink,
      output: `Event created: ${event.summary}`,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg, summary: event.summary }, 'gcalendar: createCalendarEvent failed');
    return { success: false, output: 'Calendar operation failed. Contact your administrator if this persists.' };
  }
}
