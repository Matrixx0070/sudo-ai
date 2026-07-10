/**
 * TelegramAdapter command-intercept gate (_resolveCommandText): registered
 * commands dispatch (with Telegram's group "/cmd@BotName" form normalized to
 * our bot), unregistered slash text falls through to the agent handler, and
 * duck-typed registries without isRegisteredCommand keep legacy semantics.
 * Pure-logic tests without the grammy bot, per the internals() house pattern.
 */
import { describe, it, expect } from 'vitest';
import { TelegramAdapter } from '../../src/core/channels/telegram.js';
import { CommandRegistry } from '../../src/core/commands/registry.js';

interface InterceptInternals {
  _resolveCommandText(text: string): string | null;
  _commandRegistry: unknown;
  bot: unknown;
}

function internals(a: TelegramAdapter): InterceptInternals {
  return a as unknown as InterceptInternals;
}

function makeRegistry(): CommandRegistry {
  const r = new CommandRegistry();
  r.register({ name: 'help', description: 't', usage: '/help', execute: async () => 'ok' });
  return r;
}

describe('TelegramAdapter._resolveCommandText', () => {
  it('registered commands dispatch; unregistered slash text falls through', () => {
    const a = internals(new TelegramAdapter('TELEGRAM_BOT_TOKEN', ['1']));
    a._commandRegistry = makeRegistry();
    expect(a._resolveCommandText('/help now')).toBe('/help now');
    expect(a._resolveCommandText('/summarize this thread')).toBeNull();
    expect(a._resolveCommandText('plain text')).toBeNull();
  });

  it('strips /cmd@OurBot (case-insensitive) so group-chat commands finally match', () => {
    const a = internals(new TelegramAdapter('TELEGRAM_BOT_TOKEN', ['1']));
    a._commandRegistry = makeRegistry();
    a.bot = { botInfo: { username: 'SudoBot' } };
    expect(a._resolveCommandText('/help@SudoBot')).toBe('/help');
    expect(a._resolveCommandText('/help@sudobot with args')).toBe('/help with args');
    // A different bot's command is NOT ours — stays unregistered, falls through.
    expect(a._resolveCommandText('/help@OtherBot')).toBeNull();
  });

  it('no registry → null; duck-typed legacy registry (no isRegisteredCommand) → syntactic consume-all', () => {
    const a = internals(new TelegramAdapter('TELEGRAM_BOT_TOKEN', ['1']));
    expect(a._resolveCommandText('/help')).toBeNull();
    a._commandRegistry = { isCommand: (t: string) => t.trimStart().startsWith('/') };
    expect(a._resolveCommandText('/anything at all')).toBe('/anything at all');
  });
});
