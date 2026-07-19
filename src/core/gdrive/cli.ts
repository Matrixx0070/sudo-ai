/**
 * @file gdrive/cli.ts
 * @description F109 — thin CLI subcommands over the (already-tested) Drive
 * library: `sudo-ai gdrive status|knew-at|bisect|resume`.
 *
 * This module owns ALL command logic so src/cli.ts stays a one-line dispatch
 * (max-lines ratchet). It is import-only from the standalone subcommand path —
 * never from the agent loop — so the hot-path isolation invariant
 * (tests/gdrive/hot-path.test.ts) is unaffected.
 *
 * status / knew-at / bisect are read-only against Drive state. resume performs
 * the library's existing gated claim (F14 blackboard single-writer + brain
 * counter compatibility) — the gate lives in the library, not here.
 *
 * Every collaborator is injectable so the wiring is unit-testable without a
 * live Drive; the defaults resolve the real runtime/keys/state lazily.
 */

import { createInterface } from 'node:readline';
import { isGdriveEnabled } from './config.js';
import { MANIFEST_FILE_NAME } from './blob-store.js';
import { loadHmacKey, loadEncKey } from './keys.js';
import { loadBrainState as loadBrainStateReal } from './checkpoint.js';
import type { DriveClient } from './client.js';
import type { FolderIdMap, GdriveConfig } from './types.js';
import type { BrainKeys } from './keys.js';
import type { BrainState } from './checkpoint.js';

interface RuntimeLike {
  client: DriveClient;
  folders: FolderIdMap;
  config: GdriveConfig;
}

export interface GdriveCliDeps {
  /** Feature-flag check (default: SUDO_GDRIVE gate). */
  isEnabled?: () => boolean;
  /** Lazily initialize + return the Drive runtime (client/folders/config). */
  getRuntime?: () => Promise<RuntimeLike>;
  /** Load brain keys (hmac required; enc optional). */
  loadKeys?: () => BrainKeys;
  /** Load the local brain-state (counter continuity). */
  loadBrainState?: () => BrainState;
  /** Ask the operator a question (bisect human judge). Returns their answer. */
  prompt?: (question: string) => Promise<string>;
  /** Sink for user-facing output (default: console.log). */
  out?: (line: string) => void;
}

const USAGE = [
  'Usage: sudo-ai gdrive <subcommand>',
  '',
  '  status                 Read-only Drive-layer posture (flags, folders, brain counter).',
  '  knew-at <ISO-8601>     Reconstruct what the brain knew at a timestamp (read-only).',
  '  bisect [--trust]       Binary-search the manifest history for the first bad brain',
  '                         (interactive good/bad judge; read-only).',
  '  resume <taskId>        Claim + fetch a hibernated task (F35; gated claim).',
].join('\n');

/** Resolve the remote manifest file id from the manifest folder (read-only). */
async function resolveManifestFileId(rt: RuntimeLike): Promise<string> {
  const folderId = rt.folders['manifest'];
  if (!folderId) throw new Error('manifest folder id missing — bootstrap the Drive tree first');
  const file = (await rt.client.listChildren(folderId)).find((f) => f.name === MANIFEST_FILE_NAME);
  if (!file) throw new Error('no remote manifest found — run a checkpoint (gdrive:checkpoint) first');
  return file.id;
}

function defaultPrompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (ans) => { rl.close(); resolve(ans); }));
}

function defaultLoadKeys(): BrainKeys {
  let encKey: Buffer | undefined;
  try { encKey = loadEncKey(); } catch { encKey = undefined; }
  return { hmacKey: loadHmacKey(), encKey };
}

function resolveDeps(deps: GdriveCliDeps): Required<GdriveCliDeps> {
  return {
    out: deps.out ?? ((line: string) => console.log(line)),
    isEnabled: deps.isEnabled ?? (() => isGdriveEnabled()),
    getRuntime:
      deps.getRuntime ??
      (async () => {
        const { getGdriveRuntime } = await import('./runtime.js');
        const rt = await getGdriveRuntime();
        return { client: rt.client, folders: rt.folders, config: rt.config };
      }),
    loadKeys: deps.loadKeys ?? defaultLoadKeys,
    loadBrainState: deps.loadBrainState ?? loadBrainStateReal,
    prompt: deps.prompt ?? defaultPrompt,
  };
}

async function cmdStatus(d: Required<GdriveCliDeps>): Promise<number> {
  if (!d.isEnabled()) {
    d.out('gdrive: disabled (SUDO_GDRIVE != 1)');
    d.out('  Set SUDO_GDRIVE=1 + Drive credentials to enable brain sync. See docs/gdrive-setup.md.');
    return 0;
  }
  const state = d.loadBrainState();
  d.out('gdrive: ENABLED');
  d.out(`  brain counter:  ${state.counter}`);
  d.out(`  last push:      ${state.lastPushAt ?? '(never)'}`);
  d.out(`  last restore:   ${state.lastRestoreAt ?? '(never)'}`);
  d.out(
    `  auto-hibernate: ${process.env['SUDO_GDRIVE_AUTOHIBERNATE'] === '1' ? 'armed (F35)' : 'off'}`,
  );
  try {
    const rt = await d.getRuntime();
    d.out(`  root folder:    ${rt.config.rootFolderId ?? '(unset)'}`);
    d.out(`  folders known:  ${Object.keys(rt.folders).length}`);
    try {
      const manifestId = await resolveManifestFileId(rt);
      const revisions = await rt.client.revisionsList(manifestId);
      d.out(`  manifest:       ${manifestId} (${revisions.length} revisions)`);
    } catch (err) {
      d.out(`  manifest:       ${err instanceof Error ? err.message : String(err)}`);
    }
  } catch (err) {
    d.out(`  runtime:        unavailable — ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  return 0;
}

async function cmdKnewAt(d: Required<GdriveCliDeps>, args: string[]): Promise<number> {
  const timestamp = args[0];
  if (!timestamp) {
    d.out('gdrive knew-at: a timestamp argument is required (ISO-8601, e.g. 2026-07-19T00:00:00Z)');
    return 2;
  }
  if (!d.isEnabled()) {
    d.out('gdrive knew-at: disabled (SUDO_GDRIVE != 1)');
    return 1;
  }
  const rt = await d.getRuntime();
  const manifestId = await resolveManifestFileId(rt);
  const { knewAt } = await import('./chronicle.js');
  const view = await knewAt(rt.client, manifestId, timestamp, d.loadKeys());
  d.out(`gdrive knew-at ${timestamp}`);
  d.out(`  manifest revision: ${view.revisionId}`);
  d.out(`  manifest counter:  ${view.manifest.counter}`);
  d.out(`  chronicle delta:   ${view.delta.length} op(s) after that revision`);
  d.out(`  known paths:       ${view.knownPaths.size}`);
  return 0;
}

async function cmdBisect(d: Required<GdriveCliDeps>, args: string[]): Promise<number> {
  if (!d.isEnabled()) {
    d.out('gdrive bisect: disabled (SUDO_GDRIVE != 1)');
    return 1;
  }
  const trustEndpoints = args.includes('--trust') || args.includes('--trust-endpoints');
  const rt = await d.getRuntime();
  const manifestId = await resolveManifestFileId(rt);
  const revisions = await rt.client.revisionsList(manifestId);
  const revisionIds = revisions.map((r) => r.id!).filter(Boolean);
  if (revisionIds.length < 2) {
    d.out(`gdrive bisect: need at least 2 manifest revisions (have ${revisionIds.length})`);
    return 1;
  }
  d.out(`gdrive bisect: ${revisionIds.length} revisions (oldest → newest). Answer y/n as prompted.`);
  const { bisectBrain } = await import('./bisect.js');
  // Human judge: the classic git-bisect UX. The library binary-searches and
  // only asks about the midpoints it actually needs.
  const judge = async (_m: unknown, revisionId: string): Promise<boolean> => {
    const ans = (await d.prompt(`  is revision ${revisionId} GOOD? [y/N] `)).trim().toLowerCase();
    return ans === 'y' || ans === 'yes';
  };
  const result = await bisectBrain(
    rt.client,
    manifestId,
    revisionIds,
    judge as never,
    d.loadKeys(),
    { trustEndpoints },
  );
  d.out('gdrive bisect: converged');
  d.out(`  first bad revision: ${result.firstBadRevisionId}`);
  d.out(`  last good revision: ${result.lastGoodRevisionId ?? '(none)'}`);
  d.out(`  judge calls:        ${result.judgeCalls}`);
  if (result.diff) {
    d.out(
      `  manifest diff:      +${result.diff.added.length} ~${result.diff.changed.length} -${result.diff.removed.length}`,
    );
  }
  return 0;
}

async function cmdResume(d: Required<GdriveCliDeps>, args: string[]): Promise<number> {
  const taskId = args[0];
  if (!taskId) {
    d.out('gdrive resume: a taskId argument is required');
    return 2;
  }
  if (!d.isEnabled()) {
    d.out('gdrive resume: disabled (SUDO_GDRIVE != 1)');
    return 1;
  }
  const rt = await d.getRuntime();
  const { resumeTask } = await import('./hibernate.js');
  const localCounter = d.loadBrainState().counter;
  const outcome = await resumeTask(rt.client, rt.folders, d.loadKeys(), taskId, localCounter);
  switch (outcome.action) {
    case 'resumed':
      d.out(`gdrive resume: claimed task "${taskId}"`);
      d.out(`  step cursor:   ${outcome.task.stepCursor}`);
      d.out(`  hibernated by: ${outcome.task.hibernatedBy}`);
      d.out(`  plan:          ${outcome.task.plan.slice(0, 200)}`);
      return 0;
    case 'claimed-elsewhere':
      d.out(`gdrive resume: task "${taskId}" is claimed by ${outcome.winner} — not resumed`);
      return 1;
    case 'not-found':
      d.out(`gdrive resume: no hibernated task "${taskId}" in tasks/active`);
      return 1;
    case 'incompatible':
      d.out(`gdrive resume: incompatible — ${outcome.reason}`);
      return 1;
  }
}

/**
 * Dispatch a `gdrive` subcommand. Returns a process exit code. Never throws for
 * a known-command failure path (prints a diagnostic + returns non-zero);
 * genuinely unexpected errors propagate to the caller's catch in cli.ts.
 */
export async function runGdriveCli(argv: string[], deps: GdriveCliDeps = {}): Promise<number> {
  const [subcommand, ...rest] = argv;
  const d = resolveDeps(deps);
  switch (subcommand) {
    case undefined:
    case 'status':
      return cmdStatus(d);
    case 'knew-at':
      return cmdKnewAt(d, rest);
    case 'bisect':
      return cmdBisect(d, rest);
    case 'resume':
      return cmdResume(d, rest);
    case 'help':
    case '--help':
    case '-h':
      d.out(USAGE);
      return 0;
    default:
      d.out(`gdrive: unknown subcommand "${subcommand}"`);
      d.out(USAGE);
      return 2;
  }
}
