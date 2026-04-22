/**
 * Unit tests for the SudoConfigSchema TypeBox schema.
 */

import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { SudoConfigSchema } from '../../../src/core/config/schema.js';
import { validConfig, emptyConfig, typeMismatchConfig } from '../../helpers/fixtures.js';

describe('SudoConfigSchema', () => {
  // -------------------------------------------------------------------------
  // Valid config
  // -------------------------------------------------------------------------

  it('passes validation for a complete valid config', () => {
    const result = Value.Check(SudoConfigSchema, validConfig);
    expect(result).toBe(true);
  });

  it('passes validation when cron.jobs is an empty array', () => {
    const cfg = { ...validConfig, cron: { jobs: [] } };
    expect(Value.Check(SudoConfigSchema, cfg)).toBe(true);
  });

  it('passes validation when tools.disabled is an empty array', () => {
    const cfg = { ...validConfig, tools: { ...validConfig.tools, disabled: [] } };
    expect(Value.Check(SudoConfigSchema, cfg)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Missing required fields
  // -------------------------------------------------------------------------

  it('fails validation when meta.name is an empty string', () => {
    const cfg = { ...validConfig, meta: { name: '', timezone: 'UTC' } };
    const result = Value.Check(SudoConfigSchema, cfg);
    expect(result).toBe(false);
  });

  it('fails validation when meta.timezone is an empty string', () => {
    const cfg = { ...validConfig, meta: { name: 'Agent', timezone: '' } };
    expect(Value.Check(SudoConfigSchema, cfg)).toBe(false);
  });

  it('fails validation when models.primary is an empty array (minItems:1)', () => {
    const cfg = { ...validConfig, models: { ...validConfig.models, primary: [] } };
    expect(Value.Check(SudoConfigSchema, cfg)).toBe(false);
  });

  it('fails validation when agents.maxIterations is zero (minimum: 1)', () => {
    const cfg = { ...validConfig, agents: { ...validConfig.agents, maxIterations: 0 } };
    expect(Value.Check(SudoConfigSchema, cfg)).toBe(false);
  });

  it('fails validation when gateway.port is out of range (>65535)', () => {
    const cfg = { ...validConfig, gateway: { ...validConfig.gateway, port: 99999 } };
    expect(Value.Check(SudoConfigSchema, cfg)).toBe(false);
  });

  it('fails validation when gateway.port is zero (minimum: 1)', () => {
    const cfg = { ...validConfig, gateway: { ...validConfig.gateway, port: 0 } };
    expect(Value.Check(SudoConfigSchema, cfg)).toBe(false);
  });

  it('fails validation for an empty config object', () => {
    expect(Value.Check(SudoConfigSchema, emptyConfig)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Type mismatches
  // -------------------------------------------------------------------------

  it('fails validation when meta.name is a number instead of string', () => {
    const cfg = { ...validConfig, meta: { name: 123, timezone: 'UTC' } };
    expect(Value.Check(SudoConfigSchema, cfg)).toBe(false);
  });

  it('fails validation when agents.maxIterations is a negative integer', () => {
    const cfg = { ...validConfig, agents: { ...validConfig.agents, maxIterations: -5 } };
    expect(Value.Check(SudoConfigSchema, cfg)).toBe(false);
  });

  it('fails validation when model temperature is out of range (>2)', () => {
    const badEntry = { ...validConfig.models.primary[0]!, temperature: 3.0 };
    const cfg = { ...validConfig, models: { ...validConfig.models, primary: [badEntry] } };
    expect(Value.Check(SudoConfigSchema, cfg)).toBe(false);
  });

  it('fails validation when model temperature is below 0', () => {
    const badEntry = { ...validConfig.models.primary[0]!, temperature: -0.5 };
    const cfg = { ...validConfig, models: { ...validConfig.models, primary: [badEntry] } };
    expect(Value.Check(SudoConfigSchema, cfg)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Additional properties — schema uses additionalProperties: false
  // -------------------------------------------------------------------------

  it('fails validation when unknown top-level fields are present', () => {
    const cfg = { ...validConfig, unknownField: 'should fail' };
    expect(Value.Check(SudoConfigSchema, cfg)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Error extraction
  // -------------------------------------------------------------------------

  it('returns validation errors listing the failing paths', () => {
    const cfg = { ...validConfig, meta: { name: '', timezone: 'UTC' } };
    const errors = [...Value.Errors(SudoConfigSchema, cfg)];
    expect(errors.length).toBeGreaterThan(0);
    const paths = errors.map((e) => e.path);
    expect(paths.some((p) => p.includes('name'))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Cron job sub-schema
  // -------------------------------------------------------------------------

  it('passes validation when cron contains a valid job', () => {
    const cfg = {
      ...validConfig,
      cron: {
        jobs: [{
          id: 'morning-report',
          schedule: '0 9 * * *',
          description: 'Daily morning report',
          enabled: true,
          task: 'Generate and send the morning report',
        }],
      },
    };
    expect(Value.Check(SudoConfigSchema, cfg)).toBe(true);
  });

  it('fails validation when a cron job is missing required id field', () => {
    const cfg = {
      ...validConfig,
      cron: {
        jobs: [{
          schedule: '0 9 * * *',
          description: 'Missing id',
          enabled: true,
          task: 'some task',
        }],
      },
    };
    expect(Value.Check(SudoConfigSchema, cfg)).toBe(false);
  });
});
