/**
 * @file tests/tools/persona-quarantine.test.ts
 * @description Content-creator / business "persona" tools are quarantined by
 * default (SUDO_ENABLE_PERSONA_TOOLS=1 to enable): the persona meta tools
 * (meta.finance/creative/comments/…) plus the business/earning/finance builtin
 * tool dirs.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ToolRegistry } from '../../src/core/tools/registry.js';
import { registerMetaTools, PERSONA_META_TOOLS } from '../../src/core/tools/builtin/meta/index.js';
import { registerBusinessTools } from '../../src/core/tools/builtin/business/index.js';
import { registerEarningTools } from '../../src/core/tools/builtin/earning/index.js';
import { registerFinanceTools } from '../../src/core/tools/builtin/finance/index.js';

const FLAG = 'SUDO_ENABLE_PERSONA_TOOLS';

describe('persona-tool quarantine', () => {
  const saved = process.env[FLAG];
  beforeEach(() => { delete process.env[FLAG]; });
  afterEach(() => { if (saved === undefined) delete process.env[FLAG]; else process.env[FLAG] = saved; });

  it('persona meta tools are NOT registered by default; non-persona ones are', () => {
    const r = new ToolRegistry();
    registerMetaTools(r);
    for (const name of PERSONA_META_TOOLS) {
      expect(r.get(name)).toBeUndefined();
    }
    expect(r.get('meta.predictor')).toBeDefined(); // control
  });

  it('persona meta tools ARE registered when SUDO_ENABLE_PERSONA_TOOLS=1', () => {
    process.env[FLAG] = '1';
    const r = new ToolRegistry();
    registerMetaTools(r);
    for (const name of PERSONA_META_TOOLS) {
      expect(r.get(name)).toBeDefined();
    }
  });

  it('business/earning/finance builtin dirs register nothing by default', () => {
    const r = new ToolRegistry();
    registerBusinessTools(r);
    registerEarningTools(r);
    registerFinanceTools(r);
    expect(r.get('business.crm')).toBeUndefined();
    expect(r.get('earning.tracker')).toBeUndefined();
    expect(r.get('finance.bookkeeper')).toBeUndefined();
  });

  it('business/earning/finance register when SUDO_ENABLE_PERSONA_TOOLS=1', () => {
    process.env[FLAG] = '1';
    const r = new ToolRegistry();
    registerBusinessTools(r);
    registerEarningTools(r);
    registerFinanceTools(r);
    expect(r.get('business.crm')).toBeDefined();
    expect(r.get('earning.tracker')).toBeDefined();
    expect(r.get('finance.bookkeeper')).toBeDefined();
  });
});
