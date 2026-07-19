/**
 * @file onboard/onboard.ts
 * @description BO12 / scorecard-S12 — the deterministic, ZERO-SPEND onboard
 * planner + executor + machine scan. Beats OpenClaw's "Crestodian" deterministic
 * onboarding: scripted intent (flags), a deterministic setup routine, and NO LLM
 * calls on this path (this module imports nothing from `src/llm`).
 *
 * Layers:
 *   - scanMachine()  — deterministic report of what's already configured.
 *   - buildPlan()    — PURE: given a probe (fileExists/env), what WOULD be done.
 *   - executeOnboard() — performs the plan, hash-audited; honors --dry-run.
 *
 * INVARIANTS honored:
 *   - Zero LLM / zero network on this path (no llm import; nothing calls out).
 *   - Frozen identity/constitution surfaces are NEVER created/overwritten
 *     (invariant 4): every write target is asserted non-frozen before I/O.
 *   - Idempotent: existing files are skipped, never overwritten.
 *   - Every config/file write is hash-audited (before/after sha256 + .bak +
 *     append-only ledger line).
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { isFrozenGuidancePath } from '../workspace/guidance-registry.js';
import { SEED_SPECS, type SeedSpec } from './seeds.js';
import {
  writeFileAudited,
  removeFileAudited,
  type AuditCtx,
  type OnboardAuditRecord,
} from './audit.js';

// ---------------------------------------------------------------------------
// Options + result shapes
// ---------------------------------------------------------------------------

/** Reset scope, mirroring OpenClaw's --reset-scope subset. */
export type ResetScope = 'config' | 'config+creds+sessions' | 'full';

/** Parsed onboard options (from CLI flags or a test harness). */
export interface OnboardOptions {
  nonInteractive: boolean;
  acceptRisk: boolean;
  dryRun: boolean;
  skipChannels: boolean;
  skipHealth: boolean;
  json: boolean;
  /** Operator-supplied gateway token; when absent a random one is generated. */
  gatewayToken?: string;
  reset: boolean;
  resetScope: ResetScope;
}

/** Env keys we probe for existing credentials (values are NEVER printed). */
export const CRED_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'XAI_API_KEY',
  'GROK_API_KEY',
  'OPENROUTER_API_KEY',
] as const;

/** Deterministic machine-scan report (no secrets, no I/O beyond fileExists). */
export interface ScanReport {
  workspacePath: string;
  dataDir: string;
  configEnvPath: string;
  /** Present/absent flags per credential env key (never the value). */
  creds: Record<string, boolean>;
  anyCredDetected: boolean;
  gateway: {
    tokenConfigured: boolean;
    source: 'env' | 'config' | null;
    plan: string;
  };
  defaultModel: string;
}

/** One planned filesystem action. */
export interface PlannedWrite {
  op: 'seed' | 'config-write';
  relPath: string;
  action: 'create' | 'skip-exists' | 'skip-configured';
  reason?: string;
}

/** The full deterministic plan (pure — no I/O performed to build it). */
export interface OnboardPlan {
  scan: ScanReport;
  seeds: PlannedWrite[];
  gatewayToken: PlannedWrite & { willGenerate: boolean };
  reset: { scope: ResetScope; targets: string[] } | null;
  dryRun: boolean;
  /** True when the plan, if executed, would write at least one file. */
  willWrite: boolean;
}

/** Result of executing the plan. */
export interface OnboardResult {
  plan: OnboardPlan;
  records: OnboardAuditRecord[];
  seeded: string[];
  skipped: string[];
  removed: string[];
  gatewayTokenGenerated: boolean;
  dryRun: boolean;
}

/** Injectable dependencies (all default to real fs / crypto / env / paths). */
export interface OnboardDeps {
  rootDir: string;
  auditPath: string;
  env: NodeJS.ProcessEnv;
  /** Absolute path of the dotenv config the gateway token is written into. */
  configEnvRelPath: string;
  /** Random 48-hex token generator (injectable for deterministic tests). */
  genToken: () => string;
  now: () => string;
}

/** Build the default dependency set, honoring SUDO_AI_HOME / DATA_DIR. */
export function defaultDeps(
  rootDir: string,
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): OnboardDeps {
  return {
    rootDir,
    auditPath: path.join(dataDir, 'onboard-audit.jsonl'),
    env,
    configEnvRelPath: 'config/.env',
    genToken: () => randomBytes(24).toString('hex'), // 48 hex chars, like OpenClaw
    now: () => new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

/** Read the gateway token state from env or the config/.env file (no value leak). */
function detectGatewayToken(deps: OnboardDeps): { configured: boolean; source: 'env' | 'config' | null } {
  if (typeof deps.env['GATEWAY_TOKEN'] === 'string' && deps.env['GATEWAY_TOKEN'].length > 0) {
    return { configured: true, source: 'env' };
  }
  const envFile = path.join(deps.rootDir, deps.configEnvRelPath);
  try {
    if (fs.existsSync(envFile)) {
      const raw = fs.readFileSync(envFile, 'utf-8');
      if (/^\s*GATEWAY_TOKEN\s*=\s*\S+/m.test(raw)) return { configured: true, source: 'config' };
    }
  } catch {
    /* unreadable config → treat as unconfigured */
  }
  return { configured: false, source: null };
}

/** Deterministic machine scan — mirrors Crestodian's "AI: nothing detected yet…". */
export function scanMachine(deps: OnboardDeps): ScanReport {
  const creds: Record<string, boolean> = {};
  let anyCredDetected = false;
  for (const key of CRED_ENV_KEYS) {
    const present = typeof deps.env[key] === 'string' && deps.env[key]!.length > 0;
    creds[key] = present;
    if (present) anyCredDetected = true;
  }
  const gw = detectGatewayToken(deps);
  return {
    workspacePath: path.join(deps.rootDir, 'workspace'),
    dataDir: path.dirname(deps.auditPath),
    configEnvPath: path.join(deps.rootDir, deps.configEnvRelPath),
    creds,
    anyCredDetected,
    gateway: {
      tokenConfigured: gw.configured,
      source: gw.source,
      plan: 'runs locally, loopback bind, token auth (private to this machine)',
    },
    defaultModel: 'not configured (deterministic mode — no model, no spend)',
  };
}

// ---------------------------------------------------------------------------
// Plan (pure)
// ---------------------------------------------------------------------------

/** Root-relative POSIX paths that reset scopes may remove. Never frozen. */
function resetTargets(scope: ResetScope): string[] {
  const configOnly = ['config/.env'];
  const creds = ['data/xai-oauth.json', 'data/oauth.json'];
  const sessions = ['data/sessions.db'];
  const workspaceSeeds = SEED_SPECS.map((s) => s.relPath);
  if (scope === 'config') return configOnly;
  if (scope === 'config+creds+sessions') return [...configOnly, ...creds, ...sessions];
  return [...configOnly, ...creds, ...sessions, ...workspaceSeeds]; // full
}

/**
 * Build the deterministic plan. PURE: performs read-only fileExists probes via
 * the injected fs but writes nothing. `fileExists` defaults to real fs.
 */
export function buildPlan(
  opts: OnboardOptions,
  deps: OnboardDeps,
  fileExists: (rel: string) => boolean = (rel) => fs.existsSync(path.join(deps.rootDir, rel)),
): OnboardPlan {
  const scan = scanMachine(deps);

  const seeds: PlannedWrite[] = SEED_SPECS.map((spec) => {
    // Defense in depth: a frozen target is never seeded (invariant 4).
    if (isFrozenGuidancePath(spec.relPath)) {
      return { op: 'seed', relPath: spec.relPath, action: 'skip-configured', reason: 'frozen surface' };
    }
    const exists = fileExists(spec.relPath);
    return {
      op: 'seed',
      relPath: spec.relPath,
      action: exists ? 'skip-exists' : 'create',
      reason: exists ? 'already present' : undefined,
    };
  });

  // Gateway token: generate iff none supplied AND none already configured.
  const supplied = typeof opts.gatewayToken === 'string' && opts.gatewayToken.length > 0;
  const willGenerate = !supplied && !scan.gateway.tokenConfigured;
  const gatewayToken: OnboardPlan['gatewayToken'] = {
    op: 'config-write',
    relPath: deps.configEnvRelPath,
    action: supplied || willGenerate ? 'create' : 'skip-configured',
    reason: scan.gateway.tokenConfigured && !supplied ? 'already configured' : undefined,
    willGenerate,
  };

  const reset = opts.reset ? { scope: opts.resetScope, targets: resetTargets(opts.resetScope) } : null;

  const willWrite =
    !opts.dryRun &&
    (seeds.some((s) => s.action === 'create') ||
      gatewayToken.action === 'create' ||
      (reset !== null && reset.targets.some((t) => fileExists(t))));

  return { scan, seeds, gatewayToken, reset, dryRun: opts.dryRun, willWrite };
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

/** Assert a target is not frozen; throw before any I/O if it is (invariant 4). */
function assertNotFrozen(relPath: string): void {
  if (isFrozenGuidancePath(relPath)) {
    throw new Error(`refusing to write frozen identity/constitution surface: ${relPath}`);
  }
}

/** Upsert `GATEWAY_TOKEN=<tok>` into the config/.env text, replacing any prior line. */
function upsertGatewayToken(existing: string, token: string): string {
  const line = `GATEWAY_TOKEN=${token}`;
  if (/^\s*GATEWAY_TOKEN\s*=.*$/m.test(existing)) {
    return existing.replace(/^\s*GATEWAY_TOKEN\s*=.*$/m, line);
  }
  const base = existing.length === 0 || existing.endsWith('\n') ? existing : existing + '\n';
  return base + line + '\n';
}

/**
 * Execute the plan. Honors --dry-run (writes nothing). Every write is hash-audited.
 * Requires `--accept-risk` to write (throws otherwise) — mirrors OpenClaw's ack.
 */
export function executeOnboard(opts: OnboardOptions, deps: OnboardDeps): OnboardResult {
  const plan = buildPlan(opts, deps);
  const records: OnboardAuditRecord[] = [];
  const seeded: string[] = [];
  const skipped: string[] = [];
  const removed: string[] = [];
  let gatewayTokenGenerated = false;

  const ctx: AuditCtx = { auditPath: deps.auditPath, now: deps.now };

  if (opts.dryRun) {
    // Dry-run: compute plan only. Record what would be skipped for reporting.
    for (const s of plan.seeds) if (s.action !== 'create') skipped.push(s.relPath);
    return { plan, records, seeded, skipped, removed, gatewayTokenGenerated, dryRun: true };
  }

  if (!opts.acceptRisk) {
    throw new Error('onboard: writing requires --accept-risk (real machine access). Re-run with --accept-risk or use --dry-run.');
  }

  // 1. Reset first (destructive), if requested.
  if (plan.reset) {
    for (const rel of plan.reset.targets) {
      assertNotFrozen(rel);
      const abs = path.join(deps.rootDir, rel);
      const rec = removeFileAudited(abs, rel, ctx);
      if (rec) { records.push(rec); removed.push(rel); }
    }
  }

  // 2. Seed workspace guidance files (idempotent — skip existing).
  for (const spec of SEED_SPECS) {
    assertNotFrozen(spec.relPath);
    const abs = path.join(deps.rootDir, spec.relPath);
    if (fs.existsSync(abs)) { skipped.push(spec.relPath); continue; }
    const rec = writeFileAudited(abs, seedBody(spec), spec.relPath, 'seed', ctx);
    records.push(rec);
    seeded.push(spec.relPath);
  }

  // 3. Gateway token — generate/supply + write hash-audited into config/.env.
  if (plan.gatewayToken.action === 'create') {
    const token = opts.gatewayToken && opts.gatewayToken.length > 0 ? opts.gatewayToken : deps.genToken();
    gatewayTokenGenerated = !opts.gatewayToken;
    const abs = path.join(deps.rootDir, deps.configEnvRelPath);
    assertNotFrozen(deps.configEnvRelPath);
    const existing = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf-8') : '';
    const next = upsertGatewayToken(existing, token);
    const rec = writeFileAudited(abs, next, deps.configEnvRelPath, 'config-write', ctx);
    records.push(rec);
  }

  return { plan, records, seeded, skipped, removed, gatewayTokenGenerated, dryRun: false };
}

/** Seed body accessor (kept as a seam so a future variant can template content). */
function seedBody(spec: SeedSpec): string {
  return spec.content;
}
