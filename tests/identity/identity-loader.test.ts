/**
 * @file tests/identity/identity-loader.test.ts
 * @description Unit tests for the identity loader factory.
 *
 * Each test uses an isolated tmpdir so there is no cross-test state.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createIdentityLoader } from '../../src/core/identity/loader.js';
import type { IdentityLoaderInstance } from '../../src/core/identity/loader.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'identity-test-'));
}

function writeFile(dir: string, name: string, content: string): void {
  fs.writeFileSync(path.join(dir, name), content, 'utf-8');
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('createIdentityLoader', () => {
  let configDir: string;
  let loader: IdentityLoaderInstance;

  beforeEach(() => {
    configDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  // 1. All-null anchor when configDir is empty (no files present).
  it('returns all-null anchor when configDir contains no config files', () => {
    loader = createIdentityLoader(configDir);
    expect(loader.anchor.identity).toBeNull();
    expect(loader.anchor.values).toBeNull();
    expect(loader.anchor.prohibitions).toBeNull();
  });

  // 2. verify() always returns ok:true — even when prohibitions match.
  it('verify() always returns ok:true', () => {
    writeFile(configDir, 'hard-prohibitions.yaml', '- forbidden_tool\n- another_tool\n');
    loader = createIdentityLoader(configDir);

    const matchResult = loader.verify(
      { name: 'forbidden_tool', arguments: {} },
      { sessionId: 'sess-001', actor: 'test' },
    );
    expect(matchResult.ok).toBe(true);

    const noMatchResult = loader.verify(
      { name: 'safe_tool', arguments: {} },
      { sessionId: 'sess-001' },
    );
    expect(noMatchResult.ok).toBe(true);
  });

  // 3. Valid core-identity.md → non-null string.
  it('loads core-identity.md as a non-null string when file is valid', () => {
    writeFile(configDir, 'core-identity.md', '# Identity\nYou are an operator agent.\n');
    loader = createIdentityLoader(configDir);
    expect(typeof loader.anchor.identity).toBe('string');
    expect(loader.anchor.identity).toContain('Identity');
  });

  // 4. Valid values.json → non-null object.
  it('loads values.json as a non-null object when file is valid JSON object', () => {
    writeFile(configDir, 'values.json', '{"priority": "speed", "tone": "formal"}');
    loader = createIdentityLoader(configDir);
    expect(loader.anchor.values).not.toBeNull();
    expect(typeof loader.anchor.values).toBe('object');
    expect((loader.anchor.values as Record<string, unknown>)['priority']).toBe('speed');
  });

  // 5. Array root in values.json → null (must be a plain object).
  it('returns null values when values.json root is an array', () => {
    writeFile(configDir, 'values.json', '["a", "b", "c"]');
    loader = createIdentityLoader(configDir);
    expect(loader.anchor.values).toBeNull();
  });

  // 6. Valid hard-prohibitions.yaml → non-null string[].
  it('loads hard-prohibitions.yaml as a string array when valid', () => {
    writeFile(configDir, 'hard-prohibitions.yaml', '- shell_exec\n- file_delete\n');
    loader = createIdentityLoader(configDir);
    expect(Array.isArray(loader.anchor.prohibitions)).toBe(true);
    expect(loader.anchor.prohibitions).toContain('shell_exec');
    expect(loader.anchor.prohibitions).toContain('file_delete');
  });

  // 7. Non-array YAML (scalar or map) → null.
  it('returns null prohibitions when YAML is not an array of strings', () => {
    writeFile(configDir, 'hard-prohibitions.yaml', 'key: value\nanother: mapping\n');
    loader = createIdentityLoader(configDir);
    expect(loader.anchor.prohibitions).toBeNull();
  });

  // 8. Empty file → null (no crash).
  it('returns null identity when core-identity.md is empty', () => {
    writeFile(configDir, 'core-identity.md', '   \n  \n  ');
    loader = createIdentityLoader(configDir);
    expect(loader.anchor.identity).toBeNull();
  });

  // 9. Malformed YAML → null (no throw).
  it('returns null prohibitions when hard-prohibitions.yaml is malformed YAML', () => {
    writeFile(configDir, 'hard-prohibitions.yaml', '- valid\n  bad_indent_causing_error: [\n');
    expect(() => {
      loader = createIdentityLoader(configDir);
    }).not.toThrow();
    expect(loader.anchor.prohibitions).toBeNull();
  });

  // 10. NUL byte in identity file → null (no crash).
  it('returns null identity when core-identity.md contains a NUL byte', () => {
    const nulContent = 'Identity content\x00with NUL byte';
    fs.writeFileSync(path.join(configDir, 'core-identity.md'), nulContent, 'utf-8');
    expect(() => {
      loader = createIdentityLoader(configDir);
    }).not.toThrow();
    expect(loader.anchor.identity).toBeNull();
  });

  // 11. verify() returns advisory when tool name is in prohibitions list.
  it('verify() includes advisory string when tool is in prohibitions list', () => {
    writeFile(configDir, 'hard-prohibitions.yaml', '- blocked_op\n');
    loader = createIdentityLoader(configDir);

    const result = loader.verify(
      { name: 'blocked_op' },
      { sessionId: 'sess-002' },
    );
    expect(result.ok).toBe(true);
    expect(result.advisory).toBeDefined();
    expect(result.advisory).toContain('blocked_op');
  });

  // 12. verify() returns no advisory when tool is NOT in prohibitions list.
  it('verify() has no advisory when tool is not in prohibitions list', () => {
    writeFile(configDir, 'hard-prohibitions.yaml', '- other_tool\n');
    loader = createIdentityLoader(configDir);

    const result = loader.verify(
      { name: 'allowed_tool' },
      { sessionId: 'sess-003' },
    );
    expect(result.ok).toBe(true);
    expect(result.advisory).toBeUndefined();
  });

  // 13. Accepts optional auditTrail without crashing.
  it('constructs without error when auditTrail parameter is passed', () => {
    const fakeAuditTrail = {} as import('../../src/core/security/audit-trail.js').AuditTrail;
    expect(() => {
      loader = createIdentityLoader(configDir, fakeAuditTrail);
    }).not.toThrow();
    expect(loader.anchor.identity).toBeNull();
  });

  // 14. Malformed JSON in values.json → null (no throw).
  it('returns null values when values.json contains malformed JSON', () => {
    writeFile(configDir, 'values.json', '{ broken json ::: }');
    expect(() => {
      loader = createIdentityLoader(configDir);
    }).not.toThrow();
    expect(loader.anchor.values).toBeNull();
  });
});
