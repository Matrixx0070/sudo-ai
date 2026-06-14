/**
 * LLM-written memory consolidator (gap #20) — exercises
 * `consolidateMemoryFile` and `shouldConsolidate` end-to-end against a
 * deterministic stub brain that returns canned strings. Each test uses a
 * tmpdir so disk side-effects are scoped and removed in afterEach.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import {
  consolidateMemoryFile,
  shouldConsolidate,
  type ConsolidatorBrain,
} from '../../src/core/memory/memory-consolidator.js';

let baseDir: string;
let memoryPath: string;
let backupDir: string;

function makeBrain(content: string): ConsolidatorBrain {
  return {
    async call() {
      return { content };
    },
  };
}

function makeFailingBrain(message: string): ConsolidatorBrain {
  return {
    async call() {
      throw new Error(message);
    },
  };
}

function writeMemory(text: string): void {
  writeFileSync(memoryPath, text, 'utf-8');
}

beforeEach(() => {
  baseDir = join(tmpdir(), `mem-consolidate-${randomUUID()}`);
  mkdirSync(baseDir, { recursive: true });
  memoryPath = join(baseDir, 'MEMORY.md');
  backupDir = join(baseDir, '.memory-backups');
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// shouldConsolidate
// ---------------------------------------------------------------------------

describe('shouldConsolidate', () => {
  it('returns false when the file does not exist', () => {
    expect(shouldConsolidate(memoryPath)).toBe(false);
  });

  it('returns false when the file is below the threshold', () => {
    writeMemory('# Long-Term Memory\n\n- tiny\n');
    expect(shouldConsolidate(memoryPath, 8192)).toBe(false);
  });

  it('returns true at or above the threshold', () => {
    writeMemory('x'.repeat(9000));
    expect(shouldConsolidate(memoryPath, 8192)).toBe(true);
  });

  it('uses the default 8192-byte threshold when omitted', () => {
    writeMemory('x'.repeat(8192));
    expect(shouldConsolidate(memoryPath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// consolidateMemoryFile — happy path
// ---------------------------------------------------------------------------

describe('consolidateMemoryFile happy path', () => {
  it('rewrites MEMORY.md, backs up the original, and reports the new bytes', async () => {
    const input = '# Long-Term Memory\n\n- [2026-06-01] foo\n- [2026-06-01] foo\n- bar\n';
    writeMemory(input);
    const output = '# Long-Term Memory\n\n## Misc\n- foo\n- bar\n';
    const r = await consolidateMemoryFile(makeBrain(output), { memoryPath, backupDir });

    expect(r.consolidated).toBe(true);
    expect(r.inputBytes).toBe(Buffer.byteLength(input, 'utf-8'));
    expect(r.outputBytes).toBe(Buffer.byteLength(output.trim(), 'utf-8'));
    expect(r.backupPath).toContain('.memory-backups');
    expect(readFileSync(memoryPath, 'utf-8').trim()).toBe(output.trim());
    expect(readFileSync(r.backupPath!, 'utf-8')).toBe(input);
  });

  it('strips a leading ```markdown / ``` code fence the model wrapped', async () => {
    const input = '# Long-Term Memory\n\n' + ('- factoid\n'.repeat(40));
    writeMemory(input);
    const wrapped = '```markdown\n# Long-Term Memory\n\n- factoid\n```';
    const r = await consolidateMemoryFile(makeBrain(wrapped), { memoryPath, backupDir });
    expect(r.consolidated).toBe(true);
    expect(readFileSync(memoryPath, 'utf-8')).toBe('# Long-Term Memory\n\n- factoid');
  });

  it('strips fences with any lowercase language tag (verifier MED #1)', async () => {
    const input = '# Long-Term Memory\n\n' + ('- factoid\n'.repeat(40));
    writeMemory(input);
    // ```text — was NOT stripped by the previous narrow `(?:markdown|md)?`
    // regex, leaving a literal fence in MEMORY.md.
    const wrapped = '```text\n# Long-Term Memory\n\n- factoid\n```';
    const r = await consolidateMemoryFile(makeBrain(wrapped), { memoryPath, backupDir });
    expect(r.consolidated).toBe(true);
    expect(readFileSync(memoryPath, 'utf-8')).not.toMatch(/^```/);
    expect(readFileSync(memoryPath, 'utf-8')).toBe('# Long-Term Memory\n\n- factoid');
  });

  it('strips bare ``` fences with no language tag', async () => {
    const input = '# Long-Term Memory\n\n' + ('- factoid\n'.repeat(40));
    writeMemory(input);
    const wrapped = '```\n# Long-Term Memory\n\n- factoid\n```';
    const r = await consolidateMemoryFile(makeBrain(wrapped), { memoryPath, backupDir });
    expect(r.consolidated).toBe(true);
    expect(readFileSync(memoryPath, 'utf-8')).toBe('# Long-Term Memory\n\n- factoid');
  });
});

// ---------------------------------------------------------------------------
// consolidateMemoryFile — rejection / safety
// ---------------------------------------------------------------------------

describe('consolidateMemoryFile rejection paths leave the original untouched', () => {
  it('returns consolidated:false when MEMORY.md does not exist', async () => {
    const r = await consolidateMemoryFile(makeBrain('# x'), { memoryPath, backupDir });
    expect(r.consolidated).toBe(false);
    expect(r.reason).toContain('does not exist');
  });

  it('returns consolidated:false when MEMORY.md is empty', async () => {
    writeMemory('');
    const r = await consolidateMemoryFile(makeBrain('# x'), { memoryPath, backupDir });
    expect(r.consolidated).toBe(false);
    expect(r.reason).toContain('empty');
  });

  it('rejects empty brain output', async () => {
    const original = '# Long-Term Memory\n\n- a fact\n- another fact\n';
    writeMemory(original);
    const r = await consolidateMemoryFile(makeBrain('   '), { memoryPath, backupDir });
    expect(r.consolidated).toBe(false);
    expect(r.reason).toContain('empty');
    expect(readFileSync(memoryPath, 'utf-8')).toBe(original);
  });

  it('rejects output missing a top-level # heading', async () => {
    const original = '# Long-Term Memory\n\n- a fact\n- another fact\n';
    writeMemory(original);
    const r = await consolidateMemoryFile(makeBrain('## Subheading only\n- foo\n'), { memoryPath, backupDir });
    expect(r.consolidated).toBe(false);
    expect(r.reason).toContain('top-level # heading');
    expect(readFileSync(memoryPath, 'utf-8')).toBe(original);
  });

  it('rejects an output that GROWS a previously substantial file', async () => {
    // Make the input > 2048 bytes to engage the grow-the-file guard, and
    // give the validator a generous maxOutputBytes so the BLOWN output
    // hits the grow-check rather than the byte-cap.
    const original = '# Long-Term Memory\n\n' + ('- compact fact line ' + '\n').repeat(120); // ~2.6KB
    writeMemory(original);
    const blown = '# Long-Term Memory\n\n' + 'bloat\n'.repeat(800); // ~5KB
    const r = await consolidateMemoryFile(makeBrain(blown), {
      memoryPath,
      backupDir,
      maxOutputBytes: 1_000_000,
    });
    expect(r.consolidated).toBe(false);
    expect(r.reason).toContain('grew the file');
    expect(readFileSync(memoryPath, 'utf-8')).toBe(original);
  });

  it('rejects an output that exceeds the maxOutputBytes cap', async () => {
    const original = '# Long-Term Memory\n\n- short\n';
    writeMemory(original);
    const big = '# Long-Term Memory\n\n' + 'x'.repeat(200);
    const r = await consolidateMemoryFile(makeBrain(big), {
      memoryPath,
      backupDir,
      maxOutputBytes: 50,
    });
    expect(r.consolidated).toBe(false);
    expect(r.reason).toContain('exceeds max');
    expect(readFileSync(memoryPath, 'utf-8')).toBe(original);
  });

  it('returns consolidated:false when the brain call throws', async () => {
    const original = '# Long-Term Memory\n\n- a fact\n- another fact\n';
    writeMemory(original);
    const r = await consolidateMemoryFile(makeFailingBrain('502 from provider'), { memoryPath, backupDir });
    expect(r.consolidated).toBe(false);
    expect(r.reason).toContain('brain call failed');
    expect(r.reason).toContain('502 from provider');
    expect(readFileSync(memoryPath, 'utf-8')).toBe(original);
  });

  it('throws TypeError when brain is missing', async () => {
    writeMemory('# Long-Term Memory\n');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(consolidateMemoryFile(undefined as any, { memoryPath, backupDir })).rejects.toBeInstanceOf(TypeError);
  });

  it('throws TypeError when memoryPath is missing', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(consolidateMemoryFile(makeBrain('# x'), {} as any)).rejects.toBeInstanceOf(TypeError);
  });
});

// ---------------------------------------------------------------------------
// Backups directory
// ---------------------------------------------------------------------------

describe('backup behaviour', () => {
  it('creates the backup dir if missing and writes a timestamped backup', async () => {
    const input = '# Long-Term Memory\n\n- the original\n';
    writeMemory(input);
    expect(existsSync(backupDir)).toBe(false);
    const r = await consolidateMemoryFile(makeBrain('# Long-Term Memory\n\n## X\n- 1\n'), {
      memoryPath,
      backupDir,
    });
    expect(r.consolidated).toBe(true);
    expect(existsSync(backupDir)).toBe(true);
    const backups = readdirSync(backupDir);
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^MEMORY\..*\.md$/);
    expect(readFileSync(join(backupDir, backups[0]!), 'utf-8')).toBe(input);
  });

  it('defaults the backup dir to <memoryDir>/.memory-backups when not provided', async () => {
    const input = '# Long-Term Memory\n\n- the original\n';
    writeMemory(input);
    const r = await consolidateMemoryFile(makeBrain('# Long-Term Memory\n\n## X\n- 1\n'), {
      memoryPath,
    });
    expect(r.consolidated).toBe(true);
    expect(r.backupPath).toContain('.memory-backups');
    expect(existsSync(join(baseDir, '.memory-backups'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// System prompt customization
// ---------------------------------------------------------------------------

describe('systemPrompt option', () => {
  it('uses a caller-supplied systemPrompt verbatim', async () => {
    const seen: string[] = [];
    const brain: ConsolidatorBrain = {
      async call(opts) {
        for (const m of opts.messages) if (m.role === 'system') seen.push(m.content);
        return { content: '# Long-Term Memory\n\n## X\n- 1\n' };
      },
    };
    writeMemory('# Long-Term Memory\n\n- old\n');
    await consolidateMemoryFile(brain, { memoryPath, backupDir, systemPrompt: 'CUSTOM CURATOR' });
    expect(seen).toEqual(['CUSTOM CURATOR']);
  });
});
