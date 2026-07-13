/**
 * EmailAdapter draft-default outbound + recipient allowlist + send cap (Spec 5 PR2).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EmailAdapter, setThreadContext, __resetThreadContextForTests } from '../../src/core/channels/email.js';

type MockSend = ReturnType<typeof vi.fn>;
function wire(adapter: EmailAdapter): { sendMail: MockSend; append: MockSend } {
  const sendMail = vi.fn(async () => ({ message: Buffer.from('raw') }));
  const append = vi.fn(async () => {});
  const a = adapter as unknown as { _transport: unknown; _imap: unknown };
  a._transport = { sendMail };
  a._imap = { append };
  return { sendMail, append };
}

beforeEach(() => { __resetThreadContextForTests(); process.env['EMAIL_SMTP_FROM'] = 'bot@me.com'; });
afterEach(() => {
  delete process.env['EMAIL_SMTP_FROM']; delete process.env['EMAIL_ALLOW_SEND'];
  delete process.env['EMAIL_ALLOWED_RECIPIENTS']; delete process.env['EMAIL_MAX_SENDS_PER_HOUR'];
});

describe('EmailAdapter.send — draft-default', () => {
  it('draft-only when EMAIL_ALLOW_SEND != 1: appends to Drafts, does NOT send', async () => {
    const adapter = new EmailAdapter();
    const { sendMail, append } = wire(adapter);
    await adapter.send('alice@ext.com', 'hello');
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0]![0]).toBe('Drafts');
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('real send BLOCKED for a non-allowlisted recipient', async () => {
    process.env['EMAIL_ALLOW_SEND'] = '1';
    process.env['EMAIL_ALLOWED_RECIPIENTS'] = 'ok@ext.com';
    const adapter = new EmailAdapter();
    const { sendMail } = wire(adapter);
    await expect(adapter.send('evil@ext.com', 'hi')).rejects.toThrow(/allowlist|refused/i);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('real send ALLOWED for an allowlisted recipient', async () => {
    process.env['EMAIL_ALLOW_SEND'] = '1';
    process.env['EMAIL_ALLOWED_RECIPIENTS'] = 'ok@ext.com';
    const adapter = new EmailAdapter();
    const { sendMail } = wire(adapter);
    await adapter.send('ok@ext.com', 'hi');
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0]![0]).toMatchObject({ to: 'ok@ext.com' });
  });

  it('enforces the per-hour send cap', async () => {
    process.env['EMAIL_ALLOW_SEND'] = '1';
    process.env['EMAIL_ALLOWED_RECIPIENTS'] = 'ok@ext.com';
    process.env['EMAIL_MAX_SENDS_PER_HOUR'] = '2';
    const adapter = new EmailAdapter();
    wire(adapter);
    await adapter.send('ok@ext.com', '1');
    await adapter.send('ok@ext.com', '2');
    await expect(adapter.send('ok@ext.com', '3')).rejects.toThrow(/cap/i);
  });

  it('resolves a threadId peerId to the thread reply address + Re: subject', async () => {
    process.env['EMAIL_ALLOW_SEND'] = '1';
    process.env['EMAIL_ALLOWED_RECIPIENTS'] = 'sender@ext.com';
    const adapter = new EmailAdapter();
    const { sendMail } = wire(adapter);
    setThreadContext('thread-1', { replyTo: 'sender@ext.com', subject: 'Question', messageId: '<m1@x>', references: '<m1@x>', autoReply: true });
    await adapter.send('thread-1', 'my reply');
    const arg = sendMail.mock.calls[0]![0] as { to: string; subject: string; headers: Record<string, string> };
    expect(arg.to).toBe('sender@ext.com');
    expect(arg.subject).toBe('Re: Question');
    expect(arg.headers['In-Reply-To']).toBe('<m1@x>');
  });

  it('forces DRAFT for a thread reply whose rule did NOT opt in (autoReply=false), even with allow-send', async () => {
    process.env['EMAIL_ALLOW_SEND'] = '1';
    process.env['EMAIL_ALLOWED_RECIPIENTS'] = 'sender@ext.com';
    const adapter = new EmailAdapter();
    const { sendMail, append } = wire(adapter);
    setThreadContext('thread-2', { replyTo: 'sender@ext.com', subject: 'Q', messageId: '<m2@x>', references: '<m2@x>', autoReply: false });
    await adapter.send('thread-2', 'reply');
    expect(append).toHaveBeenCalledTimes(1); // drafted, not sent
    expect(sendMail).not.toHaveBeenCalled();
  });
});
