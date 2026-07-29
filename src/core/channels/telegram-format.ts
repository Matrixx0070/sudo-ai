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
