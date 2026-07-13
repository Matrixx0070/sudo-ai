/**
 * Inbound email rule engine + thread/attachment helpers (Spec 5 PR1).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEmailRules, matchEmailRule, __resetEmailRulesForTests } from '../../src/core/channels/email-rules.js';
import { deriveThreadId, setThreadContext, getThreadContext, saveAttachments, __resetThreadContextForTests } from '../../src/core/channels/email.js';
import type { ParsedMail } from 'mailparser';

function cfg(body: string): string {
  const p = join(mkdtempSync(join(tmpdir(), 'er-')), 'email-rules.json5');
  writeFileSync(p, body, 'utf-8');
  return p;
}
const M = (o: Partial<{ from: string; to: string[]; subject: string; labels: string[] }>) =>
  ({ from: o.from ?? '', to: o.to ?? [], subject: o.subject ?? '', labels: o.labels ?? [] });

beforeEach(() => { __resetEmailRulesForTests(); __resetThreadContextForTests(); });

describe('email rule matching', () => {
  it('missing config → defaultIgnore true, no rules', () => {
    const c = loadEmailRules('/nonexistent/email-rules.json5');
    expect(c.defaultIgnore).toBe(true);
    expect(c.rules).toEqual([]);
    expect(matchEmailRule(M({ from: 'x@y.com' }), c)).toBeNull();
  });

  it('substring + regex filters, AND-combined', () => {
    const c = loadEmailRules(cfg(`{ rules: [
      { name: 'boss', from: '@work.com', subject: '/urgent/i' },
      { name: 'ci', from: '/github/i' },
    ]}`), true);
    // both from + subject must match for 'boss'
    expect(matchEmailRule(M({ from: 'a@work.com', subject: 'URGENT: x' }), c)?.name).toBe('boss');
    expect(matchEmailRule(M({ from: 'a@work.com', subject: 'hello' }), c)).toBeNull(); // subject fails, no other match
    expect(matchEmailRule(M({ from: 'noreply@github.com', subject: 'z' }), c)?.name).toBe('ci');
  });

  it('to-filter matches any recipient', () => {
    const c = loadEmailRules(cfg(`{ rules: [ { name: 'support', to: 'support@me.com' } ] }`), true);
    expect(matchEmailRule(M({ to: ['x@me.com', 'support@me.com'] }), c)?.name).toBe('support');
    expect(matchEmailRule(M({ to: ['x@me.com'] }), c)).toBeNull();
  });

  it('a rule with NO filters is NOT a catch-all', () => {
    const c = loadEmailRules(cfg(`{ rules: [ { name: 'empty', prompt: 'hi' } ] }`), true);
    expect(matchEmailRule(M({ from: 'anyone@x.com' }), c)).toBeNull();
  });

  it('first matching rule wins', () => {
    const c = loadEmailRules(cfg(`{ rules: [ { name: 'a', from: '@x.com' }, { name: 'b', from: '@x.com' } ] }`), true);
    expect(matchEmailRule(M({ from: 'u@x.com' }), c)?.name).toBe('a');
  });
});

describe('thread + attachment helpers', () => {
  it('deriveThreadId prefers References → In-Reply-To → Message-ID → uid', () => {
    expect(deriveThreadId({ references: ['<root@x>', '<b@x>'], messageId: '<m@x>' } as unknown as ParsedMail, '1')).toBe('root@x');
    expect(deriveThreadId({ inReplyTo: '<irt@x>', messageId: '<m@x>' } as unknown as ParsedMail, '1')).toBe('irt@x');
    expect(deriveThreadId({ messageId: '<only@x>' } as unknown as ParsedMail, '1')).toBe('only@x');
    expect(deriveThreadId({} as ParsedMail, '42')).toBe('uid-42');
  });

  it('thread context round-trips', () => {
    setThreadContext('t1', { replyTo: 'a@b.com', subject: 'S', messageId: '<m>', references: '', autoReply: false });
    expect(getThreadContext('t1')?.replyTo).toBe('a@b.com');
    expect(getThreadContext('missing')).toBeUndefined();
  });

  it('saveAttachments rejects oversized, keeps small (size cap)', () => {
    const big = { filename: 'big.bin', content: Buffer.alloc(11 * 1024 * 1024), size: 11 * 1024 * 1024 };
    const small = { filename: 'ok.txt', content: Buffer.from('hi'), size: 2 };
    const saved = saveAttachments({ attachments: [big, small] } as unknown as ParsedMail, 'thread-x');
    expect(saved.length).toBe(1);
    expect(saved[0]).toMatch(/ok\.txt$/);
    expect(existsSync(saved[0]!)).toBe(true);
  });
});
