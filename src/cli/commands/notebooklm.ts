/**
 * @file cli/commands/notebooklm.ts
 * @description NotebookLM annex operator commands:
 *   sudo-ai notebooklm status                 — annex health
 *   sudo-ai notebooklm export-incident <id>   — F43 redacted incident pack
 *   sudo-ai notebooklm export-studypack <q>   — F45 study pack for a topic
 * Read-only except the exporters (which only write to the notebooklm tree).
 */

/* eslint-disable no-console */

async function initNlm() {
  const { isNotebookLmEnabled } = await import('../../core/notebooklm/config.js');
  if (!isNotebookLmEnabled()) {
    console.error('notebooklm disabled (need SUDO_NOTEBOOKLM=1 and SUDO_GDRIVE=1)');
    return null;
  }
  const { getNlmRuntime } = await import('../../core/notebooklm/runtime.js');
  const { getGdriveRuntime } = await import('../../core/gdrive/runtime.js');
  const nlm = await getNlmRuntime();
  const gdrive = await getGdriveRuntime();
  return { nlm, gdrive };
}

export async function runNlmStatus(): Promise<number> {
  let rt;
  try {
    rt = await initNlm();
  } catch (err) {
    console.error('config error:', String(err).slice(0, 200));
    return 2;
  }
  if (!rt) return 2;
  const { allRituals, tier1WeeklyMinutes, TIER1_WEEKLY_BUDGET_MIN } = await import('../../core/notebooklm/rituals.js');
  const { registerN1Rituals } = await import('../../core/notebooklm/rituals-n1.js');
  const { allShapes } = await import('../../core/notebooklm/shapes.js');
  const { registerN1Shapes } = await import('../../core/notebooklm/shapes-n1.js');
  registerN1Rituals();
  registerN1Shapes();
  console.log('NotebookLM annex');
  console.log('  notebooklm folders :', Object.keys(rt.nlm.folders).length);
  console.log('  shapes registered  :', allShapes().map((s) => s.id).join(', '));
  console.log('  rituals            :', allRituals().length, `(Tier-1 ${tier1WeeklyMinutes()}/${TIER1_WEEKLY_BUDGET_MIN} min/week)`);
  return 0;
}

export async function runNlmExportIncident(bundleId: string): Promise<number> {
  let rt;
  try {
    rt = await initNlm();
  } catch (err) {
    console.error('config error:', String(err).slice(0, 200));
    return 2;
  }
  if (!rt) return 2;
  const { exportIncidentPack } = await import('../../core/notebooklm/packs.js');
  const { loadHmacKey, loadEncKey } = await import('../../core/gdrive/keys.js');
  let keys;
  try {
    keys = { hmacKey: loadHmacKey(), encKey: loadEncKey() };
  } catch (err) {
    console.error('keys required (incident bundles are encrypted):', String(err).slice(0, 120));
    return 2;
  }
  try {
    const res = await exportIncidentPack(rt.gdrive.client, rt.gdrive.folders, rt.nlm.folders, bundleId, keys, rt.gdrive.audit);
    console.log(`Incident pack for ${bundleId}: ${res.docs.length} Docs, ${res.redactionHits} secret(s) redacted`);
    for (const d of res.docs) console.log('  -', d.name, d.fileId);
    return 0;
  } catch (err) {
    console.error('export-incident failed:', String(err).slice(0, 200));
    return 1;
  }
}

export async function runNlmExportStudypack(questionId: string): Promise<number> {
  let rt;
  try {
    rt = await initNlm();
  } catch (err) {
    console.error('config error:', String(err).slice(0, 200));
    return 2;
  }
  if (!rt) return 2;
  const { exportStudyPack } = await import('../../core/notebooklm/packs.js');
  const { MindDB } = await import('../../core/memory/db.js');
  const db = new MindDB();
  // Gather zone-2 context: chunks whose text/path mention the topic.
  const kw = questionId.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3);
  const context = db
    .getActiveChunks(5000)
    .filter((c) => kw.some((k) => c.text.toLowerCase().includes(k) || c.path.toLowerCase().includes(k)))
    .slice(0, 10)
    .map((c) => c.text);
  try {
    const res = await exportStudyPack(rt.nlm.client, rt.nlm.folders, {
      questionId,
      question: questionId,
      context,
    });
    console.log(`Study pack for "${questionId}": ${res.contextCount} context snippet(s) → ${res.fileIds[0]}`);
    return 0;
  } catch (err) {
    console.error('export-studypack failed:', String(err).slice(0, 200));
    return 1;
  }
}
