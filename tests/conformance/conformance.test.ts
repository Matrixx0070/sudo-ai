/**
 * @file tests/conformance/conformance.test.ts
 * @description Golden-matrix conformance suite for the LLM gateway adapters
 * (gw-refactor Phase 6). Every case in tests/conformance/harness.ts is run
 * against its adapter and the output is deep-compared (stable-stringified,
 * sorted keys) to the committed golden at
 * tests/conformance/goldens/<adapter>/<case>.json.
 *
 * - Missing/stale goldens: run `pnpm conformance:update` (CONFORMANCE_UPDATE=1).
 * - Targeted invariants that a golden alone cannot pin (round-trip byte
 *   fidelity, token-estimate window, stream single-use) are asserted below
 *   the matrix.
 */

import { describe, it, expect } from 'vitest';
import {
  ADAPTER_MATRIX,
  IR_CASES,
  RICH_TOOL_SCHEMA,
  CONTEXT_SENTINEL,
  UPDATE_MODE,
  renderGolden,
  readGolden,
  writeGolden,
  goldenPath,
  egressOpenAI,
  egressAnthropic,
  ingressOpenAI,
  streamIR,
  estimateTokens,
  type IRRequest,
} from './harness.js';

// ---------------------------------------------------------------------------
// The golden matrix
// ---------------------------------------------------------------------------

for (const [adapter, cases] of Object.entries(ADAPTER_MATRIX)) {
  describe(`conformance: ${adapter}`, () => {
    for (const c of cases) {
      it(`golden: ${c.name}`, async () => {
        const output = await c.produce();
        const rendered = renderGolden(output);

        if (UPDATE_MODE) {
          writeGolden(adapter, c.name, output);
          return;
        }

        const golden = readGolden(adapter, c.name);
        expect(
          golden,
          `missing golden ${goldenPath(adapter, c.name)} — run pnpm conformance:update`,
        ).toBeDefined();
        expect(
          rendered,
          `output diverged from golden ${goldenPath(adapter, c.name)} — if the change is intentional, run pnpm conformance:update and review the diff`,
        ).toBe(golden as string);
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Targeted invariants (not expressible as a golden alone)
// ---------------------------------------------------------------------------

function irCase(name: string): IRRequest {
  const c = IR_CASES.find((x) => x.name === name);
  if (!c) throw new Error(`IR case not found: ${name}`);
  return c.ir;
}

describe('conformance: tool-schema fidelity (ingress→egress round trip)', () => {
  it('rich JSON Schema survives byte-exact through egress-openai → ingress-openai', () => {
    const original = JSON.stringify(RICH_TOOL_SCHEMA);
    const body = egressOpenAI(irCase('tool-schema-fidelity'));
    const back = ingressOpenAI(body, { caller: 'conformance', purpose: 'round-trip', trace_id: 't' });
    expect(back.tools).toBeDefined();
    expect(back.tools).toHaveLength(1);
    expect(JSON.stringify(back.tools![0]!.input_schema)).toBe(original);
    expect(back.tools![0]!.name).toBe('create_event');
    expect(back.tools![0]!.description).toBe('Create a calendar event.');
  });

  it('rich JSON Schema survives byte-exact into the anthropic egress body', () => {
    const original = JSON.stringify(RICH_TOOL_SCHEMA);
    const body = egressAnthropic(irCase('tool-schema-fidelity'));
    const tools = body['tools'] as Array<Record<string, unknown>>;
    expect(Array.isArray(tools)).toBe(true);
    expect(JSON.stringify(tools[0]!['input_schema'])).toBe(original);
  });
});

describe('conformance: 100k-context mock', () => {
  const ir = irCase('context-100k');

  it('estimateTokens lands within ±15% of the ~100k expectation', () => {
    const chars = ir.messages.reduce(
      (n, m) => n + m.content.reduce((k, b) => k + (b.type === 'text' ? b.text.length : 0), 0),
      0,
    );
    const expected = chars / 4; // CHARS_PER_TOKEN heuristic, overheads ignored
    expect(expected).toBeGreaterThan(90_000); // the fixture really is ~100k tokens
    const estimated = estimateTokens(ir);
    expect(estimated).toBeGreaterThanOrEqual(expected * 0.85);
    expect(estimated).toBeLessThanOrEqual(expected * 1.15);
  });

  it('egress-openai carries the full context without truncation or mutation', () => {
    const body = egressOpenAI(ir);
    const messages = body['messages'] as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(ir.messages.length);
    const last = messages[messages.length - 1]!;
    expect(last['content']).toBe(CONTEXT_SENTINEL);
    // Every message body arrives verbatim (spot-check the first and a middle one).
    expect(messages[0]!['content']).toBe((ir.messages[0]!.content[0] as { text: string }).text);
    expect(messages[25]!['content']).toBe((ir.messages[25]!.content[0] as { text: string }).text);
  });

  it('egress-anthropic carries the full context without truncation or mutation', () => {
    const body = egressAnthropic(ir);
    const messages = body['messages'] as Array<{ content: Array<{ type: string; text?: string }> }>;
    expect(messages).toHaveLength(ir.messages.length);
    expect(messages[messages.length - 1]!.content[0]!.text).toBe(CONTEXT_SENTINEL);
    expect(messages[25]!.content[0]!.text).toBe((ir.messages[25]!.content[0] as { text: string }).text);
  });
});

describe('conformance: streaming abort discipline (RULE 4)', () => {
  for (const target of ['openai', 'anthropic'] as const) {
    it(`${target}: fail() after first token emits stream_error + terminal message_end, machine is single-use`, () => {
      const m = streamIR(target);
      const first =
        target === 'openai'
          ? m.push({ choices: [{ delta: { content: 'partial' } }] })
          : m.push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } });
      expect(first.length).toBeGreaterThan(0);
      expect(m.firstTokenEmitted).toBe(true);

      const events = m.fail('upstream socket reset');
      expect(events.map((e) => e.type)).toEqual(['stream_error', 'message_end']);
      const end = events[1]!;
      expect(end.type === 'message_end' && end.stop_reason).toBe('error');
      expect(m.terminated).toBe(true);

      // Single-use enforcement: any further input throws.
      expect(() => m.push({ choices: [{ delta: { content: 'more' } }] })).toThrow(/single-use/);
      // Repeated fail()/end() after termination are silent no-ops.
      expect(m.fail('again')).toEqual([]);
      expect(m.end()).toEqual([]);
    });
  }
});
