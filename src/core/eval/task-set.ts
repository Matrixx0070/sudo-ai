/**
 * @file task-set.ts
 * @description 5 built-in benchmark task definitions for SUDO-AI Wave 10.
 *
 * Each task has a stable ID, a prompt, expected output description, and
 * a baseline complexity tier. Tasks are ordered from simple to very_complex.
 */

import type { BenchTask } from '../shared/wave10-types.js';

/** The canonical 5 built-in benchmark tasks used by BenchRunner. */
export const BUILTIN_TASKS: BenchTask[] = [
  {
    id: 'task-hello',
    name: 'Simple greeting',
    prompt: 'Say hello.',
    expectedOutput: 'A short greeting response (non-empty)',
    complexityTier: 'simple',
    tags: ['smoke'],
  },
  {
    id: 'task-arithmetic',
    name: 'Arithmetic reasoning',
    prompt: 'What is 137 multiplied by 42? Show your work step by step.',
    expectedOutput: 'Correct answer: 5754 with step-by-step reasoning',
    complexityTier: 'moderate',
    tags: ['math', 'reasoning'],
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
      'Then suggest a fixed version.',
    ].join(''),
    expectedOutput: 'Identifies ZeroDivisionError, provides fixed version with guard',
    complexityTier: 'complex',
    tags: ['code', 'review'],
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
