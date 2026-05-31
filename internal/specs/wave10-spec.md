# SUDO-AI Wave 10 — OpenJarvis Parity Spec
# Authored: 2026-04-15 | Architect: claude-sonnet-4-6
# Status: FINAL — do not modify without Architect sign-off

---

## A. EXECUTIVE SUMMARY

Wave 10 ships all 17 scope items in a single parallel wave with 4 builders.
Estimated LOC: 5,500-7,000 net new TypeScript + 3 TOML preset files.
Estimated new tests: +300 (target distribution: B1 +85, B2 +75, B3 +75, B4 +65).
Wave duration: 5-7 days with 4 simultaneous builders.
New npm dep required: smol-toml (ESM-native TOML parser, ~4 KB, zero sub-deps). Builder 3 installs Day 1.
New CLI commands extend existing src/cli/index.ts (commander-based binary already wired).
Gate chain: Integrator (tsc --noEmit + interface check) → Security (Opus adversarial, VETO)
  → Quality (100% pass, Wave 9 baseline 2527) → Performance Watchdog (soak p99 < 300 ms)
  → User Advocate (CLI UX: bench/scan/doctor/quickstart/init)
  → Rollback Guardian → DevOps (pm2 reload sudo-ai-v5).
Pre-existing 4 test failures are NOT regressions. Quality Engineer documents them at gate start.
Shared types canonical location: src/core/shared/wave10-types.ts (Architect-written, builders import-only).

---

## B. DATA MODELS + INTERFACES

All types below are canonical. Written to src/core/shared/wave10-types.ts by Architect before builder start.
Builders IMPORT from that file — never re-declare, never modify it.

### B1. SkillManifest

```typescript
export type SkillTrustTier = 'bundled' | 'indexed' | 'unreviewed' | 'workspace';
export type SkillSourceScheme = 'github' | 'openclaw' | 'openjarvis' | 'local' | 'bundled';

export interface SkillManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  source: string;                // e.g. "github:user/repo/skill.md"
  scheme: SkillSourceScheme;
  caps: string[];                // e.g. ["fs.read", "net.fetch"]
  tools: ToolTranslatorEntry[];
  trust: SkillTrustTier;
  contentHash: string;           // SHA-256 of raw skill file
  importedAt: string;            // ISO-8601
  tags?: string[];
  minVersion?: string;
}
```

### B2. ToolTranslator

```typescript
export interface ToolTranslatorEntry {
  canonical: string;             // agentskills.io name: "Bash", "Read"
  sudoName: string;              // SUDO-AI name: "system.shell", "coder.read-file"
  paramMap?: Record<string, string>;
}
export type ToolTranslatorTable = ToolTranslatorEntry[];
```

### B3. TracePattern

```typescript
export interface TracePattern {
  id: string;
  toolSequence: string[];
  occurrenceCount: number;
  successRate: number;           // 0..1
  firstSeen: string;             // ISO-8601
  lastSeen: string;              // ISO-8601
  proposalGenerated: boolean;
}
```

### B4. AgentConfigProposal

```typescript
export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'applied';

export interface AgentConfigProposal {
  id: string;
  agentId: string;
  rationale: string;
  delta: Record<string, unknown>;
  traceQuality: number;          // 0..1
  traceCount: number;
  status: ProposalStatus;
  createdAt: string;
  updatedAt: string;
}
```

### B5. ComplexityResult

```typescript
export type ComplexityTier = 'simple' | 'moderate' | 'complex' | 'very_complex';

export interface ComplexityResult {
  score: number;                    // normalised 0..1
  tier: ComplexityTier;
  signals: string[];
  suggested_max_tokens: number;     // 2048 | 4096 | 8192 | 16384
  thinking_model: boolean;          // true if x2 multiplier applied
}
```

Tier thresholds (Builder 2 must implement exactly):
- simple: score < 0.25 → 2048
- moderate: 0.25 <= score < 0.5 → 4096
- complex: 0.5 <= score < 0.75 → 8192
- very_complex: score >= 0.75 → 16384
- thinking_model multiplier x2: model name contains "think" or "reason"

Scoring signals (additive):
- code_blocks: fenced code present (+0.2)
- tool_count: >5 tools available (+0.1)
- message_length: prompt >2000 chars (+0.15)
- multi_step_keywords: plan/then/next/step/pipeline (+0.05 each)
- json_depth: estimated nesting >2 (+0.1)

### B6. BenchResult + BenchReport

```typescript
export type SkillCondition = 'no_skills' | 'skills_on' | 'skills_optimized';

export interface BenchResult {
  id: string;
  runId: string;
  model: string;
  agentId: string;
  taskId: string;
  condition: SkillCondition;
  seedIndex: number;
  success: boolean;
  latencyMs: number;
  costUsd: number;
  complexityTier: ComplexityTier;
  timestamp: string;
}

export interface BenchReport {
  runId: string;
  startedAt: string;
  completedAt: string;
  totalTasks: number;
  successRate: number;
  medianLatencyMs: number;
  p99LatencyMs: number;
  totalCostUsd: number;
  byCondition: Record<SkillCondition, { successRate: number; medianLatencyMs: number }>;
  byModel: Record<string, { successRate: number; medianLatencyMs: number }>;
  markdownSummary: string;
}
```

### B7. Config5Pillar

```typescript
export interface PillarIntelligence {
  default_model?: string;
  fallback_model?: string;
  temperature?: number;
  max_tokens?: number;
}
export interface PillarAgent {
  max_iterations?: number;
  system_prompt_append?: string;
}
export interface PillarTools {
  disabled?: string[];
  mcp_servers?: string[];
}
export type EngineRuntime = 'sudoapi' | 'ollama' | 'llamacpp' | 'openai_compat';
export interface PillarEngine {
  runtime?: EngineRuntime;
  host?: string;
  prefer_local?: boolean;
}
export interface LearningPolicy { policy?: 'heuristic' | 'none' | 'evolver'; }
export interface LearningWeights {
  accuracy?: number;
  latency?: number;
  cost?: number;
  efficiency?: number;
}
export interface PillarLearning {
  routing?: LearningPolicy;
  intelligence?: LearningPolicy;
  agent?: LearningPolicy;
  weights?: LearningWeights;
  min_quality?: number;
  min_sft_pairs?: number;
}
export interface Config5Pillar {
  intelligence?: PillarIntelligence;
  agent?: PillarAgent;
  tools?: PillarTools;
  engine?: PillarEngine;
  learning?: PillarLearning;
}
```

Config merge order: JSON5 base (SudoConfig) → TOML overlay (Config5Pillar) → env vars (env wins).
SudoConfig interface in src/core/config/types.ts is NOT modified by Wave 10.
Mapping:
  intelligence → models + auth (override fields only)
  agent        → agents (override fields only)
  tools        → tools (override fields only)
  engine       → NEW (runtime-only, no JSON5 equivalent)
  learning     → NEW (runtime-only, no JSON5 equivalent)

### B8. OperatorManifest

```typescript
export interface OperatorSchedule {
  type: 'interval' | 'cron';
  value: string | number;        // seconds (interval) or cron expression
}
export interface OperatorAgentConfig {
  max_turns?: number;
  temperature?: number;
  tools?: string[];
  prompt_path?: string;
  prompt?: string;
}
export interface OperatorManifest {
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  agent: OperatorAgentConfig;
  schedule: OperatorSchedule;
  tags?: string[];
}
```

### B9. Recipe

```typescript
export interface RecipeOperatorRef { name: string; enabled?: boolean; }
export interface Recipe {
  id: string;
  name: string;
  description: string;
  author: string;
  version: string;
  config: Config5Pillar;
  operators?: RecipeOperatorRef[];
  channels?: string[];
  tags?: string[];
}
```

### B10. SavingsRow + CompareResult

```typescript
export interface EnergyEstimate {
  wh: number;
  flops: number;
  source: 'measured' | 'estimated';
}
export interface SavingsRow {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  inputCostPerM: number;
  outputCostPerM: number;
  energy: EnergyEstimate;
  period: 'session' | 'day' | 'week' | 'month' | 'all';
  periodStart: string;
}
export interface CompareResult {
  runId: string;
  modelA: string;
  modelB: string;
  prompt: string;
  responseA: string;
  responseB: string;
  latencyAms: number;
  latencyBms: number;
  costAusd: number;
  costBusd: number;
  complexityA: ComplexityResult;
  complexityB: ComplexityResult;
  timestamp: string;
}
```

### B11. Taint

```typescript
export type TaintLevel = 'clean' | 'low' | 'medium' | 'high' | 'critical';
export type TaintSource =
  | 'user_input' | 'tool_output' | 'external_fetch'
  | 'skill_exec' | 'channel_message' | 'unknown';

export interface Taint {
  level: TaintLevel;
  source: TaintSource;
  origin: string;
  taintId: string;
  assignedAt: string;
  ancestors?: string[];
}
export interface TaintViolation {
  taint: Taint;
  toolName: string;
  reason: string;
  timestamp: string;
}
```

Propagation contract (Builder 4 — TaintTracker class):
  Rule 1: Every ToolCallResult from external tool → Taint{level='medium', source='tool_output'}.
  Rule 2: When input refs prior tainted result, new result inherits MAX(ancestor levels).
  Rule 3: TaintTracker subscribes to HookManager 'tool-result'. Emits 'taint-assigned'.
  Rule 4: taint.level >= 'high' AND next tool is 'destructive' → emit 'taint-violation', return BLOCK.
  Rule 5: Tools with category 'security' may output level='clean'.

### B12. CapabilityUnion

```typescript
export type Capability = string;  // "domain.permission" e.g. "fs.read"
export interface TierCapabilityPolicy {
  bundled: Capability[];
  indexed: Capability[];
  unreviewed: Capability[];
  workspace: Capability[];
}
export const DEFAULT_TIER_CAPS: TierCapabilityPolicy = {
  bundled:    ['fs.read','fs.write','net.fetch','db.read','db.write','shell.exec','skill.load'],
  indexed:    ['fs.read','net.fetch','db.read'],
  unreviewed: ['fs.read'],
  workspace:  ['fs.read','fs.write','net.fetch','db.read'],
};
export interface CapabilityCheckResult { granted: boolean; missing: Capability[]; }
```

### B13. SignedArtifact

```typescript
export interface SignedArtifact {
  payload: unknown;
  signedAt: string;
  keyId: string;                // first 8 chars of pubkey DER hex
  signature: string;            // ed25519, hex-encoded, over JSON.stringify(payload)+signedAt
  artifactType: 'skill' | 'bench_report' | 'config_proposal' | 'trace_pattern' | 'generic';
}
export interface ArtifactVerifyResult {
  valid: boolean;
  keyId: string;
  signedAt: string;
  error?: string;
}
```

### B14. AgentEvent trace-meta variant

Builder 2 appends to existing AgentEvent union in src/core/agent/types.ts:
```typescript
// APPEND ONLY — do not modify existing variants:
| { type: 'trace-meta'; skillId?: string; skillSource?: string; skillKind?: string;
    complexity?: import('../shared/wave10-types.js').ComplexityResult;
    taint?: import('../shared/wave10-types.js').Taint }
```

### B15. HardwareProfile

```typescript
export interface HardwareProfile {
  cpuModel: string;
  cpuCores: number;
  ramMb: number;
  hasGpu: boolean;
  gpuModel?: string;
  gpuVramMb?: number;
  meetsMinimum: boolean;         // cpuCores >= 2 AND ramMb >= 2048
  warnings: string[];
  recommendedRuntime: EngineRuntime;
  wasmtimeAvailable: boolean;
}
```

---

## C. REST ENDPOINTS

All: raw node:http, timing-safe Bearer auth via GATEWAY_TOKEN, 256 KB body cap.
Error shape: { error: { message: string; code: number } }

### C1. POST /v1/skills/import  (Builder 1 — added inside existing skills/routes.ts handleRequest)
Body: { uri: string; trustOverride?: SkillTrustTier }
200: { skill: SkillManifest; imported: true }
400: invalid URI or unsupported scheme
409: duplicate (same id+version already exists)
422: capability check failed { missing: Capability[] }
NOTE: This is added INSIDE handleRequest() in skills/routes.ts, not a new route file.
The existing server.on('request') handler already catches /v1/skills/*.
No new http-api.ts fallthrough entry needed for this path.

### C2. GET /v1/admin/learning/proposals  (Builder 2 — new learning-routes.ts)
Query: ?status=pending|approved|rejected|applied&limit=50&offset=0
200: { data: AgentConfigProposal[]; total: number; limit: number; offset: number }

### C3. POST /v1/admin/learning/proposals/:id/approve  (Builder 2)
Body: {}
200: { proposal: AgentConfigProposal }
404: not found | 409: already approved/applied

### C4. POST /v1/admin/learning/proposals/:id/reject  (Builder 2)
Body: { reason?: string }
200: { proposal: AgentConfigProposal }

### C5. GET /v1/admin/bench  (Builder 2 — new bench-routes.ts)
200: { runs: Array<{ runId: string; startedAt: string; totalTasks: number; successRate: number }> }

### C6. GET /v1/admin/bench/results  (Builder 2)
Query: ?runId=<uuid>&model=<id>&condition=<SkillCondition>&limit=100
200: { data: BenchResult[]; report?: BenchReport }

### C7. POST /v1/admin/bench/run  (Builder 2)
Body: { models?: string[]; tasks?: string[]; conditions?: SkillCondition[]; seeds?: number }
202: { runId: string; status: "queued" }
Note: bench runs async; poll C5 for completion status.

### C8. GET /v1/savings  (Builder 3 — savings-routes.ts; wired by Builder 2)
Query: ?period=session|day|week|month|all
200: { rows: SavingsRow[]; totalCostUsd: number; totalWh: number; totalFlops: number }

### C9. GET /v1/admin/compare  (Builder 3 — compare-routes.ts; wired by Builder 2)
Query: ?a=<modelId>&b=<modelId>&prompt=<text>
200: CompareResult
400: missing a, b, or prompt
Note: both model calls concurrent via Promise.all; uses existing brain/race.ts pattern.

---

## D. CLI COMMANDS

CRITICAL FINDING: src/cli/index.ts ALREADY EXISTS with commander + existing doctor command.
src/cli/commands/doctor.ts ALREADY EXISTS.

Builder 2 owns: src/cli/index.ts (EXTEND — add bench/scan/quickstart/init commands)
Builder 3 owns: src/cli/commands/scan.ts (NEW), src/cli/commands/quickstart.ts (NEW),
                src/cli/commands/init.ts (NEW)
                src/cli/commands/doctor.ts (EXTEND — add --fix flag and new checks)
Builder 2 owns: src/cli/commands/bench.ts (NEW)

### D1. sudo-ai bench [--models m1,m2] [--tasks t1,t2] [--conditions c1,c2] [--seeds N] [--output markdown|json]
Default: all primary models, 5 built-in tasks, all 3 conditions, 1 seed.
Calls POST /v1/admin/bench/run, polls until complete, prints BenchReport.markdownSummary.
--output json → raw BenchReport JSON.
Exit 0 if successRate >= 0.5, exit 1 otherwise.

### D2. sudo-ai scan [--json]
Checks: GATEWAY_TOKEN strength (>=32 chars), env var leak patterns, config file permissions,
vault key presence, port 18900 bind address (warn if 0.0.0.0), domain-validator allowlist.
Output: table of check | PASS/WARN/FAIL | detail.
--json → { checks: Array<{name,status,detail}>; score: number }
Exit 0 if all PASS, exit 1 if any FAIL.

### D3. sudo-ai doctor [--fix]  (extends existing doctor.ts)
Existing health checks preserved. New checks added: wasmtimeAvailable, disk >200 MB, mem >512 MB.
--fix: auto-remediate where possible.
Exit 0 if all healthy, exit 1 otherwise.

### D4. sudo-ai quickstart
5-step interactive wizard (Node readline, no new dep):
  1. Agent name → meta.name
  2. Model choice (lists primary options)
  3. Enable Telegram? (y/n)
  4. Pick preset: coding/research/chat
  5. Run doctor now? (y/n)
Merges answers into config/sudo-ai.json5. Exit 0 always.

### D5. sudo-ai init [--preset coding|research|chat]
Without --preset: lists available presets with descriptions.
With --preset X: loads workspace/recipes/X.toml, applies Config5Pillar overlay,
activates declared operators, prints summary of changes applied.
Prompts for confirmation before overwriting existing config. Exit 0 on success.

---

## E. FILE OWNERSHIP PARTITION

STRICT. Zero overlap. One builder per file.
Shared types: src/core/shared/wave10-types.ts — Architect-written, all builders import-only.

### BUILDER 1 — Skills + Learning
```
src/core/skills/importer.ts              (NEW — SkillImporter with 3 resolvers)
src/core/skills/tool-translator.ts       (NEW — ToolTranslatorTable + translate())
src/core/skills/trust-policy.ts          (NEW — tier enforcement + cap intersection)
src/core/skills/routes.ts                (EXTEND — add /import case inside handleRequest only)
src/core/skills/markdown-loader.ts       (EXTEND — add trust/caps to loaded skill fields)
src/core/skills/registry.ts              (EXTEND — trust tier filtering + cap check at attach)
src/core/skills/registry-sql.ts          (EXTEND — skills_manifest table + trust/caps columns)
src/core/learning/skill-discovery.ts     (NEW)
src/core/learning/agent-config-evolver.ts (NEW)
src/core/learning/proposal-store.ts      (NEW — SQLite-backed ProposalStore)
```
NOT touching: loop.ts, agent/types.ts, admin-routes.ts, cli.ts, cli/index.ts.
Submits snippet to Builder 2 for cli.ts wiring (SkillDiscovery + ProposalStore init).

### BUILDER 2 — Eval + Runtime Hooks + CLI wire-in
```
src/core/eval/bench-runner.ts            (NEW)
src/core/eval/skill-bench.ts             (NEW)
src/core/eval/bench-store.ts             (NEW — SQLite-backed BenchResult CRUD)
src/core/eval/task-set.ts               (NEW — 5 built-in bench task definitions)
src/core/agent/complexity-scorer.ts     (NEW)
src/core/agent/loop.ts                  (EXTEND — 10-line complexity hook after brain call + trace-meta event)
src/core/agent/types.ts                 (EXTEND — append trace-meta to AgentEvent union)
src/core/gateway/bench-routes.ts        (NEW — C5/C6/C7)
src/core/gateway/learning-routes.ts     (NEW — C2/C3/C4)
src/core/gateway/http-api.ts            (EXTEND — 4 new fallthroughs + import+register new route files)
src/core/commands/builtin/bench.ts      (NEW — internal bench command handler)
src/cli.ts                              (EXTEND — paste all builder snippets)
src/cli/index.ts                        (EXTEND — add bench/scan/quickstart/init subcommands)
src/cli/commands/bench.ts               (NEW — CLI bench command)
```
NOT touching: admin-routes.ts (new route families in separate files).

http-api.ts fallthroughs Builder 2 must add (4 total — NOT /v1/skills/import, that's already covered):
  /v1/admin/bench        (own bench-routes)
  /v1/admin/learning     (own learning-routes)
  /v1/savings            (Builder 3 savings-routes)
  /v1/admin/compare      (Builder 3 compare-routes)

### BUILDER 3 — Config + Ops + UX
```
src/core/config/loader.ts               (EXTEND — TOML overlay via smol-toml)
src/core/operators/loader.ts            (NEW)
src/core/operators/migrator.ts          (NEW — HEARTBEAT.md task shim)
src/core/operators/index.ts             (NEW — barrel)
src/core/recipes/composer.ts            (NEW)
src/core/recipes/index.ts              (NEW — barrel)
src/core/brain/costs.ts                 (EXTEND — energy+FLOPs per provider)
src/core/gateway/savings-routes.ts      (NEW — C8)
src/core/gateway/compare-routes.ts      (NEW — C9)
src/cli/commands/scan.ts                (NEW)
src/cli/commands/doctor.ts              (EXTEND — add --fix flag, new checks)
src/cli/commands/quickstart.ts          (NEW)
src/cli/commands/init.ts                (NEW)
workspace/operators/heartbeat-summarizer.toml (NEW)
workspace/operators/daily-briefing.toml       (NEW)
workspace/operators/security-sentinel.toml    (NEW)
workspace/recipes/coding.toml                 (NEW)
workspace/recipes/research.toml               (NEW)
workspace/recipes/chat.toml                   (NEW)
```
Day 1 FIRST ACTION: cd /root/sudo-ai-v4 && pnpm add smol-toml — this is a Day 1 blocker.
NOT touching: cli.ts directly, config/types.ts content.

Exports Builder 2 depends on:
  registerSavingsRoutes(server: HttpServer, deps: { costTracker: CostTrackerLike }): void
  registerCompareRoutes(server: HttpServer, deps: { brain: BrainLike; complexityScorer: ComplexityScorerLike }): void
  loadConfig5Pillar(tomlPath?: string): Promise<Config5Pillar>

### BUILDER 4 — Security + Sandbox + Connectors + Hardware
```
src/core/sandbox/wasm-runner.ts              (NEW)
src/core/sandbox/index.ts                    (EXTEND — export WasmRunner)
src/core/security/taint-tracker.ts           (NEW)
src/core/security/signer.ts                  (NEW)
src/core/config/hardware-detect.ts           (NEW)
src/core/channels/gmail-connector.ts         (NEW)
src/core/channels/gcalendar-connector.ts     (NEW)
src/core/channels/github-connector.ts        (NEW)
src/core/channels/slack-real-connector.ts    (NEW)
src/core/channels/imessage-connector.ts      (NEW)
src/core/tools/builtin/comms/gmail.ts        (NEW — category: 'comms')
src/core/tools/builtin/comms/gcalendar.ts    (NEW — category: 'comms')
src/core/tools/builtin/comms/github-notify.ts (NEW — category: 'comms')
src/core/tools/builtin/comms/slack-rt.ts     (NEW — category: 'comms')
src/core/tools/builtin/comms/imessage.ts     (NEW — category: 'comms')
```
NOT touching: cli.ts directly, types.ts.

Connector scoping rules:
  Gmail/GCalendar: OAuth tokens pre-stored in vault via oauthRefreshDaemon. No new consent flow.
    getCredential() from vault-credentials.ts. If absent → {success:false, output:'Token not configured'}.
  Slack: raw ws module (already installed). Slack RTM/Events API over WebSocket.
  iMessage: osascript subprocess. macOS only. On Linux → {success:false, output:'iMessage requires macOS'}.
  WASM: wasmtime CLI subprocess via spawnSync. If not in PATH → graceful not-available at init.

---

## F. SHARED TYPES FILE POLICY

File: src/core/shared/wave10-types.ts
Written by: Architect only (Section B above is the full content)
Builders: IMPORT ONLY. Never modify. Never re-declare any type from this file.
Import pattern: import type { SkillManifest, ComplexityResult, ... } from '../shared/wave10-types.js';

Import depth guide (count segments manually — ESM requires exact paths):
  From src/core/skills/*.ts:              '../shared/wave10-types.js'
  From src/core/agent/*.ts:              '../shared/wave10-types.js'
  From src/core/eval/*.ts:               '../shared/wave10-types.js'
  From src/core/learning/*.ts:           '../shared/wave10-types.js'
  From src/core/gateway/*.ts:            '../shared/wave10-types.js'
  From src/core/security/*.ts:           '../shared/wave10-types.js'
  From src/core/config/*.ts:             '../shared/wave10-types.js'
  From src/core/operators/*.ts:          '../shared/wave10-types.js'
  From src/core/recipes/*.ts:            '../shared/wave10-types.js'
  From src/core/tools/builtin/comms/*.ts: '../../../../shared/wave10-types.js'

---

## G. INTERFACE CONTRACTS BETWEEN BUILDERS

### G1. Builder 1 → Builder 2 (loop.ts hook site)
Builder 1 exports from skill-discovery.ts:
```typescript
export class SkillDiscovery {
  recordToolCall(sessionId: string, toolName: string, success: boolean): void;
  mine(windowMs?: number): TracePattern[];
}
```
Builder 2 calls skillDiscovery.recordToolCall() after each 'tool-result' event in loop.ts.
Builder 2 emits { type: 'trace-meta', skillId, complexity } AgentEvent after brain call.

### G2. Builder 1 → Builder 2 (learning routes deps)
Builder 1 exports from proposal-store.ts:
```typescript
export class ProposalStore {
  list(filter: { status?: ProposalStatus; limit: number; offset: number }): { data: AgentConfigProposal[]; total: number };
  approve(id: string): AgentConfigProposal;
  reject(id: string, reason?: string): AgentConfigProposal;
  getById(id: string): AgentConfigProposal | null;
}
```
Builder 2's learning-routes.ts accepts ProposalStore via constructor injection.

### G3. Builder 3 → Builder 2 (savings/compare registration callback)
Builder 3 exports:
```typescript
export function registerSavingsRoutes(server: HttpServer, deps: { costTracker: CostTrackerLike }): void;
export function registerCompareRoutes(server: HttpServer, deps: { brain: BrainLike; complexityScorer: ComplexityScorerLike }): void;
```
Builder 2 imports and calls both in http-api.ts setup (same pattern as registerFederationRoutes).

### G4. Builder 3 → Builder 2 (config overlay)
Builder 3 exports from loader.ts:
```typescript
export function loadConfig5Pillar(tomlPath?: string): Promise<Config5Pillar>;
```
Called in cli.ts boot step 1.5 via Builder 3 snippet.

### G5. Builder 4 → Builder 2 (hardware detect)
Builder 4 exports from hardware-detect.ts:
```typescript
export async function detectHardware(): Promise<HardwareProfile>;
```
Called in cli.ts boot step 0.5 via Builder 4 snippet.

### G6. Builder 4 → Builder 2 (taint + signer)
Builder 4 exports:
```typescript
export class TaintTracker {
  tag(toolName: string, source: TaintSource, level?: TaintLevel): Taint;
  propagate(parentTaintIds: string[], toolName: string): Taint;
  checkViolation(toolName: string, safety: 'readonly' | 'destructive', taintId: string): TaintViolation | null;
  onToolResult(event: { name: string; result: ToolResult; taintId?: string }): Taint;
}
export class ArtifactSigner {
  sign(payload: unknown, artifactType: SignedArtifact['artifactType']): SignedArtifact;
  verify(artifact: SignedArtifact): ArtifactVerifyResult;
}
```

---

## H. WIRE-IN PLAN FOR cli.ts

Builder 2 owns ALL cli.ts AND cli/index.ts edits.
Others submit snippets in this format:
  SNIPPET FOR cli.ts | Position: <label> | Code: <TypeScript>

Insertion points in src/cli.ts:
  BOOT_STEP_0.5         — hardware detect (Builder 4 snippet)
  BOOT_STEP_1.5         — TOML overlay loading (Builder 3 snippet)
  AFTER_SKILL_REGISTRY  — SkillDiscovery + ProposalStore init (Builder 1 snippet)
  BEFORE_GATEWAY_START  — register bench/learning/savings/compare routes (Builder 2 + B3 snippets)
  OPERATOR_LOADER_INIT  — OperatorLoader init (Builder 3 snippet)

Boot step 0.5 (Builder 4 delivers):
```typescript
import { detectHardware } from './core/config/hardware-detect.js';
// In boot(), first thing:
const hw = await detectHardware();
if (hw.warnings.length > 0) hw.warnings.forEach(w => log.warn({ hw }, w));
```

Insertions in src/cli/index.ts (Builder 2 adds):
- bench subcommand (dispatches to cli/commands/bench.ts)
- scan subcommand (dispatches to cli/commands/scan.ts)
- quickstart subcommand (dispatches to cli/commands/quickstart.ts)
- init subcommand with --preset option (dispatches to cli/commands/init.ts)
- --fix option on existing doctor subcommand (Builder 3 extends doctor.ts, Builder 2 adds flag to index.ts)

---

## I. TEST PLAN

Baseline: 2527 tests (Wave 9). Pre-existing 4 failures documented by QE at gate entry.
Target: 2827+ passing tests total.

Builder 1 (+85):
  importer.ts: github/openclaw/openjarvis resolver (mock HTTP), invalid URI, trust tier, cap fail (15)
  tool-translator.ts: translate() happy path, unknown canonical, paramMap remap (10)
  trust-policy.ts: cap intersection per tier, unreviewed gets only fs.read (12)
  skill-discovery.ts: mine() finds repeated sequences, min-occurrence threshold (15)
  agent-config-evolver.ts: proposal from traces, min_quality gate, ProposalStore CRUD (20)
  routes.ts import endpoint: valid import 200, duplicate 409, cap violation 422 (13)

Builder 2 (+75):
  complexity-scorer.ts: each tier threshold, each signal, thinking_model multiplier (20)
  bench-runner.ts: mock brain calls, result aggregation, BenchReport generation (20)
  bench-store.ts: CRUD, filter by condition/model (10)
  bench-routes.ts: GET /v1/admin/bench, GET results with filter, POST run (15)
  learning-routes.ts: GET proposals, approve, reject (10)

Builder 3 (+75):
  loader.ts TOML: parse overlay, merge with JSON5 base, missing file returns empty pillar (15)
  operator-loader.ts: valid TOML loads, invalid TOML errors, enabled=false skipped (15)
  recipes/composer.ts: 3 presets load and apply Config5Pillar correctly (10)
  savings-routes.ts: period param, empty tracker returns zeros (10)
  compare-routes.ts: missing params 400, mock brain two responses (10)
  CLI: scan table output, doctor health items, init --preset applies recipe (15)

Builder 4 (+65):
  taint-tracker.ts: tag assignment, propagation inherits max level, violation blocks destructive (20)
  signer.ts: sign+verify roundtrip, tampered payload fails verify, keyId format (15)
  hardware-detect.ts: mock cpus/totalmem, under-minimum warning, recommendedRuntime (10)
  wasm-runner.ts: not found → graceful, found → subprocess call (10)
  gmail-connector.ts: mock OAuth token retrieval, mock HTTPS call returns messages (10)

---

## J. GATE CHAIN

All 4 builders signal Integrator simultaneously when done.

STEP 4 — INTEGRATOR (Sonnet):
  tsc --noEmit: zero errors required.
  Import graph: no circular deps in new files.
  Interface contracts G1-G6: each call site compiles.
  http-api.ts fallthrough list includes ALL 4 new namespaces (/v1/admin/bench, /v1/admin/learning, /v1/savings, /v1/admin/compare).
  wave10-types.ts: no builder modified it (git diff check).
  PASS → Security

STEP 5 — SECURITY ENGINEER (Opus, VETO):
  SkillImporter URI parsing: SSRF risk from github:/openclaw: resolvers (validate host allowlist).
  TaintTracker: no bypass path via ancestor chain manipulation.
  Signer key storage: must live in vault, never env or disk plaintext.
  All new endpoints: auth required (check every new server.on handler).
  compare endpoint: prompt injection surface (prompt param → LLM).
  Capability bypass: unreviewed skill cannot escalate to fs.write.
  APPROVED → Quality | REJECTED → specific builder with exact fixes

STEP 6 — QUALITY ENGINEER (Sonnet):
  Run full vitest suite.
  Document pre-existing 4 failures (not regressions).
  Must achieve 2827+ passing tests; 100% on all Wave 10 new tests.
  PASS → Performance

STEP 7 — PERFORMANCE WATCHDOG (Sonnet):
  Soak: 150 req, p99 < 300 ms (Wave 9 baseline preserved).
  Bench run (5 tasks × 3 conditions): < 120 s async, no gateway blocking.
  ComplexityScorer: < 2 ms added to p99.
  PASS → User Advocate

STEP 8 — USER ADVOCATE (Sonnet):
  sudo-ai bench --help: readable, all flags shown.
  sudo-ai scan: exits 0 or 1, human-readable table output.
  sudo-ai doctor: health items visible, suggestions actionable.
  sudo-ai quickstart: wizard prompts appear in sequence.
  sudo-ai init --preset coding: applies recipe, no silent failures.
  GET /v1/savings: valid JSON.
  GET /v1/admin/compare?a=grok&b=claude&prompt=hello: CompareResult shape.
  PASS → Rollback Guardian

STEP 9 — ROLLBACK GUARDIAN:
  cp -r /root/sudo-ai-v4 /root/sudo-ai-v4-wave9-backup
  pm2 save
  Confirm backup size matches source within 1 MB.
  CONFIRMED → DevOps

STEP 10 — DEVOPS (Sonnet):
  pnpm install (for smol-toml).
  tsc --noEmit (final check).
  pm2 reload sudo-ai-v5.
  GET /health → 200.
  pm2 logs sudo-ai-v5 --lines 50: no ERROR for 60 s.
  DEPLOYED → Lead

---

## K. RISK REGISTER

RISK 1 (HIGH) — Gmail OAuth token management:
  Scope: tokens pre-stored in vault by operator. Connector reads via oauthRefreshDaemon.getCredential().
  No new browser-based consent flow.
  Absent token → {success:false, output:'Gmail not configured — run sudo-ai quickstart'}.
  No silent fail. Builder 4 documents setup in gmail-connector.ts file docstring.

RISK 2 (HIGH) — smol-toml Day 1 install:
  Builder 3's TOML loading, OperatorLoader, RecipeComposer all blocked until smol-toml installed.
  Mitigation: Lead confirms pnpm add smol-toml and package.json updated before Builder 3 starts coding.

RISK 3 (MEDIUM) — http-api.ts fallthrough omission:
  Missing fallthrough → silent 404 for all routes under that prefix.
  Mitigation: Integrator explicitly checks all 4 new prefixes before passing gate.

RISK 4 (MEDIUM) — wasmtime not on VPS:
  WasmRunner logs WARN at startup if not found. HardwareProfile.wasmtimeAvailable field exposed.
  sudo-ai doctor reports wasmtime status. Not a blocker for other features.

RISK 5 (MEDIUM) — ToolCategory union for new connector tools:
  All new connector tools in src/core/tools/builtin/comms/ MUST use category 'comms'.
  'comms' is already in ToolCategory union in types.ts. Builder 4 greps types.ts before writing.
  Lead checks this at plan-approval before Builder 4 starts.

---

## L. KNOWN CONSTRAINTS (all builders read this before writing a single line)

1.  ESM "type":"module": Worker bootstrap scripts using require() MUST be .cjs files.
    Reference via fileURLToPath(import.meta.url) + path.resolve. Applies to WasmRunner if using workers.

2.  Raw node:http only. No Express, Fastify, Hono, or any HTTP framework.

3.  Timing-safe auth on ALL new route files.
    Copy isAuthorised(req) pattern from skills/routes.ts (timingSafeEqual on GATEWAY_TOKEN).

4.  Do NOT add CREATE TABLE IF NOT EXISTS skills to schema.ts.
    Skills table exists. Builder 1 uses ALTER TABLE with existence checks in registry-sql.ts.

5.  Do NOT read config/.env directly. Use process.env['KEY'] only.

6.  ToolCategory: use existing values in src/core/tools/types.ts ONLY.
    Builder 4 uses 'comms' for all connector tools (confirmed present).
    If a new category is truly needed, Builder 2 adds to types.ts first and all other builders wait.

7.  Pre-existing 4 test failures are NOT regressions. QE documents their names at gate entry.

8.  vi.mock() at top level only. Never vi.doMock() inside it() or describe() body.
    Module registry state leaks across all tests in a file.

9.  spawnSync with array args. Never execSync with shell-interpolated strings.
    Pattern: spawnSync('wasmtime', ['run', '--', wasmFile], { encoding: 'utf8' })

10. SKILL TABLE RACE: Builder 1 preserves WAL mode on all SQLite writes to skills table.
    Use pragma journal_mode=WAL; existing migrations already set this.

11. admin-routes.ts is 2000+ lines. New route families MUST go in NEW files only.
    Pattern: bench-routes.ts, learning-routes.ts (own registerXxxRoutes function).

12. Config5Pillar is an additive overlay. JSON5 base loads first via existing loader.
    TOML merges on top. Env vars win over both. SudoConfig interface NOT modified by Wave 10.

13. Import paths: count directory segments manually before writing any import.
    ESM requires exact relative paths. Do not guess — trace from file to target.

14. No Python, no Rust, no system packages. One new npm dep: smol-toml.

---

## M. BROADCAST CHECKLIST

Before ANY builder writes code:
[ ] Architect writes src/core/shared/wave10-types.ts (all Section B types)
[ ] Builder 3 runs pnpm add smol-toml — Lead confirms package.json updated
[ ] Builder 1, 3, 4 prepare cli.ts snippets per Section H format
[ ] Builder 2 receives snippets from B1, B3, B4 before starting cli.ts edits
[ ] All builders have read Sections G (contracts) and L (constraints)
[ ] Lead confirms this spec is readable by all 4 builders
[ ] Lead marks state.md: Wave 10 active, 4 builders running in parallel
