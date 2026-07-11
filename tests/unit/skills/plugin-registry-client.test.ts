/**
 * @file plugin-registry-client.test.ts
 * @description Unit coverage for the plugin (role-bundle) catalog validator + gates.
 */

import { describe, it, expect } from 'vitest';
import {
  validatePluginEntry,
  isPluginRegistryEnabled,
  pluginRegistryUrls,
} from '../../../src/core/skills/plugin-registry-client.js';

describe('validatePluginEntry', () => {
  it('accepts a bundle with skills and connectors', () => {
    expect(validatePluginEntry({ name: 'engineering', skills: ['commit-message'], connectors: ['github'] })).toEqual([]);
  });

  it('accepts a skills-only bundle', () => {
    expect(validatePluginEntry({ name: 'writing', skills: ['email-polish', 'tldr'] })).toEqual([]);
  });

  it('rejects an empty bundle (no skills or connectors)', () => {
    expect(validatePluginEntry({ name: 'empty' })).toContain('bundle is empty (needs at least one skill or connector)');
  });

  it('rejects a bad name and non-string members', () => {
    expect(validatePluginEntry({ name: 'Bad Name!', skills: ['x'] })).toContain('invalid name');
    expect(validatePluginEntry({ name: 'x', skills: [1] as unknown as string[] })).toContain('skills must be an array of strings');
    expect(validatePluginEntry({ name: 'x', connectors: [1] as unknown as string[] })).toContain('connectors must be an array of strings');
  });
});

describe('plugin registry env gates', () => {
  it('is enabled by default and disabled by SUDO_PLUGIN_REGISTRY=0', () => {
    expect(isPluginRegistryEnabled({} as NodeJS.ProcessEnv)).toBe(true);
    expect(isPluginRegistryEnabled({ SUDO_PLUGIN_REGISTRY: '0' } as unknown as NodeJS.ProcessEnv)).toBe(false);
  });

  it('puts the operator override URL first and defaults to sudoapi.shop', () => {
    expect(pluginRegistryUrls({} as NodeJS.ProcessEnv)[0]).toBe('https://sudoapi.shop/plugins.json');
    expect(pluginRegistryUrls({ SUDO_PLUGIN_REGISTRY_URL: 'https://x/p.json' } as unknown as NodeJS.ProcessEnv)[0]).toBe('https://x/p.json');
  });
});
