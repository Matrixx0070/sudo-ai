import { describe, it, expect, beforeAll } from 'vitest';

type Debate = typeof import('../../src/core/notebooklm/debate.js');
let debate: Debate;

beforeAll(async () => {
  debate = await import('../../src/core/notebooklm/debate.js');
});

const FOLDERS = { 'notebooklm/debates': 'FLD-deb' };

class FakeDrive {
  files = new Map<string, { name: string; parent: string; content: string }>();
  private seq = 0;
  async listChildren(fid: string) {
    return [...this.files.entries()].filter(([, f]) => f.parent === fid).map(([id, f]) => ({ id, name: f.name }));
  }
  async filesCreateAsGoogleDoc(name: string, folderId: string, body: string) {
    const id = `d${++this.seq}`;
    this.files.set(id, { name, parent: folderId, content: body });
    return { id, name };
  }
  async filesUpdateGoogleDoc(id: string, body: string) {
    this.files.get(id)!.content = body;
    return { id };
  }
}

const packet = {
  id: 'dec-42',
  question: 'Should the forgetting policy drop non-evergreen chunks after 14 days?',
  evidence: ['recall latency up 20%', 'stale-hit rate 3%'],
  constraints: ['no data loss for evergreen'],
  impact: 'high' as const,
  createdAt: '2026-07-17T00:00:00Z',
};

describe('F48 debate chamber', () => {
  it('publishes a symmetric FOR/AGAINST pack + cover, each advocate on its stance', async () => {
    const drive = new FakeDrive();
    const stances: string[] = [];
    const res = await debate.exportDebatePack(
      drive as never,
      FOLDERS,
      packet,
      async (stance, prompt) => {
        stances.push(stance);
        expect(prompt).toContain(stance === 'for' ? 'FOR taking the action' : 'AGAINST taking the action');
        return `A ${stance} argument that stays neutral and factual.`;
      },
    );
    expect(stances.sort()).toEqual(['against', 'for']);
    expect(res.docs.map((d) => d.stance).sort()).toEqual(['against', 'cover', 'for']);
    const names = [...drive.files.values()].map((f) => f.name).sort();
    expect(names).toEqual(['dec-42.debate', 'dec-42.debate-against', 'dec-42.debate-for']);
  });

  it('refuses a packet that smuggles a conclusion (reuses F32 guard)', async () => {
    const drive = new FakeDrive();
    await expect(
      debate.exportDebatePack(
        drive as never,
        FOLDERS,
        { ...packet, question: 'My recommendation is to drop chunks — argue it.' },
        async () => 'x',
      ),
    ).rejects.toThrow(/conclusion/);
  });

  it('fail-closed: a generated position that leaks zone-1 is never broadcast', async () => {
    const drive = new FakeDrive();
    await expect(
      debate.exportDebatePack(
        drive as never,
        FOLDERS,
        packet,
        async (stance) => (stance === 'against' ? 'contains AKIAIOSFODNN7EXAMPLE secret' : 'clean for case'),
      ),
    ).rejects.toThrow();
    // nothing partially published beyond what was written before the throw is acceptable,
    // but the against/cover docs must not exist as a completed pack
    expect([...drive.files.values()].some((f) => f.name === 'dec-42.debate')).toBe(false);
  });
});
