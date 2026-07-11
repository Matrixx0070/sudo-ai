/**
 * @file connector-registry-client.test.ts
 * @description Unit coverage for the connector catalog validator + env gates.
 */

import { describe, it, expect } from 'vitest';
import {
  validateConnectorEntry,
  isConnectorRegistryEnabled,
  connectorRegistryUrls,
} from '../../../src/core/skills/connector-registry-client.js';

describe('validateConnectorEntry', () => {
  it('accepts a live http connector with an env-key auth ref', () => {
    expect(validateConnectorEntry({
      name: 'github', transport: 'http', url: 'https://api.githubcopilot.com/mcp/',
      authEnvKey: 'GITHUB_MCP_PAT', live: true,
    })).toEqual([]);
  });

  it('accepts a live stdio connector', () => {
    expect(validateConnectorEntry({
      name: 'playwright', transport: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'], live: true,
    })).toEqual([]);
  });

  it('accepts a catalog-only (requiresOAuth) entry without a transport', () => {
    expect(validateConnectorEntry({ name: 'gmail', requiresOAuth: true, live: false })).toEqual([]);
  });

  it('rejects a live http connector with a non-https url', () => {
    expect(validateConnectorEntry({ name: 'x', transport: 'http', url: 'http://insecure/mcp', live: true }))
      .toContain('http connector needs an https url');
  });

  it('rejects a live connector missing a transport', () => {
    expect(validateConnectorEntry({ name: 'x', live: true }))
      .toContain('live connector needs transport "http" or "stdio"');
  });

  it('rejects a live stdio connector with no command', () => {
    expect(validateConnectorEntry({ name: 'x', transport: 'stdio', live: true }))
      .toContain('stdio connector needs a command');
  });

  it('rejects an authEnvKey that looks like a token value, not a name', () => {
    expect(validateConnectorEntry({ name: 'x', transport: 'http', url: 'https://a/mcp', live: true, authEnvKey: 'ghp_secret value' }))
      .toContain('authEnvKey must be a valid env-var NAME (never a token value)');
  });

  it('rejects a bad name and non-string args', () => {
    expect(validateConnectorEntry({ name: 'Bad Name!' })).toContain('invalid name');
    expect(validateConnectorEntry({ name: 'x', args: [1, 2] as unknown as string[] }))
      .toContain('args must be an array of strings');
  });
});

describe('connector registry env gates', () => {
  it('is enabled by default and disabled by SUDO_CONNECTOR_REGISTRY=0', () => {
    expect(isConnectorRegistryEnabled({} as NodeJS.ProcessEnv)).toBe(true);
    expect(isConnectorRegistryEnabled({ SUDO_CONNECTOR_REGISTRY: '0' } as unknown as NodeJS.ProcessEnv)).toBe(false);
  });

  it('puts the operator override URL first', () => {
    const urls = connectorRegistryUrls({ SUDO_CONNECTOR_REGISTRY_URL: 'https://example.com/c.json' } as unknown as NodeJS.ProcessEnv);
    expect(urls[0]).toBe('https://example.com/c.json');
    expect(urls).toContain('https://sudoapi.shop/connectors.json');
  });

  it('defaults to sudoapi.shop first', () => {
    expect(connectorRegistryUrls({} as NodeJS.ProcessEnv)[0]).toBe('https://sudoapi.shop/connectors.json');
  });
});
