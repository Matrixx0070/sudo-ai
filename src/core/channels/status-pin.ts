/**
 * @file channels/status-pin.ts
 * @description TX6 — pinned live status card (flag `SUDO_TG_STATUS_PIN`, default OFF).
 *
 * One pinned, continuously-edited "◉ Sudo-Ai" message in the OWNER's DM:
 * current activity (idle / working, from the run-registry), background
 * summary (active cron jobs, failing jobs), today's API spend vs budget
 * (gateway ledger telemetry — zero LLM calls), and the last health incident.
 *
 * Layering (same discipline as status-card.ts):
 *   - {@link renderStatusPinCard} is PURE — snapshot struct → ≤12 markdown
 *     lines. Never throws, tolerates missing data.
 *   - {@link shouldBubbleHealthAlert} is PURE — the TX6 severity routing:
 *     severity-critical failures ALWAYS still bubble (never silently
 *     swallowed); everything else (high failures, recoveries) folds into
 *     the card when the flag is on.
 *   - {@link createMinGapThrottle} is PURE(ish) — clock-injected min-gap
 *     gate between edits.
 *   - {@link createStatusPinController} is the impure-but-injected glue:
 *     find-or-create the message (id persisted under data/ so it survives
 *     restarts), pin best-effort once, edit on a cadence plus event-driven
 *     bumps, all edits best-effort (any failure degrades silently).
 *
 * Telegram/bot calls stay OUT of this module — the cli wiring supplies
 * `send`/`edit`/`pin` callbacks, keeping this fully unit-testable.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createLogger } from '../shared/logger.js';

const log = createLogger('channels:status-pin');

// ---------------------------------------------------------------------------
// Snapshot struct + pure renderer
// ---------------------------------------------------------------------------

export interface StatusPinHealthIncident {
  severity: 'high' | 'critical';
  name: string;
  message: string;
  kind: 'failure' | 'recovery';
  atMs: number;
}

export interface StatusPinSnapshot {
  nowMs: number;
  activity: {
    /** Runs currently in flight (run-registry). */
    activeCount: number;
    /** Serialization key of the oldest active run, e.g. `telegram:123`. */
    oldestKey?: string;
    oldestStartedAtMs?: number;
  };
  cron: {
    enabledCount: number;
    failingCount: number;
    /** Name of one failing job (most recent scan order), if any. */
    lastFailureName?: string;
  };
  spend: {
    /** Today's ledger USD; null when the ledger read failed. */
    todayUsd: number | null;
    /** Daily cap (SUDO_DAILY_LLM_BUDGET_USD); null = enforcement off. */
    budgetUsd: number | null;
    model?: string;
  };
  health: {
    last?: StatusPinHealthIncident;
    /** Failure alerts folded into the card since boot. */
    foldedCount: number;
  };
  /**
   * Brain failover chain health. Optional so existing callers/tests keep
   * working; omitted = the line is not rendered.
   *
   * 2026-07-29: three of four profiles were down for hours (an Anthropic
   * org-level OAuth 403 → permanently disabled, plus 429 quota walls on google
   * and openai) with ollama/glm-5.2 carrying everything alone. Nothing surfaced
   * it — the pinned card cheerfully reported "Cron: 24 active · all green"
   * while the brain was one blip from total outage. Cron health was visible;
   * the thing that actually takes the product down was not.
   */
  brain?: {
    profileCount: number;
    /** Neither disabled nor cooling — profiles that can serve right now. */
    availableCount: number;
    /** Permanently disabled (auth_permanent, e.g. a 403 permission block). */
    disabledCount: number;
    /** In cooldown (rate limits, transient errors). */
    coolingCount: number;
    /**
     * ADR 0003 credential failure domains (profiles sharing one credential).
     * Slot counts overstate redundancy — 4 of 6 prod slots share ONE Anthropic
     * credential — so the card reports domains when the brain supplies them.
     * Optional: an older brain without profile.domain simply omits the counts.
     */
    domainCount?: number;
    /** Domains with at least one profile able to serve right now. */
    domainsUpCount?: number;
  };
}

function ago(nowMs: number, thenMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - thenMs) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** Render the pinned card. PURE, ≤12 lines, markdown ('md' format). */
export function renderStatusPinCard(s: StatusPinSnapshot): string {
  const lines: string[] = [];
  lines.push('◉ **Sudo-Ai** — live status');

  // Activity
  if (s.activity.activeCount > 0) {
    const oldest = s.activity.oldestKey
      ? ` — ${s.activity.oldestKey}${s.activity.oldestStartedAtMs != null ? ` · ${ago(s.nowMs, s.activity.oldestStartedAtMs)}` : ''}`
      : '';
    const extra = s.activity.activeCount > 1 ? ` (+${s.activity.activeCount - 1} more)` : '';
    lines.push(`🔶 working${oldest}${extra}`);
  } else {
    lines.push('🟢 idle');
  }

  // Brain chain — ABOVE cron deliberately: a dead chain is a total outage,
  // a failing cron job is not. Silent when every profile is healthy so the
  // card stays quiet in the normal case.
  if (s.brain) {
    const b = s.brain;
    const parts: string[] = [];
    if (b.disabledCount > 0) parts.push(`${b.disabledCount} disabled`);
    if (b.coolingCount > 0) parts.push(`${b.coolingCount} cooling`);
    const domains = b.domainCount != null && b.domainsUpCount != null
      ? ` · domains ${b.domainsUpCount}/${b.domainCount}`
      : '';
    if (b.availableCount === 0) {
      lines.push(`🧠 Brain: 🔴 NO provider available (${parts.join(', ') || `0/${b.profileCount}`})${domains}`);
    } else if (parts.length > 0) {
      // One failure DOMAIN left = one credential from total outage, even when
      // several slots look available; fall back to slot count without domain info.
      const warn = (b.domainsUpCount ?? b.availableCount) === 1 ? '⚠️ ' : '';
      lines.push(`🧠 Brain: ${warn}${b.availableCount}/${b.profileCount} available — ${parts.join(', ')}${domains}`);
    } else {
      lines.push(`🧠 Brain: ${b.availableCount}/${b.profileCount} providers${domains}`);
    }
  }

  // Background / cron
  const failing = s.cron.failingCount > 0
    ? ` · ⚠️ ${s.cron.failingCount} failing${s.cron.lastFailureName ? ` (${s.cron.lastFailureName})` : ''}`
    : ' · all green';
  lines.push(`⏰ Cron: ${s.cron.enabledCount} active${failing}`);

  // Spend vs budget
  const spent = s.spend.todayUsd != null ? `$${s.spend.todayUsd.toFixed(2)}` : '$?';
  const cap = s.spend.budgetUsd != null ? ` / $${s.spend.budgetUsd.toFixed(2)}` : ' (no cap)';
  lines.push(`💸 Today: ${spent}${cap}`);
  if (s.spend.model) lines.push(`🍪 ${s.spend.model}`);

  // Health
  if (s.health.last) {
    const h = s.health.last;
    const label = h.kind === 'recovery' ? 'recovered' : h.severity.toUpperCase();
    const count = s.health.foldedCount > 1 ? ` (×${s.health.foldedCount})` : '';
    lines.push(`🩺 ${h.name} ${label} ${ago(s.nowMs, h.atMs)} ago — ${h.message.slice(0, 120)}${count}`);
  } else {
    lines.push('🩺 no incidents');
  }

  const iso = new Date(s.nowMs).toISOString();
  lines.push(`_updated ${iso.slice(11, 16)} UTC_`);
  return lines.slice(0, 12).join('\n');
}

// ---------------------------------------------------------------------------
// Health-alert severity routing (TX6.3)
// ---------------------------------------------------------------------------

/**
 * TX6 severity mapping: should this watchdog alert still send a NEW bubble
 * even when the pinned card is live? Severity-critical FAILURES always
 * bubble (never silently swallowed). High failures and all recoveries fold
 * into the card only.
 */
export function shouldBubbleHealthAlert(
  severity: 'high' | 'critical',
  kind: 'failure' | 'recovery',
): boolean {
  return severity === 'critical' && kind === 'failure';
}

// ---------------------------------------------------------------------------
// Min-gap edit throttle
// ---------------------------------------------------------------------------

export interface MinGapThrottle {
  /** True (and stamps the clock) when a new edit is allowed now. */
  tryAcquire(): boolean;
  /** ms until the next acquire can succeed (0 = ready). */
  msUntilReady(): number;
}

/** Gate: at most one acquisition per `minGapMs`. Clock-injected for tests. */
export function createMinGapThrottle(minGapMs: number, now: () => number = Date.now): MinGapThrottle {
  let lastAt = 0; // epoch 0 → first acquire always succeeds
  return {
    tryAcquire(): boolean {
      const t = now();
      if (t - lastAt < minGapMs) return false;
      lastAt = t;
      return true;
    },
    msUntilReady(): number {
      return Math.max(0, minGapMs - (now() - lastAt));
    },
  };
}

// ---------------------------------------------------------------------------
// Persisted message identity (survives restarts)
// ---------------------------------------------------------------------------

interface PinState { chatId: string; messageId: string | number; }

export function readPinState(stateFile: string): PinState | null {
  try {
    const raw = JSON.parse(readFileSync(stateFile, 'utf8')) as Partial<PinState>;
    if (raw && typeof raw.chatId === 'string' && (typeof raw.messageId === 'string' || typeof raw.messageId === 'number')) {
      return { chatId: raw.chatId, messageId: raw.messageId };
    }
  } catch { /* missing/corrupt → recreate */ }
  return null;
}

export function writePinState(stateFile: string, state: PinState): void {
  try {
    mkdirSync(path.dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, JSON.stringify(state), 'utf8');
  } catch (err) {
    log.warn({ err: String(err) }, 'status-pin: state persist failed — will recreate after restart');
  }
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

/** What the cli wiring must supply. All channel calls live behind these. */
export interface StatusPinDeps {
  /** Owner DM chat id. */
  chatId: string;
  /** JSON file under data/ persisting {chatId, messageId}. */
  stateFile: string;
  /** Send a new message, return its message id. */
  send(chatId: string, text: string): Promise<string | number>;
  /** Edit an existing message (markdown-rendered by the adapter). */
  edit(chatId: string, messageId: string | number, text: string): Promise<void>;
  /** Pin a message (best-effort, called once on create). */
  pin(chatId: string, messageId: string | number): Promise<void>;
  /** Gather everything except health (controller owns health state). */
  collect(): Promise<Omit<StatusPinSnapshot, 'nowMs' | 'health'>>;
  /** Cadence between unconditional refreshes. Default 60s. */
  intervalMs?: number;
  /** Minimum gap between two edits. Default 15s. */
  minGapMs?: number;
  now?: () => number;
}

export interface StatusPinController {
  /** Find-or-create + pin the message, then start the cadence. Never throws. */
  start(): Promise<void>;
  stop(): void;
  /** Event-driven refresh request (run start/end etc.), min-gap throttled. */
  bump(reason: string): void;
  /**
   * Record a health alert into the card and request a refresh. Call for
   * EVERY alert (including criticals that also bubble) so the card's
   * "last incident" line stays truthful.
   */
  recordHealthAlert(severity: 'high' | 'critical', name: string, message: string, kind: 'failure' | 'recovery'): void;
  /** The live message id (null until start() succeeds). Test/debug seam. */
  readonly messageId: string | number | null;
}

export function createStatusPinController(deps: StatusPinDeps): StatusPinController {
  const intervalMs = deps.intervalMs ?? 60_000;
  const minGapMs = deps.minGapMs ?? 15_000;
  const now = deps.now ?? Date.now;
  const throttle = createMinGapThrottle(minGapMs, now);

  let messageId: string | number | null = null;
  let ticker: ReturnType<typeof setInterval> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let refreshing = false;
  let dirty = false;
  let stopped = false;
  let lastIncident: StatusPinHealthIncident | undefined;
  let foldedCount = 0;

  async function buildCard(): Promise<string> {
    const base = await deps.collect();
    const snapshot: StatusPinSnapshot = {
      ...base,
      nowMs: now(),
      health: { foldedCount, ...(lastIncident ? { last: lastIncident } : {}) },
    };
    return renderStatusPinCard(snapshot);
  }

  /** One best-effort edit, gated by the min-gap throttle. */
  async function refresh(): Promise<void> {
    if (stopped || messageId === null) return;
    if (refreshing) { dirty = true; return; }
    if (!throttle.tryAcquire()) {
      // Coalesce: retry once when the gap elapses.
      dirty = true;
      if (retryTimer === null) {
        retryTimer = setTimeout(() => {
          retryTimer = null;
          if (dirty) void refresh();
        }, throttle.msUntilReady() + 50);
        if (typeof retryTimer.unref === 'function') retryTimer.unref();
      }
      return;
    }
    refreshing = true;
    dirty = false;
    try {
      await deps.edit(deps.chatId, messageId, await buildCard());
    } catch (err) {
      log.debug({ err: String(err) }, 'status-pin: edit failed — degrading silently');
    } finally {
      refreshing = false;
    }
    if (dirty && !stopped) void refresh(); // coalesced update that arrived mid-edit
  }

  return {
    async start(): Promise<void> {
      try {
        const card = await buildCard();
        const saved = readPinState(deps.stateFile);
        if (saved && saved.chatId === deps.chatId) {
          try {
            await deps.edit(deps.chatId, saved.messageId, card);
            messageId = saved.messageId;
          } catch { /* stale/deleted message → recreate below */ }
        }
        if (messageId === null) {
          messageId = await deps.send(deps.chatId, card);
          writePinState(deps.stateFile, { chatId: deps.chatId, messageId });
          try { await deps.pin(deps.chatId, messageId); }
          catch (err) { log.debug({ err: String(err) }, 'status-pin: pin failed — card stays unpinned'); }
        }
        ticker = setInterval(() => { void refresh(); }, intervalMs);
        if (typeof ticker.unref === 'function') ticker.unref();
        log.info({ chatId: deps.chatId, messageId }, 'status-pin: live card started');
      } catch (err) {
        log.warn({ err: String(err) }, 'status-pin: start failed — running without pinned card');
      }
    },

    stop(): void {
      stopped = true;
      if (ticker !== null) { clearInterval(ticker); ticker = null; }
      if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null; }
    },

    bump(reason: string): void {
      log.debug({ reason }, 'status-pin: bump');
      void refresh();
    },

    recordHealthAlert(severity, name, message, kind): void {
      lastIncident = { severity, name, message, kind, atMs: now() };
      if (kind === 'failure') foldedCount++;
      void refresh();
    },

    get messageId(): string | number | null {
      return messageId;
    },
  };
}
