/**
 * @file email-bridge.ts
 * @description Wiring seam so the email.* tools reach the running EmailAdapter's
 * IMAP client + draft-default send() without importing the adapter instance
 * (mirrors canvas/webhook bridges). The adapter registers implementations in
 * start(); tools call the exported accessors. Unregistered → tools report the
 * channel isn't connected.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('channels:email-bridge');

export interface EmailSearchCriteria { from?: string; subject?: string; unseen?: boolean; limit?: number }
export interface EmailSearchHit { uid: number; from: string; subject: string; date: string; snippet: string }
export interface EmailMessage { uid: number; from: string; to: string; subject: string; date: string; text: string; attachments: string[] }

export interface EmailBridgeDeps {
  search(criteria: EmailSearchCriteria): Promise<EmailSearchHit[]>;
  read(uid: number): Promise<EmailMessage | null>;
  /** Route a reply through the adapter's draft-default send(); `to` = address or threadId. */
  reply(to: string, text: string): Promise<{ ok: boolean; drafted: boolean; reason?: string }>;
}

let _deps: EmailBridgeDeps | null = null;

export function registerEmailBridge(deps: EmailBridgeDeps): void { _deps = deps; log.info('email bridge registered'); }
export function clearEmailBridge(): void { _deps = null; }
export function isEmailBridgeReady(): boolean { return _deps !== null; }
export function __resetEmailBridgeForTests(): void { _deps = null; }

const NOT_READY = 'email channel not connected (start the EmailAdapter — EMAIL_IMAP_* env required)';

export async function emailSearch(criteria: EmailSearchCriteria): Promise<{ ok: boolean; hits: EmailSearchHit[]; reason?: string }> {
  if (!_deps) return { ok: false, hits: [], reason: NOT_READY };
  try { return { ok: true, hits: await _deps.search(criteria) }; }
  catch (err) { return { ok: false, hits: [], reason: err instanceof Error ? err.message : String(err) }; }
}
export async function emailRead(uid: number): Promise<{ ok: boolean; message: EmailMessage | null; reason?: string }> {
  if (!_deps) return { ok: false, message: null, reason: NOT_READY };
  try { return { ok: true, message: await _deps.read(uid) }; }
  catch (err) { return { ok: false, message: null, reason: err instanceof Error ? err.message : String(err) }; }
}
export async function emailReply(to: string, text: string): Promise<{ ok: boolean; drafted: boolean; reason?: string }> {
  if (!_deps) return { ok: false, drafted: false, reason: NOT_READY };
  try { return await _deps.reply(to, text); }
  catch (err) { return { ok: false, drafted: false, reason: err instanceof Error ? err.message : String(err) }; }
}
