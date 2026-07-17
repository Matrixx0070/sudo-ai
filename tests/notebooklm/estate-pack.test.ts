import { describe, it, expect, beforeAll } from 'vitest';

type EP = typeof import('../../src/core/notebooklm/estate-pack.js');
let ep: EP;

beforeAll(async () => {
  ep = await import('../../src/core/notebooklm/estate-pack.js');
});

const GDRIVE = { manifest: 'FLD-man', 'ops/reports': 'FLD-rep' };
const NLM = { 'notebooklm/releases/forks-museum': 'FLD-museum', 'notebooklm/succession': 'FLD-succ' };

// FakeDrive whose body-reads THROW — proves the estate pack is pointer-only.
class ListOnlyDrive {
  files = new Map<string, { name: string; parent: string; content: string }>();
  private seq = 0;
  add(name: string, parent: string) { const id = `f${++this.seq}`; this.files.set(id, { name, parent, content: 'SECRET-BODY-DO-NOT-EMBED' }); return id; }
  async listChildren(fid: string) { return [...this.files.entries()].filter(([, f]) => f.parent === fid).map(([id, f]) => ({ id, name: f.name })); }
  async filesDownload(): Promise<string> { throw new Error('estate pack must be POINTER-ONLY — no body reads'); }
  async filesExport(): Promise<string> { throw new Error('estate pack must be POINTER-ONLY — no body reads'); }
  async filesCreateAsGoogleDoc(name: string, folderId: string, body: string) { const id = `g${++this.seq}`; this.files.set(id, { name, parent: folderId, content: body }); return { id, name }; }
  async filesUpdateGoogleDoc(id: string, body: string) { this.files.get(id)!.content = body; return { id }; }
}

describe('F56 estate pack (pointer-only)', () => {
  it('builds pointer sections WITHOUT reading any file body', async () => {
    const drive = new ListOnlyDrive();
    drive.add('signed-manifest.json', 'FLD-man');
    drive.add('atlas-2026-07-17', 'FLD-rep');
    drive.add('daily-2026-07-17', 'FLD-rep');
    drive.add('conservative.json', 'FLD-museum');
    const pack = await ep.buildEstatePack(drive as never, GDRIVE, NLM, () => new Date('2026-07-17T00:00:00Z'));
    const labels = pack.sections.map((s) => s.label);
    expect(labels.some((l) => l.includes('manifest'))).toBe(true);
    expect(labels.some((l) => l.includes('case law'))).toBe(true);
    // manifest section points at the file by URL, not its contents
    const man = pack.sections.find((s) => s.label.includes('manifest'))!;
    expect(man.pointers[0]!.ref).toMatch(/drive\.google\.com/);
    expect(JSON.stringify(pack)).not.toContain('SECRET-BODY'); // never embedded
    // sealed + local artifacts referenced by PATH only
    const sealed = pack.sections.find((s) => s.label.includes('Sealed'))!;
    expect(sealed.pointers.some((p) => p.ref.endsWith('operator-model.sealed'))).toBe(true);
  });

  it('renders a pointer index and publishes to notebooklm/succession', async () => {
    const drive = new ListOnlyDrive();
    drive.add('signed-manifest.json', 'FLD-man');
    const id = await ep.publishEstatePack(drive as never, GDRIVE, NLM, () => new Date('2026-07-17T00:00:00Z'));
    expect(id).not.toBeNull();
    const doc = [...drive.files.values()].find((f) => f.name === 'F56.estate-pack')!;
    expect(doc.parent).toBe('FLD-succ');
    expect(doc.content).toContain('estate pack (F56)');
    expect(doc.content).toContain('data/gdrive/case-law.json'); // pointer, not content
    expect(doc.content).not.toContain('SECRET-BODY');
  });
});
