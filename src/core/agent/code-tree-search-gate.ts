/**
 * @file code-tree-search-gate.ts
 * @description Gate + opts builder for routing code-authoring turns through
 * the tree-search strategy with a real (sandboxed) verifier.
 *
 * Opt-in via SUDO_BRAIN_CODE_TREE_SEARCH=1: tree-search multiplies token
 * cost (~3-9x) and latency on matched turns, so the operator chooses when
 * to pay for verified code generation. The verifier chain is deterministic
 * and cheap: a shape check (some code present) plus a REAL bwrap-sandboxed
 * `node --check` syntax pass over the extracted candidate.
 */

import { makeExecVerifier } from '../brain/brain-verifier-exec.js';
import { makeCompositeVerifier } from '../brain/brain-verifier-compose.js';
import { extractCodeFromCandidate } from '../brain/brain-verifier-exec.js';
import type { VerifierResult } from '../brain/brain-tree-search.js';
import type { BrainResponse, BrainRequest } from '../brain/types.js';

/** Requests that read as "author code now" — write/create/implement + a code noun. */
const CODE_AUTHORING_RE =
  /\b(?:write|create|implement|build|generate|author)\b.{0,60}\b(?:script|function|program|class|module|algorithm|code|snippet)\b/i;

export function codeTreeSearchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['SUDO_BRAIN_CODE_TREE_SEARCH'] === '1';
}

function minComplexity(env: NodeJS.ProcessEnv): number {
  const raw = Number(env['SUDO_BRAIN_CODE_TS_MIN_COMPLEXITY']);
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0.5;
}

/**
 * True when this turn should run tree-search: flag on, the user text reads
 * as a code-authoring request, and the complexity score clears the floor.
 * Pure — all inputs are arguments.
 */
export function shouldUseCodeTreeSearch(
  lastUserText: string,
  complexityScore: number,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!codeTreeSearchEnabled(env)) return false;
  if (!CODE_AUTHORING_RE.test(lastUserText)) return false;
  return complexityScore >= minComplexity(env);
}

/** Shape check: the candidate must contain nontrivial code. */
function codeShapeVerifier(candidate: BrainResponse, _request: BrainRequest): VerifierResult {
  const code = extractCodeFromCandidate(candidate.content ?? '');
  if (code === '') return { score: 0, reason: 'shape: no code in candidate' };
  if (code.length < 20) return { score: 0.3, reason: 'shape: suspiciously short code' };
  return { score: 1 };
}

/**
 * Composite verifier for code candidates: shape + real sandboxed
 * `node --check` syntax verification (all must pass).
 */
export function buildCodeTreeSearchVerifier(): (
  candidate: BrainResponse,
  request: BrainRequest,
) => Promise<VerifierResult> | VerifierResult {
  const syntaxCheck = makeExecVerifier({
    testCommand: 'node --check solution.mjs',
    candidateFile: 'solution.mjs',
  });
  return makeCompositeVerifier([codeShapeVerifier, syntaxCheck], { mode: 'all' });
}
