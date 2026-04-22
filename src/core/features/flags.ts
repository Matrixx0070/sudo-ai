import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createLogger } from '../shared/logger.js';
const log = createLogger('features:flags');

export type FeatureFlag =
  | 'AGENT_LOOP' | 'TOOL_ROUTER' | 'CONSCIOUSNESS' | 'MEMORY_DB'
  | 'AUTO_DREAM' | 'ULTRA_PLAN' | 'KAIROS' | 'AGENT_TRIGGERS' | 'COORDINATOR'
  | 'AUDIT_LOG' | 'FRUSTRATION_DETECTION' | 'MICRO_COMPACT' | 'AUTO_COMPACT'
  | 'FULL_COMPACT' | 'SUBAGENT_FORK' | 'SUBAGENT_TEAMMATE' | 'SUBAGENT_WORKTREE'
  | 'BUDDY_COMPANION' | 'UNDERCOVER_MODE' | 'DECISION_BUDGET' | 'SPINNER_VERBS'
  | 'VOICE_MODE' | 'MULTI_SUBSTRATE' | 'BACKUP_RESTORE' | 'AUTO_SKILL_COMPILER'
  | 'RESOURCE_OPTIMIZER' | 'FAILURE_LEARNER';

export interface FlagConfig {
  enabled: boolean;
  description: string;
  experimental: boolean;
}

const DEFAULT_FLAGS: Record<FeatureFlag, FlagConfig> = {
  AGENT_LOOP:            { enabled: true,  description: 'Core agent loop', experimental: false },
  TOOL_ROUTER:           { enabled: true,  description: 'Smart tool routing', experimental: false },
  CONSCIOUSNESS:         { enabled: true,  description: '20-module consciousness system', experimental: false },
  MEMORY_DB:             { enabled: true,  description: 'SQLite persistent memory', experimental: false },
  AUTO_DREAM:            { enabled: true,  description: '4-phase idle memory consolidation', experimental: false },
  ULTRA_PLAN:            { enabled: true,  description: 'Deep 30-min planning before complex execution', experimental: false },
  KAIROS:                { enabled: true,  description: 'Always-on proactive background daemon', experimental: false },
  AGENT_TRIGGERS:        { enabled: true,  description: 'Event-based auto-activation', experimental: false },
  COORDINATOR:           { enabled: true,  description: 'Mailbox pattern for dangerous multi-agent ops', experimental: false },
  AUDIT_LOG:             { enabled: true,  description: 'Append-only audit trail', experimental: false },
  FRUSTRATION_DETECTION: { enabled: true,  description: 'Regex frustration detection in messages', experimental: false },
  MICRO_COMPACT:         { enabled: true,  description: 'Zero-cost local context trimming', experimental: false },
  AUTO_COMPACT:          { enabled: true,  description: 'API-based compaction near token limit', experimental: false },
  FULL_COMPACT:          { enabled: true,  description: 'Nuclear compaction with file re-injection', experimental: false },
  SUBAGENT_FORK:         { enabled: true,  description: 'Isolated parallel sub-agents', experimental: false },
  SUBAGENT_TEAMMATE:     { enabled: true,  description: 'Context-sharing collaborative sub-agents', experimental: false },
  SUBAGENT_WORKTREE:     { enabled: true,  description: 'Filesystem-isolated sub-agents', experimental: false },
  BUDDY_COMPANION:       { enabled: true,  description: 'Virtual companion creature with stats', experimental: false },
  UNDERCOVER_MODE:       { enabled: false, description: 'Strip AI attribution from commits', experimental: false },
  DECISION_BUDGET:       { enabled: true,  description: '15-second decision cycle budget', experimental: false },
  SPINNER_VERBS:         { enabled: true,  description: '187 loading spinner verbs', experimental: false },
  VOICE_MODE:            { enabled: false, description: 'Voice interaction (ElevenLabs)', experimental: true },
  MULTI_SUBSTRATE:       { enabled: false, description: 'Clone to backup VPS instances', experimental: true },
  BACKUP_RESTORE:        { enabled: false, description: 'Automated snapshots to S3/Drive', experimental: true },
  AUTO_SKILL_COMPILER:   { enabled: false, description: 'Auto-generate tools from repeated patterns', experimental: true },
  RESOURCE_OPTIMIZER:    { enabled: false, description: 'Monitor and throttle resource usage', experimental: true },
  FAILURE_LEARNER:       { enabled: false, description: 'Auto-generate fixes from errors', experimental: true },
};

export class FeatureFlags {
  private flags: Map<FeatureFlag, FlagConfig>;
  private readonly overridePath = 'data/feature-flags.json';

  constructor() {
    this.flags = new Map(Object.entries(DEFAULT_FLAGS) as [FeatureFlag, FlagConfig][]);
    this.loadOverrides();
  }

  isEnabled(flag: FeatureFlag): boolean {
    return this.flags.get(flag)?.enabled ?? false;
  }

  enable(flag: FeatureFlag): void {
    const f = this.flags.get(flag);
    if (f) { f.enabled = true; this.save(); }
  }

  disable(flag: FeatureFlag): void {
    const f = this.flags.get(flag);
    if (f) { f.enabled = false; this.save(); }
  }

  getAll(): Record<FeatureFlag, FlagConfig> {
    return Object.fromEntries(this.flags) as Record<FeatureFlag, FlagConfig>;
  }

  getEnabled(): FeatureFlag[] {
    return [...this.flags.entries()].filter(([, v]) => v.enabled).map(([k]) => k);
  }

  getExperimental(): FeatureFlag[] {
    return [...this.flags.entries()].filter(([, v]) => v.experimental).map(([k]) => k);
  }

  private loadOverrides(): void {
    try {
      if (existsSync(this.overridePath)) {
        const overrides = JSON.parse(readFileSync(this.overridePath, 'utf8')) as Partial<Record<FeatureFlag, boolean>>;
        for (const [key, val] of Object.entries(overrides)) {
          const f = this.flags.get(key as FeatureFlag);
          if (f) f.enabled = val as boolean;
        }
      }
    } catch { /* ignore */ }
  }

  private save(): void {
    try {
      mkdirSync('data', { recursive: true });
      const overrides: Partial<Record<FeatureFlag, boolean>> = {};
      for (const [key, val] of this.flags.entries()) {
        const def = DEFAULT_FLAGS[key];
        if (val.enabled !== def.enabled) overrides[key] = val.enabled;
      }
      writeFileSync(this.overridePath, JSON.stringify(overrides, null, 2));
    } catch (e) { log.error({ err: String(e) }, 'FeatureFlags save failed'); }
  }
}

export const features = new FeatureFlags();
export function isEnabled(flag: FeatureFlag): boolean { return features.isEnabled(flag); }
