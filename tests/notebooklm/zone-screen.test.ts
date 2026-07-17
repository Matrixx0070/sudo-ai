import { describe, it, expect } from 'vitest';
import { screenZone2, assertZone2, screenRecords, ZoneScreenError } from '../../src/core/notebooklm/zone-screen.js';
import { brainRadioShape, type ShapeContext } from '../../src/core/notebooklm/shapes.js';
import { splitToBudget } from '../../src/core/notebooklm/export-lane.js';

describe('E1 hard zone screen (Prime invariant 1)', () => {
  it('passes ordinary zone-2 content', () => {
    expect(screenZone2('sqlite WAL mode allows concurrent readers').ok).toBe(true);
  });

  it('rejects zone-1-classified content (credential-adjacent)', () => {
    const r = screenZone2('the api_key for prod is set in the env');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/zone-1|secrets/);
  });

  it('the independent secrets regex catches raw secrets even if classifier missed', () => {
    for (const s of [
      '-----BEGIN RSA PRIVATE KEY-----',
      'AKIA1234567890ABCDEF',
      'GOCSPX-abcdefghij1234567890',
      'client_secret: GOCSPXverylongsecretvalue12345',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.abcdefghijklmnop',
      '123-45-6789',
    ]) {
      expect(screenZone2(s).ok, s).toBe(false);
    }
  });

  it('assertZone2 throws ZoneScreenError on a hit', () => {
    expect(() => assertZone2('password: hunter2xyz')).toThrow(ZoneScreenError);
  });

  it('screenRecords drops offending records, keeps clean ones', () => {
    const recs = ['clean note about kubernetes', 'the password: supersecret123', 'another clean fact'];
    const { kept, dropped } = screenRecords(recs, (r) => r);
    expect(kept).toHaveLength(2);
    expect(dropped).toHaveLength(1);
  });
});

describe('E1 sweep: a seeded zone-1 record NEVER reaches a compiled shape', () => {
  it('brain-radio compile withholds a seeded secret from its output', async () => {
    const ctx: ShapeContext = {
      now: () => new Date('2026-07-17T00:00:00Z'),
      readReports: async () => [
        'Daily report: shipped the export lane',
        'the aws secret_key = AKIAZZZZZZZZZZZZZZZZ was rotated', // SEEDED zone-1/secret
      ],
      readOpenQuestions: async () => ['should we roll the daily doc at 200k?'],
      readAuditNotes: async () => ['nlm-export.brain-radio: success', 'password: leaked-in-audit-xyz'], // SEEDED
    };
    const [doc] = await brainRadioShape.compile(ctx);
    // The secret fragments must be absent; the clean ones present.
    expect(doc!.body).not.toContain('AKIAZZZZZZZZZZZZZZZZ');
    expect(doc!.body).not.toContain('leaked-in-audit');
    expect(doc!.body).toContain('shipped the export lane');
    // And the final gate on the assembled body passes (nothing leaked through).
    expect(() => assertZone2(doc!.body)).not.toThrow();
    // The withheld count is surfaced.
    expect(doc!.body).toMatch(/withheld by the zone screen/);
  });
});

describe('E1 rolling-Doc split', () => {
  it('splits past the size budget on paragraph boundaries', () => {
    const body = Array.from({ length: 20 }, (_, i) => `para ${i} ${'x'.repeat(100)}`).join('\n\n');
    const parts = splitToBudget(body, 500);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 500)).toBe(true);
    expect(parts.join('').replace(/\n/g, '').length).toBeGreaterThanOrEqual(body.replace(/\n/g, '').length - 50);
  });
  it('returns a single part under budget', () => {
    expect(splitToBudget('short', 500)).toEqual(['short']);
  });
});
