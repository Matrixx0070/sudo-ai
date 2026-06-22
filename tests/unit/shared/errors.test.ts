/**
 * Unit coverage for the error hierarchy and HTTP-status categoriser in
 * src/core/shared/errors.ts.
 *
 * This module had no dedicated test file. The SudoError hierarchy is relied on
 * for `instanceof` routing across channels and tools, and `categorizeError`
 * drives the LLM failover/backoff system's retry decisions, so pinning the
 * prototype-chain behaviour, code prefixes and every status branch down is
 * cheap insurance against regressions.
 */

import { describe, it, expect } from 'vitest';
import {
  SudoError,
  LLMError,
  ToolError,
  ChannelError,
  ConfigError,
  MemoryError,
  PipelineError,
  BrowserError,
  SystemError,
  KnowledgeError,
  BusinessError,
  categorizeError,
  type ErrorCategory,
} from '../../../src/core/shared/errors.js';

describe('SudoError', () => {
  it('carries message, code and optional details', () => {
    const err = new SudoError('boom', 'generic_fail', { attempt: 2 });
    expect(err.message).toBe('boom');
    expect(err.code).toBe('generic_fail');
    expect(err.details).toEqual({ attempt: 2 });
  });

  it('is a real Error with a correct prototype chain', () => {
    const err = new SudoError('x', 'c');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SudoError);
    expect(err.name).toBe('SudoError');
    expect(err.details).toBeUndefined();
  });
});

describe('typed subclasses', () => {
  it('preserve the SudoError prototype chain for instanceof routing', () => {
    const cases: Array<[SudoError, string]> = [
      [new LLMError('m', 'llm_timeout'), 'LLMError'],
      [new ToolError('m', 'tool_failed'), 'ToolError'],
      [new ChannelError('m', 'channel_down'), 'ChannelError'],
      [new ConfigError('m', 'config_invalid'), 'ConfigError'],
      [new MemoryError('m', 'memory_oom'), 'MemoryError'],
      [new PipelineError('m', 'pipeline_stall'), 'PipelineError'],
    ];
    for (const [err, name] of cases) {
      expect(err).toBeInstanceOf(SudoError);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe(name);
    }
  });

  it('auto-prefix the code for prefixing subclasses', () => {
    expect(new BrowserError('m', 'click_failed').code).toBe('browser_click_failed');
    expect(new SystemError('m', 'exec_denied').code).toBe('system_exec_denied');
    expect(new KnowledgeError('m', 'not_found').code).toBe('knowledge_not_found');
    expect(new BusinessError('m', 'quota').code).toBe('business_quota');
  });

  it('keep the literal code for non-prefixing subclasses', () => {
    expect(new LLMError('m', 'llm_rate_limit').code).toBe('llm_rate_limit');
    expect(new ToolError('m', 'tool_x').code).toBe('tool_x');
  });
});

describe('categorizeError', () => {
  it('maps the documented status codes to their categories', () => {
    const table: Array<[number, ErrorCategory]> = [
      [402, 'billing'],
      [429, 'rate_limit'],
      [503, 'overloaded'],
      [401, 'auth'],
      [403, 'auth_permanent'],
      [408, 'timeout'],
      [400, 'format'],
      [404, 'model_not_found'],
      [410, 'session_expired'],
    ];
    for (const [status, category] of table) {
      expect(categorizeError(status)).toBe(category);
    }
  });

  it('treats 429 with quota-exhaustion bodies as billing', () => {
    expect(categorizeError(429, 'You have insufficient_quota remaining')).toBe('billing');
    expect(categorizeError(429, 'You exceeded your current quota')).toBe('billing');
    expect(categorizeError(429, 'slow down, too many requests')).toBe('rate_limit');
  });

  it('disambiguates 400 via the response body', () => {
    expect(categorizeError(400, 'the session expired, re-auth')).toBe('session_expired');
    expect(categorizeError(400, 'the model not found here')).toBe('model_not_found');
    expect(categorizeError(400, 'bad request payload')).toBe('format');
  });

  it('treats other 5xx as transient overload', () => {
    expect(categorizeError(500)).toBe('overloaded');
    expect(categorizeError(502)).toBe('overloaded');
    expect(categorizeError(504)).toBe('overloaded');
  });

  it('falls back to format for unknown 4xx and non-numeric input', () => {
    expect(categorizeError(418)).toBe('format');
    // @ts-expect-error deliberately passing a wrong type
    expect(categorizeError('429')).toBe('format');
  });
});
