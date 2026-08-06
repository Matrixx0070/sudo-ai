/**
 * @file tests/channels/channel-registry.test.ts
 * @description ADR 0010 D3 stage 1. The old `gatewayFinalize` expression in
 * cli.ts restated every channel's enablement by hand, so adding a channel and
 * forgetting that line meant it registered on the router and NEVER STARTED —
 * silently. These tests pin the derived behaviour and the config-lie doctor.
 */

import { describe, it, expect } from 'vitest';
import {
  GATEWAY_CHANNELS, isChannelEnabled, enabledChannelIds,
  anyGatewayChannelEnabled, describeChannelConfigIssues,
} from '../../src/core/channels/channel-registry.js';

const env = (o: Record<string, string>): NodeJS.ProcessEnv => o as NodeJS.ProcessEnv;
const decl = (id: string) => GATEWAY_CHANNELS.find((c) => c.id === id)!;

describe('enablement matches the behaviour the old expression encoded', () => {
  it('nothing set → no channel, no finalize', () => {
    expect(enabledChannelIds(env({}))).toEqual([]);
    expect(anyGatewayChannelEnabled(env({}))).toBe(false);
  });

  it('a single token enables exactly its own channel and triggers finalize', () => {
    expect(enabledChannelIds(env({ SLACK_BOT_TOKEN: 'x' }))).toEqual(['slack']);
    expect(anyGatewayChannelEnabled(env({ SLACK_BOT_TOKEN: 'x' }))).toBe(true);
  });

  it('whatsapp needs BOTH its flag and its token (as before)', () => {
    expect(isChannelEnabled(decl('whatsapp'), env({ WHATSAPP_TOKEN: 't' }))).toBe(false);
    expect(isChannelEnabled(decl('whatsapp'), env({ SUDO_WHATSAPP_ENABLE: '1' }))).toBe(false);
    expect(isChannelEnabled(decl('whatsapp'), env({ SUDO_WHATSAPP_ENABLE: '1', WHATSAPP_TOKEN: 't' }))).toBe(true);
  });

  it('irc/matrix need ALL their keys, not just one', () => {
    expect(isChannelEnabled(decl('irc'), env({ IRC_SERVER: 's' }))).toBe(false);
    expect(isChannelEnabled(decl('irc'), env({ IRC_SERVER: 's', IRC_NICK: 'n' }))).toBe(true);
    expect(isChannelEnabled(decl('matrix'), env({ MATRIX_HOMESERVER: 'h' }))).toBe(false);
    expect(isChannelEnabled(decl('matrix'), env({ MATRIX_HOMESERVER: 'h', MATRIX_ACCESS_TOKEN: 't' }))).toBe(true);
  });

  it('imessage is flag-only opt-in (never auto-starts on the wrong host)', () => {
    expect(isChannelEnabled(decl('imessage'), env({}))).toBe(false);
    expect(isChannelEnabled(decl('imessage'), env({ SUDO_IMESSAGE_ENABLE: '1' }))).toBe(true);
  });

  it('blank / whitespace values do not count as set', () => {
    expect(anyGatewayChannelEnabled(env({ SLACK_BOT_TOKEN: '   ' }))).toBe(false);
  });

  it('every declared channel can trigger finalize on its own — the property the hand-written expression kept breaking', () => {
    for (const c of GATEWAY_CHANNELS) {
      const e: Record<string, string> = {};
      if (c.enableFlag) e[c.enableFlag] = '1';
      for (const k of c.requiresAllOf ?? c.tokenEnvKeys.slice(0, 1)) e[k] = 'set';
      expect(anyGatewayChannelEnabled(env(e)), `${c.id} must trigger finalize`).toBe(true);
    }
  });
});

describe('the Discord config lie', () => {
  it('accepts the DOCUMENTED key, which previously did nothing', () => {
    // config/sudo-ai.json5 documents tokenEnvKey: 'DISCORD_BOT_TOKEN';
    // cli.ts read DISCORD_TOKEN. Setting the documented one was a no-op.
    expect(isChannelEnabled(decl('discord'), env({ DISCORD_BOT_TOKEN: 'x' }))).toBe(true);
  });
  it('still accepts the key the code has always read', () => {
    expect(isChannelEnabled(decl('discord'), env({ DISCORD_TOKEN: 'x' }))).toBe(true);
  });
});

describe('doctor: config keys the runtime never reads', () => {
  it('reports a documented key that is not read', () => {
    const issues = describeChannelConfigIssues({ slack: 'SLACK_LEGACY_TOKEN' });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('SLACK_LEGACY_TOKEN');
    expect(issues[0]).toContain('does nothing');
  });

  it('is silent for keys the runtime does read (incl. both Discord spellings)', () => {
    expect(describeChannelConfigIssues({
      discord: 'DISCORD_BOT_TOKEN', slack: 'SLACK_BOT_TOKEN',
    })).toEqual([]);
  });

  it('reports a configured channel the registry does not know', () => {
    const issues = describeChannelConfigIssues({ pigeon: 'PIGEON_TOKEN' });
    expect(issues[0]).toContain('never start');
  });

  it('ignores unset entries', () => {
    expect(describeChannelConfigIssues({ discord: undefined })).toEqual([]);
  });
});
