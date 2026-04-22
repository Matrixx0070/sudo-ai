/**
 * @file browser-search-timeout.test.ts
 * @description Tests that the Playwright script built by _buildSearchScript
 * reads SUDO_SEARCH_WAIT_UNTIL and SUDO_SEARCH_TIMEOUT_MS from process.env
 * at child-process runtime, with correct fallback defaults.
 *
 * Strategy: inspect the returned script string — env reads MUST live inside
 * the script template (child process reads them, not the parent).
 */

import { describe, it, expect, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — suppress logger output
// ---------------------------------------------------------------------------

vi.mock('../../src/core/shared/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Import (after mocks)
// ---------------------------------------------------------------------------

import { _buildSearchScript } from '../../src/core/tools/builtin/browser/search.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('_buildSearchScript env-driven timeout config', () => {
  const script = _buildSearchScript('hello world', 5);

  it('default waitUntil fallback is domcontentloaded (literal present in script)', () => {
    expect(script).toContain("'domcontentloaded'");
  });

  it('default timeout fallback is 8000 ms (literal present in script)', () => {
    expect(script).toContain("'8000'");
  });

  it('SUDO_SEARCH_WAIT_UNTIL is read from process.env inside the script string', () => {
    expect(script).toContain("process.env['SUDO_SEARCH_WAIT_UNTIL']");
  });

  it('SUDO_SEARCH_TIMEOUT_MS is read from process.env inside the script string', () => {
    expect(script).toContain("process.env['SUDO_SEARCH_TIMEOUT_MS']");
  });
});
