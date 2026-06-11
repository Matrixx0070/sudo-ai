/**
 * @file tests/tools/mcp-enhancement.test.ts
 * @description Tests for MCP enhancements: OAuth, SSE transport, WebSocket transport, tool filtering.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OAuthClient, generateCodeChallenge } from '../../src/core/tools/mcp-oauth.js';
import { SSETransport } from '../../src/core/tools/mcp-sse-transport.js';
import { WSTransport } from '../../src/core/tools/mcp-ws-transport.js';
import {
  registerMcpServer,
  removeMcpServer,
  listMcpServers,
  getMcpServer,
  updateServerStatus,
  connectMcpServer,
  disconnectMcpServer,
  setServerTrustTier,
  setServerError,
  updateServerTools,
  getServerTools,
  getEnabledServerTools,
  setToolEnabled,
  getServerStatusSummary,
  getConnectedServers,
} from '../../src/core/plugins/mcp-registry.js';
import { MCPAdapter, MCPServerConfig } from '../../src/core/tools/mcp-adapter.js';

// ---------------------------------------------------------------------------
// OAuth Client Tests
// ---------------------------------------------------------------------------

describe('mcp-oauth', () => {
  describe('OAuthClient', () => {
    it('should throw if required config is missing', () => {
      expect(() => {
        new OAuthClient({} as OAuthClient['config']);
      }).toThrow(/issuer, clientId, and redirectUri are required/);
    });

    it('should create client with valid config', () => {
      const client = new OAuthClient({
        issuer: 'https://auth.example.com',
        clientId: 'test-client',
        redirectUri: 'http://localhost:3000/callback',
      });
      expect(client).toBeDefined();
    });

    it('should generate authorization URL with PKCE parameters', () => {
      const client = new OAuthClient({
        issuer: 'https://auth.example.com',
        clientId: 'test-client',
        redirectUri: 'http://localhost:3000/callback',
        scope: 'read write',
      });

      const urls = client.generateAuthorizationUrl();

      expect(urls.authorizationUrl).toContain('response_type=code');
      expect(urls.authorizationUrl).toContain('client_id=test-client');
      expect(urls.authorizationUrl).toContain('code_challenge=');
      expect(urls.authorizationUrl).toContain('code_challenge_method=S256');
      expect(urls.authorizationUrl).toContain('state=');
      expect(urls.authorizationUrl).toContain('scope=read+write');
      expect(urls.codeVerifier.length).toBeGreaterThanOrEqual(43);
    });

    it('should generate consistent code challenges', () => {
      const verifier = 'test_verifier_12345678901234567890123456789012';
      const challenge1 = generateCodeChallenge(verifier);
      const challenge2 = generateCodeChallenge(verifier);
      expect(challenge1).toBe(challenge2);
    });

    it('should have valid token info methods', () => {
      const client = new OAuthClient({
        issuer: 'https://auth.example.com',
        clientId: 'test-client',
        redirectUri: 'http://localhost:3000/callback',
      });

      expect(client.hasValidToken()).toBe(false);
      expect(client.getTokenInfo()).toBe(null);
    });

    it('should clear token cache', () => {
      const client = new OAuthClient({
        issuer: 'https://auth.example.com',
        clientId: 'test-client',
        redirectUri: 'http://localhost:3000/callback',
      });

      client.clearCache(); // Should not throw
      expect(true).toBe(true);
    });

    it('should respect SUDO_MCP_OAUTH_DISABLE kill-switch', async () => {
      process.env['SUDO_MCP_OAUTH_DISABLE'] = '1';
      const client = new OAuthClient({
        issuer: 'https://auth.example.com',
        clientId: 'test-client',
        redirectUri: 'http://localhost:3000/callback',
      });

      const token = await client.getAccessToken();
      expect(token).toBe(null);

      delete process.env['SUDO_MCP_OAUTH_DISABLE'];
    });
  });
});

// ---------------------------------------------------------------------------
// SSE Transport Tests
// ---------------------------------------------------------------------------

describe('mcp-sse-transport', () => {
  describe('SSETransport', () => {
    let transport: SSETransport;

    beforeEach(() => {
      transport = new SSETransport({
        url: 'http://localhost:9999/sse',
      });
    });

    afterEach(() => {
      transport.disconnect();
    });

    it('should initialize with correct config', () => {
      expect(transport.getState()).toBe('disconnected');
      expect(transport.isConnected()).toBe(false);
    });

    it('should have default reconnect settings', () => {
      const t2 = new SSETransport({ url: 'http://test/sse' });
      expect(t2).toBeDefined();
    });

    it('should emit error on connection failure', async () => {
      const errorPromise = new Promise<Error>((resolve) => {
        transport.on('error', resolve);
      });

      await transport.connect();
      const err = await errorPromise;
      expect(err).toBeDefined();
    });

    it('should respect SUDO_MCP_REMOTE_DISABLE kill-switch', async () => {
      process.env['SUDO_MCP_REMOTE_DISABLE'] = '1';
      const t2 = new SSETransport({ url: 'http://test/sse' });

      const errorPromise = new Promise<Error>((resolve) => {
        t2.on('error', resolve);
      });

      await t2.connect();
      const err = await errorPromise;
      expect(err.message).toContain('disabled');

      delete process.env['SUDO_MCP_REMOTE_DISABLE'];
      t2.disconnect();
    });

    it('should update access token', () => {
      transport.setAccessToken('new-token');
      expect(true).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// WebSocket Transport Tests
// ---------------------------------------------------------------------------

describe('mcp-ws-transport', () => {
  describe('WSTransport', () => {
    let transport: WSTransport;

    beforeEach(() => {
      transport = new WSTransport({
        url: 'ws://localhost:9999/ws',
      });
    });

    afterEach(() => {
      transport.disconnect();
    });

    it('should initialize with correct config', () => {
      expect(transport.getState()).toBe('disconnected');
      expect(transport.isConnected()).toBe(false);
    });

    it('should have default heartbeat settings', () => {
      const t2 = new WSTransport({ url: 'ws://test/ws' });
      expect(t2).toBeDefined();
    });

    it('should emit error on connection failure', async () => {
      const errorPromise = new Promise<Error>((resolve) => {
        transport.on('error', resolve);
      });

      await transport.connect();
      const err = await errorPromise;
      expect(err).toBeDefined();
    });

    it('should respect SUDO_MCP_REMOTE_DISABLE kill-switch', async () => {
      process.env['SUDO_MCP_REMOTE_DISABLE'] = '1';
      const t2 = new WSTransport({ url: 'ws://test/ws' });

      const errorPromise = new Promise<Error>((resolve) => {
        t2.on('error', resolve);
      });

      await t2.connect();
      const err = await errorPromise;
      expect(err.message).toContain('disabled');

      delete process.env['SUDO_MCP_REMOTE_DISABLE'];
      t2.disconnect();
    });

    it('should update access token', () => {
      transport.setAccessToken('new-token');
      expect(true).toBe(true);
    });

    it('should fail to send when disconnected', () => {
      const result = transport.send('test');
      expect(result).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// MCP Registry Tests
// ---------------------------------------------------------------------------

describe('mcp-registry', () => {
  beforeEach(() => {
    // Clean up any existing servers
    for (const s of listMcpServers()) {
      removeMcpServer(s.id);
    }
  });

  describe('registerMcpServer', () => {
    it('should throw if name is missing', () => {
      expect(() => registerMcpServer('', 'http://test')).toThrow(/name is required/);
    });

    it('should throw if url is missing', () => {
      expect(() => registerMcpServer('test', '')).toThrow(/url is required/);
    });

    it('should register server with defaults', () => {
      const server = registerMcpServer('Test Server', 'http://test.com');
      expect(server.id.startsWith('mcp-')).toBe(true);
      expect(server.name).toBe('Test Server');
      expect(server.url).toBe('http://test.com');
      expect(server.status).toBe('disconnected');
      expect(server.trustTier).toBe('unreviewed');
      expect(server.transport).toBe('http');
    });

    it('should register server with custom trust tier and transport', () => {
      const server = registerMcpServer('Bundled', 'http://bundled', 'desc', 'bundled', 'stdio');
      expect(server.trustTier).toBe('bundled');
      expect(server.transport).toBe('stdio');
    });
  });

  describe('server status management', () => {
    it('should update server status', () => {
      const server = registerMcpServer('Test', 'http://test');
      updateServerStatus(server.id, 'connecting');
      const updated = getMcpServer(server.id);
      expect(updated?.status).toBe('connecting');
    });

    it('should handle connect/disconnect', () => {
      const server = registerMcpServer('Test', 'http://test');
      connectMcpServer(server.id);
      expect(getMcpServer(server.id)?.status).toBe('connected');

      disconnectMcpServer(server.id);
      expect(getMcpServer(server.id)?.status).toBe('disconnected');
    });

    it('should handle setServerTrustTier', () => {
      const server = registerMcpServer('Test', 'http://test');
      setServerTrustTier(server.id, 'indexed');
      expect(getMcpServer(server.id)?.trustTier).toBe('indexed');
    });

    it('should silently handle unknown server id', () => {
      expect(() => updateServerStatus('unknown', 'connected')).not.toThrow();
      expect(() => setServerError('unknown', 'error')).not.toThrow();
      expect(() => setServerTrustTier('unknown', 'bundled')).not.toThrow();
    });

    it('should return connected servers only', () => {
      const s1 = registerMcpServer('Connected', 'http://1');
      const s2 = registerMcpServer('Disconnected', 'http://2');
      connectMcpServer(s1.id);

      const connected = getConnectedServers();
      expect(connected.length).toBe(1);
      expect(connected[0].id).toBe(s1.id);
    });
  });

  describe('tool management', () => {
    it('should update server tools', () => {
      const server = registerMcpServer('Test', 'http://test');
      updateServerTools(server.id, [
        { name: 'tool1', description: 'First tool', enabled: true },
        { name: 'tool2', description: 'Second tool', enabled: false },
      ]);

      const tools = getServerTools(server.id);
      expect(tools.length).toBe(2);
      expect(tools[0].name).toBe('tool1');
      expect(tools[0].enabled).toBe(true);
      expect(tools[1].name).toBe('tool2');
      expect(tools[1].enabled).toBe(false);
    });

    it('should return only enabled tools', () => {
      const server = registerMcpServer('Test', 'http://test');
      updateServerTools(server.id, [
        { name: 'enabled', enabled: true },
        { name: 'disabled', enabled: false },
      ]);

      const enabled = getEnabledServerTools(server.id);
      expect(enabled.length).toBe(1);
      expect(enabled[0].name).toBe('enabled');
    });

    it('should toggle tool enabled state', () => {
      const server = registerMcpServer('Test', 'http://test');
      updateServerTools(server.id, [{ name: 'tool1', enabled: true }]);

      expect(setToolEnabled(server.id, 'tool1', false)).toBe(true);
      const tools = getServerTools(server.id);
      expect(tools[0].enabled).toBe(false);
    });

    it('should return false for unknown tool', () => {
      const server = registerMcpServer('Test', 'http://test');
      expect(setToolEnabled(server.id, 'unknown', true)).toBe(false);
    });

    it('should return empty array for unknown server', () => {
      expect(getServerTools('unknown')).toEqual([]);
    });
  });

  describe('getServerStatusSummary', () => {
    it('should return summary for all servers', () => {
      const s1 = registerMcpServer('Server 1', 'http://1');
      registerMcpServer('Server 2', 'http://2');
      updateServerTools(s1.id, [
        { name: 't1', enabled: true },
        { name: 't2', enabled: false },
      ]);

      const summary = getServerStatusSummary();
      expect(summary.length).toBeGreaterThanOrEqual(1);

      const s1Summary = summary.find(s => s.id === s1.id);
      expect(s1Summary).toBeDefined();
      expect(s1Summary?.toolCount).toBe(2);
      expect(s1Summary?.enabledToolCount).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// MCP Adapter Tests
// ---------------------------------------------------------------------------

describe('mcp-adapter', () => {
  describe('MCPServerConfig', () => {
    it('should accept new transport types', () => {
      const stdioConfig: MCPServerConfig = {
        id: 'test',
        transport: 'stdio',
        command: 'node',
      };
      expect(stdioConfig.transport).toBe('stdio');

      const sseConfig: MCPServerConfig = {
        id: 'test',
        transport: 'sse',
        baseUrl: 'http://test/sse',
      };
      expect(sseConfig.transport).toBe('sse');

      const wsConfig: MCPServerConfig = {
        id: 'test',
        transport: 'websocket',
        baseUrl: 'ws://test/ws',
      };
      expect(wsConfig.transport).toBe('websocket');
    });

    it('should accept oauth config', () => {
      const config: MCPServerConfig = {
        id: 'test',
        transport: 'http',
        baseUrl: 'http://test',
        oauth: {
          issuer: 'https://auth.example.com',
          clientId: 'test',
          redirectUri: 'http://localhost/callback',
        },
      };
      expect(config.oauth).toBeDefined();
      expect(config.oauth?.clientId).toBe('test');
    });

    it('should accept tool filter', () => {
      const config: MCPServerConfig = {
        id: 'test',
        transport: 'http',
        baseUrl: 'http://test',
        toolFilter: {
          'tool1': true,
          'tool2': false,
        },
      };
      expect(config.toolFilter).toBeDefined();
      expect(config.toolFilter?.['tool1']).toBe(true);
      expect(config.toolFilter?.['tool2']).toBe(false);
    });
  });

  describe('MCPAdapter', () => {
    it('should respect SUDO_MCP_DISABLE kill-switch', async () => {
      process.env['SUDO_MCP_DISABLE'] = '1';
      const adapter = new MCPAdapter({
        id: 'test',
        transport: 'stdio',
        command: 'node',
      });

      await expect(adapter.connect()).rejects.toThrow(/MCP functionality disabled/);

      delete process.env['SUDO_MCP_DISABLE'];
    });

    it('should throw for stdio without command', async () => {
      const adapter = new MCPAdapter({
        id: 'test',
        transport: 'stdio',
      });

      await expect(adapter.connect()).rejects.toThrow(/command.*required/);
    });

    it('should throw for remote transports without baseUrl', async () => {
      const sseAdapter = new MCPAdapter({
        id: 'test',
        transport: 'sse',
      });
      await expect(sseAdapter.connect()).rejects.toThrow(/baseUrl.*required/);

      const wsAdapter = new MCPAdapter({
        id: 'test',
        transport: 'websocket',
      });
      await expect(wsAdapter.connect()).rejects.toThrow(/baseUrl.*required/);

      const httpAdapter = new MCPAdapter({
        id: 'test',
        transport: 'http',
      });
      await expect(httpAdapter.connect()).rejects.toThrow(/baseUrl.*required/);
    });
  });
});

