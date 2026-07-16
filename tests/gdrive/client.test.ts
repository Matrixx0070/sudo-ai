import { describe, it, expect } from 'vitest';
import { DriveClient } from '../../src/core/gdrive/client.js';
import type { GdriveConfig } from '../../src/core/gdrive/types.js';

const cfg: GdriveConfig = {
  enabled: true,
  authMode: 'service_account',
  requestsPerSecond: 1000,
  burst: 1000,
  maxRetries: 2,
  heartbeatIntervalMs: 300_000,
};

function makeClient(overrides: { filesGet?: unknown }) {
  let getCalls = 0;
  const drive = {
    files: {
      get: async () => {
        getCalls++;
        if (overrides.filesGet instanceof Error) throw overrides.filesGet;
        if (typeof overrides.filesGet === 'function') return (overrides.filesGet as () => unknown)();
        return { data: overrides.filesGet ?? { id: 'x', name: 'y' } };
      },
      list: async () => ({ data: { files: [{ id: 'a', name: 'n' }], nextPageToken: undefined } }),
      create: async (args: unknown) => ({ data: { id: 'new', ...(args as { requestBody: object }).requestBody } }),
    },
  };
  const sheets = { spreadsheets: { values: { get: async () => ({ data: { values: [['v']] } }) } } };
  const client = new DriveClient(cfg, {
    drive: drive as never,
    sheets: sheets as never,
    backoff: { sleep: () => Promise.resolve() },
  });
  return { client, counters: () => ({ getCalls }) };
}

describe('DriveClient', () => {
  it('returns typed file metadata', async () => {
    const { client } = makeClient({ filesGet: { id: 'f1', name: 'doc.md', mimeType: 'text/markdown' } });
    const meta = await client.filesGet('f1');
    expect(meta).toMatchObject({ id: 'f1', name: 'doc.md' });
  });

  it('retries 5xx through the backoff layer and surfaces GdriveApiError', async () => {
    let attempts = 0;
    const { client } = makeClient({
      filesGet: () => {
        attempts++;
        throw { message: 'boom', response: { status: 500, data: {} } };
      },
    });
    await expect(client.filesGet('f1')).rejects.toMatchObject({ name: 'GdriveApiError', kind: 'server' });
    expect(attempts).toBe(3); // initial + maxRetries(2)
  });

  it('reads sheet values', async () => {
    const { client } = makeClient({});
    const values = await client.sheetsValuesGet('sheet1', 'Evals!A:C');
    expect(values).toEqual([['v']]);
  });
});
