import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'nlm-approval-'));
process.env['DATA_DIR'] = tmp;

type IA = typeof import('../../src/core/notebooklm/informed-approval.js');
type Returns = typeof import('../../src/core/notebooklm/returns.js');
type Routes = typeof import('../../src/core/notebooklm/routes-n1.js');
let ia: IA, returns: Returns, routes: Routes;

beforeAll(async () => {
  ia = await import('../../src/core/notebooklm/informed-approval.js');
  returns = await import('../../src/core/notebooklm/returns.js');
  routes = await import('../../src/core/notebooklm/routes-n1.js');
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => rmSync(join(tmp, 'notebooklm'), { recursive: true, force: true }));

const FOLDERS = { 'notebooklm/approvals': 'FLD-appr' };

class FakeDrive {
  files = new Map<string, { name: string; parent: string; content: string }>();
  private seq = 0;
  add(name: string, parent: string, content: string) { const id = `f${++this.seq}`; this.files.set(id, { name, parent, content }); return id; }
  async listChildren(fid: string) { return [...this.files.entries()].filter(([, f]) => f.parent === fid).map(([id, f]) => ({ id, name: f.name })); }
  async filesDownload(id: string) { return this.files.get(id)!.content; }
  async filesUpdate(id: string, meta: { addParents?: string }) { if (meta.addParents) this.files.get(id)!.parent = meta.addParents; return { id }; }
  async filesCreate(meta: { name: string; parents?: string[] }, media?: { body: string }) { const id = `f${++this.seq}`; this.files.set(id, { name: meta.name, parent: meta.parents?.[0] ?? '', content: media?.body ?? '' }); return { id, name: meta.name }; }
  async filesCreateAsGoogleDoc(name: string, folderId: string, body: string) { const id = `g${++this.seq}`; this.files.set(id, { name, parent: folderId, content: body }); return { id, name }; }
  async filesUpdateGoogleDoc(id: string, body: string) { this.files.get(id)!.content = body; return { id }; }
}

const subject = { id: 'skill-risky-1', title: 'Promote the risky-skill', whatItDoes: ['runs shell commands'], risks: ['can delete files'] };

describe('F54 informed approval', () => {
  it('publishes an explainer + pending record; gate HOLDS until attestation', async () => {
    const drive = new FakeDrive();
    const rec = await ia.requestInformedApproval(drive as never, FOLDERS, subject, () => new Date('2026-07-17T00:00:00Z'));
    expect(rec.granted).toBe(false);
    expect(ia.isInformedApprovalGranted(subject.id)).toBe(false);
    const explainer = [...drive.files.values()].find((f) => f.name === `F54.explainer.${subject.id}`);
    expect(explainer).toBeDefined();
    // the explainer carries the exact attestation line the human must echo
    expect(explainer!.content).toContain(`APPROVE ${subject.id} ${rec.token}`);
  });

  it('grants ONLY on the exact explainer-bound token', async () => {
    const drive = new FakeDrive();
    const rec = await ia.requestInformedApproval(drive as never, FOLDERS, subject);
    expect(ia.recordAttestation(subject.id, 'APPROVE skill-risky-1 deadbeefcafe').granted).toBe(false); // wrong token
    expect(ia.recordAttestation(subject.id, 'I approve this').granted).toBe(false); // no line
    const good = ia.recordAttestation(subject.id, `some preamble\nAPPROVE ${subject.id} ${rec.token}\nthanks`);
    expect(good.granted).toBe(true);
    expect(ia.isInformedApprovalGranted(subject.id)).toBe(true);
  });

  it('holds when there is no pending approval', () => {
    expect(ia.recordAttestation('never-requested', 'APPROVE never-requested abcabcabcabc').granted).toBe(false);
  });

  it('return route: F54.attestation.<id>.md grants the gate, never touches memory', async () => {
    const drive = new FakeDrive();
    const rec = await ia.requestInformedApproval(drive as never, FOLDERS, subject);
    routes.registerN1Routes();
    const RFOLDERS = { 'notebooklm/returns': 'FLD-ret', 'notebooklm/returns/processed': 'FLD-proc', 'notebooklm/returns/held': 'FLD-held' };
    drive.add(`F54.attestation.${subject.id}.md`, 'FLD-ret', `APPROVE ${subject.id} ${rec.token}`);
    const res = await returns.processReturnsOnce({
      client: drive as never, folders: RFOLDERS, audit: null,
      chunks: { getActiveChunks: () => [], storeChunk: () => { throw new Error('must not ingest'); } } as never,
      structured: { listMemories: async () => [], saveMemory: async () => { throw new Error('no memory'); } } as never,
    });
    expect(res.routed).toEqual([{ file: `F54.attestation.${subject.id}.md`, route: 'approval-granted' }]);
    expect(ia.isInformedApprovalGranted(subject.id)).toBe(true);
  });
});
