/**
 * @file onboard/index.ts
 * @description BO12 / scorecard-S12 — CLI entry for `sudo-ai onboard`. Parses
 * flags, runs the deterministic scan → plan → (optional) execute, prints a
 * deterministic report. ZERO LLM, ZERO network on this path — this module and
 * everything it imports touch only fs/crypto/paths.
 *
 * Flags (a sane subset of OpenClaw's ~80):
 *   --non-interactive        scripted run (no chat prompts)
 *   --accept-risk            acknowledge the agent gets real machine access
 *   --dry-run                print the plan; write nothing
 *   --skip-channels          skip channel setup (deterministic no-op here)
 *   --skip-health            skip health checks
 *   --json                   machine-readable output
 *   --gateway-token <tok>    supply a token instead of generating one
 *   --reset                  reset mode
 *   --reset-scope <scope>    config | config+creds+sessions | full
 */

import { PROJECT_ROOT, DATA_DIR } from '../shared/paths.js';
import {
  buildPlan,
  executeOnboard,
  defaultDeps,
  type OnboardOptions,
  type OnboardPlan,
  type OnboardResult,
  type ResetScope,
} from './onboard.js';

const RESET_SCOPES: ResetScope[] = ['config', 'config+creds+sessions', 'full'];

/** Parse argv (already sliced past the subcommand) into OnboardOptions. */
export function parseOnboardArgs(argv: string[]): OnboardOptions {
  const has = (f: string): boolean => argv.includes(f);
  const valueOf = (f: string): string | undefined => {
    const i = argv.indexOf(f);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const scopeRaw = valueOf('--reset-scope');
  const resetScope: ResetScope = RESET_SCOPES.includes(scopeRaw as ResetScope)
    ? (scopeRaw as ResetScope)
    : 'config';
  return {
    nonInteractive: has('--non-interactive'),
    acceptRisk: has('--accept-risk'),
    dryRun: has('--dry-run'),
    skipChannels: has('--skip-channels'),
    skipHealth: has('--skip-health'),
    json: has('--json'),
    gatewayToken: valueOf('--gateway-token'),
    reset: has('--reset'),
    resetScope,
  };
}

/** Render the deterministic scan + plan report (human form). */
function renderReport(plan: OnboardPlan, opts: OnboardOptions): string {
  const s = plan.scan;
  const lines: string[] = [];
  lines.push('SUDO-AI onboard — deterministic setup (zero model, zero spend)');
  lines.push('Heads up: your agent gets real access to this machine.');
  lines.push('');
  lines.push('Machine scan:');
  lines.push(`  workspace:     ${s.workspacePath}`);
  lines.push(`  data dir:      ${s.dataDir}`);
  lines.push(`  config env:    ${s.configEnvPath}`);
  const detected = Object.entries(s.creds).filter(([, v]) => v).map(([k]) => k);
  lines.push(`  AI creds:      ${detected.length ? detected.join(', ') + ' detected (env)' : 'nothing detected yet'}`);
  lines.push(`  gateway:       ${s.gateway.tokenConfigured ? `token configured (${s.gateway.source})` : 'no token yet'} — ${s.gateway.plan}`);
  lines.push(`  default model: ${s.defaultModel}`);
  lines.push('');
  lines.push('Plan:');
  for (const w of plan.seeds) {
    lines.push(`  [seed]   ${w.relPath} — ${w.action}${w.reason ? ` (${w.reason})` : ''}`);
  }
  const gt = plan.gatewayToken;
  lines.push(`  [config] ${gt.relPath} GATEWAY_TOKEN — ${gt.action}${gt.willGenerate ? ' (generate 48-hex)' : ''}${gt.reason ? ` (${gt.reason})` : ''}`);
  if (plan.reset) {
    lines.push(`  [reset]  scope=${plan.reset.scope} → ${plan.reset.targets.join(', ')}`);
  }
  if (opts.skipChannels) lines.push('  channels: skipped (--skip-channels)');
  if (opts.skipHealth) lines.push('  health:   skipped (--skip-health)');
  lines.push('');
  lines.push(plan.dryRun ? 'DRY-RUN: nothing written.' : plan.willWrite ? 'Applying…' : 'Nothing to do (idempotent — already configured).');
  return lines.join('\n');
}

/** Render the post-execution summary. */
function renderResult(result: OnboardResult): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('Result:');
  lines.push(`  seeded:  ${result.seeded.length ? result.seeded.join(', ') : '(none)'}`);
  lines.push(`  skipped: ${result.skipped.length ? result.skipped.join(', ') : '(none)'}`);
  if (result.removed.length) lines.push(`  removed: ${result.removed.join(', ')}`);
  lines.push(`  gateway token: ${result.gatewayTokenGenerated ? 'generated + written (hash-audited)' : result.records.some((r) => r.op === 'config-write') ? 'written (hash-audited)' : 'unchanged'}`);
  lines.push(`  audit records: ${result.records.length}`);
  return lines.join('\n');
}

/**
 * CLI entry wired into cli.ts. Returns a process exit code. Deterministic and
 * side-effect-scoped to fs writes under the resolved home (never LLM/network).
 */
export async function runOnboard(argv: string[]): Promise<number> {
  const opts = parseOnboardArgs(argv);
  const deps = defaultDeps(PROJECT_ROOT, DATA_DIR);

  // Preview path: no --non-interactive means we only scan + print the plan
  // (never write), so a bare `onboard` can't mutate anything unexpectedly.
  const previewOnly = !opts.nonInteractive && !opts.dryRun;
  const effectiveOpts: OnboardOptions = previewOnly ? { ...opts, dryRun: true } : opts;

  const plan = buildPlan(effectiveOpts, deps);

  if (opts.json && effectiveOpts.dryRun) {
    console.log(JSON.stringify({ plan, previewOnly }, null, 2));
    if (previewOnly) console.error('onboard: preview only — add --non-interactive --accept-risk to apply.');
    return 0;
  }

  console.log(renderReport(plan, effectiveOpts));

  if (effectiveOpts.dryRun) {
    if (previewOnly) console.log('\nPreview only — add --non-interactive --accept-risk to apply.');
    return 0;
  }

  const result = executeOnboard(effectiveOpts, deps);
  if (opts.json) {
    console.log(JSON.stringify({ result }, null, 2));
  } else {
    console.log(renderResult(result));
  }
  return 0;
}
