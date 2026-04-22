/**
 * @file tests/channels/wave11-googleapis.test.ts
 * @description Wave 11 — googleapis wiring tests for gmail-connector and gcalendar-connector.
 *
 * Uses vi.mock to stub 'googleapis' and '../security/vault-credentials.js'
 * so no live network or vault I/O occurs.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// ---------------------------------------------------------------------------
// Mock: googleapis
// ---------------------------------------------------------------------------

const mockMessagesList = vi.fn();
const mockMessagesGet = vi.fn();
const mockMessagesSend = vi.fn();
const mockEventsList = vi.fn();
const mockEventsInsert = vi.fn();
const mockSetCredentials = vi.fn();
const mockOAuth2Constructor = vi.fn(function (this: unknown) {
  (this as { setCredentials: typeof mockSetCredentials }).setCredentials = mockSetCredentials;
});

vi.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: mockOAuth2Constructor,
    },
    gmail: vi.fn(() => ({
      users: {
        messages: {
          list: mockMessagesList,
          get: mockMessagesGet,
          send: mockMessagesSend,
        },
      },
    })),
    calendar: vi.fn(() => ({
      events: {
        list: mockEventsList,
        insert: mockEventsInsert,
      },
    })),
  },
}));

// ---------------------------------------------------------------------------
// Mock: CredentialStore
// ---------------------------------------------------------------------------

const mockGetCredential = vi.fn();

vi.mock('../../src/core/security/vault-credentials.js', () => {
  function MockCredentialStore(_ns: string) {
    // eslint-disable-next-line @typescript-eslint/no-invalid-this
    (this as unknown as { getCredential: typeof mockGetCredential }).getCredential = mockGetCredential;
  }
  return { CredentialStore: MockCredentialStore };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_GMAIL_CRED = {
  id: 'cred_test_gmail',
  namespace: 'gmail',
  type: 'mcp_oauth' as const,
  mcp_server_url: 'https://oauth2.googleapis.com/token',
  created_at: '2026-01-01T00:00:00.000Z',
  archived: false,
  client_id: 'test-client-id',
  client_secret: 'test-client-secret',
  refresh_token: 'test-refresh-token',
};

const VALID_GCAL_CRED = {
  ...VALID_GMAIL_CRED,
  id: 'cred_test_gcal',
  namespace: 'gcalendar',
};

// ---------------------------------------------------------------------------
// Gmail tests
// ---------------------------------------------------------------------------

describe('gmail-connector — Wave 11 googleapis wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('1. listGmailMessages — no vault credential returns {success:false}', async () => {
    mockGetCredential.mockResolvedValue(null);
    const { listGmailMessages } = await import('../../src/core/channels/gmail-connector.js');
    const result = await listGmailMessages(5);

    expect(result.success).toBe(false);
    expect(result.output).toContain('not configured in vault');
    expect(mockMessagesList).not.toHaveBeenCalled();
  });

  it('2. listGmailMessages — with credential calls gmail.users.messages.list', async () => {
    mockGetCredential.mockResolvedValue(VALID_GMAIL_CRED);
    mockMessagesList.mockResolvedValue({
      data: {
        messages: [
          { id: 'msg1', threadId: 'thread1' },
          { id: 'msg2', threadId: 'thread2' },
        ],
      },
    });
    mockMessagesGet.mockResolvedValue({
      data: {
        threadId: 'thread1',
        snippet: 'Hello world',
        payload: {
          headers: [
            { name: 'From', value: 'sender@example.com' },
            { name: 'Subject', value: 'Test email' },
            { name: 'Date', value: 'Wed, 16 Apr 2026 10:00:00 +0000' },
          ],
        },
      },
    });

    const { listGmailMessages } = await import('../../src/core/channels/gmail-connector.js');
    const result = await listGmailMessages(5);

    expect(result.success).toBe(true);
    expect(mockMessagesList).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'me', maxResults: 5 }),
      expect.anything(),
    );
    expect(result.messages).toBeDefined();
    expect(result.count).toBeGreaterThanOrEqual(0);
  });

  it('3. sendGmailMessage — with credential calls gmail.users.messages.send', async () => {
    mockGetCredential.mockResolvedValue(VALID_GMAIL_CRED);
    mockMessagesSend.mockResolvedValue({ data: { id: 'sent_msg_123' } });

    const { sendGmailMessage } = await import('../../src/core/channels/gmail-connector.js');
    const result = await sendGmailMessage('to@example.com', 'Hello', 'Body text');

    expect(result.success).toBe(true);
    expect(result.messageId).toBe('sent_msg_123');
    expect(mockMessagesSend).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'me',
        requestBody: expect.objectContaining({ raw: expect.any(String) }),
      }),
      expect.anything(),
    );
  });

  it('4. sendGmailMessage — missing "to" field returns {success:false} with "required" message', async () => {
    const { sendGmailMessage } = await import('../../src/core/channels/gmail-connector.js');
    const result = await sendGmailMessage('', 'Subject', 'Body');

    expect(result.success).toBe(false);
    expect(result.output).toContain('required');
    expect(mockMessagesSend).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Calendar tests
// ---------------------------------------------------------------------------

describe('gcalendar-connector — Wave 11 googleapis wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('5. listCalendarEvents — no vault credential returns {success:false}', async () => {
    mockGetCredential.mockResolvedValue(null);
    const { listCalendarEvents } = await import('../../src/core/channels/gcalendar-connector.js');
    const result = await listCalendarEvents('primary');

    expect(result.success).toBe(false);
    expect(result.output).toContain('not configured in vault');
    expect(mockEventsList).not.toHaveBeenCalled();
  });

  it('6. listCalendarEvents — with credential calls calendar.events.list', async () => {
    mockGetCredential.mockResolvedValue(VALID_GCAL_CRED);
    mockEventsList.mockResolvedValue({
      data: {
        items: [
          {
            id: 'evt1',
            summary: 'Team standup',
            start: { dateTime: '2026-04-17T09:00:00Z' },
            end: { dateTime: '2026-04-17T09:30:00Z' },
          },
        ],
      },
    });

    const { listCalendarEvents } = await import('../../src/core/channels/gcalendar-connector.js');
    const result = await listCalendarEvents('primary');

    expect(result.success).toBe(true);
    expect(mockEventsList).toHaveBeenCalledWith(
      expect.objectContaining({
        calendarId: 'primary',
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 20,
      }),
      expect.anything(),
    );
    expect(result.events).toHaveLength(1);
    expect(result.events![0]!.summary).toBe('Team standup');
  });

  it('7. createCalendarEvent — dryRun=true returns {success:true, dryRun:true}', async () => {
    const { createCalendarEvent } = await import('../../src/core/channels/gcalendar-connector.js');
    const result = await createCalendarEvent(
      {
        summary: 'Sprint review',
        start: { dateTime: '2026-04-20T14:00:00Z' },
        end: { dateTime: '2026-04-20T15:00:00Z' },
      },
      true,
    );

    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(mockEventsInsert).not.toHaveBeenCalled();
  });

  it('8. createCalendarEvent — with credential calls calendar.events.insert', async () => {
    mockGetCredential.mockResolvedValue(VALID_GCAL_CRED);
    mockEventsInsert.mockResolvedValue({
      data: {
        id: 'new_event_456',
        htmlLink: 'https://calendar.google.com/event?eid=new_event_456',
      },
    });

    const { createCalendarEvent } = await import('../../src/core/channels/gcalendar-connector.js');
    const result = await createCalendarEvent(
      {
        summary: 'Product launch',
        start: { dateTime: '2026-04-25T10:00:00Z' },
        end: { dateTime: '2026-04-25T11:00:00Z' },
      },
      false,
    );

    expect(result.success).toBe(true);
    expect(result.eventId).toBe('new_event_456');
    expect(result.htmlLink).toContain('new_event_456');
    expect(mockEventsInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        calendarId: 'primary',
        requestBody: expect.objectContaining({ summary: 'Product launch' }),
      }),
      expect.anything(),
    );
  });
});
