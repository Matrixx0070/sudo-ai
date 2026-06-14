/**
 * @file acp/tools/utils.ts
 * @description Shared helpers for the ACP fs/* + terminal/* tool wrappers
 * (gap #26 slice 3).
 */

/**
 * Throw an Error with a descriptive message when the arg at `key` is missing
 * or not a non-empty string. Tool defs catch this and turn it into a clean
 * `{success:false, output:...}` shape, so the model sees a typed failure
 * rather than an exception.
 */
export function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v === '') {
    throw new Error(`${key} must be a non-empty string`);
  }
  return v;
}
