/**
 * Evolution module — SUDO analyzes and improves its own codebase.
 *
 * Public surface:
 *   - CodeEvolver       class
 *   - CodeAnalysis      interface
 *   - CodeIssue         interface
 *   - EvolutionProposal interface
 *   - CapabilityDiscovery interface
 *   - CodebaseStats     interface
 */

export {
  CodeEvolver,
  type CodeAnalysis,
  type CodeIssue,
  type EvolutionProposal,
  type CapabilityDiscovery,
  type CodebaseStats,
} from './code-evolver.js';
