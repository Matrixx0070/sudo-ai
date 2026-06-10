/**
 * @file tests/prediction/predictor-outcomes.test.ts
 * @description Predictor outcome learning loop: recordOutcome() return value,
 * resolveExpired() semantics, and the opt-in SUDO_PREDICTOR_AUTO_RESOLVE expiry
 * sweep (default OFF) that feeds getAccuracy() and un-blinds the accuracy
 * anomaly check. Also covers the meta.predictor 'record-outcome' tool action
 * validation paths.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Predictor, type Prediction } from '../../src/core/prediction/predictor.js';
import type { ToolContext } from '../../src/core/tools/types.js';

// meta/predictor.ts resolves MIND_DB from paths.ts at module load, so point
// SUDO_AI_HOME at a temp dir BEFORE importing the tool — otherwise the tool's
// singleton Predictor would create data/mind.db under the repo root. Nothing
// in the Predictor static import chain above loads paths.ts, so this
// top-level ordering is sufficient (vitest isolates module state per file).
const toolHome = mkdtempSync(join(tmpdir(), 'predictor-tool-home-'));
process.env['SUDO_AI_HOME'] = toolHome;
const { predictorTool } = await import('../../src/core/tools/builtin/meta/predictor.js');

afterAll(() => {
  rmSync(toolHome, { recursive: true, force: true });
});

const FLAG = 'SUDO_PREDICTOR_AUTO_RESOLVE';

function makePrediction(p: Partial<Prediction> = {}): Prediction {
  return {
    id: randomUUID(),
    type: 'schedule',
    prediction: 'test prediction',
    confidence: 0.8,
    reasoning: 'test reasoning',
    outcome: 'pending',
    createdAt: new Date().toISOString(),
    ...p,
  };
}

function isoHoursFromNow(hours: number): string {
  return new Date(Date.now() + hours * 3_600_000).toISOString();
}

const ctx = { sessionId: 'test-session' } as ToolContext;

describe('Predictor outcome learning loop', () => {
  let dir: string;
  let predictor: Predictor;
  let savedFlag: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'predictor-outcomes-'));
    predictor = new Predictor(join(dir, 'mind.db'));
    savedFlag = process.env[FLAG];
    delete process.env[FLAG];
  });

  afterEach(() => {
    if (savedFlag === undefined) delete process.env[FLAG];
    else process.env[FLAG] = savedFlag;
    rmSync(dir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // recordOutcome
  // -------------------------------------------------------------------------

  it('OUT-1: recordOutcome returns true for a stored prediction and updates accuracy', () => {
    const p = makePrediction();
    predictor.storePrediction(p);

    expect(predictor.recordOutcome(p.id, 'correct')).toBe(true);

    const stats = predictor.getAccuracy();
    expect(stats).toEqual({ total: 1, correct: 1, rate: 100 });
  });

  it('OUT-2: recordOutcome returns false for an unknown prediction id', () => {
    expect(predictor.recordOutcome(randomUUID(), 'incorrect')).toBe(false);
    expect(predictor.getAccuracy().total).toBe(0);
  });

  it('OUT-3: recordOutcome rejects invalid arguments', () => {
    expect(() => predictor.recordOutcome('', 'correct')).toThrow(TypeError);
    expect(() =>
      predictor.recordOutcome(randomUUID(), 'maybe' as unknown as 'correct'),
    ).toThrow(TypeError);
  });

  // -------------------------------------------------------------------------
  // resolveExpired
  // -------------------------------------------------------------------------

  it('RES-1: resolveExpired marks only expired pending predictions as incorrect', () => {
    const expired = makePrediction({ expiresAt: isoHoursFromNow(-1) });
    const future = makePrediction({ expiresAt: isoHoursFromNow(+24) });
    const noExpiry = makePrediction({ expiresAt: undefined });
    const alreadyCorrect = makePrediction({ expiresAt: isoHoursFromNow(-1), outcome: 'correct' });
    for (const p of [expired, future, noExpiry, alreadyCorrect]) predictor.storePrediction(p);

    expect(predictor.resolveExpired()).toBe(1);

    const byId = new Map(predictor.getRecentPredictions(50).map(p => [p.id, p.outcome]));
    expect(byId.get(expired.id)).toBe('incorrect');
    expect(byId.get(future.id)).toBe('pending');
    expect(byId.get(noExpiry.id)).toBe('pending');
    expect(byId.get(alreadyCorrect.id)).toBe('correct');
  });

  it('RES-2: resolveExpired is idempotent', () => {
    predictor.storePrediction(makePrediction({ expiresAt: isoHoursFromNow(-1) }));
    expect(predictor.resolveExpired()).toBe(1);
    expect(predictor.resolveExpired()).toBe(0);
  });

  // -------------------------------------------------------------------------
  // SUDO_PREDICTOR_AUTO_RESOLVE sweep (default OFF)
  // -------------------------------------------------------------------------

  it('FLAG-off: anticipate() does NOT resolve expired predictions by default', async () => {
    const expired = makePrediction({ expiresAt: isoHoursFromNow(-1) });
    predictor.storePrediction(expired);

    await predictor.anticipate();

    const row = predictor.getRecentPredictions(50).find(p => p.id === expired.id);
    expect(row?.outcome).toBe('pending');
    expect(predictor.getAccuracy().total).toBe(0);
  });

  it('FLAG-on: anticipate() sweeps expired predictions into accuracy stats', async () => {
    process.env[FLAG] = '1';
    const expired = makePrediction({ expiresAt: isoHoursFromNow(-1) });
    predictor.storePrediction(expired);

    await predictor.anticipate();

    const row = predictor.getRecentPredictions(50).find(p => p.id === expired.id);
    expect(row?.outcome).toBe('incorrect');
    expect(predictor.getAccuracy()).toEqual({ total: 1, correct: 0, rate: 0 });
  });

  it('FLAG-on: detectAnomalies() sweeps first, un-blinding the accuracy anomaly', async () => {
    process.env[FLAG] = '1';
    // 5 expired pending predictions → after sweep: 5 resolved, 0% accuracy,
    // which trips the prediction_accuracy anomaly (total >= 5, rate < 40).
    for (let i = 0; i < 5; i++) {
      predictor.storePrediction(makePrediction({ expiresAt: isoHoursFromNow(-1) }));
    }

    const anomalies = await predictor.detectAnomalies();

    const acc = anomalies.find(a => a.metric === 'prediction_accuracy');
    expect(acc).toBeDefined();
    expect(acc?.severity).toBe('critical');
    expect(predictor.getAccuracy().total).toBe(5);
  });

  it('FLAG-off: detectAnomalies() stays blind (no accuracy anomaly without outcomes)', async () => {
    for (let i = 0; i < 5; i++) {
      predictor.storePrediction(makePrediction({ expiresAt: isoHoursFromNow(-1) }));
    }

    const anomalies = await predictor.detectAnomalies();

    expect(anomalies.find(a => a.metric === 'prediction_accuracy')).toBeUndefined();
    expect(predictor.getAccuracy().total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// meta.predictor record-outcome action — validation paths only.
// (Happy path is covered above via the Predictor directly; the tool uses a
// process-wide singleton, isolated to a temp SUDO_AI_HOME at the top of this
// file, so these tests stick to validation/not-found paths.)
// ---------------------------------------------------------------------------

describe('meta.predictor record-outcome action', () => {
  it('TOOL-1: record-outcome is an accepted action in the schema enum', () => {
    const actionParam = predictorTool.parameters['action'] as { enum?: string[] };
    expect(actionParam.enum).toContain('record-outcome');
  });

  it('TOOL-2: missing predictionId is rejected', async () => {
    const res = await predictorTool.execute({ action: 'record-outcome', outcome: 'correct' }, ctx);
    expect(res.success).toBe(false);
    expect(res.output).toContain('predictionId');
  });

  it('TOOL-3: invalid outcome is rejected', async () => {
    const res = await predictorTool.execute(
      { action: 'record-outcome', predictionId: randomUUID(), outcome: 'maybe' },
      ctx,
    );
    expect(res.success).toBe(false);
    expect(res.output).toContain('outcome');
  });

  it('TOOL-4: unknown prediction id reports not-found without throwing', async () => {
    const res = await predictorTool.execute(
      { action: 'record-outcome', predictionId: randomUUID(), outcome: 'correct' },
      ctx,
    );
    expect(res.success).toBe(false);
    expect(res.output).toContain('No prediction found');
  });
});
