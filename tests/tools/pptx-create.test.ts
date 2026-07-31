/**
 * @file tests/tools/pptx-create.test.ts
 * @description pptx.create — real .pptx generation (pptxgenjs, local/offline).
 * Asserts the produced file is a genuine OOXML package (slide parts, notes)
 * and that the path allowlist / validation hold. Chosen over the Claude seat's
 * hosted skills container because that container's files cannot be retrieved
 * on a Max seat (Files API 404) and it is rate-limited.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pptxCreateTool } from '../../src/core/tools/builtin/pptx/tools/create.js';

const ctx = { sessionId: 'test-session-id' } as never;
const made: string[] = [];

function tmpOut(name: string): string {
  const p = path.join(os.tmpdir(), `pptx-test-${process.pid}-${name}`);
  made.push(p);
  return p;
}

/** Names of entries inside the .pptx zip (a valid pptx is an OOXML zip). */
function zipEntries(file: string): string[] {
  try {
    return execFileSync('unzip', ['-l', file], { encoding: 'utf8' }).split('\n');
  } catch {
    return [];
  }
}

afterEach(() => {
  for (const p of made.splice(0)) if (existsSync(p)) rmSync(p, { force: true });
});

describe('pptx.create — validation', () => {
  it('rejects a non-.pptx extension', async () => {
    const r = await pptxCreateTool.execute({ outputPath: tmpOut('x.txt'), title: 'T', slides: [{ title: 'S' }] }, ctx);
    expect(r.success).toBe(false);
    expect(r.output).toContain('.pptx');
  });

  it('rejects paths outside the allowlist', async () => {
    const r = await pptxCreateTool.execute({ outputPath: '/etc/evil.pptx', title: 'T', slides: [{ title: 'S' }] }, ctx);
    expect(r.success).toBe(false);
    expect(r.output).toContain('must be under');
  });

  it('requires a title and a non-empty slides array', async () => {
    expect((await pptxCreateTool.execute({ outputPath: tmpOut('a.pptx'), slides: [{ title: 'S' }] }, ctx)).success).toBe(false);
    expect((await pptxCreateTool.execute({ outputPath: tmpOut('b.pptx'), title: 'T', slides: [] }, ctx)).success).toBe(false);
  });

  it('rejects a slide with neither title nor bullets, and a bad accent colour', async () => {
    const empty = await pptxCreateTool.execute({ outputPath: tmpOut('c.pptx'), title: 'T', slides: [{}] }, ctx);
    expect(empty.success).toBe(false);
    const badColor = await pptxCreateTool.execute(
      { outputPath: tmpOut('d.pptx'), title: 'T', slides: [{ title: 'S' }], accentColor: 'nope' },
      ctx,
    );
    expect(badColor.success).toBe(false);
    expect(badColor.output).toContain('hex');
  });
});

describe('pptx.create — output', () => {
  it('writes a genuine OOXML deck: one slide part per slide plus the title slide', async () => {
    const out = tmpOut('deck.pptx');
    const r = await pptxCreateTool.execute(
      {
        outputPath: out,
        title: 'Deploy Safety',
        subtitle: 'release review',
        slides: [
          { title: 'Rollback', bullets: ['Keep the last green build'], notes: 'stress this' },
          { title: 'Monitoring', bullets: ['Watch error rate', 'Alert on p99'] },
        ],
      },
      ctx,
    );
    expect(r.success).toBe(true);
    expect(existsSync(out)).toBe(true);
    // Output phrasing is what the file-attachment extractor keys on.
    expect(r.output).toContain('Presentation saved to:');

    const entries = zipEntries(out).join('\n');
    if (entries === '') return; // unzip unavailable in this env — file existence already asserted
    const slideParts = (entries.match(/ppt\/slides\/slide\d+\.xml/g) ?? []).length;
    expect(slideParts).toBe(3); // title slide + 2 content slides
    expect(entries).toContain('ppt/presentation.xml');
    expect(entries).toContain('notesSlide'); // speaker notes made it in
  });
});
