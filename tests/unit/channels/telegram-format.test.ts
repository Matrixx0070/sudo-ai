/**
 * mdToTelegramHtml — markdown → Telegram-HTML rendering for outbound replies.
 * Replaces the escape-everything MarkdownV2 path that showed literal **bold**
 * markers to users. Conservative: unbalanced markers stay literal; HTML is
 * always escaped first; never throws.
 */
import { describe, it, expect } from 'vitest';
import { mdToTelegramHtml, escapeHtml } from '../../../src/core/channels/telegram-format.js';

describe('escapeHtml', () => {
  it('escapes the three reserved chars', () => {
    expect(escapeHtml('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
  });
});

describe('mdToTelegramHtml', () => {
  it('renders bold, strikethrough and italics', () => {
    expect(mdToTelegramHtml('around **34°C (93°F)** today')).toBe('around <b>34°C (93°F)</b> today');
    expect(mdToTelegramHtml('~~old~~ and _emphasis_')).toBe('<s>old</s> and <i>emphasis</i>');
  });

  it('renders headings as bold lines, stripping nested bold', () => {
    expect(mdToTelegramHtml('## 1. Introduction')).toBe('<b>1. Introduction</b>');
    expect(mdToTelegramHtml('# **Loud** title')).toBe('<b>Loud title</b>');
  });

  it('renders inline code and protects it from further conversion', () => {
    expect(mdToTelegramHtml('run `pm2 restart **now**`')).toBe('run <code>pm2 restart **now**</code>');
  });

  it('renders fenced code blocks as <pre> with escaped contents', () => {
    expect(mdToTelegramHtml('```ts\nconst a = 1 < 2;\n```')).toBe('<pre>const a = 1 &lt; 2;\n</pre>');
  });

  it('renders links with quoted hrefs', () => {
    expect(mdToTelegramHtml('see [docs](https://example.com/a?b=1)')).toBe('see <a href="https://example.com/a?b=1">docs</a>');
  });

  it('leaves unbalanced markers literal (mid-stream partials are safe)', () => {
    expect(mdToTelegramHtml('starting **bold that never clo')).toBe('starting **bold that never clo');
    expect(mdToTelegramHtml('tick ` open')).toBe('tick ` open');
  });

  it('does not italicize snake_case identifiers', () => {
    expect(mdToTelegramHtml('use tool_call_id here')).toBe('use tool_call_id here');
  });

  it('escapes raw HTML in prose', () => {
    expect(mdToTelegramHtml('a <b>tag</b> & so on')).toBe('a &lt;b&gt;tag&lt;/b&gt; &amp; so on');
  });

  it('is total on junk input', () => {
    expect(mdToTelegramHtml(undefined as unknown as string)).toBe('');
    expect(mdToTelegramHtml(123 as unknown as string)).toBe('123');
  });
});

describe('mdToTelegramHtmlCollapsed (Read More)', () => {
  const P = (n: number, seed = 'lorem ipsum dolor sit amet '): string =>
    Array.from({ length: n }, (_, i) => `Paragraph ${i}. ${seed.repeat(8)}`).join('\n\n');

  it('renders short texts uncollapsed', async () => {
    const { mdToTelegramHtmlCollapsed } = await import('../../../src/core/channels/telegram-format.js');
    const out = mdToTelegramHtmlCollapsed('short **bold** text', 480);
    expect(out).toBe('short <b>bold</b> text');
    expect(out).not.toContain('blockquote');
  });

  it('folds the tail into an expandable blockquote at a paragraph boundary', async () => {
    const { mdToTelegramHtmlCollapsed } = await import('../../../src/core/channels/telegram-format.js');
    const out = mdToTelegramHtmlCollapsed(P(8), 480);
    expect(out).toContain('<blockquote expandable>');
    expect(out.endsWith('</blockquote>')).toBe(true);
    const visible = out.slice(0, out.indexOf('<blockquote'));
    expect(visible).toContain('Paragraph 0.');
    expect(visible).not.toContain('Paragraph 7.');
    // Head ends cleanly at a paragraph boundary — no mid-word cut.
    expect(visible.trimEnd().endsWith('amet')).toBe(true);
  });

  it('never splits inside a fenced code block', async () => {
    const { mdToTelegramHtmlCollapsed } = await import('../../../src/core/channels/telegram-format.js');
    const text = `intro line\n\n\`\`\`\n${'code line\n'.repeat(60)}\`\`\`\n\ntail paragraph`;
    const out = mdToTelegramHtmlCollapsed(text, 200);
    // The whole <pre> block must live on one side of the fold.
    const visible = out.slice(0, out.indexOf('<blockquote'));
    expect((visible.match(/<pre>/g) ?? []).length).toBe((visible.match(/<\/pre>/g) ?? []).length);
  });

  it('renders markdown on both sides of the fold', async () => {
    const { mdToTelegramHtmlCollapsed } = await import('../../../src/core/channels/telegram-format.js');
    const text = `**head bold**\n\n${'filler '.repeat(100)}\n\n## Tail heading\n\nmore ${'x'.repeat(200)}`;
    const out = mdToTelegramHtmlCollapsed(text, 300);
    expect(out).toContain('<b>head bold</b>');
    expect(out).toContain('<b>Tail heading</b>');
  });

  it('is total on junk input', async () => {
    const { mdToTelegramHtmlCollapsed } = await import('../../../src/core/channels/telegram-format.js');
    expect(mdToTelegramHtmlCollapsed(undefined as unknown as string)).toBe('');
  });
});
