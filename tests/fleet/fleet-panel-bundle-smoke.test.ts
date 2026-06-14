/**
 * @file tests/fleet/fleet-panel-bundle-smoke.test.ts
 * @description Gap #28c slice 3 — smoke check that the renderer bundle
 * contains the FleetPanel's references. The repo doesn't have RTL/jsdom
 * for React component unit testing; this is the lightest sentinel that
 * catches obvious bundle-time regressions (e.g. tree-shaking the panel
 * out, or the Dashboard wiring being removed by accident).
 *
 * The test is auto-skipped when no bundle is present — CI runs `pnpm
 * build` before `pnpm test`, but a local `pnpm test` without a build
 * shouldn't fail.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const ASSETS_DIR = path.resolve(__dirname, '../../dist/renderer/assets');

function readAdminBundle(): string | null {
  if (!existsSync(ASSETS_DIR)) return null;
  const adminFile = readdirSync(ASSETS_DIR).find((f) => f.startsWith('admin-') && f.endsWith('.js'));
  if (!adminFile) return null;
  return readFileSync(path.join(ASSETS_DIR, adminFile), 'utf8');
}

describe('FleetPanel bundle smoke (#28c slice 3)', () => {
  const bundle = readAdminBundle();

  it.skipIf(bundle === null)('FP-01: admin bundle references the fleet devices endpoint', () => {
    expect(bundle).toContain('/api/admin/fleet/devices');
  });

  it.skipIf(bundle === null)('FP-02: admin bundle references the dispatch endpoint', () => {
    expect(bundle).toContain('/api/admin/fleet/dispatch');
  });

  it.skipIf(bundle === null)('FP-03: admin bundle ships the supported command kinds', () => {
    expect(bundle).toContain('model.get');
    expect(bundle).toContain('model.set');
  });
});
