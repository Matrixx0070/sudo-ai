import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'sop-'));
process.env['DATA_DIR'] = tmp;

type Datasets = typeof import('../../src/core/gdrive/datasets.js');
type SOP = typeof import('../../src/core/gdrive/study-of-principal.js');
let datasets: Datasets, sop: SOP;

const KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 9);
const SECRET_PHRASE = 'never deploy on fridays without my sign-off';

beforeAll(async () => {
  datasets = await import('../../src/core/gdrive/datasets.js');
  sop = await import('../../src/core/gdrive/study-of-principal.js');
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => rmSync(join(tmp, 'gdrive'), { recursive: true, force: true }));

function seed() {
  datasets.appendDatasetRow('corrections', { doc: 'a', correction: SECRET_PHRASE, directive: true, marker: 'F62' });
  datasets.appendDatasetRow('corrections', { doc: 'b', correction: 'always verify verify verify before done', directive: true, marker: null });
  datasets.appendDatasetRow('corrections', { doc: 'c', correction: 'verify the timezone once more', directive: true, marker: null });
  datasets.appendDatasetRow('corrections', { doc: 'd', correction: 'a neutral note, not a directive', directive: false, marker: null });
}

describe('F62 study of the principal (zone-1 sealed)', () => {
  it('builds an operator model from directives + emphasised themes', () => {
    seed();
    const m = sop.buildOperatorModel(() => new Date('2026-07-17T00:00:00Z'));
    expect(m.standingDirectives).toContain(SECRET_PHRASE);
    expect(m.standingDirectives).not.toContain('a neutral note, not a directive'); // non-directive excluded
    expect(m.emphasizedThemes.find((t) => t.theme === 'verify')!.count).toBe(2);
    expect(m.interactionProfile.totalCorrections).toBe(4);
    expect(m.interactionProfile.directiveShare).toBeCloseTo(3 / 4, 5);
  });

  it('seals to ciphertext at rest — the principal\'s words never sit in plaintext', () => {
    seed();
    const model = sop.buildOperatorModel();
    sop.sealOperatorModel(model, KEY);
    const bytes = sop.readSealedBytes()!;
    expect(bytes).not.toBeNull();
    // the sensitive directive must NOT appear as readable plaintext on disk
    expect(bytes.toString('utf-8')).not.toContain(SECRET_PHRASE);
    expect(bytes.toString('latin1')).not.toContain(SECRET_PHRASE);
  });

  it('round-trips with the right key; returns null with the wrong key', () => {
    seed();
    sop.sealOperatorModel(sop.buildOperatorModel(), KEY);
    const back = sop.loadSealedOperatorModel(KEY)!;
    expect(back.standingDirectives).toContain(SECRET_PHRASE);
    expect(sop.loadSealedOperatorModel(OTHER_KEY)).toBeNull(); // GCM auth fails → null
  });

  it('is zone-1 by policy', () => {
    expect(sop.OPERATOR_MODEL_ZONE).toBe(1);
  });
});
