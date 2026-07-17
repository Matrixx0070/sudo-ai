/**
 * NotebookLM N0 live smoke (SMOKE=1). Real Drive, throwaway DATA_DIR (so prod
 * mind.db / folder caches are untouched). Proves: folder tree + export lane
 * (rolling Doc) + returns pipeline (seed → quarantine → memory → processed).
 *   SMOKE=1 pnpm exec tsx scripts/smoke/notebooklm.mts
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
if (process.env.SMOKE !== '1') { console.error('set SMOKE=1'); process.exit(2); }
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'nlm-smoke-'));
process.env.SUDO_NOTEBOOKLM = '1';

const { loadGdriveConfig } = await import('/root/sudo-ai-v4/src/core/gdrive/config.js');
const { DriveClient } = await import('/root/sudo-ai-v4/src/core/gdrive/client.js');
const { ensureNotebookLmTree } = await import('/root/sudo-ai-v4/src/core/notebooklm/folders.js');
const { compileAndExport } = await import('/root/sudo-ai-v4/src/core/notebooklm/export-lane.js');
const { brainRadioShape } = await import('/root/sudo-ai-v4/src/core/notebooklm/shapes.js');
const { processReturnsOnce } = await import('/root/sudo-ai-v4/src/core/notebooklm/returns.js');
const { MindDB } = await import('/root/sudo-ai-v4/src/core/memory/db.js');
const structured = await import('/root/sudo-ai-v4/src/core/memory/structured-memory.js');

const config = loadGdriveConfig();
const client = new DriveClient(config);
const t0 = Date.now();
const folders = await ensureNotebookLmTree(client, config.rootFolderId!);
console.log(`TREE_OK ${Object.keys(folders).length} folders in ${Date.now()-t0}ms`);

const exp = await compileAndExport(client, folders, brainRadioShape, {
  now: () => new Date(),
  readReports: async () => ['Smoke: N0 export lane live', 'a second clean report line'],
  readOpenQuestions: async () => ['does the rolling Doc refresh in place?'],
  readAuditNotes: async () => ['nlm-smoke: success'],
});
console.log('EXPORT_OK doc=' + exp.docsWritten[0]!.name + ' fileId=' + exp.docsWritten[0]!.fileId + ' bytes=' + exp.docsWritten[0]!.bytes);

// Returns round-trip: seed a clean return, sweep, verify it ingested (temp db).
const date = new Date().toISOString().slice(0,10);
const retName = `F99.smoke.${date}.md`;
await client.filesCreate({ name: retName, parents: [folders['notebooklm/returns']!] }, { mimeType: 'text/plain', body: 'A benign smoke-test analysis with no instructions.' });
const db = new MindDB();
const res = await processReturnsOnce({
  client, folders, audit: null, chunks: db,
  structured: { listMemories: () => structured.listMemories(), saveMemory: (m) => structured.saveMemory(m as never) },
});
console.log('RETURNS_OK ingested=' + JSON.stringify(res.ingested) + ' held=' + JSON.stringify(res.held));
if (res.ingested.length !== 1) { console.error('SMOKE FAIL: return not ingested'); process.exit(1); }
console.log('SMOKE PASS — folder tree + export lane + returns pipeline all live');
