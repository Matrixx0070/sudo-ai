/**
 * @file chat-warning-filter.ts
 * @description SCAFFOLD: suppress a spurious React duplicate-key warning emitted
 * by Ink 7 / react-reconciler 0.33 / React 19.2 in DEV builds only.
 *
 * Diagnosis (2026-07-31, evidence in the PR):
 *   - The warning fires before any user input, on a clean TUI boot.
 *   - Its stack contains ZERO sudo-ai frames — only react-reconciler internals
 *     (reconcileChildrenArray -> warnOnInvalidKey).
 *   - The "key" React reports is itself a react-reconciler stack line
 *     ("    at recursivelyTraversePassiveMountEffects (…react-reconciler…)"),
 *     i.e. the reported key is garbage, not data from our components.
 *   - No component in the TUI render tree keys children by content.
 *   - NODE_ENV=production (production reconciler) emits ZERO warnings; dev emits it.
 *
 * So it is an upstream dev-build artifact, not a sudo-ai bug. The obvious
 * alternative fix — forcing NODE_ENV=production for the TUI — was REJECTED:
 * 22 sites branch on NODE_ENV, including the llm-client caller guard which
 * flips from throw to fail-open, so that "fix" would mask real telemetry bugs.
 *
 * This filter is deliberately NARROW: it drops duplicate-key warnings only when
 * the reported key is itself a stack frame. A genuine duplicate-key bug in our
 * components reports OUR data as the key and still surfaces loudly.
 *
 * REMOVE THIS once Ink/React stop emitting it (re-test by deleting the file and
 * running `sudo-ai chat`).
 */

/** A key that looks like a stack frame is never real component data. */
const STACK_FRAME_KEY = /same key, `\s+at\s/;

export function isSpuriousDuplicateKeyWarning(text: string): boolean {
  return text.includes('Encountered two children with the same key') && STACK_FRAME_KEY.test(text);
}

/**
 * Install the filter on stderr. Returns a restore function — always call it on
 * teardown so nothing else inherits a patched stream.
 */
export function installWarningFilter(stream: NodeJS.WriteStream = process.stderr): () => void {
  // Keep the ORIGINAL reference (not a bound copy) so restore() puts back the
  // exact same function object — anything else leaves the stream subtly altered
  // for whoever patched it before us.
  const original = stream.write;
  const patched = function (this: unknown, chunk: unknown, ...rest: unknown[]): boolean {
    if (typeof chunk === 'string' && isSpuriousDuplicateKeyWarning(chunk)) return true;
    return (original as (c: unknown, ...r: unknown[]) => boolean).call(stream, chunk, ...rest);
  };
  (stream as unknown as { write: unknown }).write = patched;
  return () => {
    (stream as unknown as { write: unknown }).write = original;
  };
}
