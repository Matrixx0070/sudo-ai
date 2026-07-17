/**
 * @file cli/commands/gdrive.ts
 * @description Operator CLI for the Drive memory substrate:
 *   sudo-ai gdrive status              — live health snapshot
 *   sudo-ai gdrive knew-at <ISO> [--path P]   — reconstruct past knowledge (F31)
 *   sudo-ai gdrive bisect --path P     — when did memory P change? (F9)
 *   sudo-ai gdrive resume <taskId>     — load + claim a hibernated task (F35)
 *
 * Read-only except `resume` (which only claims via the blackboard). Exit 0 ok,
 * 1 error, 2 misconfigured/disabled.
 */

/* eslint-disable no-console */

async function initRuntime() {
  const { loadGdriveConfig, isGdriveEnabled } = await import('../../core/gdrive/config.js');
  if (!isGdriveEnabled()) {
    console.error('gdrive is disabled (SUDO_GDRIVE != 1)');
    return null;
  }
  const config = loadGdriveConfig();
  const { DriveClient } = await import('../../core/gdrive/client.js');
  const { ensureFolderTree } = await import('../../core/gdrive/bootstrap.js');
  const { loadHmacKey } = await import('../../core/gdrive/keys.js');
  const client = new DriveClient(config);
  const folders = await ensureFolderTree(client, config.rootFolderId!);
  return { config, client, folders, hmacKey: loadHmacKey() };
}

export async function runGdriveStatus(): Promise<number> {
  let rt;
  try {
    rt = await initRuntime();
  } catch (err) {
    console.error('config error:', String(err).slice(0, 200));
    return 2;
  }
  if (!rt) return 2;
  const { loadBrainState } = await import('../../core/gdrive/checkpoint.js');
  const { loadCanaryConfig, isGdrivePaused } = await import('../../core/gdrive/canary.js');
  const { HEARTBEAT_FILE_NAME } = await import('../../core/gdrive/heartbeat.js');

  const state = loadBrainState();
  console.log('Google Drive memory substrate');
  console.log('  auth mode      :', rt.config.authMode);
  console.log('  root folder    :', rt.config.rootFolderId);
  console.log('  canonical tree :', Object.keys(rt.folders).length, 'folders');
  console.log('  brain counter  :', state.counter, state.lastPushAt ? `(last push ${state.lastPushAt})` : '(never pushed)');
  console.log('  canaries armed :', loadCanaryConfig().canaries.length);
  console.log('  PAUSED         :', isGdrivePaused() ? 'YES (jobs idle)' : 'no');

  // Live heartbeat freshness.
  try {
    const opsId = rt.folders['ops'];
    const hb = (await rt.client.listChildren(opsId!)).find((f) => f.name === HEARTBEAT_FILE_NAME);
    if (hb) {
      const meta = await rt.client.filesGet(hb.id);
      const ageMin = meta.modifiedTime ? (Date.now() - Date.parse(meta.modifiedTime)) / 60000 : NaN;
      console.log('  heartbeat      :', Number.isFinite(ageMin) ? `${ageMin.toFixed(1)} min old` : 'present', ageMin > 20 ? '⚠️ STALE' : '');
    } else {
      console.log('  heartbeat      : (none yet)');
    }
  } catch (err) {
    console.log('  heartbeat      : (Drive unreachable —', String(err).slice(0, 60) + ')');
  }
  return 0;
}

export async function runGdriveKnewAt(timestamp: string, opts: { path?: string }): Promise<number> {
  if (!Number.isFinite(Date.parse(timestamp))) {
    console.error('invalid timestamp — use an ISO-8601 value, e.g. 2026-07-16T00:00:00Z');
    return 1;
  }
  let rt;
  try {
    rt = await initRuntime();
  } catch (err) {
    console.error('config error:', String(err).slice(0, 200));
    return 2;
  }
  if (!rt) return 2;
  const { knewAt } = await import('../../core/gdrive/chronicle.js');
  const { MANIFEST_FILE_NAME } = await import('../../core/gdrive/blob-store.js');
  const mf = (await rt.client.listChildren(rt.folders['manifest']!)).find((f) => f.name === MANIFEST_FILE_NAME);
  if (!mf) {
    console.error('no manifest found — the brain has not been checkpointed yet');
    return 1;
  }
  try {
    const view = await knewAt(rt.client, mf.id, new Date(timestamp).toISOString(), { hmacKey: rt.hmacKey });
    console.log(`As of ${timestamp} (manifest revision ${view.revisionId}):`);
    console.log(`  ${view.knownPaths.size} memories known; ${view.delta.length} chronicle op(s) applied since the revision`);
    if (opts.path) {
      console.log(`  "${opts.path}" was ${view.knownPaths.has(opts.path) ? 'KNOWN' : 'NOT yet known'} at that time`);
    } else {
      for (const p of [...view.knownPaths].slice(0, 40)) console.log('   -', p);
      if (view.knownPaths.size > 40) console.log(`   … and ${view.knownPaths.size - 40} more`);
    }
    return 0;
  } catch (err) {
    console.error('knew-at failed:', String(err).slice(0, 200));
    return 1;
  }
}

export async function runGdriveBisect(opts: { path?: string }): Promise<number> {
  if (!opts.path) {
    console.error('--path <logicalPath> is required (the memory to trace)');
    return 1;
  }
  let rt;
  try {
    rt = await initRuntime();
  } catch (err) {
    console.error('config error:', String(err).slice(0, 200));
    return 2;
  }
  if (!rt) return 2;
  const { bisectBrain } = await import('../../core/gdrive/bisect.js');
  const { MANIFEST_FILE_NAME } = await import('../../core/gdrive/blob-store.js');
  const mf = (await rt.client.listChildren(rt.folders['manifest']!)).find((f) => f.name === MANIFEST_FILE_NAME);
  if (!mf) {
    console.error('no manifest found');
    return 1;
  }
  const revisions = await rt.client.revisionsList(mf.id);
  const revIds = revisions.map((r) => r.id!).filter(Boolean);
  if (revIds.length < 2) {
    console.error('need at least 2 manifest revisions to bisect (only', revIds.length, 'present)');
    return 1;
  }
  // "good" = the memory has its ORIGINAL content (matches the oldest revision).
  // First "bad" = the first revision where it changed or disappeared.
  let baselineSha: string | undefined;
  const judge = async (m: { entries: Array<{ logicalPath: string; sha256: string }> }): Promise<boolean> => {
    const e = m.entries.find((x) => x.logicalPath === opts.path);
    const sha = e?.sha256;
    if (baselineSha === undefined) baselineSha = sha; // first-visited (oldest) sets the baseline
    return sha === baselineSha;
  };
  try {
    // Seed the baseline from the oldest revision so the judge is stable.
    await judge(JSON.parse(await rt.client.revisionsGetContent(mf.id, revIds[0]!)));
    const result = await bisectBrain(rt.client, mf.id, revIds, judge, { hmacKey: rt.hmacKey }, { trustEndpoints: true });
    console.log(`Memory "${opts.path}" first changed at manifest revision ${result.firstBadRevisionId}`);
    if (result.diff) {
      const ch = result.diff.changed.find((c) => c.logicalPath === opts.path);
      if (ch) console.log(`  sha ${ch.before.sha256.slice(0, 12)} → ${ch.after.sha256.slice(0, 12)}`);
      if (result.diff.added.some((a) => a.logicalPath === opts.path)) console.log('  (first appeared here)');
      if (result.diff.removed.some((r) => r.logicalPath === opts.path)) console.log('  (removed here)');
    }
    return 0;
  } catch (err) {
    console.error('bisect:', String(err).slice(0, 200));
    // "range end is not BAD" means the memory never changed — report that plainly.
    if (/not BAD/.test(String(err))) console.log(`Memory "${opts.path}" is unchanged across all ${revIds.length} revisions.`);
    return /not BAD|not GOOD/.test(String(err)) ? 0 : 1;
  }
}

export async function runGdriveResume(taskId: string): Promise<number> {
  let rt;
  try {
    rt = await initRuntime();
  } catch (err) {
    console.error('config error:', String(err).slice(0, 200));
    return 2;
  }
  if (!rt) return 2;
  const { resumeTask } = await import('../../core/gdrive/hibernate.js');
  const { loadEncKey } = await import('../../core/gdrive/keys.js');
  const { loadBrainState } = await import('../../core/gdrive/checkpoint.js');
  let encKey: Buffer;
  try {
    encKey = loadEncKey();
  } catch (err) {
    console.error('BRAIN_ENC_KEY_PATH required to resume (task state is encrypted):', String(err).slice(0, 120));
    return 2;
  }
  try {
    const outcome = await resumeTask(rt.client, rt.folders, { hmacKey: rt.hmacKey, encKey }, taskId, loadBrainState().counter);
    switch (outcome.action) {
      case 'resumed':
        console.log(`Task ${taskId} loaded (step ${outcome.task.stepCursor}):`);
        console.log('  plan:', outcome.task.plan.slice(0, 300));
        console.log('  hibernated by', outcome.task.hibernatedBy, 'at', outcome.task.hibernatedAt);
        console.log('  (loop-side resume continues this in the running agent)');
        return 0;
      case 'claimed-elsewhere':
        console.log(`Task ${taskId} is claimed by another instance (${outcome.winner}) — not resuming.`);
        return 0;
      case 'not-found':
        console.error(`No hibernated task "${taskId}" in tasks/active/`);
        return 1;
      case 'incompatible':
        console.error('incompatible:', outcome.reason);
        return 1;
    }
  } catch (err) {
    console.error('resume failed:', String(err).slice(0, 200));
    return 1;
  }
}
