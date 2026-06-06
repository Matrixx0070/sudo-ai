/**
 * Tests for the Task Completion Verifier.
 * Addresses OpenClaw's #1 community complaint: phantom task completion.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CompletionVerifier } from '../../src/core/tools/completion-verifier.js';

describe('CompletionVerifier', () => {
  let verifier: CompletionVerifier;

  beforeEach(() => {
    verifier = new CompletionVerifier({ minConfidence: 70, minOutputLength: 20 });
  });

  it('should pass genuine completions', () => {
    const result = verifier.verify(
      'I have successfully created the file at /path/to/file.ts with the requested functionality. The implementation includes error handling, input validation, and comprehensive logging.',
      'Create a file with error handling',
    );

    expect(result.passed).toBe(true);
    expect(result.confidence).toBeGreaterThanOrEqual(70);
  });

  it('should fail empty output', () => {
    const result = verifier.verify('', 'Create a file');

    expect(result.passed).toBe(false);
    expect(result.confidence).toBeLessThan(70);
    expect(result.checks.some(c => c.name === 'output_length' && c.severity === 'fail')).toBe(true);
  });

  it('should fail placeholder content', () => {
    const placeholders = ['N/A', 'TODO', 'FIXME', 'placeholder', 'STUB', 'Not implemented'];

    for (const placeholder of placeholders) {
      const result = verifier.verify(placeholder, 'Create a file');
      expect(result.passed, `Should fail for placeholder: "${placeholder}"`).toBe(false);
    }
  });

  it('should fail very short output', () => {
    const result = verifier.verify('ok', 'Create a comprehensive file');

    expect(result.passed).toBe(false);
    expect(result.checks.some(c => c.name === 'output_length')).toBe(true);
  });

  it('should fail repetitive output', () => {
    const repetitive = Array(20).fill('The same line repeated over and over').join('\n');
    const result = verifier.verify(repetitive, 'Write a summary');

    expect(result.confidence).toBeLessThan(80);
  });

  it('should fail error messages disguised as output', () => {
    const result = verifier.verify('Error: unable to complete the request', 'Create a file');

    expect(result.passed).toBe(false);
    expect(result.checks.some(c => c.name === 'content_quality' && c.severity === 'fail')).toBe(true);
  });

  it('should warn on truncated code blocks', () => {
    const truncated = 'Here is the code:\n```typescript\nfunction hello() {\n  return "hello';
    const result = verifier.verify(truncated, 'Write a function');

    expect(result.checks.some(c => c.name === 'structural_completeness')).toBe(true);
  });

  it('should check cross-reference with original request', () => {
    const result = verifier.verify(
      'The weather today is sunny with temperatures around 75°F.',
      'Write a Python web scraper',
    );

    // The output doesn't address the request at all
    expect(result.checks.some(c => c.name === 'cross_reference')).toBe(true);
  });

  it('should pass output that addresses the request', () => {
    const result = verifier.verify(
      'I have created the Python web scraper as requested. It uses BeautifulSoup to parse HTML, handles pagination, and saves results to CSV format.',
      'Write a Python web scraper',
    );

    expect(result.passed).toBe(true);
  });

  it('should provide retry strategy on failure', () => {
    const result = verifier.verify('', 'Create a file');

    expect(result.retryStrategy).toBeDefined();
    expect(result.retryStrategy?.approach).toBeTruthy();
    expect(result.retryStrategy?.reason).toBeTruthy();
  });

  it('should suggest rephrasing for placeholder output', () => {
    const result = verifier.verify('TODO', 'Create a file');

    expect(result.retryStrategy).toBeDefined();
    expect(result.retryStrategy?.approach).toBe('rephrase');
  });

  it('should track verification statistics', () => {
    verifier.verify('Good output that addresses the request with proper content', 'Write content');
    verifier.verify('N/A', 'Write content');

    const stats = verifier.getStats();
    expect(stats.totalVerifications).toBe(2);
    expect(stats.passed).toBe(1);
    expect(stats.failed).toBe(1);
  });

  it('should support verifyWithRetry', async () => {
    let attempt = 0;
    const retryFn = async () => {
      attempt++;
      if (attempt === 1) return 'Better output that properly addresses the original request';
      return 'Final attempt with comprehensive content addressing all aspects of the request';
    };

    const result = await verifier.verifyWithRetry(
      'N/A',
      'Create a comprehensive file with error handling',
      retryFn,
    );

    expect(result).not.toBeNull();
    expect(result!.output).toBeTruthy();
  });

  it('should respect custom minConfidence', () => {
    const strictVerifier = new CompletionVerifier({ minConfidence: 90, minOutputLength: 50 });

    const result = strictVerifier.verify(
      'This is a short answer.',
      'Write a comprehensive guide',
    );

    // Short answer won't pass a 90% threshold
    expect(result.passed).toBe(false);
  });
});