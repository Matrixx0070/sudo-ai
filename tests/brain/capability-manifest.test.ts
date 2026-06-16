/**
 * Tests for the Tool Capability Manifest — a single static block that maps
 * the sandbox-vs-host-vs-workspace tool boundaries the agent keeps tripping
 * over.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getCapabilityManifestBody,
  isCapabilityManifestEnabled,
} from '../../src/core/brain/capability-manifest.js';

const ORIGINAL_ENV = process.env['SUDO_CAPABILITY_MANIFEST'];

beforeEach(() => {
  delete process.env['SUDO_CAPABILITY_MANIFEST'];
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env['SUDO_CAPABILITY_MANIFEST'];
  else process.env['SUDO_CAPABILITY_MANIFEST'] = ORIGINAL_ENV;
});

describe('getCapabilityManifestBody', () => {
  it('names the three tools the bot specifically flagged', () => {
    const body = getCapabilityManifestBody();
    expect(body).toContain('system.exec');
    expect(body).toContain('meta.self-modify');
    expect(body).toContain('coder.*');
  });

  it('states the sandbox boundary explicitly', () => {
    const body = getCapabilityManifestBody();
    expect(body.toLowerCase()).toMatch(/sandbox/);
    expect(body.toLowerCase()).toMatch(/no access to the host/);
  });

  it('points host-repo paths at meta.self-modify', () => {
    const body = getCapabilityManifestBody();
    expect(body).toMatch(/\/root\/sudo-ai-v4|sudo-ai-v4 repo|sudo-ai-v4 codebase/);
    expect(body).toMatch(/meta\.self-modify/);
  });

  it('points workspace paths at coder.*', () => {
    const body = getCapabilityManifestBody();
    expect(body.toLowerCase()).toMatch(/workspace/);
  });

  it('is short enough to be cheap (< 2 KB)', () => {
    expect(getCapabilityManifestBody().length).toBeLessThan(2048);
  });

  // Issue #166 regression: agent picked meta.self-modify on "what channels
  // are enabled?" and looped until LoopExitGuard fired. The manifest now
  // explicitly routes introspective questions back to the prompt itself.
  it('routes introspective questions to the prompt, not tools (issue #166)', () => {
    const body = getCapabilityManifestBody();
    expect(body.toLowerCase()).toMatch(/introspective questions/);
    expect(body.toLowerCase()).toMatch(/what channels are enabled/);
    expect(body.toLowerCase()).toMatch(/do not invoke .*self-modify/);
    expect(body.toLowerCase()).toMatch(/solely.{0,3}to discover sudo-ai's enabled channels/);
  });

  // Verifier MED-1 (PR review): the prohibition is scoped to *introspective*
  // SUDO-AI config questions; legitimate system.exec for host introspection
  // (CPU load, active shell, Node version) must remain available.
  it('does NOT blanket-prohibit system.exec — host-level introspection stays legitimate', () => {
    const body = getCapabilityManifestBody();
    expect(body.toLowerCase()).toMatch(/legitimate.*system\.exec.*unaffected|host-level introspection/);
  });

  it('disambiguates meta.self-modify away from "inspect self"', () => {
    const body = getCapabilityManifestBody();
    // The word "self-modify" name reads ambiguously to LLMs as "introspect
    // self". The bullet now spells out it is a *write* tool, not a read.
    expect(body).toMatch(/NOT for inspecting current runtime config/);
  });
});

describe('isCapabilityManifestEnabled', () => {
  it('defaults to true when env var is unset', () => {
    expect(isCapabilityManifestEnabled()).toBe(true);
  });

  it('respects the disable flag SUDO_CAPABILITY_MANIFEST=0', () => {
    process.env['SUDO_CAPABILITY_MANIFEST'] = '0';
    expect(isCapabilityManifestEnabled()).toBe(false);
  });

  it('stays enabled when env var has any non-zero value', () => {
    process.env['SUDO_CAPABILITY_MANIFEST'] = '1';
    expect(isCapabilityManifestEnabled()).toBe(true);
    process.env['SUDO_CAPABILITY_MANIFEST'] = 'true';
    expect(isCapabilityManifestEnabled()).toBe(true);
  });
});
