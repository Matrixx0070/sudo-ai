/**
 * @file task-set.ts
 * @description 5 built-in benchmark task definitions for SUDO-AI.
 *
 * Each task has a stable ID, a prompt, expected output description, a baseline complexity
 * tier, and a {@link BenchVerifier} that produces a real pass/fail signal. Tasks are
 * ordered from simple to very_complex.
 *
 * Verifier choice per task:
 *   - 4 string verifiers (cheap, deterministic, no extra LLM call)
 *   - 1 ExecVerifier on task-code-review (runs the agent's Python fix against held-out
 *     tests inside the bubblewrap sandbox)
 */

import type { BenchTask } from '../shared/wave10-types.js';
import { ExecVerifier, StringVerifier } from './verifiers/index.js';

const DIVIDE_HELD_OUT_TESTS = `
# Held-out tests for the 'divide' function. The agent's fix must:
#   1. Still return the correct quotient for non-zero divisors.
#   2. NOT propagate a raw ZeroDivisionError when called with b == 0.
#      (Returning None, raising ValueError, returning a sentinel, etc. are all accepted.)
import sys
try:
    assert divide(10, 2) == 5, f"divide(10,2) expected 5, got {divide(10, 2)}"
    assert divide(-6, 3) == -2, f"divide(-6,3) expected -2, got {divide(-6, 3)}"
except AssertionError as e:
    print(f"ASSERT_FAIL: {e}", file=sys.stderr)
    sys.exit(1)
except Exception as e:
    print(f"NON_ZERO_DIV_FAIL: {type(e).__name__}: {e}", file=sys.stderr)
    sys.exit(2)

try:
    divide(1, 0)
except ZeroDivisionError as e:
    print(f"BARE_ZERO_DIV_NOT_HANDLED: {e}", file=sys.stderr)
    sys.exit(3)
except Exception:
    pass  # Any other handling is acceptable

print("PASS")
sys.exit(0)
`;

/** The canonical 5 built-in benchmark tasks used by BenchRunner. */
export const BUILTIN_TASKS: BenchTask[] = [
  {
    id: 'task-hello',
    name: 'Simple greeting',
    prompt: 'Say hello.',
    expectedOutput: 'A short greeting response (non-empty)',
    complexityTier: 'simple',
    tags: ['smoke'],
    verifier: new StringVerifier({
      mode: 'any',
      rules: [/\b(hello|hi|hey|greetings|howdy)\b/i],
    }),
  },
  {
    id: 'task-arithmetic',
    name: 'Arithmetic reasoning',
    prompt: 'What is 137 multiplied by 42? Show your work step by step.',
    expectedOutput: 'Correct answer: 5754 with step-by-step reasoning',
    complexityTier: 'moderate',
    tags: ['math', 'reasoning'],
    verifier: new StringVerifier({
      mode: 'all',
      rules: ['5754'],
    }),
  },
  {
    id: 'task-code-review',
    name: 'Code review',
    prompt: [
      'Review the following Python function and identify any bugs:\n',
      '```python\n',
      'def divide(a, b):\n',
      '    return a / b\n',
      '```\n',
      'Then suggest a fixed version. Reply with a fenced ```python``` code block that defines `divide(a, b)`.',
    ].join(''),
    expectedOutput: 'Identifies ZeroDivisionError, provides fixed `divide` that handles b == 0',
    complexityTier: 'complex',
    tags: ['code', 'review'],
    verifier: new ExecVerifier({
      language: 'python',
      heldOutTests: DIVIDE_HELD_OUT_TESTS,
      timeoutMs: 8_000,
    }),
  },
  {
    id: 'task-pipeline-design',
    name: 'Multi-step pipeline design',
    prompt: [
      'Design a data pipeline that:\n',
      '  Step 1: Ingests CSV files from an S3 bucket.\n',
      '  Step 2: Then validates schema using JSON schema.\n',
      '  Next transforms records into Parquet format.\n',
      '  Step 4: Loads into a data warehouse.\n',
      'Plan the error handling at each stage.',
    ].join(''),
    expectedOutput: 'Structured pipeline design with 4 stages and error handling plan',
    complexityTier: 'complex',
    tags: ['architecture', 'pipeline'],
    verifier: new StringVerifier({
      mode: 'all',
      rules: [
        /\bingest/i,
        /\bvalidat/i,
        /\btransform/i,
        /\bload/i,
        /\berror[\s-]?handling\b/i,
      ],
    }),
  },
  {
    id: 'task-system-analysis',
    name: 'Complex system analysis',
    prompt: [
      'Analyse the following distributed system specification and produce:\n',
      '  1. A fault-tolerance assessment\n',
      '  2. A performance bottleneck analysis\n',
      '  3. A security threat model\n',
      '  4. Concrete recommendations with priority ordering\n',
      '\nSystem: microservices architecture with { "services": { "api-gateway": {},',
      ' "auth-service": {}, "user-service": {}, "order-service": {} },',
      ' "databases": { "users-db": {}, "orders-db": {} } }',
    ].join(''),
    expectedOutput: 'Four-section analysis with concrete, prioritised recommendations',
    complexityTier: 'very_complex',
    tags: ['architecture', 'security', 'analysis'],
    verifier: new StringVerifier({
      mode: 'all',
      rules: [
        /fault[\s-]?toleran/i,
        /(performance|bottleneck)/i,
        /(security|threat)/i,
        /(recommend|priorit)/i,
      ],
    }),
  },
];

/**
 * Returns all built-in tasks, optionally filtered by IDs.
 * If ids is empty or omitted, returns all 5 tasks.
 */
export function getBuiltinTasks(ids?: string[]): BenchTask[] {
  if (!ids || ids.length === 0) return BUILTIN_TASKS;
  const idSet = new Set(ids);
  return BUILTIN_TASKS.filter(t => idSet.has(t.id));
}
