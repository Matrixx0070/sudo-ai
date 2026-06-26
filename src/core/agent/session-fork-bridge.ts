/**
 * @file session-fork-bridge.ts
 * @description Identity-preserving boundary bridges between the agent loop's
 * intentionally decoupled structural interfaces (`SessionLike` from
 * loop-helpers, `SessionManagerLike` from loop-types) and the concrete
 * fork-path types (`Session` / `ForkSessionManager` from sessions/session-fork).
 *
 * Why these exist: the loop is deliberately written against narrow structural
 * interfaces so it stays decoupled from session-storage internals. At runtime
 * the loop only ever runs against the real SessionManager, which yields real
 * `Session` instances, so narrowing a `SessionLike` to a `Session` (and the
 * reverse) is a sound one-shot re-type at the helper boundary — NOT a data copy
 * and NOT a dynamic guess.
 *
 * Why a named bridge instead of an inline `as unknown as`: per the boundary-cast
 * discipline, an inline double-cast in the hot loop block is an opaque boundary
 * that hides type drift. Routing every conversion through these named functions
 * gives each call site a *type-checked input* (you can only hand `toForkSession`
 * a `SessionLike`, only hand `toForkSessionManager` a `SessionManagerLike`, etc.)
 * and collapses the three impedance points into one documented place instead of
 * three inline casts scattered through loop.ts.
 *
 * Identity guarantee: each function returns the SAME object reference it was
 * given, only re-typed. Callers rely on this — the fork reassigns the loop's
 * live `session` to `fork.newSession`, and subsequent mutations/persistence must
 * land on the real object, so these bridges must never copy.
 */

import type { SessionLike } from './loop-helpers.js';
import type { SessionManagerLike } from './loop-types.js';
import type { Session } from '../sessions/types.js';
import type { ForkSessionManager } from '../sessions/session-fork.js';

/**
 * Bridge the loop's structural `SessionLike` to the concrete `Session` the fork
 * helpers (`shouldFork`, `forkSession`) consume. Identity-preserving.
 *
 * The structural impedance (`SessionLike` omits the concrete `state`/`createdAt`/
 * `updatedAt` and widens `channel` to `string`) means this is genuinely not a
 * structural subtype, hence the unchecked hop — but it is contained here and the
 * input is constrained to `SessionLike`.
 */
export function toForkSession(session: SessionLike): Session {
  return session as unknown as Session;
}

/**
 * Bridge the loop's structural `SessionManagerLike` to the `ForkSessionManager`
 * the fork path needs. Identity-preserving. The two differ only by covariant
 * return / contravariant param shifts (`SessionLike` vs `Session`), which the
 * structural checker rejects even though the runtime manager satisfies both.
 */
export function toForkSessionManager(manager: SessionManagerLike): ForkSessionManager {
  return manager as unknown as ForkSessionManager;
}

/**
 * Bridge a concrete `Session` (the freshly forked session) back to the loop's
 * `SessionLike`. Identity-preserving. `SessionLike` carries an open index
 * signature for ad-hoc per-turn metadata that the concrete `Session` does not
 * declare, so an interface `Session` is not directly assignable to it.
 */
export function fromForkSession(session: Session): SessionLike {
  return session as unknown as SessionLike;
}
