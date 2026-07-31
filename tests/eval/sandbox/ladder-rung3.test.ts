import { describe, expect, it } from 'vitest';
import { extractCode, failureSummary, gradeRung3, parseRung3Expect } from '../../../src/core/eval/sandbox/ladder-rung3.js';
import { runLadderRung } from '../../../src/core/eval/sandbox/ladder.js';

const EXPECT = { entry: 'solution.js', test: 'assert(1)', command: 'node test-suite.js' };

describe('extractCode', () => {
  it('prefers the longest fenced block and strips the language tag', () => {
    const reply = 'Here is a snippet:\n```js\nconst x=1;\n```\nAnd the solution:\n```javascript\nfunction f(){ return 42; }\nmodule.exports={f};\n```';
    const code = extractCode(reply);
    expect(code).toContain('module.exports');
    expect(code).not.toContain('```');
  });

  it('falls back to bare code, but rejects prose', () => {
    expect(extractCode('const a = 1;')).toContain('const a');
    expect(extractCode('I am unable to help with that request')).toBeNull();
    expect(extractCode('   ')).toBeNull();
  });
});

describe('parseRung3Expect', () => {
  it('accepts a well-formed descriptor', () => {
    expect(parseRung3Expect(EXPECT)).toEqual(EXPECT);
  });

  it('rejects missing fields, unknown keys, and path traversal', () => {
    expect(typeof parseRung3Expect({ entry: 'a.js', test: 't' })).toBe('string');
    expect(String(parseRung3Expect({ ...EXPECT, extra: 1 }))).toContain('unknown rung-3 expect key');
    expect(String(parseRung3Expect({ ...EXPECT, entry: '../escape.js' }))).toContain('relative in-workspace path');
    expect(String(parseRung3Expect({ ...EXPECT, entry: '/etc/passwd' }))).toContain('relative in-workspace path');
  });
});

describe('gradeRung3', () => {
  it('passes when the suite exits 0 and writes both files into the workspace', async () => {
    let seen: { command: string; workspaceDir: string } | null = null;
    const r = await gradeRung3(EXPECT, '```js\nmodule.exports={f:()=>42};\n```', async (o) => {
      seen = o;
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    });
    expect(r.passed).toBe(true);
    expect(seen!.command).toBe('node test-suite.js');
  });

  it('fails on a non-zero exit and surfaces the tail of the error', async () => {
    const r = await gradeRung3(EXPECT, '```js\nbroken\n```', async () => ({
      stdout: '', stderr: 'AssertionError: expected 4 got 5', exitCode: 1,
    }));
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('AssertionError');
  });

  it('fails (never throws) when the sandbox itself errors', async () => {
    const r = await gradeRung3(EXPECT, '```js\nx\n```', async () => { throw new Error('docker down'); });
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('sandbox error');
  });

  it('fails when the reply contains no code', async () => {
    const r = await gradeRung3(EXPECT, 'I cannot do that.', async () => ({ stdout: '', stderr: '', exitCode: 0 }));
    expect(r.passed).toBe(false);
    expect(r.detail).toBe('no code in reply');
  });
});

describe('runLadderRung rung 3', () => {
  it('runs the golden set through the injected sandbox and gates on minN', async () => {
    const rep = await runLadderRung(3, 'test/route', {
      repeats: 1,
      noCache: true,
      callRoute: async () => ({
        blocks: [{ type: 'text', text: '```js\nmodule.exports={};\n```' }],
        usage: { in: 1, out: 1 },
        stopReason: 'end_turn',
      }),
      sandboxExec: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }),
    });
    expect(rep.n).toBe(6);
    expect(rep.passRate).toBe(1);
    expect(rep.admitted).toBe(false); // n=6 < ADR minN 30
    expect(rep.threshold).toBe(0.85);
  });
});

describe('failureSummary', () => {
  it('surfaces the assertion, not the Node version banner (observed live)', () => {
    const res = { stdout: '', exitCode: 1, stderr: [
      'node:internal/x', "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: 6 !== 4",
      '    at Object.<anonymous>', 'Node.js v20.20.2',
    ].join('\n') };
    const s = failureSummary(res);
    expect(s).toContain('AssertionError');
    expect(s).not.toContain('Node.js v20');
  });

  it('is empty when there is nothing useful to report', () => {
    expect(failureSummary({ stdout: '', stderr: 'Node.js v20.20.2', exitCode: 1 })).toBe('');
  });
});
