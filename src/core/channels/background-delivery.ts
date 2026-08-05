/**
 * @file channels/background-delivery.ts
 * @description Where autonomous output goes.
 *
 * ADR 0010 / D1. Background turns — the heartbeat, cron agent turns, autonomy
 * goals and standing orders — produced text that the caller then DISCARDED
 * (`cli.ts:3805` `await run(payload, job); return;`, and the same at :3812,
 * :5192, :5769). `heartbeat-response.ts` carefully strips HEARTBEAT_OK and
 * returns "the cleaned content if delivery is warranted"; nothing ever
 * delivered it. Unless the agent happened to call a send tool mid-turn,
 * everything it concluded on its own was thrown away — which is why autonomous
 * work has been invisible to the owner.
 *
 * OpenClaw treats this as a misconfiguration worth a doctor warning
 * (`doctor-heartbeat-session-target.ts`: "heartbeats will run but replies are
 * dropped silently"). We had no target concept at all. This module adds one:
 * resolve a target, deliver, or record a TYPED reason why not — so a silent
 * drop becomes an observable state instead of the default.
 *
 * Deliberately transport-agnostic: the sender is injected, so this module owns
 * policy (is there a target? is this worth sending?) and never a socket.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('channels:background-delivery');

/** Where a background turn's output should land. */
export type DeliveryTarget =
  | { kind: 'telegram'; chatId: string }
  | { kind: 'none'; reason: NoTargetReason };

/** Why background output cannot be delivered. Typed so doctor can explain it. */
export type NoTargetReason =
  | 'no-chat-id'        // TELEGRAM_CHAT_ID unset/empty
  | 'no-transport'      // no adapter wired (channel disabled at boot)
  | 'disabled';         // operator turned background delivery off

/** Outcome of one delivery attempt — returned for logging and tests. */
export type DeliveryOutcome =
  | { delivered: true; chars: number }
  | { delivered: false; reason: NoTargetReason | 'suppressed' | 'empty' | 'send-failed' };

/** Minimal sender surface (TelegramAdapter satisfies this). */
export interface BackgroundSender {
  send(chatId: string, text: string, opts?: { parseMode?: string }): Promise<unknown>;
}

/** Kill-switch: SUDO_BACKGROUND_DELIVERY=0 restores the old silent-drop behaviour. */
export function backgroundDeliveryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['SUDO_BACKGROUND_DELIVERY'] !== '0';
}

/**
 * Resolve where autonomous output should go. The owner's first configured
 * Telegram chat is the target — the same convention the morning digest and the
 * long-web-task notice already use ad hoc (cli.ts:6064, cli.ts:3152); this
 * makes it one shared decision instead of three copies.
 */
export function resolveDeliveryTarget(
  env: NodeJS.ProcessEnv = process.env,
  hasTransport = true,
): DeliveryTarget {
  if (!backgroundDeliveryEnabled(env)) return { kind: 'none', reason: 'disabled' };
  if (!hasTransport) return { kind: 'none', reason: 'no-transport' };
  const chatId = (env['TELEGRAM_CHAT_ID'] ?? '').split(',')[0]?.trim();
  if (!chatId) return { kind: 'none', reason: 'no-chat-id' };
  return { kind: 'telegram', chatId };
}

/** Cap so a runaway background turn cannot spam the owner's chat. */
const MAX_DELIVERY_CHARS = 3_500;

/**
 * Deliver one background result. Never throws — a delivery failure must not
 * fail the cron job that produced it.
 *
 * `label` prefixes the message so the owner can tell WHICH autonomous thing
 * spoke (previously indistinguishable from a normal reply).
 */
export async function deliverBackgroundOutput(params: {
  target: DeliveryTarget;
  sender: BackgroundSender | null;
  label: string;
  text: string | null | undefined;
}): Promise<DeliveryOutcome> {
  const { target, sender, label } = params;
  const text = (params.text ?? '').trim();

  if (!text) return { delivered: false, reason: 'empty' };
  if (target.kind === 'none') {
    // The interesting case: there WAS something to say and nowhere to say it.
    log.warn({ label, reason: target.reason, chars: text.length },
      'Background output produced but no delivery target — dropping (see doctor)');
    return { delivered: false, reason: target.reason };
  }
  if (!sender) return { delivered: false, reason: 'no-transport' };

  const body = text.length > MAX_DELIVERY_CHARS
    ? `${text.slice(0, MAX_DELIVERY_CHARS)}\n\n…(truncated)`
    : text;
  try {
    await sender.send(target.chatId, `🤖 ${label}\n\n${body}`);
    log.info({ label, chars: body.length, chatId: target.chatId }, 'Background output delivered');
    return { delivered: true, chars: body.length };
  } catch (err) {
    log.warn({ label, err: String(err) }, 'Background delivery send failed (non-fatal)');
    return { delivered: false, reason: 'send-failed' };
  }
}

/**
 * Doctor check (ADR 0010 D1): describe configurations where autonomous work
 * will run and its output can never reach anyone. Modelled on OpenClaw's
 * describeHeartbeatSessionTargetIssues — warning only, since fixing it means
 * expressing operator intent.
 */
export function describeBackgroundDeliveryIssues(params: {
  env?: NodeJS.ProcessEnv;
  hasTransport: boolean;
  /** Names of background jobs that are armed (heartbeat, cron, missions…). */
  activeBackgroundJobs: string[];
}): string[] {
  const env = params.env ?? process.env;
  const jobs = params.activeBackgroundJobs;
  if (jobs.length === 0) return [];

  const target = resolveDeliveryTarget(env, params.hasTransport);
  if (target.kind !== 'none') return [];

  const detail: Record<NoTargetReason, string> = {
    'no-chat-id': 'TELEGRAM_CHAT_ID is not set, so there is no owner chat to deliver to.',
    'no-transport': 'no messaging transport is wired at boot (the channel is disabled).',
    disabled: 'SUDO_BACKGROUND_DELIVERY=0 explicitly disables delivery.',
  };
  return [
    `Background jobs are armed (${jobs.join(', ')}) but their output cannot be delivered: ` +
    `${detail[target.reason]} These turns will still run and spend budget; anything they ` +
    'conclude will be dropped unless the agent sends it itself mid-turn.',
  ];
}
