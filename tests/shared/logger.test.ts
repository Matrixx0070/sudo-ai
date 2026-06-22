/**
 * @file logger.test.ts
 * @description createLogger() contract: it rejects empty/non-string module
 * names with a TypeError and otherwise returns a child logger carrying the
 * `module` binding. Under vitest the base logger logs synchronously (no worker
 * transport), so these assertions touch no filesystem.
 */

import { describe, it, expect } from 'vitest';
import { createLogger, logger } from '../../src/core/shared/logger.js';

describe('createLogger', () => {
  it('returns a child logger for a valid module name', () => {
    const log = createLogger('test-module');
    expect(log).toBeDefined();
    expect(typeof log.info).toBe('function');
    expect(typeof log.child).toBe('function');
  });

  it('throws TypeError on an empty module name', () => {
    expect(() => createLogger('')).toThrow(TypeError);
    expect(() => createLogger('')).toThrow(/non-empty string/);
  });

  it('throws TypeError when module name is not a string', () => {
    // @ts-expect-error – exercising the runtime guard with a wrong type.
    expect(() => createLogger(undefined)).toThrow(TypeError);
    // @ts-expect-error – exercising the runtime guard with a wrong type.
    expect(() => createLogger(123)).toThrow(TypeError);
  });

  it('exports a usable base logger', () => {
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
  });
});
