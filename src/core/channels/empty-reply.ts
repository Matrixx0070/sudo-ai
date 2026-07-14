/**
 * empty-reply normalization.
 *
 * A content-filtered or "phantom-completion" turn returns an EMPTY string (not
 * null/undefined), so `result.text ?? fallback` misses it. The empty string
 * then reaches Telegram's `editMessageText`, which rejects it with
 * `400: message text is empty` — so a refusal becomes total SILENCE, for that
 * turn AND every later message in the same (now-poisoned) session.
 *
 * This module turns an empty reply into a short, visible, actionable message
 * instead. Pure + channel-agnostic so it can guard every delivery path.
 */

/** Shown when a turn produces no text and no attachments. */
export const EMPTY_REPLY_FALLBACK =
  "⚠️ I couldn't produce a reply for that — the response came back empty " +
  '(this usually means the message tripped a safety filter). If it keeps ' +
  'happening on this chat, send /reset to start a fresh conversation.';

/** True when `text` is missing or only whitespace. */
export function isEmptyReply(text: string | null | undefined): boolean {
  return !text || text.trim().length === 0;
}

/**
 * Resolve the text actually delivered to the user.
 * - Non-empty text → returned unchanged.
 * - Empty text WITH attachments → '' (the attachments carry the reply; don't
 *   inject noise text).
 * - Empty text WITHOUT attachments → the fallback message (never silence).
 */
export function normalizeReplyText(
  text: string | null | undefined,
  hasAttachments: boolean,
): string {
  if (!isEmptyReply(text)) return text as string;
  return hasAttachments ? '' : EMPTY_REPLY_FALLBACK;
}
