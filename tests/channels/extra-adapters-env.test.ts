/**
 * IRC / Matrix / Signal adapter construction — env credential requirements
 * that the cli.ts section 7.7 gate relies on. Constructors must throw a
 * ChannelError when required env vars are absent and construct cleanly
 * (disconnected) when present. No network.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { IRCAdapter } from '../../src/core/channels/irc.js';
import { MatrixAdapter } from '../../src/core/channels/matrix.js';
import { SignalAdapter } from '../../src/core/channels/signal.js';
import { ChannelError } from '../../src/core/shared/index.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('IRCAdapter env handling', () => {
  it('throws without IRC_SERVER / IRC_NICK', () => {
    vi.stubEnv('IRC_SERVER', '');
    vi.stubEnv('IRC_NICK', '');
    expect(() => new IRCAdapter()).toThrow(ChannelError);
  });

  it('constructs disconnected with credentials present', () => {
    vi.stubEnv('IRC_SERVER', 'irc.example.net');
    vi.stubEnv('IRC_NICK', 'sudobot');
    const a = new IRCAdapter();
    expect(a.channel).toBe('irc');
    expect(a.isConnected).toBe(false);
  });
});

describe('MatrixAdapter env handling', () => {
  it('throws without MATRIX_HOMESERVER / MATRIX_ACCESS_TOKEN', () => {
    vi.stubEnv('MATRIX_HOMESERVER', '');
    vi.stubEnv('MATRIX_ACCESS_TOKEN', '');
    expect(() => new MatrixAdapter()).toThrow(ChannelError);
  });

  it('constructs disconnected with credentials present', () => {
    vi.stubEnv('MATRIX_HOMESERVER', 'https://matrix.example.org/');
    vi.stubEnv('MATRIX_ACCESS_TOKEN', 'syt_test_token');
    const a = new MatrixAdapter();
    expect(a.channel).toBe('matrix');
    expect(a.isConnected).toBe(false);
  });
});

describe('SignalAdapter env handling', () => {
  it('throws without SIGNAL_PHONE_NUMBER', () => {
    vi.stubEnv('SIGNAL_PHONE_NUMBER', '');
    expect(() => new SignalAdapter()).toThrow(ChannelError);
  });

  it('constructs disconnected with credentials present', () => {
    vi.stubEnv('SIGNAL_PHONE_NUMBER', '+15550001111');
    const a = new SignalAdapter();
    expect(a.channel).toBe('signal');
    expect(a.isConnected).toBe(false);
  });
});
