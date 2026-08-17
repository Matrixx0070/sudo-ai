/**
 * @file channels/stream-markdown.ts
 * @description Make a PARTIAL, mid-stream markdown buffer render cleanly.
 *
 * While a reply streams, the buffer routinely ends mid-token — inside an open
 * `**bold`, a half-typed `` `code ``, an unclosed ```fence```, a `[link](htt` —
 * and a naive render (or a cursor glyph pasted onto the end) looks broken. This
 * pure helper balances the open constructs so EVERY frame is well-formed, and
 * places the streaming cursor at the true typing point (inside any open span, so
 * it inherits that span's styling). Dropped entirely on finalize by the caller.
 *
 * Scope: the inline/fence constructs Telegram's markdown renderer cares about —
 * fenced code (``` / ~~~), inline code (`), bold (**), underline (__),
 * strikethrough (~~), italic (* / _). Single * / _ use a conservative flanking
 * rule so ordinary prose like "2 * 3" or snake_case never trips a false span.
 */

/** Multi-char inline markers, checked before single-char ones. */
const PAIR = ['**', '__', '~~'] as const;

const WORD = /[A-Za-z0-9]/;

function canOpen(ch: string, prev: string | undefined, next: string | undefined): boolean {
  // An opening * / _ is followed by a non-space, non-marker char.
  if (next === undefined || next === ' ' || next === '\n' || next === '*' || next === '_') return false;
  // Underscore emphasis must sit at a word boundary — `foo_bar` (snake_case) and
  // other intraword underscores are NOT emphasis (CommonMark). `*` may be intraword.
  if (ch === '_' && prev !== undefined && WORD.test(prev)) return false;
  return true;
}
function isFlankClose(prev: string | undefined): boolean {
  // A closing * / _ is preceded by a non-space.
  return prev !== undefined && prev !== ' ' && prev !== '\n';
}

/**
 * Return a well-formed markdown string for a live streaming frame, with `cursor`
 * placed at the content end. Balances any open bold/italic/code/strike spans and
 * closes an open code fence so the frame never renders broken.
 */
export function stabilizeStreamingMarkdown(body: string, cursor: string): string {
  if (!body) return cursor;

  // 1) Fenced code blocks. Count fence lines (``` or ~~~ at a line start). An odd
  //    count means we're INSIDE a code block, where inline markers are literal —
  //    so just drop the cursor at the end and close the fence.
  const fences = body.match(/^[ \t]*(```|~~~)/gm) ?? [];
  if (fences.length % 2 === 1) {
    const tok = fences[fences.length - 1]!.trim().slice(0, 3);
    const sep = body.endsWith('\n') ? '' : '\n';
    return `${body}${cursor}${sep}${tok}`;
  }

  // 2) Inline balancing via a small stack scan (inline code makes other markers
  //    literal, so we skip everything until the code span closes).
  const stack: string[] = [];
  let i = 0;
  while (i < body.length) {
    const ch = body[i]!;
    const top = stack[stack.length - 1];

    // Inline code: toggles a literal region.
    if (ch === '`') {
      if (top === '`') stack.pop();
      else stack.push('`');
      i += 1;
      continue;
    }
    if (top === '`') { i += 1; continue; } // literal inside inline code

    // Multi-char markers (**, __, ~~).
    const two = body.substr(i, 2);
    if ((PAIR as readonly string[]).includes(two)) {
      if (top === two) stack.pop();
      else stack.push(two);
      i += 2;
      continue;
    }

    // Single * / _ with conservative flanking.
    if (ch === '*' || ch === '_') {
      const prev = body[i - 1];
      const next = body[i + 1];
      if (top === ch && isFlankClose(prev)) stack.pop();
      else if (top !== ch && canOpen(ch, prev, next)) stack.push(ch);
      // else: a bare marker (e.g. "2 * 3", snake_case) — leave as literal text.
      i += 1;
      continue;
    }

    i += 1;
  }

  // Cursor sits at the content end (inside any still-open spans); append the
  // matching closers in LIFO order so the frame is valid markdown.
  let closers = '';
  for (let k = stack.length - 1; k >= 0; k--) closers += stack[k];
  return `${body}${cursor}${closers}`;
}
