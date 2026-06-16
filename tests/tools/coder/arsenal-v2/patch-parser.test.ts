/**
 * @file patch-parser.test.ts
 * @description Tests for the <<<PATCH>>>...<<<END>>> extractor + validator.
 */

import { describe, it, expect } from 'vitest';
import { parsePatchBlock } from '../../../../src/core/tools/builtin/coder/arsenal-v2/patch-parser.js';

function blocked(json: string): string {
  return `Some reasoning here.\n\n<<<PATCH>>>\n${json}\n<<<END>>>\n\nTrailing prose.`;
}

describe('parsePatchBlock — empty + missing markers', () => {
  it('rejects empty input', () => {
    expect(parsePatchBlock('')).toEqual({ ok: false, error: 'empty or non-string LLM output' });
  });
  it('rejects missing <<<PATCH>>>', () => {
    const r = parsePatchBlock('just prose, no marker');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('missing <<<PATCH>>>');
  });
  it('rejects missing <<<END>>>', () => {
    const r = parsePatchBlock('<<<PATCH>>>\n[]\n');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('missing <<<END>>>');
  });
  it('rejects empty block', () => {
    const r = parsePatchBlock('<<<PATCH>>>\n\n<<<END>>>');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('patch block is empty');
  });
});

describe('parsePatchBlock — JSON wrapping + fence handling', () => {
  it('parses bare JSON', () => {
    const r = parsePatchBlock(
      blocked('[{"op":"str_replace","file":"a.ts","old":"x","new":"y"}]'),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ops).toHaveLength(1);
  });
  it('parses markdown-fenced JSON', () => {
    const r = parsePatchBlock(
      blocked('```json\n[{"op":"str_replace","file":"a.ts","old":"x","new":"y"}]\n```'),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ops).toHaveLength(1);
  });
  it('rejects non-array root', () => {
    const r = parsePatchBlock(blocked('{"op":"str_replace","file":"a","old":"x","new":"y"}'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('must be a JSON array');
  });
  it('rejects empty array', () => {
    const r = parsePatchBlock(blocked('[]'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('patch array is empty');
  });
  it('rejects malformed JSON', () => {
    const r = parsePatchBlock(blocked('[not json'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('not valid JSON');
  });
});

describe('parsePatchBlock — per-op validation', () => {
  it('rejects op missing file', () => {
    const r = parsePatchBlock(blocked('[{"op":"str_replace","old":"x","new":"y"}]'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('"file"');
  });
  it('rejects absolute path', () => {
    const r = parsePatchBlock(
      blocked('[{"op":"str_replace","file":"/etc/passwd","old":"x","new":"y"}]'),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/project-relative path|"\.\."/);
  });
  it('rejects ".." in path', () => {
    const r = parsePatchBlock(
      blocked('[{"op":"str_replace","file":"../escape.ts","old":"x","new":"y"}]'),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/"\.\."/);
  });
  it('rejects str_replace with empty old', () => {
    const r = parsePatchBlock(
      blocked('[{"op":"str_replace","file":"a.ts","old":"","new":"y"}]'),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('cannot be empty');
  });
  it('rejects str_replace where old === new', () => {
    const r = parsePatchBlock(
      blocked('[{"op":"str_replace","file":"a.ts","old":"x","new":"x"}]'),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('no-op');
  });
  it('rejects unknown op', () => {
    const r = parsePatchBlock(blocked('[{"op":"rewrite_universe","file":"a.ts"}]'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('unknown op');
  });
  it('rejects insert_after with empty anchor', () => {
    const r = parsePatchBlock(
      blocked('[{"op":"insert_after","file":"a.ts","anchor":"","content":"foo"}]'),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('non-empty string "anchor"');
  });
  it('accepts create_file with empty content', () => {
    const r = parsePatchBlock(blocked('[{"op":"create_file","file":"new.ts","content":""}]'));
    expect(r.ok).toBe(true);
  });
  it('accepts delete_file with minimal fields', () => {
    const r = parsePatchBlock(blocked('[{"op":"delete_file","file":"old.ts"}]'));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ops[0]?.op).toBe('delete_file');
  });
});

describe('parsePatchBlock — multi-op + ordering', () => {
  it('preserves op order', () => {
    const r = parsePatchBlock(
      blocked(
        '[{"op":"create_file","file":"a.ts","content":"a"},' +
          '{"op":"str_replace","file":"b.ts","old":"x","new":"y"},' +
          '{"op":"delete_file","file":"c.ts"}]',
      ),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ops.map((o) => o.op)).toEqual(['create_file', 'str_replace', 'delete_file']);
    }
  });
  it('fails the whole parse on one bad op', () => {
    const r = parsePatchBlock(
      blocked('[{"op":"str_replace","file":"a.ts","old":"x","new":"y"},{"op":"bogus","file":"b.ts"}]'),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('op[1]');
  });
});
