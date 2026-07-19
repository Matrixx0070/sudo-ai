/**
 * @file admin/status.handler.ts
 * @description BO7 / scorecard-S6 — admin API for the shared /status card.
 *
 * Route:
 *   GET /api/admin/system/status — the SAME status card Telegram + the web
 *   SPA render, as JSON, so the inline admin dashboard can show it as a card.
 *
 * Data is assembled by the single shared builder (`collectStatusCard`) reading
 * the runtime handles registered once at startup (`setStatusSources` in
 * `src/cli.ts`). No raw SQL here — the builder calls the S1 ledger/telemetry
 * helper. Fail-open: the builder never throws.
 */

import { adminRouter, sendJson } from '../admin-router.js';
import { createLogger } from '../../shared/logger.js';
import { collectStatusCard, getStatusSources } from '../../commands/builtin/status-card.js';

const log = createLogger('api:admin:status');

adminRouter.get('/api/admin/system/status', async (_req, res) => {
  log.debug('system/status requested');
  try {
    const card = await collectStatusCard(getStatusSources() ?? {});
    sendJson(res, 200, { ok: true, data: card });
  } catch (err) {
    log.warn({ err: String(err) }, 'system/status build failed');
    sendJson(res, 200, { ok: false, error: 'status unavailable' });
  }
});
