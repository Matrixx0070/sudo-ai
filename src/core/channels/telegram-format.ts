/**
 * @file channels/telegram-format.ts
 * @description Markdown → Telegram HTML rendering for outbound messages.
 *
 * The model writes standard markdown (**bold**, `code`, ## headings, links).
 * The old send path escaped EVERY MarkdownV2 special char — including the
 * formatting markers themselves — so users saw literal `**34°C**` asterisks
 * in every reply. This module renders the common markdown subset to
 * Telegram's HTML parse mode instead, which has no escaping interaction
 * with prose punctuation.
 *
 * Total + conservative by design: HTML-escape first, then convert only
 * well-formed, balanced markdown spans. Unclosed markers stay literal text.
 * Callers must still fall back to plain text if Telegram rejects the HTML
 * (only generated tags can 400, so fallback should be rare).
 */

/** Escape the three characters Telegram's HTML parse mode reserves. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Convert one non-code segment (already HTML-escaped) of markdown. */
function convertProse(escaped: string): string {
  let t = escaped;
  // Inline code first so its contents are exempt from further conversion:
  // stash spans behind NUL-framed sentinels (NUL never survives user text
  // through Telegram anyway) and restore them at the end.
  const codeSpans: string[] = [];
  t = t.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    codeSpans.push(`<code>${code}</code>`);
    return `\u0000${codeSpans.length - 1}\u0000`;
  });
  // Bold / italic / strikethrough (balanced spans only; single-line).
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  t = t.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
  t = t.replace(/(^|[^\w`])_([^_\n]+)_(?=[^\w`]|$)/gm, '$1<i>$2</i>');
  // Headings → bold lines (strip any nested <b> so tags never double-nest).
  t = t.replace(/^#{1,6}\s+(.+)$/gm, (_m, h: string) => `<b>${h.replace(/<\/?b>/g, '')}</b>`);
  // Links [text](http…) — quote-escape the href defensively.
  t = t.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
    (_m, label: string, url: string) => `<a href="${url.replace(/"/g, '&quot;')}">${label}</a>`,
  );
  // Restore stashed code spans.
  t = t.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codeSpans[Number(i)] ?? '');
  return t;
}

/** Default visible-head budget for collapsed rendering (chars of source md). */
export const DEFAULT_READMORE_HEAD = 480;

/**
 * Render markdown as Telegram HTML with the tail collapsed into an
 * expandable blockquote ("Read More" in clients, Bot API 7.3+). The head
 * stays fully visible; the split prefers a paragraph boundary, then a line
 * break, then a word break near `headChars`. Texts not meaningfully longer
 * than the head render uncollapsed. Fenced code blocks are never split —
 * a fence straddling the boundary pushes the split before it.
 */
export function mdToTelegramHtmlCollapsed(text: string, headChars: number = DEFAULT_READMORE_HEAD): string {
  const body = typeof text === 'string' ? text : String(text ?? '');
  const min = Math.max(1, headChars);
  // Not worth a collapse unless the hidden part is substantial.
  if (body.length <= min * 1.5) return mdToTelegramHtml(body);

  const window = body.slice(0, Math.floor(min * 1.3));
  let cut = window.lastIndexOf('\n\n');
  if (cut < min * 0.4) cut = window.lastIndexOf('\n');
  if (cut < min * 0.4) cut = window.lastIndexOf(' ');
  if (cut < min * 0.4) cut = min;
  // Never split inside a ``` fence: unbalanced fence count in the head means
  // the boundary landed inside a code block — retreat to before its opener.
  const headCandidate = body.slice(0, cut);
  if ((headCandidate.match(/```/g) ?? []).length % 2 === 1) {
    cut = headCandidate.lastIndexOf('```');
  }
  const head = body.slice(0, cut).trimEnd();
  const rest = body.slice(cut).replace(/^\s+/, '');
  if (!head || !rest) return mdToTelegramHtml(body);
  return `${mdToTelegramHtml(head)}\n<blockquote expandable>${mdToTelegramHtml(rest)}</blockquote>`;
}

/**
 * Render markdown text as Telegram HTML (parse_mode: 'HTML').
 * Fenced code blocks become <pre>; everything else goes through the
 * conservative prose converter. Never throws.
 */
export function mdToTelegramHtml(text: string): string {
  const body = typeof text === 'string' ? text : String(text ?? '');
  try {
    return body
      .split(/(```[\s\S]*?```)/)
      .map((part) => {
        const fence = part.match(/^```([A-Za-z0-9_+-]*)\n?([\s\S]*?)```$/);
        if (fence) return `<pre>${escapeHtml(fence[2] ?? '')}</pre>`;
        return convertProse(escapeHtml(part));
      })
      .join('');
  } catch {
    return escapeHtml(body);
  }
}
