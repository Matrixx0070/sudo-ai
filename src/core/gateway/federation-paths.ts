/**
 * @file gateway/federation-paths.ts
 * @description Canonical set of all known /v1/federation/* request paths,
 * shared by federation-routes.ts and federation-error-routes.ts.
 *
 * Both routers attach independent `server.on('request')` listeners and each
 * handles only a disjoint subset of these paths. For an unmatched federation
 * path a router must decide whether to 404 or defer to its sibling: it can only
 * safely 404 a path that NO federation router owns, otherwise it would clobber
 * the sibling's (possibly async) response for a known path. This set is that
 * single source of truth — a `/v1/federation/*` path absent from it is owned by
 * nobody and is safe to 404 (guarded by res.headersSent so the first router to
 * reach its unmatched branch wins and the others no-op, avoiding a double send).
 */
export const FEDERATION_KNOWN_PATHS: ReadonlySet<string> = new Set([
  // Owned by federation-routes.ts
  '/v1/federation/audit/ingest',
  '/v1/federation/audit/tail',
  '/v1/federation/public-key',
  '/v1/federation/peers',
  '/v1/federation/stats',
  // Owned by federation-error-routes.ts
  '/v1/federation/error-report',
  '/v1/federation/fix-notify',
  '/v1/federation/token-contribute',
  '/v1/federation/error-reports',
  '/v1/federation/token-pool',
]);
