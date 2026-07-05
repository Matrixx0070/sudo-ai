/**
 * harness-bug-scan — surfaces uncaught tool crashes (TypeError/ReferenceError/null
 * reads) distinct from agent errors and legit failures. Proves the classifier,
 * signature normalization, and clustering.
 */
import { describe, it, expect } from 'vitest';
import {
  isHarnessCrash, crashErrorType, crashSignature, mineHarnessBugs, type HarnessBugRow,
} from '../../src/core/learning/harness-bug-scan.js';

describe('isHarnessCrash', () => {
  it('flags uncaught runtime crashes', () => {
    expect(isHarnessCrash('Error executing tool browser.navigate: TypeError: Cannot read properties of null (reading \'split\')')).toBe(true);
    expect(isHarnessCrash('Error executing tool coder.read-file: ReferenceError: __dirname is not defined')).toBe(true);
    expect(isHarnessCrash('SEO audit error: Cannot read properties of undefined (reading \'map\')')).toBe(true);
    expect(isHarnessCrash('x.foo is not a function')).toBe(true);
  });
  it('does NOT flag agent errors or legitimate failures', () => {
    expect(isHarnessCrash("Refused: shell metacharacters are not allowed in repo-exec")).toBe(false);
    expect(isHarnessCrash('sheets array is required and must not be empty.')).toBe(false);
    expect(isHarnessCrash('Path traversal blocked: /x resolves outside project root')).toBe(false);
    expect(isHarnessCrash('browser.click: ref=3 not found on the page.')).toBe(false);
    expect(isHarnessCrash('')).toBe(false);
  });
  it('excludes subprocess failures that merely ECHO a TypeError from the child program', () => {
    expect(isHarnessCrash('Command exited with code 1:\nTypeError: user script blew up')).toBe(false);
  });
});

describe('crashErrorType', () => {
  it('extracts the JS error type, or RuntimeError for a typeless "Cannot read…"', () => {
    expect(crashErrorType('TypeError: Cannot read properties of null')).toBe('TypeError');
    expect(crashErrorType('ReferenceError: __dirname is not defined')).toBe('ReferenceError');
    expect(crashErrorType('SEO audit error: Cannot read properties of undefined (reading \'x\')')).toBe('RuntimeError');
  });
});

describe('crashSignature', () => {
  it('drops the executor prefix and variable data but keeps the property name', () => {
    const sig = crashSignature('Error executing tool browser.navigate: TypeError: Cannot read properties of null (reading \'split\')');
    expect(sig).not.toContain('Error executing tool');
    expect(sig).toContain("reading 'split'"); // the code-site hint is preserved
  });
  it('normalizes paths and numbers so the same bug groups together', () => {
    const a = crashSignature('Error executing tool x: TypeError: bad at /root/a/b.ts:12');
    const b = crashSignature('Error executing tool x: TypeError: bad at /root/c/d.ts:99');
    expect(a).toBe(b);
  });
});

describe('mineHarnessBugs', () => {
  const row = (tool: string, msg: string, at: string): HarnessBugRow => ({ tool_name: tool, error_message: msg, created_at: at });
  it('groups crashes by (tool, signature), counts, tracks first/last, sorts by count', () => {
    const rows = [
      row('browser.navigate', "TypeError: Cannot read properties of null (reading 'split')", '2026-07-01'),
      row('browser.navigate', "TypeError: Cannot read properties of null (reading 'split')", '2026-07-03'),
      row('coder.read-file', 'ReferenceError: __dirname is not defined', '2026-07-02'),
      row('system.exec', 'Refused: shell metacharacters are not allowed', '2026-07-02'), // not a crash
      row('system.exec', 'Command exited with code 1:\nTypeError: child', '2026-07-02'), // excluded
    ];
    const bugs = mineHarnessBugs(rows);
    expect(bugs).toHaveLength(2); // navigate (2) + read-file (1); the two exec rows dropped
    expect(bugs[0]!.tool).toBe('browser.navigate');
    expect(bugs[0]!.count).toBe(2);
    expect(bugs[0]!.firstSeen).toBe('2026-07-01');
    expect(bugs[0]!.lastSeen).toBe('2026-07-03');
    expect(bugs[1]!.tool).toBe('coder.read-file');
    expect(bugs[1]!.errorType).toBe('ReferenceError');
  });
  it('minCount filters singletons when asked', () => {
    const rows = [row('a', 'TypeError: x', '2026-07-01')];
    expect(mineHarnessBugs(rows, 2)).toHaveLength(0);
  });
});
