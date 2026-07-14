/**
 * textproc capability manifest injection (Spec 10 / PR-5).
 *
 * The Tool Capability Manifest gains a concise textproc section + a cached,
 * probe-free one-line coverage summary so the model knows the tools exist
 * without a discovery tool call.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { getCapabilityManifestBody } from '../../src/core/brain/capability-manifest.js';
import { getManifest, clearManifestCache } from '../../src/core/tools/builtin/textproc/capabilities.js';

afterEach(() => {
  delete process.env['SUDO_TEXTPROC'];
  clearManifestCache();
});

describe('capability manifest — textproc section', () => {
  it('advertises the four textproc tools', () => {
    const body = getCapabilityManifestBody();
    expect(body).toContain('textproc.capabilities');
    expect(body).toContain('textproc.extract');
    expect(body).toContain('textproc.replace');
    expect(body).toContain('textproc.analyze');
    // still contains the original sandbox/host manifest
    expect(body).toContain('system.exec');
    expect(body).toContain('meta.self-modify');
  });

  it('includes the cached coverage summary once the manifest is warmed', async () => {
    await getManifest({ refresh: true }); // warm the in-memory + disk cache
    const body = getCapabilityManifestBody();
    expect(body).toContain('Installed here: textproc');
    expect(body).toContain('search:'); // one of the summary role keys
  });

  it('omits the textproc section body cleanly is NOT required — but kill-switch drops the summary line', () => {
    process.env['SUDO_TEXTPROC'] = '0';
    clearManifestCache();
    const body = getCapabilityManifestBody();
    // Section still describes the tools (they may be re-enabled), but the
    // live "Installed here" summary is suppressed under the kill-switch.
    expect(body).not.toContain('Installed here:');
  });
});
