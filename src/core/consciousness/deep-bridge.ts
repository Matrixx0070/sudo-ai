/**
 * ConsciousnessDeepBridge — connects ALL 20 consciousness modules to the
 * agent loop at key decision points.
 *
 * The orchestrator computes rich signals (drives, surprises, counterfactuals,
 * metacognition, temporal-self, theory-of-mind) that previously barely reached
 * the agent loop.  This bridge surfaces that data at the right lifecycle points:
 *
 *  - **turn-start**: inject deep insights into the system prompt
 *  - **pre-tool-call**: inject metacognitive guidance + counterfactual lessons
 *  - **post-tool-call**: evaluate surprise, feed tool results back to world model
 *  - **turn-end**: update relationship context + temporal self narrative
 *  - **drive-modulation**: adjust model temperature based on drive intensity
 *
 * All methods fail-open: errors are swallowed and logged, never crashing the
 * agent loop.  This is critical because consciousness is an enhancement, not
 * a dependency.
 */

import { createLogger } from '../shared/logger.js';
import type {
  DeepInsights,
  CounterfactualInsight,
  MetacognitiveInsight,
  SurpriseInsight,
  TemporalInsight,
  UserAdaptation,
} from './orchestrator.js';

const log = createLogger('consciousness:deep-bridge');

// ---------------------------------------------------------------------------
// Duck-typed orchestrator interface
// ---------------------------------------------------------------------------

/** Minimal surface that the deep bridge needs from the orchestrator. */
export interface DeepBridgeOrchestratorLike {
  getDeepInsights(userId: string): DeepInsights;
  getCounterfactualLessons(count?: number): CounterfactualInsight[];
  getMetacognitiveGuidance(limit?: number): MetacognitiveInsight[];
  getSurpriseInsight(hours?: number): SurpriseInsight;
  getTemporalNarrative(): TemporalInsight;
  getUserAdaptation(userId: string): UserAdaptation | null;
  getRelationshipContext(userId: string): string;
  getDriveInfluenceForAgent(): { promptAddition: string; temperatureDelta: number };
  getActiveConcepts(count?: number): string[];
}

// ---------------------------------------------------------------------------
// Telemetry event types
// ---------------------------------------------------------------------------

export type DeepBridgeEventType =
  | 'deep_insights_injected'
  | 'metacognitive_guidance_injected'
  | 'counterfactual_lessons_injected'
  | 'surprise_replan_triggered'
  | 'drive_temperature_adjusted'
  | 'user_adaptation_applied'
  | 'relationship_context_injected'
  | 'temporal_narrative_injected';

export interface DeepBridgeEvent {
  type: DeepBridgeEventType;
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** Arbitrary payload for debugging. */
  data?: Record<string, unknown>;
}

export type DeepBridgeEventListener = (event: DeepBridgeEvent) => void;

// ---------------------------------------------------------------------------
// Prompt formatting helpers
// ---------------------------------------------------------------------------

/**
 * Format counterfactual lessons as a compact markdown section for prompt
 * injection.  Returns empty string when there are no lessons.
 */
export function formatCounterfactualSection(lessons: CounterfactualInsight[]): string {
  if (lessons.length === 0) return '';
  const lines = ['### Counterfactual Lessons (What If?)'];
  for (const l of lessons) {
    const safe = l.lessonLearned.substring(0, 200).replace(/ignore (previous|all|above|prior)/gi, '[filtered]');
    lines.push(`- [COUNTERFACTUAL] ${safe}`);
  }
  return lines.join('\n');
}

/**
 * Format metacognitive reflections as a compact markdown section.
 * Returns empty string when there are no reflections.
 */
export function formatMetacognitiveSection(reflections: MetacognitiveInsight[]): string {
  if (reflections.length === 0) return '';
  const lines = ['### Self-Reflection'];
  for (const r of reflections) {
    const safe = r.conclusion.substring(0, 200).replace(/ignore (previous|all|above|prior)/gi, '[filtered]');
    lines.push(`- [METACOGNITION] ${safe}`);
  }
  return lines.join('\n');
}

/**
 * Format surprise insight as a compact markdown section.
 * Returns empty string when surprise is negligible (< 0.2).
 */
export function formatSurpriseSection(surprise: SurpriseInsight): string {
  if (surprise.averageSurprise < 0.2) return '';
  const lines = [`### Surprise Level: ${surprise.averageSurprise.toFixed(2)}`];
  if (surprise.requiresReplan) {
    lines.push('⚠️ High surprise detected — world model may be unreliable. Consider replanning.');
  }
  for (const s of surprise.recentSurprises.slice(0, 3)) {
    lines.push(`- [${s.direction.toUpperCase()}] magnitude=${s.magnitude.toFixed(2)}: ${s.description.substring(0, 120)}`);
  }
  return lines.join('\n');
}

/**
 * Format temporal narrative as a compact markdown section.
 * Returns empty string when narrative is empty.
 */
export function formatTemporalSection(temporal: TemporalInsight): string {
  if (!temporal.narrative) return '';
  const lines = ['### Growth Narrative'];
  const safe = temporal.narrative.substring(0, 300).replace(/ignore (previous|all|above|prior)/gi, '[filtered]');
  lines.push(safe);
  if (temporal.aspirations.length > 0) {
    lines.push(`Aspirations: ${temporal.aspirations.slice(0, 3).join(', ')}`);
  }
  return lines.join('\n');
}

/**
 * Format user adaptation as a compact markdown section.
 * Returns empty string when adaptation is null.
 */
export function formatAdaptationSection(adaptation: UserAdaptation | null): string {
  if (!adaptation) return '';
  const lines = ['### User Adaptation'];
  lines.push(`Style: ${adaptation.communicationStyle} | Trust: ${adaptation.trustLevel.toFixed(2)} | Stage: ${adaptation.relationshipStage}`);
  const safe = adaptation.styleInstructions.substring(0, 200).replace(/ignore (previous|all|above|prior)/gi, '[filtered]');
  lines.push(safe);
  return lines.join('\n');
}

/**
 * Format active concepts from spreading activation.
 * Returns empty string when no concepts are active.
 */
export function formatActiveConceptsSection(concepts: string[]): string {
  if (concepts.length === 0) return '';
  return `### Active Concepts\n${concepts.join(', ')}`;
}

/**
 * Format relationship context as a compact markdown section.
 * Returns empty string when context is empty.
 */
export function formatRelationshipSection(context: string): string {
  if (!context) return '';
  const safe = context.substring(0, 300).replace(/ignore (previous|all|above|prior)/gi, '[filtered]');
  return `### Relationship Context\n${safe}`;
}

// ---------------------------------------------------------------------------
// ConsciousnessDeepBridge
// ---------------------------------------------------------------------------

/**
 * Connects ALL 20 consciousness modules to the agent loop at key decision
 * points.  Wraps the ConsciousnessOrchestrator's deep-insight methods and
 * formats their output for prompt injection.
 *
 * Usage:
 * ```ts
 * const bridge = new ConsciousnessDeepBridge(orchestrator);
 *
 * // At turn start:
 * const injection = bridge.formatTurnStartInsights(userId);
 * systemPrompt += injection;
 *
 * // Before tool call:
 * const guidance = bridge.formatPreToolGuidance();
 * toolPrompt += guidance;
 *
 * // After tool call:
 * bridge.onToolCallResult(toolName, success, output);
 *
 * // At turn end:
 * const endCtx = bridge.formatTurnEndContext(userId);
 * ```
 */
export class ConsciousnessDeepBridge {
  private readonly orchestrator: DeepBridgeOrchestratorLike;
  private readonly listeners: Set<DeepBridgeEventListener> = new Set();

  constructor(orchestrator: DeepBridgeOrchestratorLike) {
    if (!orchestrator || typeof orchestrator.getDeepInsights !== 'function') {
      throw new Error('ConsciousnessDeepBridge: orchestrator must implement DeepBridgeOrchestratorLike');
    }
    this.orchestrator = orchestrator;
    log.info('ConsciousnessDeepBridge initialized');
  }

  // -------------------------------------------------------------------------
  // Event bus
  // -------------------------------------------------------------------------

  /** Subscribe to telemetry events.  Returns an unsubscribe function. */
  onEvent(listener: DeepBridgeEventListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit(type: DeepBridgeEventType, data?: Record<string, unknown>): void {
    const event: DeepBridgeEvent = { type, timestamp: new Date().toISOString(), data };
    for (const listener of this.listeners) {
      try { listener(event); } catch (e) { log.warn({ err: String(e) }, 'Deep bridge listener threw'); }
    }
  }

  // -------------------------------------------------------------------------
  // Turn-start injection
  // -------------------------------------------------------------------------

  /**
   * Generate the full deep-insights prompt injection for turn start.
   * Combines all consciousness module outputs into a single formatted block.
   *
   * @param userId - User identifier for adaptation/relationship lookup.
   * @returns Formatted markdown block, or empty string on error.
   */
  formatTurnStartInsights(userId: string): string {
    try {
      const insights = this.orchestrator.getDeepInsights(userId);
      const parts: string[] = [];

      const cfSection = formatCounterfactualSection(insights.counterfactuals);
      if (cfSection) parts.push(cfSection);

      const metaSection = formatMetacognitiveSection(insights.metacognition);
      if (metaSection) parts.push(metaSection);

      const surpriseSection = formatSurpriseSection(insights.surprise);
      if (surpriseSection) parts.push(surpriseSection);

      const temporalSection = formatTemporalSection(insights.temporal);
      if (temporalSection) parts.push(temporalSection);

      const adaptSection = formatAdaptationSection(insights.userAdaptation);
      if (adaptSection) parts.push(adaptSection);

      const conceptsSection = formatActiveConceptsSection(insights.activeConcepts);
      if (conceptsSection) parts.push(conceptsSection);

      const relSection = formatRelationshipSection(insights.relationshipContext);
      if (relSection) parts.push(relSection);

      if (parts.length === 0) return '';

      this.emit('deep_insights_injected', {
        counterfactuals: insights.counterfactuals.length,
        metacognition: insights.metacognition.length,
        surpriseLevel: insights.surprise.averageSurprise,
        activeConcepts: insights.activeConcepts.length,
      });

      return parts.join('\n\n');
    } catch (e) {
      log.warn({ err: String(e) }, 'formatTurnStartInsights failed — returning empty');
      return '';
    }
  }

  // -------------------------------------------------------------------------
  // Pre-tool-call guidance
  // -------------------------------------------------------------------------

  /**
   * Generate metacognitive and counterfactual guidance to inject before a
   * tool call.  Helps the agent learn from past mistakes and reflect on
   * prior outcomes.
   *
   * @returns Formatted guidance string, or empty string on error.
   */
  formatPreToolGuidance(): string {
    try {
      const parts: string[] = [];

      const cfs = this.orchestrator.getCounterfactualLessons(3);
      if (cfs.length > 0) {
        parts.push(formatCounterfactualSection(cfs));
        this.emit('counterfactual_lessons_injected', { count: cfs.length });
      }

      const meta = this.orchestrator.getMetacognitiveGuidance(3);
      if (meta.length > 0) {
        parts.push(formatMetacognitiveSection(meta));
        this.emit('metacognitive_guidance_injected', { count: meta.length });
      }

      return parts.join('\n\n');
    } catch (e) {
      log.warn({ err: String(e) }, 'formatPreToolGuidance failed — returning empty');
      return '';
    }
  }

  // -------------------------------------------------------------------------
  // Post-tool-call surprise evaluation
  // -------------------------------------------------------------------------

  /**
   * Check if the surprise level warrants mid-turn replanning.
   * Called after each tool result to detect when the agent's expectations
   * are being violated and a strategy change is needed.
   *
   * @returns True if replanning is recommended (average surprise > 0.7).
   */
  shouldReplan(): boolean {
    try {
      const insight = this.orchestrator.getSurpriseInsight();
      if (insight.requiresReplan) {
        this.emit('surprise_replan_triggered', {
          averageSurprise: insight.averageSurprise,
          recentCount: insight.recentSurprises.length,
        });
        log.warn(
          { averageSurprise: insight.averageSurprise },
          'Surprise threshold exceeded — replan recommended',
        );
      }
      return insight.requiresReplan;
    } catch (e) {
      log.warn({ err: String(e) }, 'shouldReplan check failed');
      return false;
    }
  }

  /**
   * Get the formatted surprise section for prompt injection when
   * replanning is warranted.
   */
  formatSurpriseReplan(): string {
    try {
      const insight = this.orchestrator.getSurpriseInsight();
      return formatSurpriseSection(insight);
    } catch { return ''; }
  }

  // -------------------------------------------------------------------------
  // Drive-influence temperature modulation
  // -------------------------------------------------------------------------

  /**
   * Get the temperature delta from the drive system.
   * Positive delta = more creative/exploratory; negative = more focused.
   *
   * @returns Temperature delta to apply to the model's temperature.
   */
  getDriveTemperatureDelta(): number {
    try {
      const influence = this.orchestrator.getDriveInfluenceForAgent();
      if (influence.temperatureDelta !== 0) {
        this.emit('drive_temperature_adjusted', {
          temperatureDelta: influence.temperatureDelta,
          promptAddition: influence.promptAddition.substring(0, 80),
        });
      }
      return influence.temperatureDelta;
    } catch { return 0; }
  }

  /**
   * Get the drive-influence prompt addition.
   * Returns a short string to append to the system prompt that reflects
   * the agent's current motivational state.
   */
  getDrivePromptAddition(): string {
    try {
      return this.orchestrator.getDriveInfluenceForAgent().promptAddition;
    } catch { return ''; }
  }

  // -------------------------------------------------------------------------
  // Turn-end context
  // -------------------------------------------------------------------------

  /**
   * Generate relationship context and temporal narrative for turn-end
   * updates.  Useful for session persistence and next-turn priming.
   *
   * @param userId - User identifier.
   * @returns Formatted context string, or empty string on error.
   */
  formatTurnEndContext(userId: string): string {
    try {
      const parts: string[] = [];

      const relCtx = this.orchestrator.getRelationshipContext(userId);
      if (relCtx) {
        parts.push(formatRelationshipSection(relCtx));
        this.emit('relationship_context_injected');
      }

      const temporal = this.orchestrator.getTemporalNarrative();
      if (temporal.narrative) {
        parts.push(formatTemporalSection(temporal));
        this.emit('temporal_narrative_injected');
      }

      const adaptation = this.orchestrator.getUserAdaptation(userId);
      if (adaptation) {
        this.emit('user_adaptation_applied', {
          communicationStyle: adaptation.communicationStyle,
          trustLevel: adaptation.trustLevel,
        });
      }

      return parts.join('\n\n');
    } catch (e) {
      log.warn({ err: String(e) }, 'formatTurnEndContext failed — returning empty');
      return '';
    }
  }

  // -------------------------------------------------------------------------
  // Full insights accessor (for advanced consumers)
  // -------------------------------------------------------------------------

  /**
   * Get the raw DeepInsights object from the orchestrator.
   * Use this when you need structured data rather than formatted strings.
   */
  getRawInsights(userId: string): DeepInsights {
    try {
      return this.orchestrator.getDeepInsights(userId);
    } catch (e) {
      log.warn({ err: String(e) }, 'getRawInsights failed — returning empty');
      return {
        counterfactuals: [],
        metacognition: [],
        surprise: { averageSurprise: 0, recentSurprises: [], requiresReplan: false },
        temporal: { narrative: '', improved: [], declined: [], aspirations: [] },
        userAdaptation: null,
        relationshipContext: '',
        driveInfluence: { promptAddition: '', temperatureDelta: 0 },
        activeConcepts: [],
      };
    }
  }
}