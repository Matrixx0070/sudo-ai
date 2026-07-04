/**
 * repair-flywheel — Phase-A prototype of the verified continual-learning loop.
 * Pins the mine → signature → distill → coverage half (the part validated against
 * real trace data: ~45% of failures are addressable by 2 learnable repair lessons).
 */
import { describe, it, expect } from 'vitest';
import {
  errorSignature,
  mineFailureClusters,
  matchLesson,
  measureCoverage,
  repairReadFilePath,
  type FailureRow,
} from '../../src/core/learning/repair-flywheel.js';

describe('errorSignature', () => {
  it('normalizes volatile specifics so the same failure clusters together', () => {
    const a = errorSignature('Path traversal blocked: /root/x/package.json resolves outside project root');
    const b = errorSignature('Path traversal blocked: /root/y/errors.ts resolves outside project root');
    expect(a).toBe(b); // same signature despite different paths
  });
});

describe('mineFailureClusters', () => {
  it('groups by tool+signature and drops rare clusters', () => {
    const rows: FailureRow[] = [
      ...Array(4).fill({ tool_name: 'system.exec', error_message: 'Refused: shell metacharacters are not allowed in repo-exec. target:"repo"' }),
      { tool_name: 'coder.read-file', error_message: 'one-off weird error' },
    ];
    const clusters = mineFailureClusters(rows, 3);
    expect(clusters).toHaveLength(1); // the rare one-off is dropped
    expect(clusters[0]!.tool).toBe('system.exec');
    expect(clusters[0]!.count).toBe(4);
  });
});

describe('matchLesson', () => {
  it('recognizes the two learnable clusters and the system-bug cluster', () => {
    expect(matchLesson('Refused: shell metacharacters are not allowed in repo-exec')!.id).toBe('exec-repo-readonly-metachars');
    expect(matchLesson("Refused: 'cat' is not a repo-allowlisted command")!.id).toBe('exec-repo-readonly-metachars');
    expect(matchLesson('Path traversal blocked: src/x.ts resolves outside project root')!.id).toBe('readfile-relative-path');
    const bug = matchLesson('Error executing tool coder.read-file: ReferenceError: __dirname is not defined')!;
    expect(bug.id).toBe('readfile-dirname-undefined');
    expect(bug.learnable).toBe(false); // flagged as a SYSTEM BUG, not agent error
  });
  it('returns undefined for an unrecognized failure', () => {
    expect(matchLesson('some novel error nobody has clustered yet')).toBeUndefined();
  });
});

describe('measureCoverage (the canary)', () => {
  it('separates learnable (repair) coverage from flagged system bugs', () => {
    const rows: FailureRow[] = [
      ...Array(6).fill({ tool_name: 'system.exec', error_message: 'Refused: shell metacharacters are not allowed in repo-exec' }),
      ...Array(3).fill({ tool_name: 'coder.read-file', error_message: 'Path traversal blocked: a/b.ts resolves outside project root' }),
      { tool_name: 'coder.read-file', error_message: '__dirname is not defined' }, // system bug
      { tool_name: 'browser.click', error_message: 'unrelated one-off' },          // unaddressed
    ];
    const cov = measureCoverage(rows);
    expect(cov.total).toBe(11);
    expect(cov.learnableAddressed).toBe(9);   // 6 exec + 3 read-file
    expect(cov.systemBugs).toBe(1);           // the __dirname bug
    expect(cov.coveragePct).toBeCloseTo(81.8, 1);
  });
});

describe('repairReadFilePath', () => {
  it('rewrites an in-repo absolute path to project-relative', () => {
    expect(repairReadFilePath('/root/sudo-ai-v4/src/x.ts', '/root/sudo-ai-v4')).toBe('src/x.ts');
  });
  it('leaves an out-of-repo path unchanged (genuinely unreadable, not repairable)', () => {
    expect(repairReadFilePath('/root/other.txt', '/root/sudo-ai-v4')).toBe('/root/other.txt');
  });
});
