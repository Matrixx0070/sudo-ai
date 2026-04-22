/**
 * Test fixtures for SUDO-AI v3 test suite.
 * Export valid and invalid config objects plus a mock environment variable map.
 */

import type { SudoConfig } from '../../src/core/config/types.js';

// ---------------------------------------------------------------------------
// Valid config fixture
// ---------------------------------------------------------------------------

export const validConfig: SudoConfig = {
  meta: {
    name: 'TestAgent',
    timezone: 'UTC',
  },
  agents: {
    maxIterations: 10,
    systemPrompt: 'You are a test assistant.',
  },
  models: {
    primary: [
      {
        id: 'xai/grok-3-fast',
        contextWindow: 131072,
        maxOutputTokens: 8192,
        temperature: 0.7,
      },
    ],
    fallback: {
      id: 'openai/gpt-4o-mini',
      contextWindow: 128000,
      maxOutputTokens: 4096,
      temperature: 0.5,
    },
    embedding: {
      id: 'openai/text-embedding-3-small',
      dims: 1536,
    },
  },
  auth: {
    xai: { envKey: 'XAI_API_KEY' },
    openai: { envKey: 'OPENAI_API_KEY' },
    anthropic: { envKey: 'ANTHROPIC_API_KEY' },
    google: { envKey: 'GEMINI_API_KEY' },
  },
  channels: {
    telegram: {
      enabled: false,
      tokenEnvKey: 'TELEGRAM_BOT_TOKEN',
      allowedUsers: [],
    },
    whatsapp: {
      enabled: false,
      sessionPath: 'data/whatsapp-session',
      allowedJids: [],
    },
    discord: {
      enabled: false,
      tokenEnvKey: 'DISCORD_BOT_TOKEN',
      allowedChannelIds: [],
    },
  },
  tools: {
    disabled: [],
    browser: {
      headless: true,
      timeoutMs: 30000,
    },
  },
  cron: {
    jobs: [],
  },
  gateway: {
    enabled: false,
    port: 3001,
    allowedHosts: ['localhost'],
    secretEnvKey: 'GATEWAY_SECRET',
  },
};

// ---------------------------------------------------------------------------
// Invalid config fixture — missing required fields
// ---------------------------------------------------------------------------

export const invalidConfig: Partial<SudoConfig> = {
  // meta is missing name (required, minLength:1) and timezone
  meta: {
    name: '',        // violates minLength: 1
    timezone: 'UTC',
  },
  // agents is completely absent
} as unknown as Partial<SudoConfig>;

// Config that is entirely missing required top-level sections
export const emptyConfig = {};

// Config with type mismatches
export const typeMismatchConfig = {
  meta: {
    name: 123,       // should be string
    timezone: 'UTC',
  },
  agents: {
    maxIterations: -5,   // should be >= 1 (PosInt)
    systemPrompt: '',    // empty string OK since schema uses Type.String not Str
  },
};

// ---------------------------------------------------------------------------
// Test environment variables
// ---------------------------------------------------------------------------

export const testEnv: Record<string, string> = {
  XAI_API_KEY: 'test-xai-key-abc123',
  OPENAI_API_KEY: 'test-openai-key-xyz789',
  ANTHROPIC_API_KEY: 'test-anthropic-key-def456',
  GEMINI_API_KEY: 'test-gemini-key-ghi012',
  TELEGRAM_BOT_TOKEN: 'test-telegram-token',
  DISCORD_BOT_TOKEN: 'test-discord-token',
  GATEWAY_SECRET: 'test-gateway-secret',
};
