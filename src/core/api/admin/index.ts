/**
 * @file admin/index.ts
 * @description Admin handler registration entry-point.
 *
 * Import this module during application startup to activate all admin API
 * endpoints. Each handler file registers its routes with the shared
 * adminRouter singleton when imported.
 *
 * Example (in your app bootstrap):
 *   import { registerAdminHandlers } from './core/api/admin/index.js';
 *   await registerAdminHandlers();
 *
 * As real handler modules are built, add their dynamic imports here.
 * The adminRouter already carries stub routes for every endpoint — those
 * stubs will be automatically overridden when a real handler registers the
 * same path (first-registered wins, so import order matters).
 */

import { createLogger } from '../../shared/logger.js';

const log = createLogger('api:admin');

/**
 * Register all admin route handlers.
 * Safe to call multiple times — duplicate registrations are a no-op at the
 * module-cache level since dynamic imports are deduplicated by the runtime.
 */
export async function registerAdminHandlers(): Promise<void> {
  log.info('Registering admin API handlers');

  // Real handlers — each module self-registers its routes on import.
  // These must be imported AFTER admin-router.ts has registered stubs so that
  // the integrator can remove the corresponding stubs from admin-router.ts
  // and let these registrations become the authoritative first-match entries.
  await import('./dashboard.handler.js');
  await import('./logs.handler.js');
  await import('./system.handler.js');
  await import('./status.handler.js');
  await import('./usage.handler.js');
  // BO9 / S8 — sessions table (context fill + fork + archive-with-confirm).
  await import('./system-sessions.handler.js');

  // New handlers — tools, consciousness, security:
  await import('./tools.handler.js');
  await import('./consciousness.handler.js');
  await import('./security.handler.js');

  await import('./models.handler.js');
  await import('./channels.handler.js');
  await import('./cron.handler.js');
  await import('./settings.handler.js');
  await import('./sessions.handler.js');

  log.info('Admin API handlers registered');
}
