/**
 * @file scenario.ts
 * @description Eval-sandbox scenario manifest types + strict validator (ADR-0007
 * Phase 0). Validation uses TypeBox, the same style as the config loader
 * (src/core/config/loader.ts) — no new dependency.
 */

import { readFileSync } from 'node:fs';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { load as parseYaml } from 'js-yaml';

// ---------------------------------------------------------------------------
// Grading checks (Verifiability rungs 0–3 — code-graded only in Phase 1)
// ---------------------------------------------------------------------------

const CheckSchema = Type.Union([
  Type.Object({ type: Type.Literal('fileExists'), path: Type.String() }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('fileContains'), path: Type.String(), substring: Type.String() }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('outputContains'), substring: Type.String() }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('outputMatches'), regex: Type.String() }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('commandExitZero'), command: Type.String() }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('toolCalled'), name: Type.String() }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('toolNotCalled'), name: Type.String() }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('canaryClean') }, { additionalProperties: false }),
]);

// ---------------------------------------------------------------------------
// Scenario manifest
// ---------------------------------------------------------------------------

const ScenarioSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    version: Type.String({ minLength: 1 }),
    title: Type.String({ minLength: 1 }),
    taskType: Type.Union([
      Type.Literal('coding'),
      Type.Literal('browser'),
      Type.Literal('restricted-resource'),
      Type.Literal('credential-canary'),
      Type.Literal('unreliable-service'),
      Type.Literal('recovery-drill'),
    ]),
    prompt: Type.String({ minLength: 1 }),
    fixtures: Type.Optional(Type.Array(
      Type.Object({ path: Type.String({ minLength: 1 }), content: Type.String() }, { additionalProperties: false }),
    )),
    policy: Type.Optional(Type.Object(
      {
        tools: Type.Optional(Type.Object(
          {
            allow: Type.Optional(Type.Array(Type.String())),
            deny: Type.Optional(Type.Array(Type.String())),
          },
          { additionalProperties: false },
        )),
        egressAllowlist: Type.Optional(Type.Array(Type.String())),
        env: Type.Optional(Type.Record(Type.String(), Type.String())),
        canaryCredentials: Type.Optional(Type.Array(
          Type.Object({ name: Type.String({ minLength: 1 }), value: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
        )),
      },
      { additionalProperties: false },
    )),
    grading: Type.Object(
      { checks: Type.Array(CheckSchema, { minItems: 1 }) },
      { additionalProperties: false },
    ),
    budgets: Type.Object(
      {
        maxUsd: Type.Number({ minimum: 0 }),
        maxSteps: Type.Integer({ minimum: 1 }),
        maxWallMs: Type.Integer({ minimum: 1 }),
      },
      { additionalProperties: false },
    ),
    /** Path to a mind.db snapshot to seed persistent memory. Absent = clean state. */
    persistentMemory: Type.Optional(Type.String()),
    // 'runsc' is validated + recorded here but only ENFORCED in Phase 2 (gVisor
    // runtime class per ADR-0007) — Phase 1 runs everything under runc.
    isolation: Type.Optional(Type.Union([Type.Literal('runc'), Type.Literal('runsc')])),
    /** Unreliable-service fault script: local mock HTTP server (mock-service.ts). */
    mockService: Type.Optional(Type.Object(
      {
        failuresBeforeSuccess: Type.Integer({ minimum: 0 }),
        successBody: Type.String(),
      },
      { additionalProperties: false },
    )),
  },
  { additionalProperties: false },
);

export type Scenario = Static<typeof ScenarioSchema>;
export type ScenarioPolicy = NonNullable<Scenario['policy']>;
export type GradingCheck = Static<typeof CheckSchema>;

export type ScenarioValidation =
  | { ok: true; scenario: Scenario }
  | { ok: false; errors: string[] };

/** Strictly validate a raw manifest object against the scenario schema. */
export function validateScenario(raw: unknown): ScenarioValidation {
  if (Value.Check(ScenarioSchema, raw)) {
    return { ok: true, scenario: raw };
  }
  const errors = [...Value.Errors(ScenarioSchema, raw)].map(
    (e) => `${e.path || '/'}: ${e.message}`,
  );
  return { ok: false, errors };
}

/** Load + validate a scenario manifest from a YAML (or JSON) file. Throws on invalid. */
export function loadScenarioFile(filePath: string): Scenario {
  const raw = parseYaml(readFileSync(filePath, 'utf-8'));
  const v = validateScenario(raw);
  if (!v.ok) {
    throw new Error(`invalid scenario manifest ${filePath}:\n  ${v.errors.join('\n  ')}`);
  }
  return v.scenario;
}
