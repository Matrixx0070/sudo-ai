/**
 * @file channels/channel-registry.ts
 * @description Declare each gateway channel ONCE.
 *
 * ADR 0010 / D3, stage 1. Adding a channel to `cli.ts` is a two-place edit: the
 * adapter block, and the `gatewayFinalize` expression that re-derives every
 * channel's enablement BY HAND:
 *
 *   const gatewayFinalize =
 *     extraChannelEnv.irc || extraChannelEnv.matrix || … ||
 *     Boolean(process.env['DISCORD_TOKEN']) || Boolean(process.env['SLACK_BOT_TOKEN']) || …
 *
 * Miss the second and the channel registers on the router and **never starts** —
 * a silent failure with no error anywhere. This module makes the declaration the
 * single source: `cli.ts` asks the registry instead of restating the list.
 *
 * It also closes a live config lie the audit found: `config/sudo-ai.json5`
 * documents Discord as `tokenEnvKey: 'DISCORD_BOT_TOKEN'` while `cli.ts` reads
 * `DISCORD_TOKEN`, so setting the documented variable does nothing. The
 * declaration below accepts BOTH, and the doctor reports any channel whose
 * documented key is not one the code actually reads.
 *
 * Scope note: this stage owns *declaration and enablement* only. Adapter
 * construction stays in `cli.ts` until a later stage — one capability family
 * per PR, each shipping green (ADR 0010, D3).
 */

/** One gateway-managed channel. */
export interface ChannelDeclaration {
  id: string;
  /** Env keys that switch this channel on. ANY present (and truthy) enables it. */
  tokenEnvKeys: string[];
  /**
   * Extra keys that must ALSO be set (e.g. IRC needs server AND nick).
   * Empty means `tokenEnvKeys` alone is sufficient.
   */
  requiresAllOf?: string[];
  /** An explicit opt-in flag that must equal '1' (host-sensitive channels). */
  enableFlag?: string;
  /** Human note for the doctor output. */
  note?: string;
}

/**
 * Every channel the gateway finalize step must account for. Keep this list —
 * not an expression in cli.ts — as the place a channel is declared.
 */
export const GATEWAY_CHANNELS: readonly ChannelDeclaration[] = [
  // DISCORD_BOT_TOKEN is what config/sudo-ai.json5 documents; DISCORD_TOKEN is
  // what the code has always read. Accept both so the documented name works.
  { id: 'discord', tokenEnvKeys: ['DISCORD_TOKEN', 'DISCORD_BOT_TOKEN'] },
  { id: 'slack', tokenEnvKeys: ['SLACK_BOT_TOKEN'] },
  { id: 'whatsapp', tokenEnvKeys: ['WHATSAPP_TOKEN'], enableFlag: 'SUDO_WHATSAPP_ENABLE' },
  { id: 'email', tokenEnvKeys: ['EMAIL_IMAP_USER'] },
  { id: 'sms', tokenEnvKeys: ['TWILIO_ACCOUNT_SID'] },
  { id: 'irc', tokenEnvKeys: ['IRC_SERVER'], requiresAllOf: ['IRC_SERVER', 'IRC_NICK'] },
  { id: 'matrix', tokenEnvKeys: ['MATRIX_HOMESERVER'], requiresAllOf: ['MATRIX_HOMESERVER', 'MATRIX_ACCESS_TOKEN'] },
  { id: 'signal', tokenEnvKeys: ['SIGNAL_PHONE_NUMBER'] },
  {
    id: 'imessage', tokenEnvKeys: [], enableFlag: 'SUDO_IMESSAGE_ENABLE',
    note: 'macOS-only (polls chat.db, needs Full Disk Access); opt-in so it never auto-starts on the wrong host',
  },
];

function present(env: NodeJS.ProcessEnv, key: string): boolean {
  return Boolean(env[key]?.trim());
}

/** Is this channel switched on by the current environment? */
export function isChannelEnabled(decl: ChannelDeclaration, env: NodeJS.ProcessEnv = process.env): boolean {
  if (decl.enableFlag && env[decl.enableFlag] !== '1') return false;
  if (decl.requiresAllOf && !decl.requiresAllOf.every((k) => present(env, k))) return false;
  // A flag-only channel (imessage) has no token keys — the flag alone enables it.
  if (decl.tokenEnvKeys.length === 0) return Boolean(decl.enableFlag);
  return decl.tokenEnvKeys.some((k) => present(env, k));
}

/** Ids of every enabled gateway channel. */
export function enabledChannelIds(env: NodeJS.ProcessEnv = process.env): string[] {
  return GATEWAY_CHANNELS.filter((c) => isChannelEnabled(c, env)).map((c) => c.id);
}

/**
 * Whether the gateway finalize step must run. Replaces the hand-written
 * expression in cli.ts, so a newly declared channel is included automatically.
 */
export function anyGatewayChannelEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return GATEWAY_CHANNELS.some((c) => isChannelEnabled(c, env));
}

/**
 * Doctor: report channels whose documented config key is not one the runtime
 * reads. `configuredKeys` maps channel id → the `tokenEnvKey` declared in
 * config/sudo-ai.json5. Setting a key nobody reads is silent dead config.
 */
export function describeChannelConfigIssues(
  configuredKeys: Record<string, string | undefined>,
): string[] {
  const issues: string[] = [];
  for (const [id, key] of Object.entries(configuredKeys)) {
    if (!key) continue;
    const decl = GATEWAY_CHANNELS.find((c) => c.id === id);
    if (!decl) {
      issues.push(`config declares channel "${id}" which the gateway registry does not know — it will never start.`);
      continue;
    }
    if (decl.tokenEnvKeys.length > 0 && !decl.tokenEnvKeys.includes(key)) {
      issues.push(
        `config documents ${id} token as ${key}, but the runtime reads ` +
        `${decl.tokenEnvKeys.join(' or ')} — setting ${key} alone does nothing.`,
      );
    }
  }
  return issues;
}
