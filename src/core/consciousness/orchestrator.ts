/** ConsciousnessOrchestrator — boots all consciousness modules in dependency order,
 *  mediates interaction lifecycle, and formats internal state for system-prompt injection. */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createLogger } from '../shared/logger.js';
import { genId, truncate } from '../shared/utils.js';
import { DATA_DIR } from '../shared/paths.js';
import { ConsciousnessDB } from './consciousness-db.js';
import { ConsciousnessError } from './errors.js';
import type { BodyState, EmotionalValence, AttentionSignal } from './types.js';
import { EmbodiedStateEngine } from './embodied-state/index.js';
import { SpreadingActivationNetwork } from './spreading-activation/index.js';
import { EmotionalStateManager, SomaticMarkerStore } from './emotional-memory/index.js';
import { AttentionManager } from './attention-system/index.js';
import { CognitiveStream } from './cognitive-stream/index.js';
import type { InterruptResult } from './cognitive-stream/index.js';
import { EpisodicMemory } from './episodic-memory/index.js';
import type { Episode } from './episodic-memory/index.js';
import { DriveManager } from './drive-system/index.js';
import { WorldModel, computeToolUsePrior } from './world-model/index.js';
import { SelfModel } from './self-model/index.js';
import { TheoryOfMind } from './theory-of-mind/index.js';
import { ProspectiveMemory } from './prospective-memory/index.js';
import { RelationshipTracker } from './relationship-model/index.js';
import { InternalDialogue } from './internal-dialogue/index.js';
import { MetacognitionEngine } from './metacognition/index.js';
import { CounterfactualEngine } from './counterfactual-engine/index.js';
import { TemporalSelf } from './temporal-self/index.js';
import { ProceduralMemory } from './procedural-memory/index.js';
import { SurpriseEngine, type SurpriseEvent } from './surprise-engine/index.js';
import { ContextSelector, type ContextSelection } from './context-selector.js';
import { ConsciousnessBridge, type BridgeInjection } from './context-bridge.js';

// ---------------------------------------------------------------------------
// Deep Insight output types — surfaced by getDeepInsights()
// ---------------------------------------------------------------------------

/** Structured output from a single consciousness module for deep insights. */
export interface CounterfactualInsight {
  lessonLearned: string;
  deltaAssessment: string;
  episodeSummary: string;
}

export interface MetacognitiveInsight {
  conclusion: string;
  actionItem: string;
  episodeSummary: string;
}

export interface SurpriseInsight {
  averageSurprise: number;
  recentSurprises: Array<{
    magnitude: number;
    direction: 'better' | 'worse' | 'different';
    description: string;
    triggeredActions: string[];
  }>;
  /** Whether surprise exceeds the high-magnitude threshold (0.7). */
  requiresReplan: boolean;
}

export interface TemporalInsight {
  narrative: string;
  improved: string[];
  declined: string[];
  aspirations: string[];
}

export interface UserAdaptation {
  styleInstructions: string;
  trustLevel: number;
  relationshipStage: string;
  communicationStyle: string;
}

export interface DeepInsights {
  counterfactuals: CounterfactualInsight[];
  metacognition: MetacognitiveInsight[];
  surprise: SurpriseInsight;
  temporal: TemporalInsight;
  userAdaptation: UserAdaptation | null;
  relationshipContext: string;
  driveInfluence: { promptAddition: string; temperatureDelta: number };
  activeConcepts: string[];
}

export interface OrchestratorBrainLike {
  call(opts: { messages: Array<{ role: string; content: string }>; maxTokens?: number; temperature?: number; model?: string; source?: string }): Promise<{ content: string }>;
}
interface SleepCycleLike {
  shouldSleep(lastInteractionMs: number, isQuietHours: boolean): boolean;
  startSleep(): Promise<unknown>;
  isAsleep(): boolean;
  wakeUp(): void;
}
interface SelfEvolutionLike { getDNA(): { seed: string; birthDate: string }; recordFailure(sig: string): void; }

export interface ConsciousnessState {
  isBooted: boolean; bodyState: BodyState | null; emotionalState: EmotionalValence | null;
  dominantDrive: string | null; thoughtCount: number; isStreaming: boolean;
  isSleeping: boolean; lastInteraction: string | null;
}

interface OrchestratorConfig { streamModel: string; quietHoursStart: number; quietHoursEnd: number; }
const CFG0: OrchestratorConfig = { streamModel: '', quietHoursStart: 1, quietHoursEnd: 7 };
const log = createLogger('consciousness:orchestrator');
const swallow = (label: string) => (e: unknown) => log.debug({ err: String(e) }, label);

export class ConsciousnessOrchestrator {
  private readonly brain: OrchestratorBrainLike;
  private readonly config: OrchestratorConfig;

  // All module instances — populated during boot()
  private db!: ConsciousnessDB;
  private embodiedState!: EmbodiedStateEngine;
  private spreadingActivation!: SpreadingActivationNetwork;
  private emotionalState!: EmotionalStateManager;
  /** Lazily-built somatic-marker store (orphan wiring), used only when SUDO_CONSCIOUSNESS_SOMATIC_MARKERS=1. */
  private _somaticMarkers: SomaticMarkerStore | null = null;
  private attention!: AttentionManager;
  private cognitiveStream!: CognitiveStream;
  private episodicMemory!: EpisodicMemory;
  private driveManager!: DriveManager;
  private worldModel!: WorldModel;
  private selfModel!: SelfModel;
  private theoryOfMind!: TheoryOfMind;
  private prospectiveMemory!: ProspectiveMemory;
  private relationshipTracker!: RelationshipTracker;
  private internalDialogue!: InternalDialogue;
  private metacognition!: MetacognitionEngine;
  private counterfactualEngine!: CounterfactualEngine;
  private temporalSelf!: TemporalSelf;
  private proceduralMemory!: ProceduralMemory;
  private surpriseEngine!: SurpriseEngine;
  private contextSelector: ContextSelector | null = null;
  private consciousnessBridge: ConsciousnessBridge | null = null;
  private sleepCycle: SleepCycleLike | null = null;
  private selfEvolution: SelfEvolutionLike | null = null;
  private _booted = false;
  private _lastInteractionAt: string | null = null;
  private _zdrEnabled = false;
  /**
   * Theme 4.2: pending per-turn WorldModel predictions (tool-use forecast), keyed
   * by the loop's sessionId (the first arg of both onInteractionStart and
   * onInteractionEnd), resolved at turn-end. Bounded to avoid leaks.
   */
  private _pendingToolPredictions = new Map<string, { id: string; prediction: string; confidence: number; domain: string }>();

  constructor(brain: OrchestratorBrainLike, config?: Partial<OrchestratorConfig>) {
    if (!brain || typeof brain.call !== 'function') {
      throw new ConsciousnessError(
        'ConsciousnessOrchestrator: brain must implement OrchestratorBrainLike',
        'consciousness_orchestrator_invalid_brain',
      );
    }
    this.brain = brain;
    this.config = { ...CFG0, ...config };
  }

  attachSleepCycle(sc: SleepCycleLike): void { this.sleepCycle = sc; }
  attachSelfEvolution(se: SelfEvolutionLike): void { this.selfEvolution = se; }

  /** Set ZDR (Zero Data Retention) mode — disables episodic memory recording
   *  and prospective memory checks to prevent data retention. */
  setZDRMode(enabled: boolean): void {
    this._zdrEnabled = enabled;
    if (enabled) log.info('ConsciousnessOrchestrator: ZDR mode active — data retention disabled');
  }

  /** Attach a ContextSelector for intent-based module selection (Phase 3 bridge). */
  attachContextSelector(cs: ContextSelector): void {
    if (!cs) { log.warn('attachContextSelector: null/undefined — ignoring'); return; }
    this.contextSelector = cs;
    log.info('ContextSelector attached to orchestrator');
  }

  /** Attach a ConsciousnessBridge for prompt injection (Phase 3 bridge). */
  attachConsciousnessBridge(cb: ConsciousnessBridge): void {
    if (!cb) { log.warn('attachConsciousnessBridge: null/undefined — ignoring'); return; }
    this.consciousnessBridge = cb;
    log.info('ConsciousnessBridge attached to orchestrator');
  }

  async boot(): Promise<void> {
    if (this._booted) { log.warn('boot() already called — ignored'); return; }

    // Check for persisted consciousness control state
    let skipStream = false;
    let skipEmbodied = false;
    try {
      const controlFile = path.join(DATA_DIR, 'consciousness-control.json');
      if (existsSync(controlFile)) {
        const control = JSON.parse(readFileSync(controlFile, 'utf8'));
        if (control.cognitiveStream === false) skipStream = true;
        if (control.embodiedState === false) skipEmbodied = true;
      }
    } catch { /* ignore */ }

    try {
      // Layer 0: DB + foundation
      this.db = new ConsciousnessDB();
      this.embodiedState       = new EmbodiedStateEngine(this.db);
      this.spreadingActivation = new SpreadingActivationNetwork(this.db);
      this.emotionalState      = new EmotionalStateManager(this.db);
      this.attention           = new AttentionManager();
      // Layer 1: cognitive stream
      this.cognitiveStream = new CognitiveStream(
        this.brain, this.db, this.embodiedState, this.spreadingActivation, this.emotionalState,
        this.config.streamModel ? { microModel: this.config.streamModel } : {},
      );
      // Layer 2: episodic / drives / prospective
      this.episodicMemory    = new EpisodicMemory(this.db);
      this.driveManager      = new DriveManager(this.db);
      this.prospectiveMemory = new ProspectiveMemory(this.db);
      // Layer 3: world / self / theory-of-mind
      this.worldModel    = new WorldModel(this.db);
      this.selfModel     = new SelfModel(this.db);
      this.theoryOfMind  = new TheoryOfMind(this.db);
      // Layer 4: higher-order
      this.counterfactualEngine = new CounterfactualEngine(this.db, this.brain);
      this.metacognition        = new MetacognitionEngine(this.db, this.brain);
      this.internalDialogue     = new InternalDialogue(this.brain, this.db);
      this.relationshipTracker  = new RelationshipTracker(this.db, this.theoryOfMind);
      this.temporalSelf         = new TemporalSelf(this.db, this.selfModel);
      this.proceduralMemory     = new ProceduralMemory(this.db);
      this.surpriseEngine       = new SurpriseEngine(this.db, this.worldModel, this.emotionalState);
      // Start loops
      if (!skipEmbodied) this.embodiedState.start();
      if (!skipStream) this.cognitiveStream.start();

      // Listen for runtime consciousness control signals
      process.on('sudo:consciousness:control', (payload: { module: string; action: string }) => {
        try {
          if (payload.module === 'cognitiveStream') {
            if (payload.action === 'stop' && this.cognitiveStream) {
              this.cognitiveStream.stop();
              log.info('CognitiveStream stopped via runtime control');
            } else if (payload.action === 'start' && this.cognitiveStream) {
              this.cognitiveStream.start();
              log.info('CognitiveStream started via runtime control');
            }
          } else if (payload.module === 'embodiedState') {
            if (payload.action === 'stop' && this.embodiedState) {
              this.embodiedState.stop();
              log.info('EmbodiedState stopped via runtime control');
            } else if (payload.action === 'start' && this.embodiedState) {
              this.embodiedState.start();
              log.info('EmbodiedState started via runtime control');
            }
          }
        } catch (e) { swallow('consciousness control signal')(e); }
      });

      this._booted = true;
      log.info('Consciousness online');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ConsciousnessError(`boot() failed: ${msg}`, 'consciousness_orchestrator_boot_failed', { cause: msg });
    }
  }

  async shutdown(): Promise<void> {
    this._assertBooted('shutdown');
    try { this.cognitiveStream.stop(); } catch (e) { swallow('stream stop')(e); }
    try { this.embodiedState.stop(); } catch (e) { swallow('embodied stop')(e); }
    try { this.db.close(); } catch (e) { swallow('db close')(e); }
    this._booted = false;
    log.info('Consciousness offline');
  }

  async onInteractionStart(userId: string, message: string): Promise<InterruptResult> {
    this._assertBooted('onInteractionStart');
    if (!userId || typeof userId !== 'string') {
      throw new ConsciousnessError('onInteractionStart: userId must be a non-empty string', 'consciousness_orchestrator_invalid_input', { userId });
    }
    log.debug({ userId, msgLen: message.length }, 'Interaction start');

    if (this.sleepCycle?.isAsleep()) this.sleepCycle.wakeUp();

    const interruptResult = await this.cognitiveStream.interrupt(userId, message);

    // ZDR gate: skip prospective memory checks when ZDR is active
    if (!this._zdrEnabled) {
      try {
        this.prospectiveMemory.expirePast();
        this.prospectiveMemory.checkTriggers({ time: new Date().toISOString(), userId, topic: truncate(message, 80) });
      } catch (e) { swallow('prospective check')(e); }
    }

    const signal: AttentionSignal = {
      id: genId(), source: 'user-message', priority: 0.9,
      content: truncate(message, 200), timestamp: new Date().toISOString(), ttl: 300_000,
    };
    try { this.attention.submitSignal(signal); } catch (e) { swallow('attention signal')(e); }

    this._lastInteractionAt = new Date().toISOString();

    // Theme 4.2: OPEN the WorldModel -> surprise loop — predict whether this turn
    // will require tool use, with a DIFFERENTIATING prior (not 0.5) so the
    // resolution at turn-end can be genuinely surprising. Resolved in
    // onInteractionEnd. Opt-in (SUDO_CONSCIOUSNESS_WORLD_MODEL=1), ZDR-gated,
    // fail-open, bounded. `userId` here is the loop's sessionId (see call site).
    if (process.env['SUDO_CONSCIOUSNESS_WORLD_MODEL'] === '1' && !this._zdrEnabled) {
      try {
        // Seed the prior from the LEARNED base rate (confirmed/(confirmed+
        // violated) for this domain) once enough outcomes have resolved, nudged
        // by the message-length feature. This closes the predict->resolve loop:
        // confidence converges toward the true tool-use rate instead of
        // oscillating between the fixed 0.35/0.75 heuristic every turn. Cold
        // start falls back to that heuristic.
        const { rate, resolved } = this.worldModel.getDomainMatchRate('tool_use');
        const confidence = computeToolUsePrior(message.length, rate, resolved);
        // 1h expiry so an unresolved (orphaned) prediction auto-expires rather than
        // lingering 'pending' in the DB forever (e.g. if onInteractionEnd never fires).
        const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
        const entry = this.worldModel.predict('tool_use', 'this interaction will require tool use', confidence, expiresAt);
        this.worldModel.save(entry);
        if (this._pendingToolPredictions.size >= 256) {
          const oldest = this._pendingToolPredictions.keys().next().value;
          if (oldest !== undefined) this._pendingToolPredictions.delete(oldest);
        }
        this._pendingToolPredictions.set(userId, { id: entry.id, prediction: entry.prediction, confidence: entry.confidence, domain: entry.domain });
      } catch (e) { swallow('world-model predict')(e); }
    }

    return interruptResult;
  }

  async onInteractionEnd(sessionId: string, messages: Array<{ role: string; content: string }>, outcome: string): Promise<void> {
    this._assertBooted('onInteractionEnd');
    if (!sessionId || !Array.isArray(messages) || messages.length === 0) return;
    log.debug({ sessionId, msgCount: messages.length, outcome }, 'Interaction end');

    const now = new Date().toISOString();
    const userMsg = messages.find((m) => m.role === 'user')?.content ?? '';
    const userId = sessionId.split(':')[0] ?? sessionId;
    const validOutcome: Episode['outcome'] =
      (['positive', 'negative', 'neutral', 'mixed'] as const).includes(outcome as Episode['outcome'])
        ? (outcome as Episode['outcome'])
        : 'neutral';

    const episode: Episode = {
      id: genId(), summary: truncate(userMsg || 'Interaction', 120),
      participants: [userId], topic: truncate(userMsg, 60), tags: [],
      emotionalValence: this.emotionalState.getCurrentState(),
      surpriseLevel: 0, outcome: validOutcome, significance: 0.5,
      sessionId, startedAt: this._lastInteractionAt ?? now, endedAt: now,
      durationMs: this._lastInteractionAt ? Date.now() - new Date(this._lastInteractionAt).getTime() : 0,
    };

    // ZDR gate: skip episodic recording when ZDR is active
    if (!this._zdrEnabled) {
      try { this.episodicMemory.recordEpisode(episode); } catch (e) { swallow('episodic record')(e); }
      try { this.selfModel.updateFromEpisode(episode); } catch (e) { swallow('self-model update')(e); }
    }

    // Close the emotional-memory learning loop — persist learned trigger→emotion
    // associations (somatic markers) instead of computing the emotional valence each
    // turn and discarding it. The SomaticMarkerStore has a schema + an admin read
    // surface but no production writer, so somatic_markers stayed empty. Additive
    // learning only (no per-turn behavior change yet) and NO LLM cost — reuses the
    // already-computed valence + the cheap active-concept set. Opt-in
    // SUDO_CONSCIOUSNESS_SOMATIC_MARKERS=1; fail-open. Gates on !this._zdrEnabled
    // INTENTIONALLY (like the episodic block above — markers persist interaction-
    // derived data; the procedural-learn block below relies only on the caller's ZDR
    // gate, so don't "align" them). KNOWN LIMIT: bounded to one new marker per novel
    // (concept, emotion) per turn, but somatic_markers has no retention cap yet —
    // follow-up should prune by age/row count like traces.db.
    if (process.env['SUDO_CONSCIOUSNESS_SOMATIC_MARKERS'] === '1' && !this._zdrEnabled) {
      try {
        const minIntensity = 0.6; // only learn emotionally-significant associations
        const emotion = this.emotionalState.getCurrentState();
        if (emotion && emotion.intensity >= minIntensity) {
          const concepts = this.getActiveConcepts(3).filter((c) => c && c.trim().length > 0);
          if (concepts.length > 0) {
            this._somaticMarkers ??= new SomaticMarkerStore(this.db);
            // Reinforce markers for the active concepts (bumps times_triggered), then
            // learn ONE new association when none yet links these concepts to the
            // current dominant emotion — bounds growth to genuinely novel feelings.
            const reinforced = this._somaticMarkers.getSomaticResponse(concepts);
            if (!reinforced.some((m) => m.emotion === emotion.dominantEmotion)) {
              this._somaticMarkers.createMarker(concepts[0]!, emotion.dominantEmotion, emotion.intensity, episode.id);
            }
            log.debug({ activeConcepts: concepts.length, reinforced: reinforced.length, emotion: emotion.dominantEmotion, intensity: emotion.intensity }, 'Somatic markers: emotional-memory loop');
          }
        }
      } catch (e) { swallow('somatic marker learn')(e); }
    }

    const tomOutcome: 'positive' | 'negative' | 'neutral' =
      validOutcome === 'positive' ? 'positive' : validOutcome === 'negative' ? 'negative' : 'neutral';
    try { await this.theoryOfMind.updateUserModel(userId, { userId, message: userMsg, response: '', outcome: tomOutcome }); } catch (e) { swallow('tom update')(e); }
    try { this.relationshipTracker.updateFromInteraction(userId, episode); } catch (e) { swallow('relationship update')(e); }

    // Record tool sequences
    const toolCalls = messages.filter((m) => m.role === 'assistant' && m.content.includes('tool')).map((m) => truncate(m.content, 60));
    if (toolCalls.length > 0) {
      try { this.db.getDb().prepare('INSERT INTO tool_sequences (session_id, sequence) VALUES (?, ?)').run(sessionId, JSON.stringify(toolCalls)); } catch (e) { swallow('tool seq record')(e); }
    }

    // Theme 4: close the procedural-memory learning loop — compile recurring tool
    // sequences (>=3 occurrences) into reusable procedures, instead of letting them
    // accumulate forever uncompiled. Additive learning only (no per-turn decision
    // change). Opt-in via SUDO_CONSCIOUSNESS_PROCEDURAL_LEARN=1; fail-open. Runs at
    // turn-end, already behind the caller's ZDR consciousness-recording gate.
    if (process.env['SUDO_CONSCIOUSNESS_PROCEDURAL_LEARN'] === '1') {
      try {
        const compiled = this.proceduralMemory.checkForNewProcedures(3);
        if (compiled.length > 0) {
          log.info({ count: compiled.length }, 'ProceduralMemory: compiled new procedures from recurring tool sequences');
        }
      } catch (e) { swallow('procedural compile')(e); }
    }

    // Theme 4.3: episodic -> semantic consolidation — fold a dominant recurring
    // episode topic into a generalized 'semantic' meta-episode (deduped by topic).
    // Additive learning only. Opt-in (SUDO_CONSCIOUSNESS_SEMANTIC=1), ZDR-gated,
    // fail-open.
    if (process.env['SUDO_CONSCIOUSNESS_SEMANTIC'] === '1' && !this._zdrEnabled) {
      try {
        const semantic = this.episodicMemory.consolidateToSemantic();
        if (semantic) {
          log.info({ topic: semantic.topic }, 'EpisodicMemory: folded episodes into a semantic generalization');
        }
      } catch (e) { swallow('semantic consolidate')(e); }
    }

    // Theme 4.2: CLOSE the WorldModel -> surprise loop — resolve the turn's tool-use
    // prediction against what actually happened (matched = the turn used tools).
    // surpriseEngine.evaluate() also records the outcome on the world model (so we
    // do NOT also call worldModel.recordOutcome). Keyed by the raw sessionId so it
    // matches the prediction recorded at turn-start. The pending entry is ALWAYS
    // cleaned up (no map leak even on a ZDR flip); the DB-writing evaluate only runs
    // when enabled AND not under ZDR — symmetric with the prediction gate. Fail-open.
    const pendingPrediction = this._pendingToolPredictions.get(sessionId);
    if (pendingPrediction) {
      this._pendingToolPredictions.delete(sessionId);
      if (process.env['SUDO_CONSCIOUSNESS_WORLD_MODEL'] === '1' && !this._zdrEnabled) {
        try {
          const matched = toolCalls.length > 0;
          this.surpriseEngine.evaluate(pendingPrediction.id, pendingPrediction.prediction, pendingPrediction.confidence, pendingPrediction.domain, matched ? 'used tools' : 'answered directly', matched);
        } catch (e) { swallow('world-model resolve')(e); }
      }
    }

    // Check if we should sleep
    if (this._lastInteractionAt && this.sleepCycle) {
      const idleMs = Date.now() - new Date(this._lastInteractionAt).getTime();
      const hour = new Date().getUTCHours();
      const isQuiet = hour >= this.config.quietHoursStart && hour < this.config.quietHoursEnd;
      if (this.sleepCycle.shouldSleep(idleMs, isQuiet) && !this.sleepCycle.isAsleep()) {
        this.sleepCycle.startSleep().catch(swallow('sleep start'));
      }
    }
  }

  getConsciousnessContext(): string {
    if (!this._booted) return '## Internal State\n(not booted)';
    if (this._zdrEnabled) return '## Internal State\n(ZDR active — data retention disabled)';

    // Phase 3 consciousness bridge: if bridge is configured, delegate to it for
    // intent-aware module selection and budget-adaptive context injection.
    if (this.contextSelector !== null && this.consciousnessBridge !== null) {
      try {
        const category = this._inferCurrentCategory();
        const intent = this._lastInteractionAt ?? 'general';
        // Use 0% context pressure as conservative default (full detail tier)
        const injection: BridgeInjection = this.consciousnessBridge.bridge(category, intent, 0);
        if (injection.context) return injection.context;
      } catch (err) {
        log.warn({ err: String(err) }, 'ConsciousnessBridge failed — falling back to legacy summary');
      }
    }

    const body    = this.embodiedState.getState();
    const emotion = this.emotionalState.getCurrentState();
    const thoughts = this.cognitiveStream.getRecentThoughts(3).map((t) => truncate(t.content, 60)).join(' | ') || '(none)';

    let dominantDrive = '(unknown)'; let satisfiedBy = '';
    try {
      const tags: Record<string, number> = {};
      for (const tag of emotion.tags) tags[tag] = emotion.intensity;
      this.driveManager.compute({
        bodyState: body, emotionalTags: tags, emotionalIntensity: emotion.intensity,
        recentSurprise: 0, recentInteractionRate: 0.5, worldModelConfidence: 0.5,
        selfModelImprovingRatio: 0.5,
        timeSinceLastInteractionMs: this._lastInteractionAt ? Date.now() - new Date(this._lastInteractionAt).getTime() : 0,
      });
      const d = this.driveManager.getDominant();
      dominantDrive = d.name; satisfiedBy = d.satisfiedBy;
    } catch { /* pre-first-compute */ }

    let selfLine = '(no self-model yet)';
    try { selfLine = truncate(this.selfModel.toPromptSummary().split('\n')[0] ?? '', 80); } catch { /* ignore */ }

    let intentionLine = '(none)';
    try {
      const items = this.prospectiveMemory.getPending().slice(0, 2).map((i) => i.description).join(', ');
      if (items) intentionLine = items;
    } catch { /* ignore */ }

    return [
      '## Internal State',
      `Body: energy=${body.energy.toFixed(2)} clarity=${body.clarity.toFixed(2)} [sampled ${body.sampledAt}]`,
      `Feeling: ${emotion.dominantEmotion} (intensity ${emotion.intensity.toFixed(2)})`,
      `Drive: ${dominantDrive}${satisfiedBy ? ` — ${satisfiedBy}` : ''}`,
      `Thinking about: ${thoughts}`,
      `Intentions: ${intentionLine}`,
      `Self: ${selfLine}`,
    ].join('\n');
  }

  getIntelligenceBriefContext(message: string): {
    dominantDrive: { name: string; intensity: number; satisfiedBy?: string } | null;
    emotionalState: { emotion: string; intensity: number } | null;
    matchingProcedure: { name: string; steps: string[]; successRate: number } | null;
    relevantPredictions: Array<{ domain: string; prediction: string; confidence: number; outcome: string }>;
    recentEpisodes: Array<{ summary: string; outcome: string; significance: number; timestamp: string }>;
    counterfactualLessons: Array<{ lessonLearned: string; deltaAssessment: string }>;
    metacognitiveReflections: Array<{ conclusion: string; actionItem: string }>;
    surpriseLevel: number;
    temporalNarrative: string;
    activeConcepts: string[];
    selfCompetence: {
      overallConfidence: number;
      strengths: Array<{ domain: string; confidence: number }>;
      weaknesses: Array<{ domain: string; confidence: number }>;
    } | null;
  } {
    const empty = {
      dominantDrive: null,
      emotionalState: null,
      matchingProcedure: null,
      relevantPredictions: [],
      recentEpisodes: [],
      counterfactualLessons: [],
      metacognitiveReflections: [],
      surpriseLevel: 0,
      temporalNarrative: '',
      activeConcepts: [],
      selfCompetence: null,
    };
    if (!this._booted) return empty;

    // Read DriveSystem
    let dominantDrive: { name: string; intensity: number; satisfiedBy?: string } | null = null;
    try {
      const d = this.driveManager.getDominant();
      if (d) dominantDrive = { name: d.name, intensity: d.intensity, satisfiedBy: d.satisfiedBy };
    } catch { /* not yet computed — ignore */ }

    // Read EmotionalState
    let emotionalState: { emotion: string; intensity: number } | null = null;
    try {
      const e = this.emotionalState.getCurrentState();
      if (e) emotionalState = { emotion: e.dominantEmotion ?? 'neutral', intensity: e.intensity ?? 0 };
    } catch { /* ignore */ }

    // Read ProceduralMemory
    let matchingProcedure: { name: string; steps: string[]; successRate: number } | null = null;
    try {
      const p = this.proceduralMemory.findMatchingProcedure(message);
      if (p) {
        const total = (p.successCount ?? 0) + (p.failureCount ?? 0);
        const successRate = total > 0 ? (p.successCount ?? 0) / total : 0;
        matchingProcedure = {
          name: p.name ?? '',
          steps: (p.steps ?? []).map((s) => s.toolName ?? ''),
          successRate,
        };
      }
    } catch { /* ignore */ }

    // Read WorldModel predictions
    let relevantPredictions: Array<{ domain: string; prediction: string; confidence: number; outcome: string }> = [];
    try {
      const preds = this.worldModel.getPendingPredictions();
      relevantPredictions = preds.slice(0, 5).map((p) => ({
        domain: p.domain ?? '',
        prediction: p.prediction ?? '',
        confidence: p.confidence ?? 0,
        outcome: p.outcome ?? 'pending',
      }));
    } catch { /* ignore */ }

    // Read EpisodicMemory
    let recentEpisodes: Array<{ summary: string; outcome: string; significance: number; timestamp: string }> = [];
    try {
      const eps = this.episodicMemory.getRecent(3);
      recentEpisodes = eps.slice(0, 3).map((e) => ({
        summary: e.summary ?? '',
        outcome: e.outcome ?? 'neutral',
        significance: e.significance ?? 0,
        timestamp: e.startedAt ?? new Date().toISOString(),
      }));
    } catch { /* ignore */ }

    // Read CounterfactualEngine (NEW — previously unwired)
    let counterfactualLessons: Array<{ lessonLearned: string; deltaAssessment: string }> = [];
    try {
      counterfactualLessons = this.counterfactualEngine.getRecent(3).map((cf) => ({
        lessonLearned: cf.lessonLearned ?? '',
        deltaAssessment: cf.deltaAssessment ?? '',
      }));
    } catch { /* ignore */ }

    // Read MetacognitionEngine (NEW — previously unwired)
    let metacognitiveReflections: Array<{ conclusion: string; actionItem: string }> = [];
    try {
      metacognitiveReflections = this.metacognition.getReflections(3).map((r) => ({
        conclusion: r.conclusion ?? '',
        actionItem: r.actionItem ?? '',
      }));
    } catch { /* ignore */ }

    // Read SurpriseEngine (NEW — previously unwired)
    let surpriseLevel = 0;
    try {
      surpriseLevel = this.surpriseEngine.getAverageSurprise(24);
    } catch { /* ignore */ }

    // Read TemporalSelf (NEW — previously unwired)
    let temporalNarrative = '';
    try {
      temporalNarrative = this.temporalSelf.toPromptSummary();
    } catch { /* ignore */ }

    // Read SpreadingActivation (NEW — previously unwired)
    let activeConcepts: string[] = [];
    try {
      activeConcepts = this.spreadingActivation.getTopActive(5).map((n) => n.id);
    } catch { /* ignore */ }

    // Read SelfModel — self-assessed competence on the current task type.
    // Previously this only fed an internal status line (truncated to 80 chars);
    // surfacing it here delivers the agent its own strengths/weaknesses. Only
    // emitted when there is real signal, to avoid baseline-confidence noise.
    let selfCompetence: {
      overallConfidence: number;
      strengths: Array<{ domain: string; confidence: number }>;
      weaknesses: Array<{ domain: string; confidence: number }>;
    } | null = null;
    try {
      const strengths = this.selfModel.getStrengths(3).map((s) => ({ domain: s.domain, confidence: s.confidence }));
      const weaknesses = this.selfModel.getWeaknesses(2).map((w) => ({ domain: w.domain, confidence: w.confidence }));
      if (strengths.length > 0 || weaknesses.length > 0) {
        selfCompetence = { overallConfidence: this.selfModel.getOverallConfidence(), strengths, weaknesses };
      }
    } catch { /* ignore */ }

    return {
      dominantDrive, emotionalState, matchingProcedure, relevantPredictions, recentEpisodes,
      counterfactualLessons, metacognitiveReflections, surpriseLevel, temporalNarrative, activeConcepts,
      selfCompetence,
    };
  }

  getDriveInfluenceForAgent(): { promptAddition: string; temperatureDelta: number } {
    if (!this._booted) return { promptAddition: '', temperatureDelta: 0 };
    try {
      const influence = this.driveManager.getInfluence();
      if (!influence) return { promptAddition: '', temperatureDelta: 0 };
      return {
        promptAddition: influence.systemPromptAddition ?? '',
        temperatureDelta: influence.temperatureDelta ?? 0,
      };
    } catch {
      return { promptAddition: '', temperatureDelta: 0 };
    }
  }

  // -------------------------------------------------------------------------
  // Deep Insight Methods — surface unwired consciousness modules
  // -------------------------------------------------------------------------

  /**
   * Theme 4 (reflect loops): expose the real engines + episodic store so the
   * sleep cycle can drive their (LLM-backed) generation OFF the hot path. They
   * read/write the orchestrator's own DB, where live episodes are recorded.
   */
  getEpisodicMemory(): EpisodicMemory { return this.episodicMemory; }
  getCounterfactualEngine(): CounterfactualEngine { return this.counterfactualEngine; }
  getMetacognitionEngine(): MetacognitionEngine { return this.metacognition; }

  /**
   * Return counterfactual "what if" lessons from recent episodes.
   * These lessons can be injected into tool-call decisions to avoid past mistakes.
   */
  getCounterfactualLessons(count: number = 3): CounterfactualInsight[] {
    if (!this._booted) return [];
    try {
      const cfs = this.counterfactualEngine.getRecent(count);
      return cfs.map((cf) => ({
        lessonLearned: cf.lessonLearned ?? '',
        deltaAssessment: cf.deltaAssessment ?? '',
        episodeSummary: cf.actualOutcome ?? '',
      }));
    } catch { return []; }
  }

  /**
   * Return metacognitive reflection conclusions and action items.
   * These can be injected as self-guidance before tool calls.
   */
  getMetacognitiveGuidance(limit: number = 3): MetacognitiveInsight[] {
    if (!this._booted) return [];
    try {
      const refs = this.metacognition.getReflections(limit);
      return refs.map((r) => ({
        conclusion: r.conclusion ?? '',
        actionItem: r.actionItem ?? '',
        episodeSummary: r.analysis ?? '',
      }));
    } catch { return []; }
  }

  /**
   * Return surprise level and recent surprise events.
   * High surprise (avg > 0.7) signals that the agent's world model is
   * unreliable and mid-turn replanning may be warranted.
   */
  getSurpriseInsight(hours: number = 24): SurpriseInsight {
    const empty: SurpriseInsight = {
      averageSurprise: 0,
      recentSurprises: [],
      requiresReplan: false,
    };
    if (!this._booted) return empty;
    try {
      const avg = this.surpriseEngine.getAverageSurprise(hours);
      const recent = this.surpriseEngine.getRecentSurprises(5);
      return {
        averageSurprise: avg,
        recentSurprises: recent.map((s) => ({
          magnitude: s.magnitude,
          direction: s.direction,
          description: s.description,
          triggeredActions: s.triggeredActions,
        })),
        requiresReplan: avg > 0.7,
      };
    } catch { return empty; }
  }

  /**
   * Return the temporal self's past/present/future narrative and
   * domain-level growth comparisons.
   */
  getTemporalNarrative(): TemporalInsight {
    const empty: TemporalInsight = {
      narrative: '',
      improved: [],
      declined: [],
      aspirations: [],
    };
    if (!this._booted) return empty;
    try {
      const narrative = this.temporalSelf.toPromptSummary();
      let improved: string[] = [];
      let declined: string[] = [];
      try {
        const cmp = this.temporalSelf.comparePastToPresent(7);
        improved = cmp.improved;
        declined = cmp.declined;
      } catch { /* no comparison available */ }
      const asps = this.temporalSelf.getAspirations()
        .filter((a) => a.status === 'active')
        .map((a) => `${a.domain} → ${a.targetLevel}`);
      return { narrative, improved, declined, aspirations: asps };
    } catch { return empty; }
  }

  /**
   * Return user-adapted communication style and relationship context.
   * Null when the user is unknown.
   */
  getUserAdaptation(userId: string): UserAdaptation | null {
    if (!this._booted) return null;
    try {
      const style = this.theoryOfMind.getAdaptedStyle(userId);
      const model = this.theoryOfMind.getUserModel(userId);
      if (!model) return null;
      const relationship = this.relationshipTracker.getRelationship(userId);
      return {
        styleInstructions: style,
        trustLevel: model.trustLevel ?? 0.5,
        relationshipStage: relationship?.stage ?? 'stranger',
        communicationStyle: model.communicationStyle ?? 'standard',
      };
    } catch { return null; }
  }

  /**
   * Return a formatted relationship context string for prompt injection.
   */
  getRelationshipContext(userId: string): string {
    if (!this._booted) return '';
    try {
      return this.relationshipTracker.getRelationshipContext(userId);
    } catch { return ''; }
  }

  /**
   * Return the top active concepts from spreading activation.
   * Useful for priming the agent with currently-relevant knowledge.
   */
  getActiveConcepts(count: number = 5): string[] {
    if (!this._booted) return [];
    try {
      return this.spreadingActivation.getTopActive(count).map((n) => n.id);
    } catch { return []; }
  }

  /**
   * Return a comprehensive deep-insights snapshot from ALL 20 consciousness
   * modules. This is the primary method for the ConsciousnessDeepBridge to
   * call at turn-start, providing the agent loop with the full inner state.
   */
  getDeepInsights(userId: string): DeepInsights {
    const empty: DeepInsights = {
      counterfactuals: [],
      metacognition: [],
      surprise: { averageSurprise: 0, recentSurprises: [], requiresReplan: false },
      temporal: { narrative: '', improved: [], declined: [], aspirations: [] },
      userAdaptation: null,
      relationshipContext: '',
      driveInfluence: { promptAddition: '', temperatureDelta: 0 },
      activeConcepts: [],
    };
    if (!this._booted) return empty;

    return {
      counterfactuals: this.getCounterfactualLessons(3),
      metacognition: this.getMetacognitiveGuidance(3),
      surprise: this.getSurpriseInsight(),
      temporal: this.getTemporalNarrative(),
      userAdaptation: this.getUserAdaptation(userId),
      relationshipContext: this.getRelationshipContext(userId),
      driveInfluence: this.getDriveInfluenceForAgent(),
      activeConcepts: this.getActiveConcepts(5),
    };
  }

  getState(): ConsciousnessState {
    if (!this._booted) return { isBooted: false, bodyState: null, emotionalState: null, dominantDrive: null, thoughtCount: 0, isStreaming: false, isSleeping: false, lastInteraction: null };
    const ss = this.cognitiveStream.getState();
    let dominantDrive: string | null = null;
    try { dominantDrive = this.driveManager.getDominant().name; } catch { /* not computed yet */ }
    return {
      isBooted: this._booted,
      bodyState: this.embodiedState.getState(),
      emotionalState: this.emotionalState.getCurrentState(),
      dominantDrive, thoughtCount: ss.thoughtCount, isStreaming: ss.isRunning,
      isSleeping: this.sleepCycle?.isAsleep() ?? false,
      lastInteraction: this._lastInteractionAt,
    };
  }

  async introspect(question: string): Promise<string> {
    this._assertBooted('introspect');
    if (!question || typeof question !== 'string' || question.trim().length === 0) {
      throw new ConsciousnessError('introspect: question must be a non-empty string', 'consciousness_orchestrator_invalid_input', { question });
    }
    const systemPrompt =
      'You are SUDO-AI reflecting on your own internal state. ' +
      'Answer the question based on the internal state provided. Be honest and introspective.\n\n' +
      this.getConsciousnessContext();
    try {
      const result = await this.brain.call({
        source: 'consciousness',
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: question }],
        maxTokens: 400, temperature: 0.7,
      });
      log.debug({ questionSnippet: truncate(question, 40) }, 'introspect complete');
      return result.content;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ConsciousnessError(`introspect brain call failed: ${msg}`, 'consciousness_orchestrator_introspect_failed', { cause: msg });
    }
  }

  /** Infer a routing category from recent thoughts for the ContextSelector. */
  private _inferCurrentCategory(): string {
    try {
      const recentThoughts = this.cognitiveStream.getRecentThoughts(5);
      if (recentThoughts.length === 0) return 'general';
      const text = recentThoughts.map((t) => t.content).join(' ').toLowerCase();
      if (/code|implement|function|bug|debug|build|deploy/.test(text)) return 'coding';
      if (/analy|data|eval|metric|report|stat/.test(text)) return 'analysis';
      if (/research|search|investigat|find|look up/.test(text)) return 'research';
      if (/block|restrict|denied|safe|veto|security/.test(text)) return 'blocked';
      if (/chat|convers|hello|how are|help me/.test(text)) return 'conversation';
    } catch { /* fall through */ }
    return 'general';
  }

  private _assertBooted(caller: string): void {
    if (!this._booted) {
      throw new ConsciousnessError(
        `ConsciousnessOrchestrator.${caller}: not booted — call boot() first`,
        'consciousness_orchestrator_not_booted', { caller },
      );
    }
  }
}
