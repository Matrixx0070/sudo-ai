/**
 * @file chat-warning-filter.test.ts
 * @description The TUI's narrow suppression of an upstream Ink/React dev-build
 * artifact. The contract that matters: it drops ONLY warnings whose reported key
 * is a stack frame — a genuine duplicate-key bug in our own components still
 * reaches stderr loudly.
 */

import { describe, it, expect, vi } from 'vitest';
import { isSpuriousDuplicateKeyWarning, installWarningFilter } from '../../src/cli/commands/chat-warning-filter.js';

const ARTIFACT =
  'Encountered two children with the same key, `    at recursivelyTraversePassiveMountEffects ' +
  '(/x/node_modules/react-reconciler/cjs/react-reconciler.development.js:12934:11)`. Keys should be unique';
const REAL_BUG =
  'Encountered two children with the same key, `msg-42`. Keys should be unique so that components maintain their identity';

describe('isSpuriousDuplicateKeyWarning', () => {
  it('recognises the upstream artifact (key is a stack frame)', () => {
    expect(isSpuriousDuplicateKeyWarning(ARTIFACT)).toBe(true);
  });

  it('does NOT match a real duplicate-key bug in our components', () => {
    expect(isSpuriousDuplicateKeyWarning(REAL_BUG)).toBe(false);
  });

  it('ignores unrelated stderr', () => {
    expect(isSpuriousDuplicateKeyWarning('some other warning')).toBe(false);
    expect(isSpuriousDuplicateKeyWarning('')).toBe(false);
  });
});

describe('installWarningFilter', () => {
  function fakeStream(): { stream: NodeJS.WriteStream; written: string[] } {
    const written: string[] = [];
    const stream = { write: (c: unknown) => { written.push(String(c)); return true; } } as unknown as NodeJS.WriteStream;
    return { stream, written };
  }

  it('swallows the artifact but passes everything else through', () => {
    const { stream, written } = fakeStream();
    const restore = installWarningFilter(stream);
    stream.write(ARTIFACT);
    stream.write(REAL_BUG);
    stream.write('ordinary log line');
    restore();
    expect(written).not.toContain(ARTIFACT);
    expect(written).toContain(REAL_BUG);      // a real bug still surfaces
    expect(written).toContain('ordinary log line');
  });

  it('restore() puts the original write back', () => {
    const { stream } = fakeStream();
    const before = stream.write;
    const restore = installWarningFilter(stream);
    expect(stream.write).not.toBe(before);
    restore();
    expect(stream.write).toBe(before);
  });

  it('passes non-string chunks (Buffers) straight through', () => {
    const { stream, written } = fakeStream();
    const restore = installWarningFilter(stream);
    stream.write(Buffer.from('binary-ish'));
    restore();
    expect(written).toHaveLength(1);
  });
});
