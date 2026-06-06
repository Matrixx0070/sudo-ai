/**
 * CalendarClient — Google Calendar integration via the googleapis package.
 *
 * Environment variables:
 *   GOOGLE_CALENDAR_CREDENTIALS — path to a service-account JSON file, OR
 *                                  the raw JSON string.
 *   GOOGLE_CALENDAR_ID          — calendar ID (default: 'primary').
 *
 * When credentials are absent the client operates in stub mode: reads
 * return empty arrays and writes are logged but not executed.
 */

import { createLogger } from '../shared/logger.js';
import { BusinessError } from '../shared/errors.js';
import type { CalendarEvent } from './types.js';
import { nanoid } from 'nanoid';
import { readFileSync } from 'fs';

const log = createLogger('business');

// ---------------------------------------------------------------------------
// Types for googleapis (dynamic import to avoid hard dep when unconfigured)
// ---------------------------------------------------------------------------

interface GCalEvent {
  id?: string | null;
  summary?: string | null;
  description?: string | null;
  location?: string | null;
  start?: { dateTime?: string | null; date?: string | null };
  end?: { dateTime?: string | null; date?: string | null };
  attendees?: Array<{ email?: string | null }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function gEventToLocal(ev: GCalEvent): CalendarEvent {
  return {
    id: ev.id ?? nanoid(),
    title: ev.summary ?? '(no title)',
    start: ev.start?.dateTime ?? ev.start?.date ?? '',
    end: ev.end?.dateTime ?? ev.end?.date ?? '',
    description: ev.description ?? undefined,
    location: ev.location ?? undefined,
    attendees: ev.attendees?.map((a) => a.email ?? '').filter(Boolean),
  };
}

function localToGEvent(ev: Omit<CalendarEvent, 'id'>): GCalEvent {
  return {
    summary: ev.title,
    description: ev.description,
    location: ev.location,
    start: { dateTime: ev.start },
    end: { dateTime: ev.end },
    attendees: ev.attendees?.map((email) => ({ email })),
  };
}

function loadCredentials(): Record<string, unknown> | null {
  const raw = process.env['GOOGLE_CALENDAR_CREDENTIALS'];
  if (!raw) return null;

  try {
    // Try as JSON string first
    if (raw.trimStart().startsWith('{')) {
      return JSON.parse(raw) as Record<string, unknown>;
    }
    // Otherwise treat as file path
    const content = readFileSync(raw, 'utf8');
    return JSON.parse(content) as Record<string, unknown>;
  } catch (err) {
    log.error({ err }, 'CalendarClient: failed to load credentials');
    return null;
  }
}

// ---------------------------------------------------------------------------
// CalendarClient
// ---------------------------------------------------------------------------

export class CalendarClient {
  private readonly calendarId: string;
  private readonly stub: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private calendarApi: any = null;

  constructor() {
    this.calendarId = process.env['GOOGLE_CALENDAR_ID'] ?? 'primary';
    const creds = loadCredentials();
    this.stub = creds === null;

    if (this.stub) {
      log.warn('CalendarClient: no credentials found — running in stub mode');
    } else {
      this._initApi(creds!).catch((err: unknown) => {
        log.error({ err }, 'CalendarClient: API init failed');
      });
    }
  }

  private async _initApi(creds: Record<string, unknown>): Promise<void> {
    try {
      // Dynamic import so the module loads even without googleapis installed
      const { google } = await import('googleapis');
      const auth = new google.auth.GoogleAuth({
        credentials: creds,
        scopes: ['https://www.googleapis.com/auth/calendar'],
      });
      this.calendarApi = google.calendar({ version: 'v3', auth });
      log.info({ calendarId: this.calendarId }, 'CalendarClient initialised');
    } catch (err) {
      log.error({ err }, 'CalendarClient: googleapis import failed');
    }
  }

  private _requireApi(): void {
    if (this.stub || !this.calendarApi) {
      throw new BusinessError(
        'Google Calendar is not configured. Set GOOGLE_CALENDAR_CREDENTIALS.',
        'not_configured',
      );
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async listEvents(startDate: string, endDate: string): Promise<CalendarEvent[]> {
    if (this.stub) {
      log.warn({ startDate, endDate }, 'CalendarClient stub: listEvents returning []');
      return [];
    }
    this._requireApi();

    try {
      const res = await this.calendarApi.events.list({
        calendarId: this.calendarId,
        timeMin: new Date(startDate).toISOString(),
        timeMax: new Date(endDate).toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 250,
      });
      const items: GCalEvent[] = (res.data.items as GCalEvent[]) ?? [];
      log.info({ count: items.length, startDate, endDate }, 'Calendar events listed');
      return items.map(gEventToLocal);
    } catch (err) {
      log.error({ err }, 'CalendarClient: listEvents failed');
      throw new BusinessError(
        `listEvents failed: ${err instanceof Error ? err.message : String(err)}`,
        'api_error',
      );
    }
  }

  async createEvent(event: Omit<CalendarEvent, 'id'>): Promise<CalendarEvent> {
    if (!event.title?.trim()) throw new BusinessError('Event title is required', 'invalid_input');
    if (!event.start) throw new BusinessError('Event start is required', 'invalid_input');
    if (!event.end) throw new BusinessError('Event end is required', 'invalid_input');

    if (this.stub) {
      const stubEvent: CalendarEvent = { id: `stub-${nanoid()}`, ...event };
      log.warn({ stubEvent }, 'CalendarClient stub: createEvent (not persisted)');
      return stubEvent;
    }
    this._requireApi();

    try {
      const res = await this.calendarApi.events.insert({
        calendarId: this.calendarId,
        requestBody: localToGEvent(event),
      });
      const created = gEventToLocal(res.data as GCalEvent);
      log.info({ eventId: created.id, title: created.title }, 'Calendar event created');
      return created;
    } catch (err) {
      log.error({ err }, 'CalendarClient: createEvent failed');
      throw new BusinessError(
        `createEvent failed: ${err instanceof Error ? err.message : String(err)}`,
        'api_error',
      );
    }
  }

  async updateEvent(id: string, patch: Partial<Omit<CalendarEvent, 'id'>>): Promise<CalendarEvent> {
    if (!id?.trim()) throw new BusinessError('Event id is required', 'invalid_input');

    if (this.stub) {
      log.warn({ id, patch }, 'CalendarClient stub: updateEvent (not persisted)');
      return { id, title: patch.title ?? '', start: patch.start ?? '', end: patch.end ?? '' };
    }
    this._requireApi();

    // Build the patch body conditionally so unspecified fields are left
    // untouched. localToGEvent unconditionally sets start/end, which would
    // serialize undefined timings to empty objects and clobber the event.
    const requestBody: GCalEvent = {};
    if (patch.title !== undefined) requestBody.summary = patch.title;
    if (patch.description !== undefined) requestBody.description = patch.description;
    if (patch.location !== undefined) requestBody.location = patch.location;
    if (patch.start !== undefined) requestBody.start = { dateTime: patch.start };
    if (patch.end !== undefined) requestBody.end = { dateTime: patch.end };
    if (patch.attendees !== undefined) {
      requestBody.attendees = patch.attendees.map((email) => ({ email }));
    }

    try {
      const res = await this.calendarApi.events.patch({
        calendarId: this.calendarId,
        eventId: id,
        requestBody,
      });
      const updated = gEventToLocal(res.data as GCalEvent);
      log.info({ eventId: id }, 'Calendar event updated');
      return updated;
    } catch (err) {
      log.error({ err }, 'CalendarClient: updateEvent failed');
      throw new BusinessError(
        `updateEvent failed: ${err instanceof Error ? err.message : String(err)}`,
        'api_error',
      );
    }
  }

  async deleteEvent(id: string): Promise<void> {
    if (!id?.trim()) throw new BusinessError('Event id is required', 'invalid_input');

    if (this.stub) {
      log.warn({ id }, 'CalendarClient stub: deleteEvent (not persisted)');
      return;
    }
    this._requireApi();

    try {
      await this.calendarApi.events.delete({ calendarId: this.calendarId, eventId: id });
      log.info({ eventId: id }, 'Calendar event deleted');
    } catch (err) {
      log.error({ err }, 'CalendarClient: deleteEvent failed');
      throw new BusinessError(
        `deleteEvent failed: ${err instanceof Error ? err.message : String(err)}`,
        'api_error',
      );
    }
  }
}
