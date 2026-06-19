/**
 * @file tool-output-clamp.ts
 * @description Central size cap for tool outputs before they re-enter the model
 * context.
 *
 * Per-tool truncation exists ad hoc (api-call 4KB, log-search, …) but there was
 * no CENTRAL budget — a tool that doesn't self-truncate (a large scrape, an MCP
 * response, a big file read) could dump its full payload into the conversation
 * and blow up context + cost. This clamps every tool result at one choke point.
 *
 * On by default with a generous budget (only pathological outputs are touched);
 * tune via SUDO_MAX_TOOL_RESULT_CHARS, or set it to '0' to disable entirely.
 * Head + tail are preserved (status/errors usually live at the end) with a
 * middle marker so the model knows the result was clamped and can paginate.
 */

/** Default budget: ~6k tokens of text — generous enough that normal tools never hit it. */
const DEFAULT_MAX_CHARS = 24000;

/** Resolve the per-result character budget. Returns 0 when clamping is disabled. */
export function maxToolResultChars(): number {
  const raw = process.env['SUDO_MAX_TOOL_RESULT_CHARS'];
  if (raw === '0') return 0; // explicit kill-switch
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_CHARS;
}

/**
 * Clamp a tool output to the central character budget, keeping the head and
 * tail with a middle marker. Returns the input unchanged when under budget or
 * when clamping is disabled (max <= 0).
 *
 * @param output - The tool's output string.
 * @param max    - Budget override (defaults to maxToolResultChars()).
 */
export function clampToolOutput(output: string, max: number = maxToolResultChars()): string {
  if (typeof output !== 'string' || max <= 0 || output.length <= max) return output;
  const omitted = output.length - max;
  const headLen = Math.max(1, Math.floor(max * 0.8));
  const tailLen = Math.max(0, max - headLen);
  const head = output.slice(0, headLen);
  const tail = tailLen > 0 ? output.slice(output.length - tailLen) : '';
  return (
    `${head}\n` +
    `…[tool output clamped: ${omitted} of ${output.length} chars omitted; ` +
    `raise SUDO_MAX_TOOL_RESULT_CHARS or paginate]…\n` +
    `${tail}`
  );
}
