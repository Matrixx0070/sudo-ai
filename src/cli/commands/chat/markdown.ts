/**
 * @file markdown.ts — Convert markdown to ANSI-styled terminal string.
 * Uses marked lexer. Outputs plain string with ANSI codes.
 * Wrap at 76 chars with 2-space left margin.
 */

import { marked, type Token } from 'marked';
import { highlight } from 'cli-highlight';

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const A = {
  reset:     '\x1b[0m',
  bold:      '\x1b[1m',
  dim:       '\x1b[2m',
  italic:    '\x1b[3m',
  underline: '\x1b[4m',
} as const;

function bold(s: string): string { return `${A.bold}${s}${A.reset}`; }
function dim(s: string): string  { return `${A.dim}${s}${A.reset}`; }

function underline(s: string): string { return `${A.underline}${s}${A.reset}`; }

// ---------------------------------------------------------------------------
// Word-wrap at 76 chars, 2-space left margin
// ---------------------------------------------------------------------------

const WRAP_WIDTH = 76;
const MARGIN = '  ';

/**
 * Hard-wrap a plain (no ANSI) string at WRAP_WIDTH, prepend MARGIN.
 * Used for paragraph text before ANSI codes are applied.
 */
function wrapPlain(text: string): string {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= WRAP_WIDTH) {
      current += ' ' + word;
    } else {
      lines.push(MARGIN + current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(MARGIN + current);
  return lines.join('\n');
}

/**
 * Wrap a pre-styled string (may have ANSI) by visible char budget.
 * Strips ANSI for length counting, then inserts newline+margin.
 */
function wrapStyled(text: string): string {
  // Split on existing newlines first, wrap each segment
  const segments = text.split('\n');
  return segments.map(seg => wrapStyledLine(seg)).join('\n');
}

function wrapStyledLine(line: string): string {
  if (visibleLen(line) <= WRAP_WIDTH) return MARGIN + line;

  const result: string[] = [];
  let currentLine = '';
  let visLen = 0;
  let i = 0;

  while (i < line.length) {
    // Check for ANSI escape
    if (line[i] === '\x1b' && line[i + 1] === '[') {
      const end = line.indexOf('m', i);
      if (end !== -1) {
        const code = line.slice(i, end + 1);
        currentLine += code;
        i = end + 1;
        continue;
      }
    }

    const ch = line[i] as string;
    if (ch === ' ' && visLen >= WRAP_WIDTH - 10) {
      result.push(MARGIN + currentLine);
      currentLine = '';
      visLen = 0;
      i++;
      continue;
    }

    currentLine += ch;
    visLen++;
    i++;

    if (visLen >= WRAP_WIDTH) {
      result.push(MARGIN + currentLine);
      currentLine = '';
      visLen = 0;
    }
  }

  if (currentLine.length > 0) result.push(MARGIN + currentLine);
  return result.join('\n');
}

function visibleLen(s: string): number {
  // Remove ANSI escape codes then measure
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

// ---------------------------------------------------------------------------
// Token walker
// ---------------------------------------------------------------------------

function renderTokens(tokens: Token[]): string {
  return tokens.map(renderToken).join('');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderToken(token: any): string {
  switch (token.type) {
    case 'heading': {
      const text = renderInline(token.tokens ?? []);
      return '\n' + MARGIN + bold(text) + '\n';
    }

    case 'paragraph': {
      const raw = renderInline(token.tokens ?? []);
      return wrapStyled(raw) + '\n';
    }

    case 'list': {
      const ordered: boolean = token.ordered === true;
      const startNum: number = typeof token.start === 'number' ? token.start : 1;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const items: string[] = (token.items ?? []).map((item: any, idx: number) => {
        const body = renderTokens(item.tokens ?? []).trimEnd();
        const prefix = ordered
          ? `  ${startNum + idx}  `
          : '  \u2022 ';
        return prefix + body;
      });
      return items.join('\n') + '\n';
    }

    case 'code': {
      return renderCodeBlock(token.text ?? '', token.lang ?? '');
    }

    case 'blockquote': {
      const inner = renderTokens(token.tokens ?? []).trimEnd();
      return dim('  ┃ ') + inner.split('\n').join('\n' + dim('  ┃ ')) + '\n\n';
    }

    case 'hr': {
      return '\n' + dim(MARGIN + '─'.repeat(WRAP_WIDTH)) + '\n\n';
    }

    case 'space': {
      return '\n';
    }

    case 'html': {
      return token.text ?? '';
    }

    default: {
      if (token.tokens) return renderInline(token.tokens);
      if (typeof token.text === 'string') return token.text;
      return '';
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderInline(tokens: any[]): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return tokens.map((t: any) => {
    switch (t.type) {
      case 'text':   return t.text ?? '';
      case 'strong': return bold(renderInline(t.tokens ?? []));
      case 'em':     return `${A.italic}${renderInline(t.tokens ?? [])}${A.reset}`;
      case 'codespan':
        return `${A.dim}${A.italic}${t.text ?? ''}${A.reset}`;
      case 'link': {
        const text = renderInline(t.tokens ?? []);
        const href = t.href ?? '';
        return `${underline(text)} ${dim(href)}`;
      }
      case 'image': {
        const alt = t.text ?? 'image';
        return dim(`[image: ${alt}]`);
      }
      case 'br':     return '\n';
      case 'del':    return dim(renderInline(t.tokens ?? []));
      case 'html':   return t.text ?? '';
      case 'escape': return t.text ?? '';
      default: {
        if (t.tokens) return renderInline(t.tokens);
        if (typeof t.text === 'string') return t.text;
        if (typeof t.raw === 'string') return t.raw;
        return '';
      }
    }
  }).join('');
}

function renderCodeBlock(code: string, lang: string): string {
  let highlighted: string;
  try {
    highlighted = highlight(code, {
      language: lang || 'plaintext',
      ignoreIllegals: true,
    });
  } catch {
    highlighted = code;
  }

  const rule = dim(MARGIN + '─'.repeat(WRAP_WIDTH));
  const lines = highlighted.split('\n').map(l => MARGIN + '  ' + l).join('\n');
  return `\n${rule}\n${lines}\n${rule}\n`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert markdown string to ANSI-styled terminal string.
 * Hard-wraps at 76 chars with 2-space left margin.
 */
export function renderMarkdown(markdown: string): string {
  try {
    const tokens = marked.lexer(markdown);
    return renderTokens(tokens).trimEnd();
  } catch {
    return markdown;
  }
}

/**
 * Strip markdown syntax for plain contexts.
 */
export function stripMarkdown(markdown: string): string {
  return markdown
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/#+\s/g, '')
    .replace(/\[(.+?)\]\(.+?\)/g, '$1')
    .trim();
}

/**
 * Hard-wrap plain text at 76 chars with 2-space margin.
 * For user messages (no markdown).
 */
export function wrapText(text: string): string {
  return text.split('\n').map(line => wrapPlain(line)).join('\n');
}
