/**
 * @module wave10-types — SHARED CONTRACT — builders import only, never modify.
 *
 * Canonical type definitions for SUDO-AI Wave 10 (OpenJarvis Parity).
 * Source of truth: docs/wave10-spec.md Section B.
 * Written by Architect. Builders IMPORT from this file — never re-declare, never modify.
 *
 * Import pattern:
 *   import type { SkillManifest, ComplexityResult } from '../shared/wave10-types.js';
 */

// ---------------------------------------------------------------------------
// B1. SkillManifest — agentskills.io canonical + trust tier extension
// ---------------------------------------------------------------------------

/** Trust tier for a skill, determines capability access policy. */
export type SkillTrustTier = 'bundled' | 'indexed' | 'unreviewed' | 'workspace';

/**
 * Alias: required export name maps to canonical SkillTrustTier.
 * Builders may import either name.
 */
export type TrustTier = SkillTrustTier;

/** URI scheme used to resolve a skill from its source location. */
export type SkillSourceScheme = 'github' | 'openclaw' | 'openjarvis' | 'local' | 'bundled' | 'sudo';

/** Canonical agentskills.io skill manifest with SUDO-AI trust tier extension. */
export interface SkillManifest {
  /** Unique skill identifier. */
  id: string;
  /** Human-readable skill name. */
  name: string;
  /** Semantic version string. */
  version: string;
  /** Short description of what the skill does. */
  description: string;
  /** Author name or organisation. */
  author: string;
  /** Fully qualified source URI, e.g. "github:user/repo/skill.md". */
  source: string;
  /** URI scheme component parsed from source. */
  scheme: SkillSourceScheme;
  /** Capability strings required, e.g. ["fs.read", "net.fetch"]. */
  caps: string[];
  /** Tool translation entries bundled with this skill. */
  tools: ToolTranslatorEntry[];
  /** Trust tier assigned at import time. */
  trust: SkillTrustTier;
  /** SHA-256 hex digest of the raw skill file bytes. */
  contentHash: string;
  /** ISO-8601 timestamp of when the skill was imported. */
  importedAt: string;
  /** Optional classification tags. */
  tags?: string[];
  /** Optional minimum SUDO-AI version required. */
  minVersion?: string;
}

// ---------------------------------------------------------------------------
// B2. ToolTranslator — canonical ↔ SUDO-AI name mapping
// ---------------------------------------------------------------------------

/** Single tool name mapping entry between agentskills.io canonical and SUDO-AI internal names. */
export interface ToolTranslatorEntry {
  /** agentskills.io canonical tool name, e.g. "Bash", "Read". */
  canonical: string;
  /** SUDO-AI internal tool name, e.g. "system.shell", "coder.read-file". */
  sudoName: string;
  /** Optional parameter name remapping from canonical to SUDO-AI param names. */
  paramMap?: Record<string, string>;
}

/** Full translation table mapping canonical agentskills.io tools to SUDO-AI equivalents. */
export type ToolTranslatorTable = ToolTranslatorEntry[];

/**
 * Branded string type for a SUDO-AI tool name in "category.action" format.
 * Used wherever a tool name must be distinguished from arbitrary strings.
 */
export type ToolName = string & { readonly __toolName: unique symbol };

// ---------------------------------------------------------------------------
// B3. SkillResolver — per-resolver configuration types
// ---------------------------------------------------------------------------

/** Configuration for resolving a skill from a GitHub repository. */
export interface GithubResolverConfig {
  /** Resolver scheme discriminant. */
  scheme: 'github';
  /** GitHub personal access token for private repos (optional). */
  token?: string;
  /** Allowlisted GitHub organisations/users (SSRF mitigation). */
  allowedHosts?: string[];
}

/** Configuration for resolving a skill from the openclaw registry. */
export interface OpenClawResolverConfig {
  /** Resolver scheme discriminant. */
  scheme: 'openclaw';
  /** openclaw registry base URL. */
  registryUrl?: string;
  /** API key for authenticated registry access. */
  apiKey?: string;
}

/** Configuration for resolving a skill from an openjarvis-compatible registry. */
export interface OpenJarvisResolverConfig {
  /** Resolver scheme discriminant. */
  scheme: 'openjarvis';
  /** openjarvis registry base URL. */
  registryUrl?: string;
  /** API key for authenticated registry access. */
  apiKey?: string;
}

/** Union of all supported per-resolver configuration objects. */
export type SkillResolver =
  | GithubResolverConfig
  | OpenClawResolverConfig
  | OpenJarvisResolverConfig;

// ---------------------------------------------------------------------------
// B3 (trace). TracePattern — SkillDiscovery output
// ---------------------------------------------------------------------------

/** Mined tool-call sequence pattern with occurrence statistics. */
export interface TracePattern {
  /** Stable identifier for this pattern (hash of toolSequence). */
  id: string;
  /** Ordered list of tool names forming the pattern. */
  toolSequence: string[];
  /** Number of times this sequence was observed in the trace window. */
  occurrenceCount: number;
  /** Fraction of occurrences that ended in success (0..1). */
  successRate: number;
  /** ISO-8601 timestamp of first observation. */
  firstSeen: string;
  /** ISO-8601 timestamp of most recent observation. */
  lastSeen: string;
  /** True if an AgentConfigProposal was already generated from this pattern. */
  proposalGenerated: boolean;
}

// ---------------------------------------------------------------------------
// B4. AgentConfigProposal — AgentConfigEvolver output
// ---------------------------------------------------------------------------

/** Lifecycle status of an agent configuration change proposal. */
export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'applied';

/**
 * Proposed configuration delta for a specific agent, generated from trace patterns.
 * delta is Record<string, unknown> because the shape varies by config pillar.
 */
export interface AgentConfigProposal {
  /** UUID for this proposal. */
  id: string;
  /** Target agent ID. */
  agentId: string;
  /** Human-readable rationale derived from trace analysis. */
  rationale: string;
  /** Configuration fields to change and their proposed values (arbitrary shape). */
  delta: Record<string, unknown>;
  /** Aggregate quality score of the source traces (0..1). */
  traceQuality: number;
  /** Number of traces used to generate this proposal. */
  traceCount: number;
  /** Current proposal lifecycle status. */
  status: ProposalStatus;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 last-modified timestamp. */
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// B4b. SkillOptimizationProposal — SkillOptimizer output (Wave 13)
// ---------------------------------------------------------------------------

/** Lifecycle status of a skill optimization proposal. */
export type SkillOptimizationStatus = 'pending' | 'approved' | 'rejected';

/**
 * Proposed per-field optimization for a specific skill,
 * generated from trace patterns during sleep cycles.
 */
export interface SkillOptimizationProposal {
  /** UUID for this proposal. */
  id: string;
  /** Target skill id from SkillRegistry. */
  skillId: string;
  /** Human-readable skill name for display. */
  skillName: string;
  /** Which frontmatter field to optimize. */
  targetField: 'description' | 'examples' | 'tags';
  /** Current value (string serialization of the field). */
  currentValue: string;
  /** Proposed replacement value. */
  proposedValue: string;
  /** Human-readable evidence / rationale. */
  evidence: string;
  /** Confidence score 0..1. */
  confidence: number;
  /** Lifecycle status. */
  status: SkillOptimizationStatus;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 last-modified timestamp. */
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// B5. ComplexityResult — prompt complexity scoring output
// ---------------------------------------------------------------------------

/** Bucketed complexity tier driving token budget selection. */
export type ComplexityTier = 'simple' | 'moderate' | 'complex' | 'very_complex';

/** Output of the ComplexityScorer for a single prompt evaluation. */
export interface ComplexityResult {
  /** Normalised composite complexity score (0..1). */
  score: number;
  /** Discrete tier derived from score thresholds. */
  tier: ComplexityTier;
  /** List of signal names that contributed to the score. */
  signals: string[];
  /** Recommended max_tokens budget: 2048 | 4096 | 8192 | 16384. */
  suggested_max_tokens: number;
  /** True when a x2 multiplier was applied because the model name contains "think" or "reason". */
  thinking_model: boolean;
}

// ---------------------------------------------------------------------------
// B6. BenchResult + BenchReport + BenchTask
// ---------------------------------------------------------------------------

/** Experimental condition under which a bench task was evaluated. */
export type SkillCondition = 'no_skills' | 'skills_on' | 'skills_optimized' | 'skills_post_optimizer';

/**
 * Alias: required export name maps to canonical SkillCondition.
 * Builders may import either name.
 */
export type BenchCondition = SkillCondition;

/** Single benchmark measurement for one task × model × condition × seed. */
export interface BenchResult {
  /** UUID for this result row. */
  id: string;
  /** Parent benchmark run UUID. */
  runId: string;
  /** Model identifier used. */
  model: string;
  /** Agent configuration identifier. */
  agentId: string;
  /** Task identifier from the task set. */
  taskId: string;
  /** Skill availability condition for this run. */
  condition: SkillCondition;
  /** Random seed index (0-based). */
  seedIndex: number;
  /** True if the agent produced a correct / accepted response. */
  success: boolean;
  /** Wall-clock latency in milliseconds. */
  latencyMs: number;
  /** Estimated cost in USD for this call. */
  costUsd: number;
  /** Complexity tier assigned to this task's prompt. */
  complexityTier: ComplexityTier;
  /** ISO-8601 timestamp of the measurement. */
  timestamp: string;
}

/** Aggregated benchmark report across all results in a run. */
export interface BenchReport {
  /** UUID matching the run. */
  runId: string;
  /** ISO-8601 start timestamp. */
  startedAt: string;
  /** ISO-8601 completion timestamp. */
  completedAt: string;
  /** Total number of individual task evaluations. */
  totalTasks: number;
  /** Fraction of tasks that succeeded (0..1). */
  successRate: number;
  /** Median latency in milliseconds across all results. */
  medianLatencyMs: number;
  /** 99th-percentile latency in milliseconds. */
  p99LatencyMs: number;
  /** Sum of all per-call costs in USD. */
  totalCostUsd: number;
  /** Per-condition aggregated success rate and median latency. */
  byCondition: Record<SkillCondition, { successRate: number; medianLatencyMs: number }>;
  /** Per-model aggregated success rate and median latency. */
  byModel: Record<string, { successRate: number; medianLatencyMs: number }>;
  /** Pre-rendered Markdown summary for CLI output. */
  markdownSummary: string;
}

/** A single benchmark task definition used in the built-in task set. */
export interface BenchTask {
  /** Stable task identifier. */
  id: string;
  /** Human-readable task name. */
  name: string;
  /** Prompt text sent to the agent. */
  prompt: string;
  /** Expected output or acceptance criteria description. */
  expectedOutput: string;
  /** Baseline complexity tier for this task. */
  complexityTier: ComplexityTier;
  /** Optional per-task tags for filtering. */
  tags?: string[];
}

// ---------------------------------------------------------------------------
// B7. Config5Pillar — TOML overlay configuration schema
// ---------------------------------------------------------------------------

/** Intelligence pillar: model selection and sampling parameters. */
export interface PillarIntelligence {
  /** Primary model identifier. */
  default_model?: string;
  /** Fallback model if primary is unavailable. */
  fallback_model?: string;
  /** Sampling temperature (0..2). */
  temperature?: number;
  /** Maximum tokens for responses. */
  max_tokens?: number;
}

/** Alias: required export name maps to PillarIntelligence. */
export type IntelligenceConfig = PillarIntelligence;

/** Agent pillar: iteration limits and prompt customisation. */
export interface PillarAgent {
  /** Maximum agentic loop iterations. */
  max_iterations?: number;
  /** Text appended to the system prompt. */
  system_prompt_append?: string;
}

/** Alias: required export name maps to PillarAgent. */
export type AgentConfig5Pillar = PillarAgent;

/** Tools pillar: tool enable/disable list and MCP server references. */
export interface PillarTools {
  /** Tool names to disable for this configuration. */
  disabled?: string[];
  /** MCP server addresses to connect. */
  mcp_servers?: string[];
}

/** Alias: required export name maps to PillarTools. */
export type ToolsConfig5Pillar = PillarTools;

/** Supported execution runtimes for the engine pillar. */
export type EngineRuntime = 'sudoapi' | 'ollama' | 'llamacpp' | 'openai_compat';

/** Engine pillar: runtime selection and host configuration. */
export interface PillarEngine {
  /** Target execution runtime. */
  runtime?: EngineRuntime;
  /** Runtime API host URL. */
  host?: string;
  /** Prefer local execution over remote when both are available. */
  prefer_local?: boolean;
}

/** Alias: required export name maps to PillarEngine. */
export type EngineConfig = PillarEngine;

/** Learning subsystem routing and intelligence policy. */
export interface LearningPolicy {
  /** Policy name governing how the subsystem updates. */
  policy?: 'heuristic' | 'none' | 'evolver';
}

/** Weights for the learning objective function. */
export interface LearningWeights {
  /** Weight assigned to accuracy metric. */
  accuracy?: number;
  /** Weight assigned to latency metric. */
  latency?: number;
  /** Weight assigned to cost metric. */
  cost?: number;
  /** Weight assigned to efficiency metric. */
  efficiency?: number;
}

/** Learning pillar: adaptive policy configuration per subsystem. */
export interface PillarLearning {
  /** Policy governing routing decisions. */
  routing?: LearningPolicy;
  /** Policy governing intelligence/model selection. */
  intelligence?: LearningPolicy;
  /** Policy governing agent configuration evolution. */
  agent?: LearningPolicy;
  /** Objective weights used by the evolver. */
  weights?: LearningWeights;
  /** Minimum trace quality threshold to accept a proposal (0..1). */
  min_quality?: number;
  /** Minimum number of SFT pairs required before applying a proposal. */
  min_sft_pairs?: number;
}

/** Alias: required export name maps to PillarLearning. */
export type LearningConfig = PillarLearning;

/** Complete 5-pillar TOML overlay configuration, all fields optional (additive merge). */
export interface Config5Pillar {
  /** Intelligence pillar overrides. */
  intelligence?: PillarIntelligence;
  /** Agent pillar overrides. */
  agent?: PillarAgent;
  /** Tools pillar overrides. */
  tools?: PillarTools;
  /** Engine pillar (runtime-only, no JSON5 equivalent). */
  engine?: PillarEngine;
  /** Learning pillar (runtime-only, no JSON5 equivalent). */
  learning?: PillarLearning;
}

// ---------------------------------------------------------------------------
// B8. OperatorManifest — TOML operator descriptor schema
// ---------------------------------------------------------------------------

/** Schedule descriptor for when an operator should run. */
export interface OperatorSchedule {
  /** Schedule type: fixed interval or cron expression. */
  type: 'interval' | 'cron';
  /** Interval in seconds (number) or cron expression string. */
  value: string | number;
}

/** Per-operator agent execution configuration. */
export interface OperatorAgentConfig {
  /** Maximum turns the operator agent may take. */
  max_turns?: number;
  /** Sampling temperature override. */
  temperature?: number;
  /** Restricted tool list for this operator. */
  tools?: string[];
  /** Path to a prompt file relative to workspace root. */
  prompt_path?: string;
  /** Inline prompt string (takes precedence over prompt_path). */
  prompt?: string;
}

/** Canonical TOML operator manifest (TypeScript equivalent of TOML schema). */
export interface OperatorManifest {
  /** Operator name used as identifier. */
  name: string;
  /** Semantic version string. */
  version: string;
  /** Human-readable description of what this operator does. */
  description: string;
  /** Whether this operator should be activated on startup. */
  enabled: boolean;
  /** Agent execution configuration for this operator. */
  agent: OperatorAgentConfig;
  /** Execution schedule. */
  schedule: OperatorSchedule;
  /** Optional classification tags. */
  tags?: string[];
}

// ---------------------------------------------------------------------------
// B9. Recipe — TOML recipe descriptor schema
// ---------------------------------------------------------------------------

/** Reference to an operator within a recipe. */
export interface RecipeOperatorRef {
  /** Operator name (must match an OperatorManifest.name). */
  name: string;
  /** Override the operator's enabled flag for this recipe. */
  enabled?: boolean;
}

/** Canonical TOML recipe descriptor (TypeScript equivalent of TOML schema). */
export interface Recipe {
  /** Stable unique recipe identifier. */
  id: string;
  /** Human-readable recipe name. */
  name: string;
  /** What this recipe configures and for whom. */
  description: string;
  /** Recipe author name or organisation. */
  author: string;
  /** Semantic version string. */
  version: string;
  /** 5-pillar configuration overlay applied by this recipe. */
  config: Config5Pillar;
  /** Optional list of operators activated by this recipe. */
  operators?: RecipeOperatorRef[];
  /** Optional channel names enabled by this recipe. */
  channels?: string[];
  /** Optional classification tags. */
  tags?: string[];
}

// ---------------------------------------------------------------------------
// B10. SavingsRow + CompareResult
// ---------------------------------------------------------------------------

/** Energy consumption estimate for a model call or session. */
export interface EnergyEstimate {
  /** Energy consumed in watt-hours. */
  wh: number;
  /** Floating-point operations count. */
  flops: number;
  /** Whether this is a real measurement or a provider-estimate. */
  source: 'measured' | 'estimated';
}

/** One row of cost/energy data for a provider+model+period combination. */
export interface SavingsRow {
  /** Provider name, e.g. "anthropic", "openai". */
  provider: string;
  /** Model identifier. */
  model: string;
  /** Total input tokens consumed in this period. */
  inputTokens: number;
  /** Total output tokens produced in this period. */
  outputTokens: number;
  /** Total cost in USD for this period. */
  costUsd: number;
  /** Cost per million input tokens in USD. */
  inputCostPerM: number;
  /** Cost per million output tokens in USD. */
  outputCostPerM: number;
  /** Energy estimate for this period. */
  energy: EnergyEstimate;
  /** Aggregation period granularity. */
  period: 'session' | 'day' | 'week' | 'month' | 'all';
  /** ISO-8601 start of the aggregation period. */
  periodStart: string;
}

/** Side-by-side comparison result for two models on the same prompt. */
export interface CompareResult {
  /** UUID for this comparison run. */
  runId: string;
  /** First model identifier. */
  modelA: string;
  /** Second model identifier. */
  modelB: string;
  /** Prompt text sent to both models. */
  prompt: string;
  /** Response text from model A. */
  responseA: string;
  /** Response text from model B. */
  responseB: string;
  /** Latency in milliseconds for model A. */
  latencyAms: number;
  /** Latency in milliseconds for model B. */
  latencyBms: number;
  /** Cost in USD for model A call. */
  costAusd: number;
  /** Cost in USD for model B call. */
  costBusd: number;
  /** Complexity assessment for model A's prompt context. */
  complexityA: ComplexityResult;
  /** Complexity assessment for model B's prompt context. */
  complexityB: ComplexityResult;
  /** ISO-8601 timestamp of this comparison. */
  timestamp: string;
}

// ---------------------------------------------------------------------------
// B11. Taint — taint tracking for data provenance and propagation
// ---------------------------------------------------------------------------

/** Severity level of a taint tag. */
export type TaintLevel = 'clean' | 'low' | 'medium' | 'high' | 'critical';

/** Origin category of a taint assignment. */
export type TaintSource =
  | 'user_input'
  | 'tool_output'
  | 'external_fetch'
  | 'skill_exec'
  | 'channel_message'
  | 'unknown';

/** Immutable taint tag attached to a value or tool result. */
export interface Taint {
  /** Severity of this taint. */
  level: TaintLevel;
  /** Category of origin for this taint. */
  source: TaintSource;
  /** Descriptive origin identifier (tool name, URL, session ID, etc.). */
  origin: string;
  /** UUID for this specific taint instance. */
  taintId: string;
  /** ISO-8601 timestamp when this taint was assigned. */
  assignedAt: string;
  /** taintId values of taints this one was derived from (propagation chain). */
  ancestors?: string[];
}

/** Record of a taint-level violation that blocked a destructive tool call. */
export interface TaintViolation {
  /** The taint that triggered the violation. */
  taint: Taint;
  /** Name of the tool that was blocked. */
  toolName: string;
  /** Human-readable reason for the block. */
  reason: string;
  /** ISO-8601 timestamp of the violation event. */
  timestamp: string;
}

/** A named set of active taints keyed by taintId for O(1) lookup. */
export type TaintSet = Map<string, Taint>;

// ---------------------------------------------------------------------------
// B12. CapabilityUnion — capability policy and intersection helpers
// ---------------------------------------------------------------------------

/** A capability string in "domain.permission" format, e.g. "fs.read". */
export type Capability = string;

/**
 * Union helper: resolves to the union of capability literals from two arrays.
 * Type-level only — no runtime implementation.
 */
export type CapabilityUnion<A extends readonly Capability[], B extends readonly Capability[]> =
  A[number] | B[number];

/**
 * Intersection helper: resolves to the intersection of capability literals from two arrays.
 * Type-level only — no runtime implementation.
 */
export type IntersectCaps<A extends readonly Capability[], B extends readonly Capability[]> =
  A[number] & B[number];

/** Per-tier default capability policy. */
export interface TierCapabilityPolicy {
  /** Capabilities granted to bundled (fully trusted) skills. */
  bundled: Capability[];
  /** Capabilities granted to indexed (registry-verified) skills. */
  indexed: Capability[];
  /** Capabilities granted to unreviewed skills. */
  unreviewed: Capability[];
  /** Capabilities granted to workspace (local) skills. */
  workspace: Capability[];
}

/**
 * Default tier capability policy.
 * NOTE: This is the only runtime value in this file, included because builders
 * need the policy constants for capability intersection logic.
 */
export const DEFAULT_TIER_CAPS: TierCapabilityPolicy = {
  bundled:    ['fs.read', 'fs.write', 'net.fetch', 'db.read', 'db.write', 'shell.exec', 'skill.load'],
  indexed:    ['fs.read', 'net.fetch', 'db.read'],
  unreviewed: ['fs.read'],
  workspace:  ['fs.read', 'fs.write', 'net.fetch', 'db.read'],
};

/** Result of checking whether a skill's declared caps are within tier policy. */
export interface CapabilityCheckResult {
  /** True if all required capabilities are within the tier policy. */
  granted: boolean;
  /** Capability strings that were requested but not allowed by the tier. */
  missing: Capability[];
}

// ---------------------------------------------------------------------------
// B13. SignedArtifact — signed envelope for verifiable artifacts
// ---------------------------------------------------------------------------

/** Supported signature algorithm identifiers. */
export type SignatureAlgorithm = 'ed25519';

/**
 * Signed artifact envelope wrapping an arbitrary payload.
 * payload is unknown because any serializable value may be signed.
 */
export interface SignedArtifact {
  /** The value being signed — must be JSON.stringify-able. */
  payload: unknown;
  /** ISO-8601 timestamp included in the signature input. */
  signedAt: string;
  /** First 8 hex characters of the public key DER encoding. */
  keyId: string;
  /** Monotonic key version from key_rotation_log. Added in Wave 10G. */
  keyVersion: number;
  /** ed25519 signature over JSON.stringify(payload)+signedAt, hex-encoded. */
  signature: string;
  /** Semantic type of the artifact for routing and display. */
  artifactType: 'skill' | 'bench_report' | 'config_proposal' | 'trace_pattern' | 'federation_event' | 'generic';
}

/** Result of verifying a SignedArtifact against the stored public key. */
export interface ArtifactVerifyResult {
  /** True if signature is cryptographically valid. */
  valid: boolean;
  /** Key ID extracted from the artifact. */
  keyId: string;
  /** ISO-8601 timestamp from the artifact. */
  signedAt: string;
  /** Error message if verification failed. */
  error?: string;
}

// ---------------------------------------------------------------------------
// B15. HardwareProfile — system capability detection output
// ---------------------------------------------------------------------------

/** Detected hardware capabilities and runtime recommendations. */
export interface HardwareProfile {
  /** CPU model name string. */
  cpuModel: string;
  /** Number of logical CPU cores. */
  cpuCores: number;
  /** Total system RAM in megabytes. */
  ramMb: number;
  /** True if a GPU was detected. */
  hasGpu: boolean;
  /** GPU model name if detected. */
  gpuModel?: string;
  /** GPU VRAM in megabytes if detected. */
  gpuVramMb?: number;
  /** True if minimum requirements are met (cpuCores >= 2 AND ramMb >= 2048). */
  meetsMinimum: boolean;
  /** Human-readable warning messages for sub-optimal configurations. */
  warnings: string[];
  /** Recommended EngineRuntime based on detected hardware. */
  recommendedRuntime: EngineRuntime;
  /** True if the wasmtime CLI binary was found in PATH. */
  wasmtimeAvailable: boolean;
}
