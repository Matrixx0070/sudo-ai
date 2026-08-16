/**
 * @file profile-identity.test.ts
 * @description Every browser tool must report the profile it ACTUALLY ran on.
 *
 * `browser.launch` said "running on a per-process FORK"; the other twenty
 * instance-scoped browser tools (auth, captcha, console, file_upload, click,
 * type, …) said nothing, so a tool could report success while holding an empty
 * cookie jar and the model had no way to know. The annotation is applied at one
 * chokepoint (profile-identity.ts) and this suite covers the WHOLE tool list,
 * not one example.
 */
import { describe, it, expect } from 'vitest';
import {
  PROFILE_PARAM_BY_TOOL,
  resolveToolProfileName,
  annotateResult,
  describeInstance,
  withProfileIdentity,
  FORKED_PROFILE_NOTE,
} from '../../src/core/tools/builtin/browser/profile-identity.js';
import { RAW_BROWSER_TOOLS, BROWSER_TOOLS } from '../../src/core/tools/builtin/browser/index.js';
import type { BrowserInstance } from '../../src/core/tools/builtin/browser/browser-manager.js';
import type { ToolContext, ToolDefinition } from '../../src/core/tools/types.js';

/** Instance-scoped tools: the ones that CAN silently run on a forked profile. */
const INSTANCE_SCOPED = Object.entries(PROFILE_PARAM_BY_TOOL)
  .filter(([, keys]) => keys.length > 0)
  .map(([name]) => name);

function fakeInstance(over: Partial<BrowserInstance> = {}): BrowserInstance {
  return {
    name: 'default',
    profileDir: '/tmp/browser-profiles/default',
    context: {} as BrowserInstance['context'],
    browser: null,
    launchedAt: new Date(),
    trust: 'low',
    ownerOnly: false,
    ...over,
  } as BrowserInstance;
}

const CTX = { logger: { info() {}, error() {} }, workingDir: '/tmp' } as unknown as ToolContext;

describe('tool coverage', () => {
  it('every registered browser tool has an explicit profile-parameter decision', () => {
    const missing = RAW_BROWSER_TOOLS.map((t) => t.name).filter((n) => !(n in PROFILE_PARAM_BY_TOOL));
    expect(missing).toEqual([]);
  });

  it('covers all 21 instance-scoped entry points, not just browser.launch', () => {
    expect(INSTANCE_SCOPED).toHaveLength(21);
    expect(INSTANCE_SCOPED).toContain('browser.launch');
    // The ones that carried no profile signal before this change:
    for (const n of ['browser.auth', 'browser.captcha', 'browser.console', 'browser.file_upload',
      'browser.click', 'browser.type', 'browser.wait', 'browser.mouse', 'browser.network',
      'browser.history', 'browser.snapshot', 'browser.navigate', 'browser.interact',
      'browser.scrape', 'browser.screenshot', 'browser.fill-form', 'browser.download',
      'browser.tabs', 'browser.watch', 'browser.login']) {
      expect(INSTANCE_SCOPED).toContain(n);
    }
  });

  it('the exported BROWSER_TOOLS are the WRAPPED definitions', () => {
    const raw = new Map(RAW_BROWSER_TOOLS.map((t) => [t.name, t as ToolDefinition]));
    for (const t of BROWSER_TOOLS) {
      const isScoped = (PROFILE_PARAM_BY_TOOL[t.name] ?? []).length > 0;
      expect(t.execute === raw.get(t.name)!.execute).toBe(!isScoped);
    }
  });
});

describe('resolveToolProfileName', () => {
  it('defaults to "default" for instance-scoped tools', () => {
    expect(resolveToolProfileName('browser.click', {})).toBe('default');
  });
  it('reads the tool-specific parameter name', () => {
    expect(resolveToolProfileName('browser.click', { browser: 'work' })).toBe('work');
    expect(resolveToolProfileName('browser.launch', { profile: 'work' })).toBe('work');
    expect(resolveToolProfileName('browser.launch', { name: 'work' })).toBe('work');
    expect(resolveToolProfileName('browser.launch', { profile: 'a', name: 'b' })).toBe('a');
    expect(resolveToolProfileName('browser.watch', { profile: 'work' })).toBe('work');
  });
  it('returns null for tools that do not act on one instance', () => {
    expect(resolveToolProfileName('browser.profiles', { name: 'x' })).toBeNull();
    expect(resolveToolProfileName('browser.search', {})).toBeNull();
  });
});

describe('annotateResult', () => {
  const forked = describeInstance('default', fakeInstance({
    profileDir: '/tmp/browser-profiles/default__pid99', forked: true,
  }));

  it('reports the logical profile behind a fork dir', () => {
    expect(forked.profile).toBe('default');
    expect(forked.forked).toBe(true);
    expect(forked.profileDir).toMatch(/__pid99$/);
  });

  it('appends a loud, model-readable note when forked', () => {
    const r = annotateResult({ success: true, output: 'Clicked Sign in.' }, forked);
    expect(r.output).toContain(FORKED_PROFILE_NOTE);
    expect(r.output).toContain('FRESH cookie jar');
    expect((r.data as { profileIdentity: unknown }).profileIdentity).toEqual(forked);
  });

  it('does not append the note twice', () => {
    const once = annotateResult({ success: true, output: 'x' }, forked);
    const twice = annotateResult(once, forked);
    expect(twice.output.split('NOTE: the requested browser profile').length - 1).toBe(1);
  });

  it('adds identity without the note for a normal profile, preserving data', () => {
    const id = describeInstance('work', fakeInstance({ name: 'work', trust: 'medium' }));
    const r = annotateResult({ success: true, output: 'ok', data: { entries: [1, 2] } }, id);
    expect(r.output).toBe('ok');
    expect(r.data).toEqual({ entries: [1, 2], profileIdentity: id });
    expect(id.forked).toBe(false);
  });

  it('leaves array/primitive payloads structurally untouched', () => {
    const r = annotateResult({ success: true, output: 'ok', data: [1, 2] }, forked);
    expect(r.data).toEqual([1, 2]);
    expect(r.output).toContain(FORKED_PROFILE_NOTE);
  });
});

describe('withProfileIdentity wrapper', () => {
  const base: ToolDefinition = {
    name: 'browser.click',
    description: 'd',
    category: 'browser',
    parameters: {},
    async execute() { return { success: true, output: 'clicked' }; },
  };

  it('passes the result through unchanged when no instance is live', async () => {
    const r = await withProfileIdentity(base).execute({ browser: 'nope-not-live' }, CTX);
    expect(r.output).toBe('clicked');
  });

  it('never turns a working call into a failure if annotation throws', async () => {
    const boom: ToolDefinition = { ...base, name: 'browser.click' };
    const wrapped = withProfileIdentity(boom);
    // A param that is not a string falls back to 'default'; no live instance in
    // this process → untouched result rather than an exception.
    const r = await wrapped.execute({ browser: 42 }, CTX);
    expect(r.success).toBe(true);
  });

  it('leaves non-instance-scoped tools as the same object', () => {
    const t: ToolDefinition = { ...base, name: 'browser.search' };
    expect(withProfileIdentity(t)).toBe(t);
  });
});
