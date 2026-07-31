/**
 * @file ir-interceptor.ts
 * @description Optional process-wide IR interceptor seam (generic capability,
 * same spirit as SUDO_SANDBOX_DOCKER_RUNTIME). A process that wants every IR
 * call served locally (deterministic eval replay, capture harnesses) installs
 * one; when unset (the default, always in prod) callIR/streamIR behave exactly
 * as before — provably inert, pinned by tests/eval/sandbox/replay.test.ts.
 * The interceptor OWNS the call outcome: transport does no fetch, no auth, no
 * policy wrap, and no llm_calls row for intercepted calls. streamIR under an
 * interceptor fails closed rather than falling through to a live wire call.
 */

import type { IRRequest, IRResponse } from '../../shared-types/ir/v1.js';

export type IRInterceptor = (ir: IRRequest) => Promise<IRResponse>;

let _irInterceptor: IRInterceptor | null = null;

/** Install (or clear, with null) the process-wide IR interceptor. */
export function setIRInterceptor(fn: IRInterceptor | null): void {
  _irInterceptor = fn;
}

/** Transport-side accessor: the installed interceptor, or null (inert). */
export function getIRInterceptor(): IRInterceptor | null {
  return _irInterceptor;
}
