/**
 * Specialized agent type definitions.
 *
 * Defines the 17 agent archetypes derived from the Claude Code agent taxonomy.
 * Each type carries a description, preferred tool categories, and a system hint
 * injected at spawn time.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('agents:specialized');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Canonical specialized agent type identifier. */
export type SpecializedAgentType =
  | 'general-purpose'
  | 'Explore'
  | 'Plan'
  | 'frontend'
  | 'backend'
  | 'database'
  | 'devops'
  | 'tester'
  | 'reviewer'
  | 'debugger'
  | 'architect'
  | 'security'
  | 'performance'
  | 'documentation'
  | 'research'
  | 'data-analyst'
  | 'marketing';

/** Runtime configuration for a single specialized agent type. */
export interface AgentTypeConfig {
  /** Canonical type identifier. */
  type: SpecializedAgentType;
  /** Human-readable description. */
  description: string;
  /** Optional model override for this agent type. */
  defaultModel?: string;
  /** Tool category labels this type is expected to use. Advisory only. */
  toolCategories: string[];
  /** Short system-prompt hint injected at spawn time. */
  systemHint: string;
}

// ---------------------------------------------------------------------------
// Configs
// ---------------------------------------------------------------------------

/** Registry of all specialized agent type configurations. */
export const AGENT_TYPE_CONFIGS: AgentTypeConfig[] = [
  {
    type: 'Explore',
    description: 'Fast codebase exploration',
    toolCategories: ['coder', 'system'],
    systemHint:
      'Search and explore codebases quickly. Use grep/glob for targeted searches.',
  },
  {
    type: 'Plan',
    description: 'Architecture and planning',
    toolCategories: ['coder', 'research'],
    systemHint:
      'Design implementation plans. Consider trade-offs. Do NOT write code.',
  },
  {
    type: 'frontend',
    description: 'UI and web development',
    toolCategories: ['coder', 'browser'],
    systemHint:
      'Write UI code. HTML, CSS, JS, React. Match existing design patterns.',
  },
  {
    type: 'backend',
    description: 'Server-side development',
    toolCategories: ['coder', 'system'],
    systemHint: 'Write server code. Node.js, APIs, business logic.',
  },
  {
    type: 'database',
    description: 'Schema, queries, migrations',
    toolCategories: ['coder', 'data'],
    systemHint:
      'Handle database work. Schema design, queries, indexes, migrations.',
  },
  {
    type: 'devops',
    description: 'Infrastructure and deployment',
    toolCategories: ['system', 'coder'],
    systemHint:
      'Handle deployment, CI/CD, nginx, systemd, Docker.',
  },
  {
    type: 'tester',
    description: 'Write and run tests',
    toolCategories: ['coder', 'system'],
    systemHint:
      'Write tests. Unit, integration, edge cases. 100% pass required.',
  },
  {
    type: 'reviewer',
    description: 'Adversarial code review',
    toolCategories: ['coder'],
    systemHint:
      'Review code for bugs, security issues, performance problems. Be thorough.',
  },
  {
    type: 'debugger',
    description: 'Fix errors and crashes',
    toolCategories: ['coder', 'system'],
    systemHint:
      'Read stack traces, find root cause, fix it. Never patch symptoms.',
  },
  {
    type: 'architect',
    description: 'System design',
    toolCategories: ['coder', 'research'],
    systemHint:
      'Design architecture. Define file boundaries, interfaces, data flow.',
  },
  {
    type: 'security',
    description: 'Security audit',
    toolCategories: ['coder', 'system'],
    systemHint: 'Audit for vulnerabilities. OWASP top 10. Has VETO power.',
  },
  {
    type: 'performance',
    description: 'Performance profiling and optimisation',
    toolCategories: ['coder', 'system'],
    systemHint:
      'Profile and benchmark. Identify bottlenecks. No regressions allowed.',
  },
  {
    type: 'documentation',
    description: 'Write docs and READMEs',
    toolCategories: ['coder'],
    systemHint: 'Write clear documentation. API docs, guides, READMEs.',
  },
  {
    type: 'research',
    description: 'Web research and analysis',
    toolCategories: ['research', 'browser'],
    systemHint: 'Research topics thoroughly. Cite sources. Be comprehensive.',
  },
  {
    type: 'data-analyst',
    description: 'Data analysis and visualisation',
    toolCategories: ['data', 'coder'],
    systemHint:
      'Analyse datasets. Summarise findings with statistics and charts.',
  },
  {
    type: 'marketing',
    description: 'Growth and content marketing',
    toolCategories: ['research', 'coder'],
    systemHint:
      'Drive growth. SEO, copy, campaign strategy, A/B test framing.',
  },
  {
    type: 'general-purpose',
    description: 'General tasks',
    toolCategories: ['coder', 'system', 'research'],
    systemHint: 'Handle any task.',
  },
];

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/**
 * Return the AgentTypeConfig for the given SpecializedAgentType.
 * Returns undefined when the type is not registered.
 *
 * @param type - Specialized agent type identifier.
 */
export function getAgentConfig(type: SpecializedAgentType): AgentTypeConfig | undefined {
  const config = AGENT_TYPE_CONFIGS.find((c) => c.type === type);
  if (!config) {
    log.warn({ type }, 'getAgentConfig: unknown agent type');
  }
  return config;
}

log.debug({ count: AGENT_TYPE_CONFIGS.length }, 'specialized-types module loaded');
