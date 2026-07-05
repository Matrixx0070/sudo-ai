/**
 * marketing tools — regression for the harness-bug-scan-surfaced crash: Brain.chat()
 * returns a STRING, but askBrain read `.content` (typed wrongly as { content }) and
 * every marketing tool crashed on `.trim()`. These tests use the REAL string contract,
 * so they would have caught it.
 */
import { describe, it, expect } from 'vitest';
import { askBrain, registerMarketingTools } from '../../src/core/tools/builtin/marketing/index.js';
import type { ToolContext } from '../../src/core/tools/types.js';

// A ctx whose brain.chat returns whatever `reply` yields (defaults to the real: a string).
const ctxWith = (reply: unknown): ToolContext =>
  ({ config: { brain: { chat: async () => reply } }, logger: { info() {}, error() {} } } as unknown as ToolContext);

describe('askBrain (Brain.chat returns a string — the real contract)', () => {
  it('returns the trimmed string reply (no crash on .content)', async () => {
    await expect(askBrain(ctxWith('  hello world  '), 'sys', 'user')).resolves.toBe('hello world');
  });
  it('tolerates a legacy { content } shape defensively', async () => {
    await expect(askBrain(ctxWith({ content: '  x  ' }), 'sys', 'user')).resolves.toBe('x');
  });
  it('empty / malformed replies yield "" instead of throwing', async () => {
    await expect(askBrain(ctxWith(''), 'sys', 'user')).resolves.toBe('');
    await expect(askBrain(ctxWith(undefined), 'sys', 'user')).resolves.toBe('');
    await expect(askBrain(ctxWith(42), 'sys', 'user')).resolves.toBe('');
  });
  it('throws a clear error when no brain is configured', async () => {
    await expect(askBrain({ config: {} } as unknown as ToolContext, 's', 'u')).rejects.toThrow(/Brain/);
  });
});

describe('marketing tool execute (integration — no more silent crash)', () => {
  it('marketing.seo-audit succeeds with a string-returning brain', async () => {
    const tools = new Map<string, { execute: (p: Record<string, unknown>, c: ToolContext) => Promise<{ success: boolean; output: string }> }>();
    registerMarketingTools({ register: (t: { name: string }) => tools.set(t.name, t as never) } as never);
    const seo = tools.get('marketing.seo-audit')!;
    const res = await seo.execute({ url: 'https://example.com' }, ctxWith('1. TECHNICAL SEO CHECKLIST\n- verify page speed'));
    expect(res.success).toBe(true);            // was false ("SEO audit error: …reading 'trim'")
    expect(res.output).toContain('TECHNICAL SEO CHECKLIST');
  });
});
