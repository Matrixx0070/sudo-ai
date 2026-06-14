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
