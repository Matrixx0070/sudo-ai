/**
 * @file brain-tool-call-repair.test.ts
 * @description Proves the JSON-repair layer is WIRED into Brain's weak-model
 * tool-call fallback parsers (not just unit-tested in isolation). A malformed
 * <tool_call> / {"tool_calls":[…]} block that previously got silently dropped —
 * stranding the model into a retry loop — is now repaired into a usable call.
 * SUDO_JSON_REPAIR=0 restores the old drop-on-malformed behavior.
 *
 * The parsers are private; we reflect into them for a focused wiring test
 * (TypeScript `private` is compile-time only). They consult the GLOBAL
 * ToolRegistry for the injection-guard allowlist, so we seed it with one tool.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Brain } from '../../src/core/brain/brain.js';
import { ToolRegistry } from '../../src/core/tools/registry.js';
import type { ToolDefinition } from '../../src/core/tools/types.js';

type ParsedCall = { name: string; arguments: Record<string, unknown> };
type ParseFn = (text: string) => ParsedCall[];

function seedRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  const tool: ToolDefinition = {
    name: 'web.fetch',
    description: 'fetch a url',
    category: 'research',
    parameters: { url: { type: 'string', description: 'url', required: true } },
    execute: async () => ({ success: true, output: 'ok' }),
  };
  reg.register(tool);
  return reg;
}

describe('brain tool-call fallback — JSON repair wiring', () => {
  let prevGlobal: ToolRegistry | null;
  let brain: Brain;

  beforeEach(() => {
    prevGlobal = ToolRegistry.getGlobal();
    ToolRegistry.setGlobal(seedRegistry());
    brain = new Brain({});
    delete process.env['SUDO_JSON_REPAIR'];
  });
  afterEach(() => {
    if (prevGlobal) ToolRegistry.setGlobal(prevGlobal);
    delete process.env['SUDO_JSON_REPAIR'];
  });

  const parseText = (): ParseFn =>
    (brain as unknown as { _parseTextToolCalls: ParseFn })._parseTextToolCalls.bind(brain);
  const parseJson = (): ParseFn =>
    (brain as unknown as { _parseJsonToolCalls: ParseFn })._parseJsonToolCalls.bind(brain);

  it('recovers a malformed <tool_call> block (single quotes + trailing comma)', () => {
    const calls = parseText()(
      `<tool_call>{'name': 'web.fetch', 'arguments': {'url': 'http://x'},}</tool_call>`,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe('web.fetch');
    expect(calls[0]?.arguments).toEqual({ url: 'http://x' });
  });

  it('still parses a well-formed <tool_call> block (no-regression)', () => {
    const calls = parseText()(
      `<tool_call>{"name":"web.fetch","arguments":{"url":"http://z"}}</tool_call>`,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.arguments).toEqual({ url: 'http://z' });
  });

  it('SUDO_JSON_REPAIR=0 restores drop-on-malformed (call is dropped)', () => {
    process.env['SUDO_JSON_REPAIR'] = '0';
    const calls = parseText()(`<tool_call>{'name':'web.fetch'}</tool_call>`);
    expect(calls).toHaveLength(0);
  });

  it('recovers a tool call from a {"tool_calls":[…]} block', () => {
    const calls = parseJson()(
      `{"tool_calls": [{"name": "web.fetch", "arguments": {"url": "http://y"}}]}`,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe('web.fetch');
    expect(calls[0]?.arguments).toEqual({ url: 'http://y' });
  });

  it('injection guard still drops unknown tool names even after repair', () => {
    const calls = parseText()(`<tool_call>{'name':'evil.exfiltrate','arguments':{}}</tool_call>`);
    expect(calls).toHaveLength(0);
  });
});
