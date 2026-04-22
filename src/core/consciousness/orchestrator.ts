/** ConsciousnessOrchestrator — boots all consciousness modules in dependency order,
 *  mediates interaction lifecycle, and formats internal state for system-prompt injection. */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createLogger } from '../shared/logger.js';
import { genId, truncate } from '../shared/utils.js';
import { ConsciousnessDB } from './consciousness-db.js';
import { ConsciousnessError } from './errors.js';
import type { BodyState, EmotionalValence, AttentionSignal } from './types.js';
import { EmbodiedStateEngine } from './embodied-state/index.js';
import { SpreadingActivationNetwork } from './spreading-activation/index.js';
import { EmotionalStateManager } from './emotional-memory/index.js';
import { AttentionManager } from './attention-system/index.js';
import { CognitiveStream } from './cognitive-stream/index.js';
import type { InterruptResult } from './cognitive-stream/index.js';
import { EpisodicMemory } from './episodic-memory/index.js';
import type { Episode } from './episodic-memory/index.js';
import { DriveManager } from './drive-system/index.js';
import { WorldModel } from './world-model/index.js';
import { SelfModel } from './self-model/index.js';
import { TheoryOfMind } from './theory-of-mind/index.js';
import { ProspectiveMemory } from './prospective-memory/index.js';
import { RelationshipTracker } from './relationship-model/index.js';
import { InternalDialogue } from './internal-dialogue/index.js';
import { MetacognitionEngine } from './metacognition/index.js';
import { CounterfactualEngine } from './counterfactual-engine/index.js';
import { TemporalSelf } from './temporal-self/index.js';
import { ProceduralMemory } from './procedural-memory/index.js';

export interface OrchestratorBrainLike {
  call(opts: { messages: Array<{ role: string; content: string }>; maxTokens?: number; temperature?: number; model?: string }): Promise<{ content: string }>;
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
  private sleepCycle: SleepCycleLike | null = null;
  private selfEvolution: SelfEvolutionLike | null = null;
  private _booted = false;
  private _lastInteractionAt: string | null = null;

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

  async boot(): Promise<void> {
    if (this._booted) { log.warn('boot() already called — ignored'); return; }

    // Check for persisted consciousness control state
    let skipStream = false;
    let skipEmbodied = false;
    try {
      const controlFile = path.resolve('data/consciousness-control.json');
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

    try {
      this.prospectiveMemory.expirePast();
      this.prospectiveMemory.checkTriggers({ time: new Date().toISOString(), userId, topic: truncate(message, 80) });
    } catch (e) { swallow('prospective check')(e); }

    const signal: AttentionSignal = {
      id: genId(), source: 'user-message', priority: 0.9,
      content: truncate(message, 200), timestamp: new Date().toISOString(), ttl: 300_000,
    };
    try { this.attention.submitSignal(signal); } catch (e) { swallow('attention signal')(e); }

    this._lastInteractionAt = new Date().toISOString();
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

    try { this.episodicMemory.recordEpisode(episode); } catch (e) { swallow('episodic record')(e); }
    try { this.selfModel.updateFromEpisode(episode); } catch (e) { swallow('self-model update')(e); }

    const tomOutcome: 'positive' | 'negative' | 'neutral' =
      validOutcome === 'positive' ? 'positive' : validOutcome === 'negative' ? 'negative' : 'neutral';
    try { await this.theoryOfMind.updateUserModel(userId, { userId, message: userMsg, response: '', outcome: tomOutcome }); } catch (e) { swallow('tom update')(e); }
    try { this.relationshipTracker.updateFromInteraction(userId, episode); } catch (e) { swallow('relationship update')(e); }

    // Record tool sequences
    const toolCalls = messages.filter((m) => m.role === 'assistant' && m.content.includes('tool')).map((m) => truncate(m.content, 60));
    if (toolCalls.length > 0) {
      try { this.db.getDb().prepare('INSERT INTO tool_sequences (session_id, sequence) VALUES (?, ?)').run(sessionId, JSON.stringify(toolCalls)); } catch (e) { swallow('tool seq record')(e); }
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
  } {
    const empty = {
      dominantDrive: null,
      emotionalState: null,
      matchingProcedure: null,
      relevantPredictions: [],
      recentEpisodes: [],
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

    return { dominantDrive, emotionalState, matchingProcedure, relevantPredictions, recentEpisodes };
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

  private _assertBooted(caller: string): void {
    if (!this._booted) {
      throw new ConsciousnessError(
        `ConsciousnessOrchestrator.${caller}: not booted — call boot() first`,
        'consciousness_orchestrator_not_booted', { caller },
      );
    }
  }
}
