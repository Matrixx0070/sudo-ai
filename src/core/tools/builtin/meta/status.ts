/**
 * @file builtin/meta/status.ts
 * @description `meta.status` — lets the AGENT read its OWN live status: the same
 * card the `/status` command, the admin API and the pinned Telegram status card
 * render from, PLUS live activity (working/idle + active runs) from the run
 * registry. Before this, the agent could not see the pinned status card, so it
 * could not answer "are you working?", "what model are you on?", "how many jobs
 * are running?" accurately. Read-only.
 */

import { createLogger } from '../../../shared/logger.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';

const log = createLogger('tool:meta-status');

export const statusTool: ToolDefinition = {
  name: 'meta.status',
  description:
    "Read your own live operational status: whether you're idle or actively working (and on what), the active runs, current model/auth, token/cost/cache/context usage, uptime, session, and queue mode — the same data shown on the pinned Telegram status card and the /status command. Use this to answer questions about your own state.",
  category: 'meta',
  safety: 'readonly',
  timeout: 8_000,
  parameters: {},
  async execute(_params: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    // Live activity (working/idle + active runs) — the dynamic half the pin shows.
    let activityLine = '🟢 idle';
    const activeRuns: Array<{ key: string; ageMs: number }> = [];
    try {
      const { getRunRegistry } = await import('../../../agent/run-registry.js');
      const runs = getRunRegistry().list();
      if (runs.length > 0) {
        const now = Date.now();
        for (const r of runs) activeRuns.push({ key: r.key, ageMs: now - r.startedAt });
        const oldest = activeRuns.reduce((a, b) => (a.ageMs >= b.ageMs ? a : b));
        const secs = Math.floor(oldest.ageMs / 1000);
        const extra = runs.length > 1 ? ` (+${runs.length - 1} more)` : '';
        activityLine = `🔶 working — ${oldest.key} · ${secs}s${extra}`;
      }
    } catch (e) {
      log.debug({ err: String(e) }, 'meta.status: run registry unavailable');
    }

    // The shared status card (model/tokens/cost/cache/context/uptime/session/queue).
    let cardText = '';
    let card: unknown;
    try {
      const { collectStatusCard, getStatusSources, renderStatusCardText } = await import('../../../commands/builtin/status-card.js');
      card = await collectStatusCard(getStatusSources() ?? {});
      cardText = renderStatusCardText(card as Parameters<typeof renderStatusCardText>[0]);
    } catch (e) {
      log.warn({ err: String(e) }, 'meta.status: status card unavailable');
    }

    const output = cardText ? `${activityLine}\n\n${cardText}` : activityLine;
    return {
      success: true,
      output,
      data: { activity: activityLine, activeRuns, card },
    };
  },
};
