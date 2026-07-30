/**
 * @file morning-digest.ts
 * @description TX7 — the morning digest: one owner DM at a scheduled hour
 * summarising the last day in glanceable form (spend vs budget, cron health,
 * brain chain domains, active missions, checkpoints waiting on the owner).
 *
 * Pure renderer over an injected snapshot — every reader is a seam so the
 * digest never couples to store internals and tests need no daemon. Flag
 * SUDO_TG_MORNING_DIGEST=1 (default OFF); hour via SUDO_TG_DIGEST_HOUR_UTC
 * (default 7). Registered as a normal cron job in cli.ts, so it shows on the
 * Telemetry/cron surfaces like any recurring work (invariant 10 posture: a
 * digest run makes NO llm calls — it reads stores only).
 */

export interface DigestSnapshot {
  /** ISO date the digest covers (yesterday, UTC). */
  date: string;
  spend: { todayUsd: number | null; budgetUsd: number | null };
  cron: { enabledCount: number; failingCount: number; lastFailureName?: string };
  brain: { domainsUp: number; domainCount: number; disabledCount: number; coolingCount: number } | null;
  missions: Array<{ title: string; status: string }>;
  pendingCheckpoints: Array<{ kind: string; question: string }>;
  /** Health incidents folded since yesterday (0 = quiet night). */
  incidentCount: number;
}

export function morningDigestEnabled(): boolean {
  return process.env['SUDO_TG_MORNING_DIGEST'] === '1';
}

export function digestHourUtc(): number {
  const raw = Number(process.env['SUDO_TG_DIGEST_HOUR_UTC']);
  return Number.isInteger(raw) && raw >= 0 && raw <= 23 ? raw : 7;
}

/** Render the digest card (markdown). Pure. */
export function renderMorningDigest(s: DigestSnapshot): string {
  const lines: string[] = [`☀️ **Morning digest — ${s.date}**`, ''];

  const spent = s.spend.todayUsd != null ? `$${s.spend.todayUsd.toFixed(2)}` : '$?';
  const cap = s.spend.budgetUsd != null ? ` / $${s.spend.budgetUsd.toFixed(2)}` : '';
  lines.push(`💸 Spend: ${spent}${cap}`);

  const cronBad = s.cron.failingCount > 0
    ? ` · ⚠️ ${s.cron.failingCount} failing${s.cron.lastFailureName ? ` (${s.cron.lastFailureName})` : ''}`
    : ' · all green';
  lines.push(`⏰ Cron: ${s.cron.enabledCount} active${cronBad}`);

  if (s.brain) {
    const b = s.brain;
    const warn = b.domainsUp <= 1 ? '⚠️ ' : '';
    const degraded = b.disabledCount + b.coolingCount > 0
      ? ` (${b.disabledCount} disabled, ${b.coolingCount} cooling)` : '';
    lines.push(`🧠 Brain: ${warn}domains ${b.domainsUp}/${b.domainCount} up${degraded}`);
  }

  lines.push(s.incidentCount === 0 ? '🌙 Quiet night — no incidents' : `🚨 ${s.incidentCount} incident(s) overnight`);

  if (s.missions.length > 0) {
    lines.push('', '🎯 Missions:');
    for (const m of s.missions.slice(0, 5)) lines.push(`  • ${m.title} — ${m.status}`);
  }

  if (s.pendingCheckpoints.length > 0) {
    lines.push('', '🛂 **Waiting on you:**');
    for (const c of s.pendingCheckpoints.slice(0, 5)) lines.push(`  • [${c.kind}] ${c.question}`);
  }

  return lines.join('\n');
}

/** Reader seams — cli.ts wires the real stores. All fail-soft to defaults. */
export interface DigestReaders {
  spend?: () => { todayUsd: number | null; budgetUsd: number | null };
  cron?: () => { enabledCount: number; failingCount: number; lastFailureName?: string };
  brain?: () => DigestSnapshot['brain'];
  missions?: () => DigestSnapshot['missions'];
  pendingCheckpoints?: () => DigestSnapshot['pendingCheckpoints'];
  incidents?: () => number;
}

/** Assemble the snapshot from readers; each reader failure degrades to a default, never throws. */
export function buildDigestSnapshot(readers: DigestReaders, date: string): DigestSnapshot {
  const safe = <T>(fn: (() => T) | undefined, fallback: T): T => {
    try { return fn ? fn() : fallback; } catch { return fallback; }
  };
  return {
    date,
    spend: safe(readers.spend, { todayUsd: null, budgetUsd: null }),
    cron: safe(readers.cron, { enabledCount: 0, failingCount: 0 }),
    brain: safe(readers.brain, null),
    missions: safe(readers.missions, []),
    pendingCheckpoints: safe(readers.pendingCheckpoints, []),
    incidentCount: safe(readers.incidents, 0),
  };
}
