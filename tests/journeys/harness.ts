/**
 * @file tests/journeys/harness.ts
 * @description GW-13 — scenario-journey harness helpers.
 *
 * The journeys assert on OBSERVABLE ARTIFACTS (SQLite rows, sentinel files,
 * outbox states) across a simulated process boundary — not on internals. This
 * module gives each journey an isolated on-disk DATA_DIR (so the durable outbox
 * and the restart sentinel write real files, and a "restart" is modelled by
 * re-opening the same directory with fresh objects), plus small assertion
 * helpers. Everything is in-process under vitest; the Docker wrapper
 * (docker-compose.journeys.yml) is only the CI isolation vehicle — the harness
 * itself is what proves the behavior.
 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface JourneyEnv {
  /** Isolated data dir for this journey (mimics the daemon's DATA_DIR). */
  dataDir: string;
  /** On-disk outbox DB path — survives a simulated restart. */
  outboxDbPath: string;
  /** Sentinel dir (data/restart) — survives a simulated restart. */
  restartDir: string;
  cleanup(): void;
}

export function makeJourneyEnv(label: string): JourneyEnv {
  const dataDir = mkdtempSync(path.join(tmpdir(), `journey-${label}-`));
  const restartDir = path.join(dataDir, 'restart');
  return {
    dataDir,
    outboxDbPath: path.join(dataDir, 'outbox.db'),
    restartDir,
    cleanup: () => rmSync(dataDir, { recursive: true, force: true }),
  };
}

/** True once the successor has published readiness and cleared the intent. */
export function handoffCompleted(restartDir: string): boolean {
  return (
    existsSync(path.join(restartDir, 'ready.json')) &&
    !existsSync(path.join(restartDir, 'intent.json'))
  );
}
