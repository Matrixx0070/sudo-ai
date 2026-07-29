/**
 * @file shared/sanitize-error.ts
 * @description Turn a raw error into safe, user-facing copy.
 *
 * Turn-failure handlers used to send `err.message` straight to the channel, so a
 * raw provider payload — Anthropic/kimi JSON (`{"type":"invalid_request_error",
 * "message":"..."}`), a Cloudflare/gateway HTML page, or a bare errno string —
 * could reach a chat user verbatim. sanitizeUserFacingError maps those to concise,
 * actionable copy while keeping the raw error for logs. Never throws.
 *
 * Kill-switch: SUDO_ERROR_SANITIZE=0 returns the raw (truncated) message, matching
 * the legacy behaviour.
 */

/** Extract a machine-readable code from an error-like object, if present. */
function errorCode(err: unknown): string | undefined {
  const c = (err as { code?: unknown } | null)?.code;
  return typeof c === 'string' ? c : undefined;
}

function rawMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err ?? '');
}

/**
 * Map an error to safe user-facing text. Order matters: specific LLMError codes
 * first, then transport/gateway/JSON shape heuristics, then a length backstop.
 */
export function sanitizeUserFacingError(err: unknown, maxLen = 200): string {
  const raw = rawMessage(err);
  if (process.env['SUDO_ERROR_SANITIZE'] === '0') {
    return raw.slice(0, maxLen);
  }

  const code = errorCode(err);
  if (code === 'llm_context_overflow') {
    return 'That conversation got too long for the model. I compacted it — please send your request again.';
  }
  if (code === 'llm_idle_circuit_open') {
    return 'The AI provider is temporarily unresponsive. Please try again in a minute.';
  }
  if (code === 'llm_all_attempts_failed' || code === 'llm_all_profiles_exhausted') {
    // Do NOT claim "temporary" without checking. A permanently-disabled profile
    // (403 auth_permanent — e.g. an org-level OAuth block) never recovers by
    // waiting, and "try again shortly" sends the user into a retry loop instead
    // of their provider settings. 2026-07-29: three of four profiles were
    // permanently blocked or quota-walled for hours behind this exact sentence.
    const d = (err as { details?: Record<string, unknown> } | null)?.details;
    const disabled = typeof d?.['disabledCount'] === 'number' ? d['disabledCount'] : 0;
    const cooling = typeof d?.['coolingCount'] === 'number' ? d['coolingCount'] : 0;
    const total = typeof d?.['profileCount'] === 'number' ? d['profileCount'] : 0;
    const soonestMs = typeof d?.['soonestRetryMs'] === 'number' ? d['soonestRetryMs'] : 0;

    if (disabled > 0) {
      const scope = total > 0 && disabled >= total ? 'Every' : `${disabled} of ${total}`;
      return (
        `No AI provider is available. ${scope} configured provider${disabled === 1 ? ' is' : 's are'} ` +
        'permanently disabled (auth or permission failure) — that needs a configuration fix, not a retry.'
      );
    }
    if (cooling > 0) {
      const secs = Math.max(1, Math.ceil(soonestMs / 1000));
      return `All AI providers are rate-limited right now. The soonest is available again in about ${secs}s.`;
    }
    return 'The AI providers are all temporarily unavailable. Please try again shortly.';
  }

  // Cloudflare / gateway HTML page — transient infra, not a real message.
  if (/<!doctype html|<html[\s>]|cloudflare|cf-ray|bad gateway|gateway time-?out/i.test(raw)) {
    return 'The AI provider returned a temporary gateway error. Please try again.';
  }

  // Raw provider JSON error payload — surface only the message field, if any.
  if (/[{[]/.test(raw) && /"(?:type|error|message)"\s*:/.test(raw)) {
    const m = /"message"\s*:\s*"([^"]{1,160})"/.exec(raw);
    return m ? `The AI request failed: ${m[1]}` : 'The AI request failed. Please try again.';
  }

  // Transport / network errno codes.
  if (/\b(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|EPIPE)\b/.test(raw)) {
    return 'A network error interrupted the request. Please try again.';
  }

  // Anything long or empty is likely leaking internals → generic copy.
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > maxLen) {
    return 'The request failed with an unexpected error. Please try again.';
  }
  return trimmed;
}
