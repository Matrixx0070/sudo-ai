/**
 * @file tests/federation/federation-error-sanitizer.test.ts
 * @description Federation error sanitizer unit tests — Wave 2.
 *
 * Tests:
 *   SAN-1  sanitizeErrorReport: valid input passes through cleaned
 *   SAN-2  errorSignature: long string truncated, path stripped, IP stripped
 *   SAN-3  stackTrace: oversized truncated at newline boundary, secrets redacted
 *   SAN-4  botVersion: invalid semver → defaults to '0.0.0'
 *   SAN-5  peerId: invalid chars → throws
 *   SAN-6  severity: invalid value → defaults to 'MEDIUM'
 *   SAN-7  meta: oversized → throws, dangerous keys → stripped
 *   SAN-8  redactSecrets: API key redacted
 *   SAN-9  redactSecrets: Bearer token redacted
 *   SAN-10 redactSecrets: connection string redacted
 *   SAN-11 redactSecrets: password in URL redacted
 *   SAN-12 redactSecrets: AWS key redacted
 *   SAN-13 capStackTrace: exact boundary test, empty string, no-newline string
 *   SAN-14 null byte stripping in all string fields
 *   SAN-15 Non-object input → throws
 */

import { describe, it, expect } from 'vitest';
import {
  sanitizeErrorReport,
  capStackTrace,
  redactSecrets,
  MAX_BODY_BYTES,
  type SanitizedErrorReport,
} from '../../src/core/federation/federation-error-sanitizer.js';

// ---------------------------------------------------------------------------
// SAN-1: Valid input passes through cleaned
// ---------------------------------------------------------------------------
describe('sanitizeErrorReport — valid input', () => {
  it('SAN-1: valid input passes through cleaned', () => {
    const input = {
      errorSignature: 'TestError: something went wrong',
      stackTrace: 'Error: TestError\n    at foo (bar.ts:10:5)',
      botVersion: '1.2.3',
      peerId: 'peer-a',
      timestamp: 1234567890,
      severity: 'HIGH',
      toolName: 'test-tool',
      sessionId: 'session-123',
      phase: 'Phase1',
      meta: { key1: 'value1', key2: 42 },
    };

    const result = sanitizeErrorReport(input);

    expect(result.errorSignature).toBe('TestError: something went wrong');
    expect(result.stackTrace).toBe('Error: TestError\n    at foo (bar.ts:10:5)');
    expect(result.botVersion).toBe('1.2.3');
    expect(result.peerId).toBe('peer-a');
    expect(result.timestamp).toBe(1234567890);
    expect(result.severity).toBe('HIGH');
    expect(result.toolName).toBe('test-tool');
    expect(result.sessionId).toBe('session-123');
    expect(result.phase).toBe('Phase1');
    expect(result.meta).toEqual({ key1: 'value1', key2: 42 });
  });

  it('SAN-1b: minimal valid input (required fields only)', () => {
    const input = {
      errorSignature: 'Error',
      botVersion: '0.0.1',
      peerId: 'test-peer',
      timestamp: Date.now(),
    };

    const result = sanitizeErrorReport(input);

    expect(result.errorSignature).toBe('Error');
    expect(result.stackTrace).toBeUndefined();
    expect(result.botVersion).toBe('0.0.1');
    expect(result.peerId).toBe('test-peer');
    expect(result.severity).toBe('MEDIUM'); // default
    expect(result.toolName).toBeUndefined();
    expect(result.sessionId).toBeUndefined();
    expect(result.phase).toBeUndefined();
    expect(result.meta).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// SAN-2: errorSignature processing
// ---------------------------------------------------------------------------
describe('sanitizeErrorReport — errorSignature processing', () => {
  it('SAN-2a: long string truncated to 500 chars', () => {
    const longSig = 'A'.repeat(600);
    const input = {
      errorSignature: longSig,
      botVersion: '1.0.0',
      peerId: 'peer-a',
      timestamp: 1234567890,
    };

    const result = sanitizeErrorReport(input);

    expect(result.errorSignature.length).toBe(500);
    expect(result.errorSignature).toBe('A'.repeat(500));
  });

  it('SAN-2b: file path stripped to filename only', () => {
    const input = {
      errorSignature: 'Error at /home/user/app/src/core/federation/handler.ts:42:10',
      botVersion: '1.0.0',
      peerId: 'peer-a',
      timestamp: 1234567890,
    };

    const result = sanitizeErrorReport(input);

    expect(result.errorSignature).toContain('handler.ts');
    expect(result.errorSignature).not.toContain('/home/user/app/src/core/federation/');
  });

  it('SAN-2c: IP address stripped to [IP]', () => {
    const input = {
      errorSignature: 'Connection failed to 192.168.1.100:8080',
      botVersion: '1.0.0',
      peerId: 'peer-a',
      timestamp: 1234567890,
    };

    const result = sanitizeErrorReport(input);

    expect(result.errorSignature).toContain('[IP]');
    expect(result.errorSignature).not.toContain('192.168.1.100');
  });
});

// ---------------------------------------------------------------------------
// SAN-3: stackTrace processing
// ---------------------------------------------------------------------------
describe('sanitizeErrorReport — stackTrace processing', () => {
  it('SAN-3a: oversized stack truncated at newline boundary', () => {
    const longStack = 'Line 1\n'.repeat(1000); // Way over 8KB
    const input = {
      errorSignature: 'Error',
      botVersion: '1.0.0',
      peerId: 'peer-a',
      timestamp: 1234567890,
      stackTrace: longStack,
    };

    const result = sanitizeErrorReport(input);

    expect(result.stackTrace).toBeDefined();
    expect(result.stackTrace!.length).toBeLessThanOrEqual(8192);
    // Should end at a newline boundary (or be empty if truncated before first newline)
    expect(result.stackTrace!.endsWith('\n') || result.stackTrace!.length === 8192).toBe(true);
  });

  it('SAN-3b: stack trace secrets redacted', () => {
    const stackWithSecrets = `Error: Test
    at handler (api_key=sk_live_abc1234567890xyz.ts:10:5)
    at Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ0.test
    at mongodb://user:pass@localhost:27017/db`;

    const input = {
      errorSignature: 'Error',
      botVersion: '1.0.0',
      peerId: 'peer-a',
      timestamp: 1234567890,
      stackTrace: stackWithSecrets,
    };

    const result = sanitizeErrorReport(input);

    expect(result.stackTrace).not.toContain('sk_live_abc1234567890xyz');
    expect(result.stackTrace).toContain('[REDACTED]');
    expect(result.stackTrace).not.toContain('Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ0');
    expect(result.stackTrace).not.toContain('mongodb://');
  });

  it('SAN-3c: stack trace file paths stripped to filename', () => {
    const stackWithPath = `Error: Test
    at /root/sudo-ai-v4/src/core/handler.ts:42:10
    at /home/user/app/src/foo/bar.ts:20:5`;

    const input = {
      errorSignature: 'Error',
      botVersion: '1.0.0',
      peerId: 'peer-a',
      timestamp: 1234567890,
      stackTrace: stackWithPath,
    };

    const result = sanitizeErrorReport(input);

    expect(result.stackTrace).toContain('handler.ts');
    expect(result.stackTrace).toContain('bar.ts');
    expect(result.stackTrace).not.toContain('/root/sudo-ai-v4/');
    expect(result.stackTrace).not.toContain('/home/user/app/');
  });

  it('SAN-3d: stack trace backticks replaced', () => {
    const stackWithBackticks = `Error in \`functionName\`
    at \`arrowFn\` () => {}`;

    const input = {
      errorSignature: 'Error',
      botVersion: '1.0.0',
      peerId: 'peer-a',
      timestamp: 1234567890,
      stackTrace: stackWithBackticks,
    };

    const result = sanitizeErrorReport(input);

    expect(result.stackTrace).not.toContain('`');
    expect(result.stackTrace).toContain("'");
  });

  it('SAN-3e: stack trace IPv6 private addresses redacted', () => {
    const stackWithIPv6 = `Connection failed
    at fe80::1:8080
    at fd12:3456::1:3000
    at ::1:2000`;

    const input = {
      errorSignature: 'Error',
      botVersion: '1.0.0',
      peerId: 'peer-a',
      timestamp: 1234567890,
      stackTrace: stackWithIPv6,
    };

    const result = sanitizeErrorReport(input);

    expect(result.stackTrace).not.toContain('fe80::');
    expect(result.stackTrace).not.toContain('fd12:');
    expect(result.stackTrace).not.toContain('::1');
    expect(result.stackTrace).toContain('[IPV6]');
  });
});

// ---------------------------------------------------------------------------
// SAN-4: botVersion validation
// ---------------------------------------------------------------------------
describe('sanitizeErrorReport — botVersion validation', () => {
  it('SAN-4a: invalid semver → defaults to 0.0.0', () => {
    const input = {
      errorSignature: 'Error',
      botVersion: 'not-semver',
      peerId: 'peer-a',
      timestamp: 1234567890,
    };

    const result = sanitizeErrorReport(input);

    expect(result.botVersion).toBe('0.0.0');
  });

  it('SAN-4b: partial semver accepted (matches prefix)', () => {
    const input = {
      errorSignature: 'Error',
      botVersion: '2.1.0-beta.1',
      peerId: 'peer-a',
      timestamp: 1234567890,
    };

    const result = sanitizeErrorReport(input);

    expect(result.botVersion).toBe('2.1.0');
  });

  it('SAN-4c: valid semver passes through', () => {
    const input = {
      errorSignature: 'Error',
      botVersion: '3.2.1',
      peerId: 'peer-a',
      timestamp: 1234567890,
    };

    const result = sanitizeErrorReport(input);

    expect(result.botVersion).toBe('3.2.1');
  });
});

// ---------------------------------------------------------------------------
// SAN-5: peerId validation
// ---------------------------------------------------------------------------
describe('sanitizeErrorReport — peerId validation', () => {
  it('SAN-5a: invalid chars → throws', () => {
    const input = {
      errorSignature: 'Error',
      botVersion: '1.0.0',
      peerId: 'peer@invalid!',
      timestamp: 1234567890,
    };

    expect(() => sanitizeErrorReport(input)).toThrow('peerId must match');
  });

  it('SAN-5b: too long peerId → throws', () => {
    const input = {
      errorSignature: 'Error',
      botVersion: '1.0.0',
      peerId: 'a'.repeat(65),
      timestamp: 1234567890,
    };

    expect(() => sanitizeErrorReport(input)).toThrow('peerId must match');
  });

  it('SAN-5b: valid peerId passes (alphanumeric, underscore, hyphen)', () => {
    const input = {
      errorSignature: 'Error',
      botVersion: '1.0.0',
      peerId: 'peer-a_123',
      timestamp: 1234567890,
    };

    const result = sanitizeErrorReport(input);

    expect(result.peerId).toBe('peer-a_123');
  });
});

// ---------------------------------------------------------------------------
// SAN-6: severity validation
// ---------------------------------------------------------------------------
describe('sanitizeErrorReport — severity validation', () => {
  it('SAN-6a: invalid severity → defaults to MEDIUM', () => {
    const input = {
      errorSignature: 'Error',
      botVersion: '1.0.0',
      peerId: 'peer-a',
      timestamp: 1234567890,
      severity: 'INVALID',
    };

    const result = sanitizeErrorReport(input);

    expect(result.severity).toBe('MEDIUM');
  });

  it('SAN-6b: missing severity → defaults to MEDIUM', () => {
    const input = {
      errorSignature: 'Error',
      botVersion: '1.0.0',
      peerId: 'peer-a',
      timestamp: 1234567890,
    };

    const result = sanitizeErrorReport(input);

    expect(result.severity).toBe('MEDIUM');
  });

  it('SAN-6c: valid severity passes through', () => {
    const input = {
      errorSignature: 'Error',
      botVersion: '1.0.0',
      peerId: 'peer-a',
      timestamp: 1234567890,
      severity: 'CRITICAL',
    };

    const result = sanitizeErrorReport(input);

    expect(result.severity).toBe('CRITICAL');
  });
});

// ---------------------------------------------------------------------------
// SAN-7: meta field processing
// ---------------------------------------------------------------------------
describe('sanitizeErrorReport — meta field processing', () => {
  it('SAN-7a: oversized meta → throws', () => {
    const input = {
      errorSignature: 'Error',
      botVersion: '1.0.0',
      peerId: 'peer-a',
      timestamp: 1234567890,
      meta: { largeValue: 'x'.repeat(2000) },
    };

    expect(() => sanitizeErrorReport(input)).toThrow('meta exceeds');
  });

  it('SAN-7b: dangerous keys stripped', () => {
    const input = {
      errorSignature: 'Error',
      botVersion: '1.0.0',
      peerId: 'peer-a',
      timestamp: 1234567890,
      meta: {
        safeKey: 'safe value',
        code: 'malicious code',
        script: '<script>alert(1)</script>',
        eval: 'eval(this)',
        exec: 'exec command',
        command: 'rm -rf /',
      },
    };

    const result = sanitizeErrorReport(input);

    expect(result.meta).toBeDefined();
    expect(result.meta!.safeKey).toBe('safe value');
    expect(result.meta!.code).toBeUndefined();
    expect(result.meta!.script).toBeUndefined();
    expect(result.meta!.eval).toBeUndefined();
    expect(result.meta!.exec).toBeUndefined();
    expect(result.meta!.command).toBeUndefined();
  });

  it('SAN-7c: valid meta passes through', () => {
    const input = {
      errorSignature: 'Error',
      botVersion: '1.0.0',
      peerId: 'peer-a',
      timestamp: 1234567890,
      meta: { userId: '123', action: 'test', count: 5 },
    };

    const result = sanitizeErrorReport(input);

    expect(result.meta).toEqual({ userId: '123', action: 'test', count: 5 });
  });
});

// ---------------------------------------------------------------------------
// SAN-8 to SAN-12: redactSecrets tests
// ---------------------------------------------------------------------------
describe('redactSecrets', () => {
  it('SAN-8: API key redacted', () => {
    const input = 'Failed with api_key=sk_live_abc1234567890xyz';
    const result = redactSecrets(input);
    expect(result).not.toContain('sk_live_abc1234567890xyz');
    expect(result).toContain('[REDACTED]');
  });

  it('SAN-9: Bearer token redacted', () => {
    const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ0.abc123';
    const result = redactSecrets(input);
    expect(result).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ0');
    expect(result).toContain('[REDACTED]');
  });

  it('SAN-10: connection string redacted', () => {
    const input = 'Connection: mongodb://user:pass@localhost:27017/mydb';
    const result = redactSecrets(input);
    expect(result).not.toContain('mongodb://');
    expect(result).toContain('[REDACTED]');
  });

  it('SAN-11: password in URL redacted', () => {
    const input = 'URL: https://admin:secretpass123@api.example.com/endpoint';
    const result = redactSecrets(input);
    expect(result).toContain(':[REDACTED]@');
    expect(result).not.toContain('secretpass123');
  });

  it('SAN-12: AWS key redacted', () => {
    const input = 'AWS Access Key: AKIAIOSFODNN7EXAMPLE';
    const result = redactSecrets(input);
    expect(result).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(result).toContain('[REDACTED]');
  });

  it('SAN-12b: multiple secrets in one string all redacted', () => {
    const input = 'Key: sk_test_12345678 and Bearer token123.abc';
    const result = redactSecrets(input);
    expect(result).not.toContain('sk_test_12345678');
    expect(result).not.toContain('token123.abc');
    expect((result.match(/\[REDACTED\]/g) || []).length).toBeGreaterThanOrEqual(1);
  });

  it('SAN-12c: IPv6 private addresses redacted', () => {
    // Link-local fe80::/10
    expect(redactSecrets('fe80::1')).toContain('[IPV6]');
    expect(redactSecrets('fe80::1')).not.toContain('fe80::1');
    expect(redactSecrets('fea0::abcd')).toContain('[IPV6]');
    expect(redactSecrets('feb0::1')).toContain('[IPV6]');
    expect(redactSecrets('febb::1')).toContain('[IPV6]');

    // ULA fc00::/7 (fc and fd prefixes)
    expect(redactSecrets('fc00::1')).toContain('[IPV6]');
    expect(redactSecrets('fc00::1')).not.toContain('fc00::1');
    expect(redactSecrets('fd12:3456::1')).toContain('[IPV6]');
    expect(redactSecrets('fd00::abcd')).toContain('[IPV6]');

    // Localhost
    expect(redactSecrets('::1')).toContain('[IPV6]');
    expect(redactSecrets('::1')).not.toContain('::1');
  });

  it('SAN-12d: IPv6 in stack trace redacted', () => {
    const input = 'Connection failed to fe80::1:8080 and fd12:3456::1:3000';
    const result = redactSecrets(input);
    expect(result).not.toContain('fe80::');
    expect(result).not.toContain('fd12:');
    expect(result).toContain('[IPV6]');
  });

  it('SAN-12e: IPv6 link-local fe80::1 fully redacted (not [IPV6]:1)', () => {
    const input = 'Connection to fe80::1 failed';
    const result = redactSecrets(input);
    expect(result).toContain('[IPV6]');
    expect(result).not.toContain('fe80::1');
    expect(result).not.toContain('[IPV6]:1'); // Should NOT leave :1 exposed
  });

  it('SAN-12f: IPv6 public address 2001:db8::1 NOT redacted', () => {
    const input = 'Connection to 2001:db8::1 failed';
    const result = redactSecrets(input);
    expect(result).toContain('2001:db8::1'); // Public IP should NOT be redacted
    expect(result).not.toContain('[IPV6]');
  });

  it('SAN-12g: IPv6 ULA fc00:1234:5678::1 fully redacted', () => {
    const input = 'Connection to fc00:1234:5678::1 failed';
    const result = redactSecrets(input);
    expect(result).toContain('[IPV6]');
    expect(result).not.toContain('fc00:1234:5678::1');
  });

  it('SAN-12h: IPv6 localhost ::1 redacted', () => {
    const input = 'Connection to ::1:8080 failed';
    const result = redactSecrets(input);
    expect(result).toContain('[IPV6]');
    expect(result).not.toContain('::1');
  });

  it('SAN-12i: IPv6 full forms redacted correctly', () => {
    // Full form link-local
    expect(redactSecrets('fe80:0000:0000:0000:0000:0000:0000:0001')).toContain('[IPV6]');
    expect(redactSecrets('fe80:0000:0000:0000:0000:0000:0000:0001')).not.toContain('fe80');

    // Full form ULA
    expect(redactSecrets('fd12:3456:7890:abcd::1')).toContain('[IPV6]');
    expect(redactSecrets('fd12:3456:7890:abcd::1')).not.toContain('fd12');

    // Mixed case
    expect(redactSecrets('FE80::1')).toContain('[IPV6]');
    expect(redactSecrets('FC00::1')).toContain('[IPV6]');
  });

  it('SAN-12j: false positives - public IPv6 NOT redacted', () => {
    // 2001:db8::/32 is documentation range (public)
    expect(redactSecrets('2001:db8::1')).toBe('2001:db8::1');
    expect(redactSecrets('2001:db8::1')).not.toContain('[IPV6]');

    // 2001:4860:4860::8888 (Google DNS - public)
    expect(redactSecrets('2001:4860:4860::8888')).toBe('2001:4860:4860::8888');
    expect(redactSecrets('2001:4860:4860::8888')).not.toContain('[IPV6]');
  });
});

// ---------------------------------------------------------------------------
// SAN-13: capStackTrace tests
// ---------------------------------------------------------------------------
describe('capStackTrace', () => {
  it('SAN-13a: empty string returns empty', () => {
    expect(capStackTrace('')).toBe('');
  });

  it('SAN-13b: short stack passes through unchanged', () => {
    const shortStack = 'Error: Test\n    at foo (bar.ts:10:5)';
    const result = capStackTrace(shortStack, 100);
    expect(result).toBe(shortStack);
  });

  it('SAN-13c: long stack truncated at newline boundary', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `    at frame${i} (file${i}.ts:1:1)`);
    const longStack = `Error: Test\n${lines.join('\n')}`;

    const result = capStackTrace(longStack, 1000);

    expect(result.length).toBeLessThanOrEqual(1000);
    expect(result).not.toContain('frame199'); // Should be cut off
  });

  it('SAN-13d: no-newline string hard truncated', () => {
    const noNewline = 'A'.repeat(200);
    const result = capStackTrace(noNewline, 50);
    expect(result.length).toBe(50);
    expect(result).toBe('A'.repeat(50));
  });

  it('SAN-13e: secrets redacted in stack trace', () => {
    const stack = 'Error\n    at api_key=sk_test_1234567890abcdef.ts:1:1';
    const result = capStackTrace(stack, 1000);
    expect(result).not.toContain('sk_test_1234567890abcdef');
    expect(result).toContain('[REDACTED]');
  });

  it('SAN-13f: file paths stripped to filename only', () => {
    const stack = 'Error\n    at /root/sudo-ai-v4/src/core/foo/bar.ts:10:5\n    at /home/user/app/src/handler.ts:20:3';
    const result = capStackTrace(stack, 1000);
    expect(result).toContain('bar.ts');
    expect(result).toContain('handler.ts');
    expect(result).not.toContain('/root/sudo-ai-v4/src/core/foo/');
    expect(result).not.toContain('/home/user/app/src/');
  });

  it('SAN-13g: backticks replaced with apostrophes', () => {
    const stack = 'Error in `functionName` at line 10\n    at `arrowFn` ()';
    const result = capStackTrace(stack, 1000);
    expect(result).not.toContain('`');
    expect(result).toContain("'");
  });

  it('SAN-13h: IPv4 addresses redacted in stack trace', () => {
    const stack = 'Connection failed at 192.168.1.100:8080\n    at 10.0.0.1:3000';
    const result = capStackTrace(stack, 1000);
    expect(result).not.toContain('192.168.1.100');
    expect(result).not.toContain('10.0.0.1');
    expect(result).toContain('[IP]');
  });

  it('SAN-13i: IPv6 private addresses redacted in stack trace', () => {
    const stack = 'Connection failed at fe80::1:8080\n    at fd12:3456::1:3000\n    at ::1:2000';
    const result = capStackTrace(stack, 1000);
    expect(result).not.toContain('fe80::');
    expect(result).not.toContain('fd12:');
    expect(result).not.toContain('::1');
    expect(result).toContain('[IPV6]');
  });

  it('SAN-13j: full processing order (nulls, paths, backticks, secrets)', () => {
    const stack = 'Error\x00\n    at /root/sudo-ai-v4/src/core/api_key=sk_test_12345678.ts:10:5\n    at `badFunc`';
    const result = capStackTrace(stack, 1000);
    expect(result).not.toContain('\x00');
    expect(result).not.toContain('/root/sudo-ai-v4/');
    expect(result).toContain('[REDACTED].ts'); // secret redacted but extension kept
    expect(result).not.toContain('sk_test_12345678');
    expect(result).not.toContain('`');
    expect(result).toContain("'");
    expect(result).toContain('[REDACTED]');
  });
});

// ---------------------------------------------------------------------------
// SAN-14: Null byte stripping
// ---------------------------------------------------------------------------
describe('sanitizeErrorReport — null byte stripping', () => {
  it('SAN-14a: null bytes stripped from errorSignature', () => {
    const input = {
      errorSignature: 'Error\x00with\x00nulls',
      botVersion: '1.0.0',
      peerId: 'peer-a',
      timestamp: 1234567890,
    };

    const result = sanitizeErrorReport(input);

    expect(result.errorSignature).not.toContain('\x00');
    expect(result.errorSignature).toBe('Errorwithnulls');
  });

  it('SAN-14b: null bytes stripped from stackTrace', () => {
    const input = {
      errorSignature: 'Error',
      botVersion: '1.0.0',
      peerId: 'peer-a',
      timestamp: 1234567890,
      stackTrace: 'Line1\x00\nLine2\x00',
    };

    const result = sanitizeErrorReport(input);

    expect(result.stackTrace).not.toContain('\x00');
  });

  it('SAN-14c: null bytes stripped from optional string fields', () => {
    const input = {
      errorSignature: 'Error',
      botVersion: '1.0.0',
      peerId: 'peer-a',
      timestamp: 1234567890,
      toolName: 'tool\x00name',
      sessionId: 'session\x00id',
      phase: 'phase\x001',
    };

    const result = sanitizeErrorReport(input);

    expect(result.toolName).toBe('toolname');
    expect(result.sessionId).toBe('sessionid');
    expect(result.phase).toBe('phase1');
  });

  it('SAN-14d: null bytes stripped from meta string values', () => {
    const input = {
      errorSignature: 'Error',
      botVersion: '1.0.0',
      peerId: 'peer-a',
      timestamp: 1234567890,
      meta: { key1: 'value\x001', key2: 'value2\x00' },
    };

    const result = sanitizeErrorReport(input);

    expect(result.meta!.key1).toBe('value1');
    expect(result.meta!.key2).toBe('value2');
  });
});

// ---------------------------------------------------------------------------
// SAN-15: Non-object input throws
// ---------------------------------------------------------------------------
describe('sanitizeErrorReport — input validation', () => {
  it('SAN-15a: null input → throws', () => {
    expect(() => sanitizeErrorReport(null)).toThrow('must be a non-null object');
  });

  it('SAN-15b: undefined input → throws', () => {
    expect(() => sanitizeErrorReport(undefined)).toThrow('must be a non-null object');
  });

  it('SAN-15c: string input → throws', () => {
    expect(() => sanitizeErrorReport('error')).toThrow('must be a non-null object');
  });

  it('SAN-15d: number input → throws', () => {
    expect(() => sanitizeErrorReport(123)).toThrow('must be a non-null object');
  });

  it('SAN-15e: array input → throws', () => {
    expect(() => sanitizeErrorReport([])).toThrow('must be a non-null object');
  });

  it('SAN-15f: missing errorSignature → throws', () => {
    const input = {
      botVersion: '1.0.0',
      peerId: 'peer-a',
      timestamp: 1234567890,
    };

    expect(() => sanitizeErrorReport(input)).toThrow('errorSignature is required');
  });

  it('SAN-15g: missing botVersion → throws', () => {
    const input = {
      errorSignature: 'Error',
      peerId: 'peer-a',
      timestamp: 1234567890,
    };

    expect(() => sanitizeErrorReport(input)).toThrow('botVersion is required');
  });

  it('SAN-15h: missing peerId → throws', () => {
    const input = {
      errorSignature: 'Error',
      botVersion: '1.0.0',
      timestamp: 1234567890,
    };

    expect(() => sanitizeErrorReport(input)).toThrow('peerId is required');
  });

  it('SAN-15i: missing timestamp → throws', () => {
    const input = {
      errorSignature: 'Error',
      botVersion: '1.0.0',
      peerId: 'peer-a',
    };

    expect(() => sanitizeErrorReport(input)).toThrow('timestamp is required');
  });

  it('SAN-15j: NaN timestamp → throws', () => {
    const input = {
      errorSignature: 'Error',
      botVersion: '1.0.0',
      peerId: 'peer-a',
      timestamp: NaN,
    };

    expect(() => sanitizeErrorReport(input)).toThrow('timestamp is required');
  });
});

// ---------------------------------------------------------------------------
// Export constant test
// ---------------------------------------------------------------------------
describe('federation-error-sanitizer exports', () => {
  it('MAX_BODY_BYTES is 65536 (64KB)', () => {
    expect(MAX_BODY_BYTES).toBe(65536);
  });
});
