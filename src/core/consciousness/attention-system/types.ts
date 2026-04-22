/**
 * @file types.ts
 * @description Local type declarations for the attention-system sub-module.
 *
 * Kept separate from the parent consciousness types.ts so this module can
 * extend the vocabulary without polluting the shared namespace.
 */

// ---------------------------------------------------------------------------
// CognitiveBudget
// ---------------------------------------------------------------------------

/**
 * Represents the pool of attention units available for a single processing
 * cycle.  Computed from the current BodyState and consumed as thoughts are
 * allocated.
 */
export interface CognitiveBudget {
  /** Maximum attention units available this cycle (0–100). */
  totalBudget: number;
  /** Units consumed so far this cycle. */
  used: number;
  /** Units still available (totalBudget - used). */
  remaining: number;
}
