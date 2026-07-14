/**
 * textproc allowlist extension (Spec 10 / PR-5).
 *
 * Read-only text tools auto-approve as single commands; write-capable ones
 * (sed -i / gawk -i inplace / perl -i) fall through to the approval gate;
 * any pipeline still requires approval (metachar rejection is unchanged).
 */

import { describe, it, expect } from 'vitest';
import { isAllowlisted } from '../../src/core/security/approval/allowlist.js';

describe('textproc allowlist — read-only single commands', () => {
  it('auto-approves plain read invocations', () => {
    for (const cmd of [
      'rg TODO src',
      'jq . data.json',
      'mlr --icsv --ojson cat f.csv',
      'gron config.json',
      'yq .services docker.yml',
      'datamash sum 1',
      'cut -d, -f2 f.csv',
      'sort -u names.txt',
      'htmlq .price index.html',
      'batcat --plain notes.md',
    ]) {
      expect(isAllowlisted(cmd), cmd).toBe(true);
    }
  });
});

describe('textproc allowlist — write-capable tools gated by flag scan', () => {
  it('auto-approves the read form of sed/awk/perl (no metachars)', () => {
    expect(isAllowlisted('sed -n 1,10p file.txt')).toBe(true);
    expect(isAllowlisted("awk NR==1 file.txt")).toBe(true);
    expect(isAllowlisted('perl -pe s/a/b/ file.txt')).toBe(true);
  });

  it("awk with a $ field ref is deferred (pre-existing metachar rule, safe)", () => {
    // $ is a shell metachar → not auto-approved; goes through approval. Correct.
    expect(isAllowlisted("awk '{print $1}' file.txt")).toBe(false);
  });

  it('defers in-place writes to approval', () => {
    expect(isAllowlisted("sed -i s/a/b/ file.txt")).toBe(false);
    expect(isAllowlisted("sed --in-place s/a/b/ file.txt")).toBe(false);
    expect(isAllowlisted("gawk -i inplace '{print}' file.txt")).toBe(false);
    expect(isAllowlisted("perl -i -pe s/a/b/ file.txt")).toBe(false);
  });
});

describe('textproc allowlist — pipelines and injection still rejected', () => {
  it('rejects any command with shell metacharacters', () => {
    expect(isAllowlisted('rg foo | head')).toBe(false);
    expect(isAllowlisted('jq . f.json > out.json')).toBe(false);
    expect(isAllowlisted('cut -f1 f && rm -rf /')).toBe(false);
    expect(isAllowlisted('sort $(cat evil)')).toBe(false);
  });

  it('rejects path-prefixed binaries (symlink swap guard)', () => {
    expect(isAllowlisted('/tmp/rg foo')).toBe(false);
    expect(isAllowlisted('./mlr cat f')).toBe(false);
  });
});
