import { describe, expect, it } from 'vitest';
import {
  isGatewayRouteOwnerAttached,
  markGatewayRouteOwnerAttached,
  markGatewayRouteOwnerDetached,
} from '../gateway/server.js';

/**
 * The server.ts fall-through allowlist consults this guard for /v1/events and
 * /v1/webhook-endpoints: pre-attach requests get a 503 instead of a hung
 * socket. initEventSystem marks 'events' attached; stop() detaches.
 */
describe('events route-owner boot guard', () => {
  it('attach/detach toggles the guard', () => {
    expect(isGatewayRouteOwnerAttached('events')).toBe(false);
    markGatewayRouteOwnerAttached('events');
    expect(isGatewayRouteOwnerAttached('events')).toBe(true);
    markGatewayRouteOwnerDetached('events');
    expect(isGatewayRouteOwnerAttached('events')).toBe(false);
  });
});
