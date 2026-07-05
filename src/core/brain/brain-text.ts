/**
 * @file brain/brain-text.ts
 * @description Normalize a Brain.chat() reply into safe text.
 *
 * Brain.chat() resolves to a plain STRING (see brain.ts — it returns
 * `response.content ?? ''`). Several call sites historically typed it as
 * `Promise<{ content: string }>` and read `response.content`, which was `undefined` at
 * runtime → `.trim()` threw "Cannot read properties of undefined". The wrong type
 * annotation hid it from tsc, so whole tool suites (marketing, finance, pm, personal,
 * legal, …) were silently dead in prod. This is the single, null-safe normalizer they
 * should all funnel through.
 *
 * Tolerates: a string (the real contract), a legacy `{ content }` object (defensive),
 * or anything else → ''. Never throws.
 */
export function normalizeBrainText(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object' && typeof (raw as { content?: unknown }).content === 'string') {
    return (raw as { content: string }).content;
  }
  return '';
}
