/**
 * @file index.ts
 * @description Public surface of the testing module.
 *
 * Consumers import from 'src/core/testing' to get the test harness
 * and its supporting types.
 */

export {
  TestHarness,
} from './test-harness.js';

export type {
  TestResult,
  TestSuite,
} from './test-harness.js';
