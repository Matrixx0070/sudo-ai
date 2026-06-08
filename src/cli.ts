/**
 * @file cli.ts
 * @description Headless CLI entry point for SUDO-AI v5.
 *
 * Boots the full agent stack without Electron:
 *   ConfigLoader -> MindDB -> Brain -> ToolRegistry -> SessionManager
 *   -> AgentLoop -> TelegramAdapter -> CronScheduler -> HeartbeatRunner
 *
 * Usage:
 *   npx tsx src/cli.ts
 *   pnpm cli
 */

import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createLogger } from './core/shared/logger.js';
import { ConfigLoader } from './core/config/loader.js';
import { MindDB } from './core/memory/db.js';
import { Brain } from './core/brain/brain.js';
import { ToolRegistry } from './core/tools/registry.js';
import { loadBuiltinTools } from './core/tools/loader.js';
import { SessionManager } from './core/sessions/manager.js';
import { AgentLoop } from './core/agent/loop.js';
import { TelegramAdapter } from './core/channels/telegram.js';
import { CronStore } from './core/cron/store.js';
import { CronScheduler } from './core/cron/scheduler.js';
import { HeartbeatRunner } from './core/cron/heartbeat.js';
import { CommandRegistry } from './core/commands/registry.js';
import { HookManager } from './core/hooks/index.js';
import { CostTracker } from './core/brain/cost-tracker.js';
import { createFeedbackKeyboard, saveFeedback } from './core/feedback/index.js';
import type { SudoConfig } from './core/config/types.js';
import type { CronPayload, CronJob } from './core/cron/types.js';
import { CrossChannelMemory } from './core/channels/cross-channel-memory.js';
import { GoalEngineV2 } from './core/autonomy/goal-engine-v2.js';
import { OutcomesLedger } from './core/autonomy/outcomes.js';
import { AuditTrail } from './core/security/audit-trail.js';
import { AgentWallet } from './core/economy/wallet.js';
import { AgentIdentity } from './core/economy/did.js';
import { AutoDream } from './core/memory/auto-dream.js';
import { TeammateIdleDetector } from './core/agent/teammate-idle.js';
import { BackgroundAgentExecutor } from './core/agent/background-agent.js';
import { InMemorySteeringChannel } from './core/agent/steering.js';
import { loadMarkdownSkills } from './core/skills/markdown-loader.js';
import { startGateway, gatewayServer } from './core/gateway/server.js';
import { attachWsRpc } from './core/gateway/ws-server.js';
import { attachHttpApi } from './core/gateway/http-api.js';
import { DualSessionManager } from './core/sessions/dual-manager.js';
import { JournalSessionStore } from './core/sessions/journal-store.js';
import { buildSessionRouteDeps, registerSessionRoutes } from './core/sessions/routes.js';
import { AgentConfigStore, registerAgentRoutes } from './core/agents/index.js';
import { registerSseRoutes } from './core/gateway/sse-stream.js';
import { oauthRefreshDaemon } from './core/security/vault-credentials.js';
import { registerVaultCredentialRoutes } from './core/security/vault-routes.js';
import { createInspectionQueue } from './core/security/inspection-queue.js';
import { setInspectionQueue } from './core/security/injection-detector.js';
import { setRationalizationQueue } from './core/agent/rationalization-guard.js';
import { injectWorkspaceContext } from './core/workspace/injector.js';
import { DailyLogManager } from './core/workspace/daily-log.js';
import { FileStore, registerFileRoutes } from './core/files/index.js';
import { SkillRegistry, registerSkillRoutes } from './core/skills/index.js';
import { SandboxManager, DEFAULT_SANDBOX_POLICY } from './core/sandbox/index.js';
import { createGoalEvaluator, SessionOutcomeListener } from './core/outcomes/index.js';
import { CommitmentAuditor } from './core/cognition/commitment-auditor.js';
import { MistakePatternRecognizer } from './core/cognition/mistake-pattern-recognizer.js';
import { ConfidenceCalibrationTracker } from './core/cognition/confidence-calibration-tracker.js';
import { CommitmentResolutionTracker } from './core/cognition/commitment-resolution-tracker.js';
import { InjectionDetector } from './core/cognition/injection-detector.js';
import { ReAnchorMonitor } from './core/cognition/reanchor-monitor.js';
import { MistakeAutoBlockGuard } from './core/cognition/mistake-auto-block-guard.js';
import { setAutoBlockGuard, setVetoReAnchorCallback, setAutoThresholdTuner } from './core/agent/veto-gate.js';
import { AutoThresholdTuner } from './core/cognition/auto-threshold-tuner.js';
import { setDiscordanceReAnchorCallback } from './core/security/discordance-detector.js';
import { setGlobalDispatchReAnchorCallback } from './core/brain/dispatch-router.js';
import { createReAnchorEmitter } from './core/cognition/re-anchor-emitter.js';
import { AlignmentAutoRemediator } from './core/cognition/alignment-autoremediator.js';
import { detectHardware } from './core/config/hardware-detect.js';
import { BenchStore } from './core/eval/bench-store.js';
import { ProposalStore } from './core/learning/proposal-store.js';
import { scoreComplexity } from './core/agent/complexity-scorer.js';
import { SkillDiscovery } from './core/learning/skill-discovery.js';
import { TraceStore } from './core/learning/trace-store.js';
import { TraceAnalyzer } from './core/learning/trace-analyzer.js';
import { TraceDrivenPolicy } from './core/learning/trace-driven-policy.js';
import { AgentConfigEvolver } from './core/learning/agent-config-evolver.js';
import { SkillOptimizer } from './core/skills/skill-optimizer.js';
import { SkillOptimizationStore } from './core/skills/skill-optimization-store.js';
import { buildSkillToolIndex } from './core/skills/skill-tool-index.js';
import * as proactiveNotifier from './core/awareness/proactive-notifier.js';
import { taintTracker } from './core/security/taint-tracker.js';
import { artifactSigner } from './core/security/signer.js';
// injectMetaToolDeps imported dynamically in boot() to avoid eagerly loading 47 meta tool files

// ---------------------------------------------------------------------------
// Module-level logger
// ---------------------------------------------------------------------------

const log = createLogger('cli');

// ---------------------------------------------------------------------------
// Shutdown registry — all teardown functions collected here
// ---------------------------------------------------------------------------

const shutdownHandlers: Array<() => Promise<void> | void> = [];

let isShuttingDown = false;

function registerShutdown(fn: () => Promise<void> | void): void {
  shutdownHandlers.push(fn);
}

async function runShutdown(signal: string): Promise<void> {
  // Re-entrancy guard: SIGINT and SIGTERM are independent one-shot handlers,
  // so a second signal arriving during async teardown would otherwise re-run
  // every handler (double db.close(), double adapter stop, etc.).
  if (isShuttingDown) return;
  isShuttingDown = true;

  log.info({ signal }, 'Graceful shutdown initiated');

  // Run in reverse-registration order (LIFO — last-started stops first).
  // Iterate over a copy so the source array is not mutated in place.
  for (const handler of [...shutdownHandlers].reverse()) {
    try {
      await handler();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, 'Shutdown handler error — continuing teardown');
    }
  }

  log.info('SUDO-AI v5 shutdown complete');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function boot(): Promise<void> {
  log.info('SUDO-AI v5 boot sequence starting');

  // -------------------------------------------------------------------------
  // 0.5 Hardware detection — non-fatal; warns if under-resourced
  // -------------------------------------------------------------------------
  try {
    const hw = await detectHardware();
    if (hw.warnings.length > 0) {
      hw.warnings.forEach(w => log.warn({ hw: { cpuCores: hw.cpuCores, ramMb: hw.ramMb } }, w));
    } else {
      log.info({ cpuCores: hw.cpuCores, ramMb: hw.ramMb, wasmtimeAvailable: hw.wasmtimeAvailable }, 'Hardware OK');
    }
  } catch (hwErr: unknown) {
    log.warn({ err: String(hwErr) }, 'Hardware detection failed (non-fatal) — continuing boot');
  }


  // Emit agent:bootstrap as early as possible — hooks manager not yet available here,
  // so we defer this emit to after hooks init below.

  // -------------------------------------------------------------------------
  // 1. Config
  // -------------------------------------------------------------------------
  const configLoader = new ConfigLoader(process.cwd());
  await configLoader.load();
  const config: SudoConfig = configLoader.get();
  registerShutdown(() => configLoader.close());
  log.info({ name: config.meta.name, tz: config.meta.timezone }, 'Config loaded');

  // -------------------------------------------------------------------------
  // 1.5 First-run bootstrap check
  // -------------------------------------------------------------------------
  try {
    const { existsSync } = await import('node:fs');
    const bootstrapPath = path.resolve('workspace', 'BOOTSTRAP.md');
    if (existsSync(bootstrapPath)) {
      // BOOTSTRAP.md is read by the system-prompt injector on each turn.
      // The agent will detect it and initiate the onboarding dialogue via Telegram.
      // BootstrapRunner requires live send/receive callbacks that are only available
      // after channel adapters start, so explicit invocation happens in-channel.
      log.info({ bootstrapPath }, 'BOOTSTRAP.md found — first-run onboarding will be initiated via Telegram');
    } else {
      log.info('Bootstrap already completed — BOOTSTRAP.md not present');
    }
  } catch (err) {
    log.warn({ err: String(err) }, 'Bootstrap check failed (non-fatal)');
  }

  // -------------------------------------------------------------------------
  // 2. MindDB (SQLite + optional sqlite-vec)
  // -------------------------------------------------------------------------
  const db = new MindDB();
  registerShutdown(() => db.close());
  log.info({ vecLoaded: db.vecLoaded }, 'MindDB initialized');

  // -------------------------------------------------------------------------
  // 2.1 Inspection queue — wire flagged-content capture for injection-detector
  //     and rationalization-guard. Must run after MindDB (schema already
  //     initialized in MindDB constructor) and before any agent activity.
  // -------------------------------------------------------------------------
  const inspectionQueue = createInspectionQueue(db.db);
  setInspectionQueue(inspectionQueue);
  setRationalizationQueue(inspectionQueue);
  log.info('Inspection queue wired (injection-detector + rationalization-guard)');

  // -------------------------------------------------------------------------
  // 3.0 Claude OAuth Token Manager — use Claude Max as primary brain
  // -------------------------------------------------------------------------
  //
  // Must run BEFORE Brain construction so that ANTHROPIC_AUTH_TOKEN is set
  // when initProviders() builds the anthropic provider instance.
  // -------------------------------------------------------------------------
  let claudeTokenManager: import('./core/brain/claude-token-manager.js').ClaudeTokenManager | null = null;

  try {
    const { ClaudeTokenManager, TOKEN_POLL_INTERVAL_MS } = await import('./core/brain/claude-token-manager.js');
    const claudeToken = new ClaudeTokenManager();

    if (claudeToken.isAvailable()) {
      const token = claudeToken.getAccessToken();
      if (token) {
        process.env['ANTHROPIC_AUTH_TOKEN'] = token;
        log.info('Claude Max OAuth token loaded — ANTHROPIC_AUTH_TOKEN set for Brain init');
      } else {
        // Token exists but is within the 10-minute expiry buffer — attempt immediate refresh.
        log.info('Claude token within expiry buffer — attempting pre-boot refresh');
        const refreshed = await claudeToken.refreshToken();
        if (refreshed) {
          const freshToken = claudeToken.getAccessToken();
          if (freshToken) {
            process.env['ANTHROPIC_AUTH_TOKEN'] = freshToken;
            log.info('Claude Max OAuth token refreshed — ANTHROPIC_AUTH_TOKEN set for Brain init');
          }
        } else {
          log.warn('Claude pre-boot refresh failed — Claude provider may be unavailable');
        }
      }

      claudeToken.startAutoRefresh();
      claudeTokenManager = claudeToken;
      registerShutdown(() => claudeToken.stopAutoRefresh());

      // Poll every minute and update ANTHROPIC_AUTH_TOKEN when the token rotates.
      const tokenPollTimer = setInterval(() => {
        if (!claudeTokenManager) return;
        const newToken = claudeTokenManager.getAccessToken();
        if (newToken && newToken !== process.env['ANTHROPIC_AUTH_TOKEN']) {
          process.env['ANTHROPIC_AUTH_TOKEN'] = newToken;
          log.info('ANTHROPIC_AUTH_TOKEN updated with refreshed Claude token');
        }
      }, TOKEN_POLL_INTERVAL_MS);

      if (tokenPollTimer.unref) tokenPollTimer.unref();
      registerShutdown(() => clearInterval(tokenPollTimer));
    } else {
      log.info('Claude credentials not found — Claude provider unavailable; using configured providers');
    }
  } catch (err) {
    log.warn({ err: String(err) }, 'Claude token manager failed to initialize — using existing providers');
  }
  // -------------------------------------------------------------------------
  // 2.95 Local Gateway — start before Brain so the API is available
  // -------------------------------------------------------------------------
  let gatewayPort: number | undefined;
  try {
    gatewayPort = await startGateway();
    console.log(`[boot] Gateway started on port ${gatewayPort}`);
  } catch (err) {
    console.warn(
      '[boot] Gateway failed to start, local API unavailable:',
      (err as Error).message,
    );
  }

  // -------------------------------------------------------------------------
  // 3. Brain (LLM core with multi-model failover)
  // -------------------------------------------------------------------------
  const brain = new Brain(config);
  log.info('Brain initialized');

  // -------------------------------------------------------------------------
  // 3.1 HookManager — lifecycle event hooks
  // -------------------------------------------------------------------------
  const hooks = new HookManager();
  log.info('HookManager initialized');

  // Wave 10E: Wire TaintTracker into HookManager (fail-open, kill-switch: SUDO_TAINT_DISABLE=1).
  if (process.env['SUDO_TAINT_DISABLE'] !== '1') {
    try {
      taintTracker.attachHooks(hooks);
      log.info('TaintTracker attached to HookManager');
    } catch (err) {
      log.warn({ err: String(err) }, 'TaintTracker.attachHooks failed — taint tracking disabled');
    }
  }

  // agent:bootstrap — fired once per process start, after hooks manager is ready.
  try {
    await hooks.emit('agent:bootstrap', { event: 'agent:bootstrap' });
  } catch (err) {
    log.warn({ err: String(err) }, 'agent:bootstrap emit failed — continuing');
  }

  // gateway:startup — emitted after hooks manager is available (gateway started earlier in boot).
  if (gatewayPort !== undefined) {
    try {
      await hooks.emit('gateway:startup', { event: 'gateway:startup', gatewayId: 'sudo-gateway', meta: { port: gatewayPort } });
    } catch (err) {
      log.warn({ err: String(err) }, 'gateway:startup emit failed — continuing');
    }
  }

  // gateway:shutdown — emitted during graceful teardown.
  registerShutdown(async () => {
    try {
      await hooks.emit('gateway:shutdown', { event: 'gateway:shutdown', gatewayId: 'sudo-gateway' });
    } catch (err) {
      log.warn({ err: String(err) }, 'gateway:shutdown emit failed — continuing');
    }
  });

  // -------------------------------------------------------------------------
  // 3.15 SecurityGuard — prompt injection detection + tool-call validation
  // -------------------------------------------------------------------------
  let security: import('./core/security/index.js').SecurityGuard | null = null;
  try {
    const { SecurityGuard } = await import('./core/security/index.js');
    security = new SecurityGuard();
    log.info('SecurityGuard initialized');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ err: msg }, 'SecurityGuard failed to initialize — running without security hardening');
  }

  // -------------------------------------------------------------------------
  // 3.2 CostTracker — session-level token cost tracking
  // -------------------------------------------------------------------------
  const costTracker = new CostTracker();
  log.info('CostTracker initialized');

  // -------------------------------------------------------------------------
  // 3.3 CommandRegistry — slash command routing
  // -------------------------------------------------------------------------
  const commandRegistry = new CommandRegistry();
  log.info('CommandRegistry initialized');

  // -------------------------------------------------------------------------
  // 3.5 RAG Engine — attach memory retrieval to the brain
  // -------------------------------------------------------------------------
  // Declared outside the try block so section 3.6 can attach the knowledge graph.
  let ragEngine: import('./core/knowledge/rag-engine.js').RAGEngine | null = null;

  try {
    const { RAGEngine } = await import('./core/knowledge/rag-engine.js');
    ragEngine = new RAGEngine(db);
    brain.setRAGEngine(ragEngine);
    log.info('RAG engine attached to brain');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ err: msg }, 'RAG engine failed to initialize — running without memory retrieval');
  }

  // -------------------------------------------------------------------------
  // 3.6 Knowledge Graph + Zettelkasten
  // -------------------------------------------------------------------------
  try {
    const { KnowledgeGraph } = await import('./core/knowledge/knowledge-graph.js');
    const { Zettelkasten } = await import('./core/knowledge/zettelkasten.js');
    const { ObsidianVault } = await import('./core/knowledge/obsidian.js');

    const knowledgeGraph = new KnowledgeGraph('data/knowledge.db');
    const vault = new ObsidianVault('workspace/notes');
    // Zettelkasten wires vault + graph; instance kept for future skill exposure.
    const _zettelkasten = new Zettelkasten(vault, knowledgeGraph);
    void _zettelkasten; // suppress unused-variable warning

    // Connect to RAG engine if it initialised successfully.
    if (ragEngine !== null) {
      ragEngine.setKnowledgeGraph(knowledgeGraph);
    }

    log.info('Knowledge Graph + Zettelkasten initialized');
  } catch (err) {
    log.warn({ err: String(err) }, 'Knowledge system failed — running without');
  }

  // -------------------------------------------------------------------------
  // 4. ToolRegistry + load all builtin tools
  // -------------------------------------------------------------------------
  const registry = new ToolRegistry();
  ToolRegistry.setGlobal(registry); // allow tools to self-register at runtime
  const toolsDir = new URL('./core/tools/builtin', import.meta.url).pathname;
  await loadBuiltinTools(registry, toolsDir);

  // Register superpower tools (12 advanced capabilities)
  try {
    const { registerSuperpowers } = await import('./core/superpowers/index.js');
    registerSuperpowers(registry);
    log.info('Superpower tools registered');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ err: msg }, 'Superpower registration failed — continuing without superpowers');
  }

  log.info({ toolCount: registry.listAll().length }, 'ToolRegistry initialized with all tools');

  // Disable tools listed in config.
  for (const toolName of config.tools.disabled) {
    try {
      registry.disable(toolName);
      log.info({ toolName }, 'Tool disabled via config');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ toolName, err: msg }, 'Failed to disable tool — skipping');
    }
  }

  // -------------------------------------------------------------------------
  // 5. SessionManager
  // -------------------------------------------------------------------------
  const sessionManager = new SessionManager(db);
  const journalStore = new JournalSessionStore();
  const dualSessionManager = new DualSessionManager(sessionManager, journalStore);
  log.info('SessionManager initialized');

  const dailyLog = new DailyLogManager();

  // -------------------------------------------------------------------------
  // 5.5 Multi-agent orchestration
  // -------------------------------------------------------------------------
  try {
    const { MultiAgentOrchestrator, createMultiAgentTool } = await import('./core/agents/index.js');
    const multiAgent = new MultiAgentOrchestrator(brain, registry, dualSessionManager);
    registry.register(createMultiAgentTool(multiAgent));
    log.info('Multi-agent orchestrator registered (system.spawn-agent)');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ err: msg }, 'Multi-agent orchestrator failed — running without');
  }

  // -------------------------------------------------------------------------
  // 5.6 SandboxManager (early init with proxy EventEmitter)
  // The real SessionStateMachine isn't available until step 9.5. We create
  // SandboxManager with a proxy EventEmitter now and forward terminal events
  // from the real stateMachine once it boots. This lets both AgentLoop
  // constructors receive sandboxManager immediately.
  // -------------------------------------------------------------------------
  const sandboxProxyBus = new EventEmitter();
  const sandboxManager = new SandboxManager({
    stateMachine: sandboxProxyBus,
    workspaceRoot: path.join(process.cwd(), 'workspace', 'sessions'),
    defaultPolicy: DEFAULT_SANDBOX_POLICY,
  });
  registerShutdown(async () => sandboxManager.teardownAll());
  log.info('SandboxManager pre-initialized with proxy event bus');

  // -------------------------------------------------------------------------
  // 6. AgentLoop
  // -------------------------------------------------------------------------
  const workspaceInjector = (session: any) =>
    injectWorkspaceContext(session, {
      config: {
        workspaceDir: path.resolve('workspace'),
        mainPeerId: (process.env['TELEGRAM_CHAT_ID'] ?? '').split(',')[0]?.trim() || config.channels?.telegram?.allowedUsers?.[0],
      },
    });

  const agentLoop = new AgentLoop(brain, registry, dualSessionManager, {
    maxIterations: config.agents.maxIterations,
  }, undefined, security ?? undefined, workspaceInjector, hooks, sandboxManager);
  log.info({ maxIterations: config.agents.maxIterations }, 'AgentLoop initialized');

  // -------------------------------------------------------------------------
  // 6.4 CommitmentAuditor — reads commitment rows from the audit_log table.
  //     Instantiated here so it can be passed to SleepCycle (6.5) and the
  //     HTTP admin routes (9.5) without circular deps.
  // -------------------------------------------------------------------------
  let commitmentAuditor: CommitmentAuditor | undefined;
  let mistakePatternRecognizer: MistakePatternRecognizer | undefined;
  let reanchorMonitor: ReAnchorMonitor | undefined;
  try {
    const dataDir = process.env['DATA_DIR'];
    if (dataDir) {
      const Database = (await import('better-sqlite3')).default;
      const caDb = new Database(path.join(dataDir, 'audit.db'));

      // Wave 7A P1: Lazy audit_chain schema seed (idempotent, fail-open).
      // Ensures the table exists before any module tries to query it.
      try {
        caDb.exec(`
          CREATE TABLE IF NOT EXISTS audit_chain (
            id         TEXT NOT NULL PRIMARY KEY,
            ts         INTEGER NOT NULL,
            learned    TEXT,
            mistake    TEXT,
            commitment TEXT,
            ttl_days   REAL
          );
          CREATE INDEX IF NOT EXISTS idx_audit_chain_ts ON audit_chain(ts);
        `);
        log.info('audit_chain schema seed complete');
      } catch (seedErr: unknown) {
        log.warn({ err: String(seedErr) }, 'audit_chain schema seed failed (non-fatal)');
      }

      // Wave 7A P2 (refactored 7D): Identity re-anchor instrumentation at startup.
      // Uses createReAnchorEmitter for DRY — same helper used for post-veto/discordance/dispatch.
      // Note: sleepTrustTracker not yet initialized here; the trust write happens after 6.4b below.
      try {
        const _emitStartupAudit = createReAnchorEmitter('startup', caDb, undefined);
        _emitStartupAudit();
        log.info('audit_chain startup re-anchor row inserted (via re-anchor-emitter)');
      } catch (insertErr: unknown) {
        log.warn({ err: String(insertErr) }, 'audit_chain startup re-anchor insert failed (non-fatal)');
      }

      commitmentAuditor = new CommitmentAuditor(caDb);
      log.info('CommitmentAuditor initialised');
      try {
        mistakePatternRecognizer = new MistakePatternRecognizer(caDb);
        log.info('MistakePatternRecognizer initialised (reusing audit.db)');
      } catch (mprErr: unknown) {
        const mprMsg = mprErr instanceof Error ? mprErr.message : String(mprErr);
        log.error({ err: mprMsg }, 'MistakePatternRecognizer init failed — pattern endpoints will return 503');
      }
      // Wave 6R: wire MistakeAutoBlockGuard into veto-gate pre-check (fail-open).
      // Cast via unknown: MistakePattern satisfies the structural duck type but lacks
      // an index signature, which is a TypeScript structural quirk, not a runtime issue.
      if (mistakePatternRecognizer) {
        try {
          const autoBlockGuard = new MistakeAutoBlockGuard({
            patternRecognizer: mistakePatternRecognizer as unknown as import('./core/cognition/mistake-auto-block-guard.js').PatternRecognizerLike,
          });
          setAutoBlockGuard(autoBlockGuard);
          log.info('MistakeAutoBlockGuard wired into veto-gate (pre-veto pattern block active)');
        } catch (mabErr: unknown) {
          const mabMsg = mabErr instanceof Error ? mabErr.message : String(mabErr);
          log.warn({ err: mabMsg }, 'MistakeAutoBlockGuard init failed — veto-gate will run without auto-block guard');
        }
      }
      try {
        reanchorMonitor = new ReAnchorMonitor(caDb);
        log.info('ReAnchorMonitor initialised (reusing audit.db)');
      } catch (ramErr: unknown) {
        const ramMsg = ramErr instanceof Error ? ramErr.message : String(ramErr);
        log.error({ err: ramMsg }, 'ReAnchorMonitor init failed — reanchor endpoints will return 503');
      }
    } else {
      log.warn('DATA_DIR not set — CommitmentAuditor skipped (commitment expiry endpoints will return 503)');
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg }, 'CommitmentAuditor init failed — commitment expiry endpoints will return 503');
  }

  // -------------------------------------------------------------------------
  // 6.4b TrustTierTracker for SleepCycle (commitment-expired outcome hooks).
  //      Opens a separate connection to trust.db — better-sqlite3 allows it.
  // -------------------------------------------------------------------------
  let sleepTrustTracker: import('./core/cognition/trust-tier-tracker.js').TrustTierTracker | undefined;
  try {
    const dataDir = process.env['DATA_DIR'];
    if (dataDir) {
      const Database = (await import('better-sqlite3')).default;
      const ttDb = new Database(path.join(dataDir, 'trust.db'));
      const { TrustTierTracker } = await import('./core/cognition/trust-tier-tracker.js');
      sleepTrustTracker = new TrustTierTracker(ttDb);
      log.info('TrustTierTracker (sleep) initialised');

      // Wave 7A P2 (refactored 7D): Record startup re-anchor outcome in trust tracker (fail-open).
      try {
        const _emitStartupTrust = createReAnchorEmitter('startup', undefined, sleepTrustTracker);
        _emitStartupTrust();
        log.info('TrustTierTracker: startup re-anchor outcome recorded (via re-anchor-emitter)');
      } catch (raErr: unknown) {
        log.warn({ err: String(raErr) }, 'TrustTierTracker: startup re-anchor outcome failed (non-fatal)');
      }
    } else {
      log.warn('DATA_DIR not set — TrustTierTracker (sleep) skipped');
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ err: msg }, 'TrustTierTracker (sleep) init failed — commitment-expired outcomes will not be recorded');
  }

  // -------------------------------------------------------------------------
  // 6.4b2 Wave 7D: Wire re-anchor callbacks for post-veto, post-discordance,
  //        post-dispatch trigger paths. Requires caDb (from 6.4) and
  //        sleepTrustTracker (from 6.4b) — both may be undefined (fail-open).
  // -------------------------------------------------------------------------
  try {
    // We need caDb in scope — it was opened in the 6.4 block. Re-read from audit.db.
    // Both sinks accept undefined — the factory is fully fail-open.
    const dataDir7d = process.env['DATA_DIR'];
    if (dataDir7d && sleepTrustTracker) {
      const Database7d = (await import('better-sqlite3')).default;
      const caDb7d = new Database7d(path.join(dataDir7d, 'audit.db'));

      // post-veto: fires when adversarial-model DENY verdict is returned
      setVetoReAnchorCallback(createReAnchorEmitter('post-veto', caDb7d, sleepTrustTracker));
      log.info('Wave 7D: post-veto re-anchor callback wired');

      // post-discordance: fires when discordance level crosses 'discordant' (score >= 0.70)
      setDiscordanceReAnchorCallback(createReAnchorEmitter('post-discordance', caDb7d, sleepTrustTracker));
      log.info('Wave 7D: post-discordance re-anchor callback wired');

      // post-dispatch: fires after every DispatchRouter.route() call (module-level — no instance ref needed)
      setGlobalDispatchReAnchorCallback(createReAnchorEmitter('post-dispatch', caDb7d, sleepTrustTracker));
      log.info('Wave 7D: post-dispatch re-anchor callback wired');

      log.info('Wave 7D: re-anchor callbacks wired (post-veto + post-discordance + post-dispatch)');
    } else {
      log.warn('Wave 7D: re-anchor callback wiring skipped (DATA_DIR or sleepTrustTracker unavailable)');
    }
  } catch (w7dErr: unknown) {
    const w7dMsg = w7dErr instanceof Error ? w7dErr.message : String(w7dErr);
    log.warn({ err: w7dMsg }, 'Wave 7D: re-anchor callback wiring failed (non-fatal)');
  }

  // -------------------------------------------------------------------------
  // 6.4c ConfidenceCalibrationTracker — predicted-vs-actual calibration (Wave 6L).
  //      Opens calibration.db; fail-open on any init error.
  // -------------------------------------------------------------------------
  let confidenceCalibrationTracker: ConfidenceCalibrationTracker | undefined;
  try {
    const dataDir = process.env['DATA_DIR'];
    if (dataDir) {
      const Database = (await import('better-sqlite3')).default;
      const calDb = new Database(path.join(dataDir, 'calibration.db'));
      confidenceCalibrationTracker = new ConfidenceCalibrationTracker(calDb);
      log.info('ConfidenceCalibrationTracker initialised');
    } else {
      log.warn('DATA_DIR not set — ConfidenceCalibrationTracker skipped (calibration endpoint will return 503)');
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg }, 'ConfidenceCalibrationTracker init failed — calibration endpoint will return 503');
  }

  // -------------------------------------------------------------------------
  // 6.4g AutoThresholdTuner — dynamic veto threshold from calibration drift
  //      (Wave 7C). Requires confidenceCalibrationTracker from 6.4c.
  //      Fail-open: if tracker undefined, tuner is skipped and veto-gate uses
  //      static BASE_VETO_THRESHOLD. Module-level setter pattern (mirrors 6R).
  // -------------------------------------------------------------------------
  let autoThresholdTuner: AutoThresholdTuner | undefined;
  try {
    if (confidenceCalibrationTracker) {
      autoThresholdTuner = new AutoThresholdTuner(confidenceCalibrationTracker);
      setAutoThresholdTuner(autoThresholdTuner);
      log.info('AutoThresholdTuner initialised and wired into veto-gate');
    } else {
      log.warn('ConfidenceCalibrationTracker absent — AutoThresholdTuner skipped (veto threshold endpoint will return 503)');
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg }, 'AutoThresholdTuner init failed — veto threshold will use static baseline');
  }

  // -------------------------------------------------------------------------
  // 6.4d CrossSignalDiagnostics — correlates trust/epistemic/veto/commitment
  //      signals across subsystems. Opens 3 DB connections (fail-open).
  //      audit.db reused (separate handle); trust.db reused; mind.db for epistemic.
  // -------------------------------------------------------------------------
  let crossSignalDiagnostics: import('./core/cognition/cross-signal-diagnostics.js').CrossSignalDiagnostics | undefined;
  try {
    const dataDir = process.env['DATA_DIR'];
    if (dataDir) {
      const Database = (await import('better-sqlite3')).default;
      const { CrossSignalDiagnostics } = await import('./core/cognition/cross-signal-diagnostics.js');
      const csdTrustDb = new Database(path.join(dataDir, 'trust.db'));
      const csdAuditDb = new Database(path.join(dataDir, 'audit.db'));
      const csdEpistemicDb = new Database(path.join(dataDir, 'mind.db'));
      crossSignalDiagnostics = new CrossSignalDiagnostics({
        trustDb: csdTrustDb,
        epistemicDb: csdEpistemicDb,
        auditDb: csdAuditDb,
      });
      log.info('CrossSignalDiagnostics initialised');
    } else {
      log.warn('DATA_DIR not set — CrossSignalDiagnostics skipped (diagnostics endpoint will return 503)');
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ err: msg }, 'CrossSignalDiagnostics init failed — diagnostics endpoint will return 503');
  }

  // -------------------------------------------------------------------------
  // 6.4e CommitmentResolutionTracker — persistent commitment outcome log (Wave 6N).
  //      Opens resolutions.db (separate DB to isolate schema from audit.db).
  //      Fail-open on any init error.
  // -------------------------------------------------------------------------
  let commitmentResolutionTracker: CommitmentResolutionTracker | undefined;
  try {
    const dataDir = process.env['DATA_DIR'];
    if (dataDir) {
      const Database = (await import('better-sqlite3')).default;
      const resDb = new Database(path.join(dataDir, 'resolutions.db'));
      commitmentResolutionTracker = new CommitmentResolutionTracker(resDb);
      log.info('CommitmentResolutionTracker initialised');
    } else {
      log.warn('DATA_DIR not set — CommitmentResolutionTracker skipped (commitments/resolve endpoint will return 503)');
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg }, 'CommitmentResolutionTracker init failed — commitments/resolve endpoint will return 503');
  }

  // -------------------------------------------------------------------------
  // 6.4f InjectionDetector — stateless pure detector, no DB (Wave 6O).
  //      strictMode controlled by SUDO_INJECTION_STRICT=1 env var.
  // -------------------------------------------------------------------------
  const injectionDetector = new InjectionDetector({
    strictMode: process.env['SUDO_INJECTION_STRICT'] === '1',
  });
  log.info({ strictMode: process.env['SUDO_INJECTION_STRICT'] === '1' }, 'InjectionDetector initialised');

  // -------------------------------------------------------------------------
  // 6.4h Wave 7E: Federation — PeerRegistry + AuditChainSync.
  //      Reads peer config from env (fail-open if missing/malformed).
  //      Opens a second handle on audit.db for federation tables.
  //      Instance ID = SUDO_INSTANCE_ID env or "hostname-pid" fallback.
  // -------------------------------------------------------------------------
  let federationDeps: import('./core/gateway/federation-routes.js').FederationRoutesDeps | undefined;
  // Wave 2 — Federation Error Protocol (hoisted for later init)
  let federationErrorIngestor: any;
  let federationTokenPool: any;
  let peerRegistryForAuth: any;
  try {
    const dataDir64h = process.env['DATA_DIR'];
    if (dataDir64h) {
      const Database64h = (await import('better-sqlite3')).default;
      const fedAuditDb = new Database64h(path.join(dataDir64h, 'audit.db'));
      const { PeerRegistry } = await import('./core/federation/peer-registry.js');
      const { AuditChainSync } = await import('./core/federation/audit-chain-sync.js');

      peerRegistryForAuth = PeerRegistry.fromEnv();
      const peerRegistry = peerRegistryForAuth;

      // Wave 10H: PeerKeyCache + PeerKeyFetcher for federation ingest verification
      const { PeerKeyCache } = await import('./core/federation/peer-key-cache.js');
      const { PeerKeyFetcher } = await import('./core/federation/peer-key-fetcher.js');
      const peerKeyCache = new PeerKeyCache();
      const peerKeyFetcher = new PeerKeyFetcher(peerRegistry, peerKeyCache);

      // Derive instance ID — stable across restarts if env is set
      const { hostname: osHostname } = await import('node:os');
      const rawHostname = (() => { try { return osHostname(); } catch { return 'unknown'; } })();
      const instanceId = process.env['SUDO_INSTANCE_ID'] || `${rawHostname}-${process.pid}`;

      const auditChainSync = new AuditChainSync(fedAuditDb, peerRegistry, instanceId, artifactSigner);

      federationDeps = { peerRegistry, auditChainSync, peerKeyFetcher, artifactSigner };
      log.info({ instanceId, peersConfigured: peerRegistry.getPeers().length }, 'Wave 7E: Federation initialised');

      // Hook re-anchor events into federation publish (fire-and-forget).
      // Wraps the 7D re-anchor callbacks to also fan-out events to peers.
      if (peerRegistry.getPeers().length > 0) {
        const { setGlobalDispatchReAnchorCallback: setDispatchCb } = await import('./core/brain/dispatch-router.js');
        const { setVetoReAnchorCallback: setVetoCb } = await import('./core/agent/veto-gate.js');
        const { setDiscordanceReAnchorCallback: setDiscCb } = await import('./core/security/discordance-detector.js');
        const { createReAnchorEmitter: cre } = await import('./core/cognition/re-anchor-emitter.js');

        // Build a composed emitter: base re-anchor + federation publish.
        // Open fresh audit.db handle per trigger (fail-open).
        const buildComposed = (trigger: string): (() => void) => {
          try {
            const caDb64h = new Database64h(path.join(dataDir64h, 'audit.db'));
            const base = cre(trigger, caDb64h, sleepTrustTracker);
            return (): void => {
              base();
              auditChainSync.publishEvent('re-anchor', { trigger });
            };
          } catch {
            return (): void => { auditChainSync.publishEvent('re-anchor', { trigger }); };
          }
        };

        setVetoCb(buildComposed('post-veto'));
        setDiscCb(buildComposed('post-discordance'));
        setDispatchCb(buildComposed('post-dispatch'));
        log.info('Wave 7E: re-anchor federation hooks composed (post-veto, post-discordance, post-dispatch)');
      }
    } else {
      log.warn('DATA_DIR not set — Federation skipped (federation endpoints will return 404)');
    }
  } catch (err64h: unknown) {
    const msg64h = err64h instanceof Error ? err64h.message : String(err64h);
    log.error({ err: msg64h }, 'Wave 7E: Federation init failed (non-fatal, federation disabled)');
  }

  // -------------------------------------------------------------------------
  // 6.4i Wave 8E: AlignmentAutoRemediator — auto-remediation on sustained RED.
  //      Instantiated here so it can be wired into alignmentAggregator
  //      (done in section 9.5 where finalAgentLoop is available) and into
  //      the HTTP admin routes. All deps are optional (fail-open).
  // -------------------------------------------------------------------------
  let alignmentAutoRemediator: AlignmentAutoRemediator | undefined;
  try {
    const dataDir6i = process.env['DATA_DIR'];
    // Build re-anchor emitter for auto-remediation trigger (fail-open if no DATA_DIR).
    let reAnchorEmitter6i: (() => void) | undefined;
    if (dataDir6i) {
      try {
        const Database6i = (await import('better-sqlite3')).default;
        const caDb6i = new Database6i(path.join(dataDir6i, 'audit.db'));
        reAnchorEmitter6i = createReAnchorEmitter('auto-remediation', caDb6i, sleepTrustTracker);
      } catch (emitterErr: unknown) {
        log.warn({ err: String(emitterErr) }, 'Wave 8E: re-anchor emitter for auto-remediation failed (non-fatal)');
      }
    }

    alignmentAutoRemediator = new AlignmentAutoRemediator(
      {
        reAnchorEmitter: reAnchorEmitter6i,
        // Cast: AlignmentAutoRemediatorDeps uses a wider 'kind: string' signature
        // while TrustTierTracker uses a narrower union. The actual call passes
        // 're-anchor' which is valid for both. Duck-type compatibility at runtime.
        trustTierTracker: sleepTrustTracker as { recordOutcome: (e: { kind: string; timestamp: number; meta?: Record<string, unknown> }) => void } | undefined,
        commitmentAuditor: commitmentAuditor as { forceAuditNow?: () => void } | undefined,
      },
      {
        redThreshold: 0.3,
        sustainedWindowMs: 600_000,   // 10 minutes
        cooldownMs: 1_800_000,         // 30 minutes
        minSamples: 3,
      },
    );
    log.info('Wave 8E: AlignmentAutoRemediator initialised');
  } catch (err6i: unknown) {
    const msg6i = err6i instanceof Error ? err6i.message : String(err6i);
    log.warn({ err: msg6i }, 'Wave 8E: AlignmentAutoRemediator init failed (non-fatal, remediation disabled)');
  }

  // -------------------------------------------------------------------------
  // 6.45 Wave 13 pre-init — SkillDiscovery + SkillOptimizationStore (fail-open)
  // These are initialised before the consciousness layer so they can be wired
  // into the SleepCycle constructor at 6.5. SkillOptimizer is created later
  // (after calibration tracker is available) and injected via setSkillOptimizer().
  // -------------------------------------------------------------------------
  let wave13SkillDiscovery: SkillDiscovery | undefined;
  let wave13SkillOptimizationStore: SkillOptimizationStore | undefined;
  /** Duck-typed ref to sleepCycle so setSkillOptimizer can be called post-Wave-13 init. */
  let wave13SleepCycleRef: { setSkillOptimizer(o: unknown): void } | undefined;
  try {
    wave13SkillDiscovery = new SkillDiscovery();
    wave13SkillOptimizationStore = new SkillOptimizationStore('data/skill-optimizations.db');
    log.info('Wave 13: SkillDiscovery + SkillOptimizationStore pre-initialised');
  } catch (err13pre: unknown) {
    log.warn(
      { err: String(err13pre) },
      'Wave 13: pre-init failed — skill optimization disabled (fail-open)',
    );
  }

  // -------------------------------------------------------------------------
  // 6.5 Consciousness Layer
  // -------------------------------------------------------------------------
  let consciousness: { getConsciousnessContext(): string; shutdown(): Promise<void> } | null = null;

  try {
    const { ConsciousnessOrchestrator } = await import('./core/consciousness/orchestrator.js');
    const { SleepCycle } = await import('./core/consciousness/sleep-cycle/index.js');
    const { SelfEvolution } = await import('./core/consciousness/self-evolution/index.js');
    const { ConsciousnessDB } = await import('./core/consciousness/consciousness-db.js');

    const consciousnessInstance = new ConsciousnessOrchestrator(brain);
    await consciousnessInstance.boot();
    registerShutdown(() => consciousnessInstance.shutdown());

    // Attach SleepCycle — requires its own ConsciousnessDB + duck-typed dependencies.
    try {
      const sleepCDB = new ConsciousnessDB();
      // Theme 4 (reflect loops): when SUDO_CONSCIOUSNESS_REFLECT=1, drive the real
      // (LLM-backed) Counterfactual + Metacognition engines from the sleep cycle's
      // idle phases — OFF the per-turn hot path. Default OFF keeps the no-op stubs
      // (zero LLM cost / no behavior change). Adapters bind the orchestrator's real
      // episodic store so reflection runs over live episodes (orchestrator DB).
      const reflectOn = process.env['SUDO_CONSCIOUSNESS_REFLECT'] === '1';
      const reflectEpisodic = consciousnessInstance.getEpisodicMemory();
      const sleepCycle = new SleepCycle({
        cdb: sleepCDB,
        brain,
        episodicMemory: {
          getBySignificance: () => [],
          strengthenEpisode: () => undefined,
          weakenEpisode: () => undefined,
        },
        counterfactualEngine: reflectOn
          ? { runIdleBatch: (count: number) => consciousnessInstance.getCounterfactualEngine().runIdleBatch(reflectEpisodic, count) }
          : { runIdleBatch: async () => [] },
        selfModel: { updateFromEpisode: () => undefined },
        temporalSelf: { takeSnapshot: () => undefined },
        metacognition: reflectOn
          ? { runBatchReflection: (count: number) => consciousnessInstance.getMetacognitionEngine().runBatchReflection(reflectEpisodic, count) }
          : { runBatchReflection: async () => [] },
        wisdomStore: { storeInsight: () => undefined },
        commitmentAuditor,
        trustTracker: sleepTrustTracker,
        mistakePatternRecognizer,
        crossSignalDiagnostics,
        reanchorMonitor,
        skillDiscovery: wave13SkillDiscovery,
      });
      // Capture ref for Wave 13 setter injection (post-calibration-tracker init).
      wave13SleepCycleRef = sleepCycle;
      consciousnessInstance.attachSleepCycle(sleepCycle);
      // Wave 8D: wire federation peer-audit into sleep cycle (section 6.4h.2).
      if (federationDeps?.auditChainSync) sleepCycle.setAuditChainSync(federationDeps.auditChainSync);
    } catch (err) {
      log.warn({ err: String(err) }, 'SleepCycle attach failed — running without sleep');
    }

    // Attach SelfEvolution — requires brain, a ConsciousnessDB, and a minimal selfModel stub.
    try {
      const evoCDB = new ConsciousnessDB();
      const selfEvolution = new SelfEvolution(
        brain,
        evoCDB,
        { getWeaknesses: () => [], getStrengths: () => [] },
      );
      consciousnessInstance.attachSelfEvolution(selfEvolution);
    } catch (err) {
      log.warn({ err: String(err) }, 'SelfEvolution attach failed — running without self-evolution');
    }

    consciousness = consciousnessInstance;
    log.info('Consciousness layer booted');

    // Wire ZDR mode into consciousness orchestrator if active.
    try {
      const { getZDRManager } = await import('./core/privacy/zdr-mode.js');
      const zdrManager = getZDRManager();
      if (zdrManager.isEnabled()) {
        consciousnessInstance.setZDRMode(true);
        log.info('ZDR mode wired into consciousness — episodic recording disabled');
      }
    } catch (err) {
      log.warn({ err: String(err) }, 'ZDR consciousness wiring failed — continuing');
    }
  } catch (err) {
    log.warn({ err: String(err) }, 'Consciousness layer failed to boot — running without consciousness');
  }

  // Rebuild agentLoop with consciousness and security if available.
  const finalAgentLoop = consciousness
    ? new AgentLoop(brain, registry, dualSessionManager, { maxIterations: config.agents.maxIterations }, consciousness, security ?? undefined, workspaceInjector, hooks, sandboxManager)
    : agentLoop;

  // Wire ConfidenceCalibrationTracker into the resolved agent loop (Wave 6L).
  if (confidenceCalibrationTracker) {
    try {
      finalAgentLoop.setConfidenceCalibrationTracker(confidenceCalibrationTracker);
      // Wave 6Q: also inject into AlignmentAggregator's 8th signal (Brier-drift) — fail-open.
      (finalAgentLoop.getAlignmentAggregator() as unknown as Record<string, unknown>)['confidenceCalibrationTracker'] = confidenceCalibrationTracker;
    } catch (err: unknown) {
      log.warn({ err: String(err) }, 'ConfidenceCalibrationTracker wiring failed — calibration hooks disabled');
    }
  }

  // Wire InjectionDetector into the resolved agent loop (Wave 6O).
  try {
    finalAgentLoop.setInjectionDetector(injectionDetector);
  } catch (err: unknown) {
    log.warn({ err: String(err) }, 'InjectionDetector wiring failed — injection scan hooks disabled');
  }

  // Wave 10B: wire SkillDiscovery into agent loop (fail-open)
  if (wave13SkillDiscovery) {
    try {
      finalAgentLoop.setSkillDiscovery(wave13SkillDiscovery);
    } catch (err: unknown) {
      log.warn({ err: String(err) }, 'Wave 10B: SkillDiscovery wiring failed — learning feed disabled');
    }
  }

  // Wave 10E: wire TaintTracker into agent loop (fail-open, kill-switch: SUDO_TAINT_DISABLE=1).
  if (process.env['SUDO_TAINT_DISABLE'] !== '1') {
    try {
      finalAgentLoop.setTaintTracker(taintTracker);
    } catch (err: unknown) {
      log.warn({ err: String(err) }, 'TaintTracker wiring into loop failed — taint violation checks disabled');
    }
  }

  // Theme 1 (learning flywheel, slice 1): wire TraceStore so the agent loop
  // records execution traces (routing / brain / tool outcomes) into a local
  // SQLite DB — the foundation the policy learner + skill-forge build on later.
  // RECORDING-ONLY (no routing influence yet). Opt-in via SUDO_TRACE_LEARNING=1
  // (default OFF → zero change); never persists under ZDR; fully fail-open.
  if (process.env['SUDO_TRACE_LEARNING'] === '1') {
    // Whole block is fail-open (incl. the dynamic ZDR import) so this feature can
    // never crash boot. ZDR was already resolved during finalAgentLoop construction.
    try {
      const traceDataDir = process.env['DATA_DIR'];
      const { isZDRBlocked } = await import('./core/privacy/zdr-mode.js');
      if (isZDRBlocked('trace_upload')) {
        log.info('Learning flywheel: ZDR active — trace recording disabled');
      } else if (!traceDataDir) {
        log.warn('Learning flywheel: DATA_DIR not set — trace recording skipped');
      } else {
        const traceStore = new TraceStore(path.join(traceDataDir, 'traces.db'));
        await traceStore.init();
        finalAgentLoop.setTraceStore(traceStore);
        registerShutdown(() => traceStore.close());
        log.info({ db: path.join(traceDataDir, 'traces.db') }, 'Learning flywheel: TraceStore wired — recording execution traces');

        // Theme 1 slice 2: TraceDrivenPolicy — learned ROUTING INFLUENCE.
        // Strictly opt-in BEYOND recording (SUDO_TRACE_POLICY=1) and honoring the
        // module kill-switch (SUDO_POLICY_DISABLE=1). Conservative by construction
        // (rules need >=5 calls and confidence >= 0.3), fail-open, and a no-op until
        // enough trace history accumulates. Rules are built once at boot here;
        // refreshPolicies() does SYNCHRONOUS SQLite aggregation, so it is NOT run on
        // a recurring event-loop timer (async/worker periodic refresh is a follow-up).
        if (process.env['SUDO_TRACE_POLICY'] === '1' && process.env['SUDO_POLICY_DISABLE'] !== '1') {
          const traceAnalyzer = new TraceAnalyzer(traceStore);
          const tracePolicy = new TraceDrivenPolicy(traceStore, traceAnalyzer);
          tracePolicy.refreshPolicies();
          finalAgentLoop.setTraceDrivenPolicy(tracePolicy);
          log.info('Learning flywheel: TraceDrivenPolicy wired — learned routing influence active (conservative; SUDO_POLICY_DISABLE=1 to disable)');
        }
      }
    } catch (err: unknown) {
      log.warn({ err: String(err) }, 'Learning flywheel: trace recording setup failed — continuing without it');
    }
  }

  // -------------------------------------------------------------------------
  // 7. Telegram channel adapter
  // -------------------------------------------------------------------------

  // Hoisted so web handler can send Telegram notifications when long tasks finish.
  let telegramNotifier: TelegramAdapter | null = null;

  // Hoisted so the channelRouter in section 9.6 can dispatch to active adapters.
  let discordAdapter: import('./core/channels/discord.js').DiscordAdapter | null = null;
  let slackAdapter: import('./core/channels/slack.js').SlackAdapter | null = null;
  let whatsAppAdapter: import('./core/channels/whatsapp.js').WhatsAppAdapter | null = null;
  let emailAdapter: import('./core/channels/email.js').EmailAdapter | null = null;
  let smsAdapter: import('./core/channels/sms.js').SmsAdapter | null = null;

  if (config.channels.telegram.enabled && process.env['SUDO_TELEGRAM_DISABLE'] !== '1') {
    const tgAllowed = (process.env['TELEGRAM_CHAT_ID'] ?? '')
      .split(',').map(s => s.trim()).filter(Boolean);
    const telegram = new TelegramAdapter(
      'TELEGRAM_BOT_TOKEN',  // env key name, not the token value
      tgAllowed.length > 0 ? tgAllowed : config.channels.telegram.allowedUsers,
    );
    telegram.setHookEmitter(hooks);
    telegramNotifier = telegram;

    telegram.onMessage(async (msg) => {
      log.info(
        { channel: msg.channel, peerId: msg.peerId, text: msg.text?.slice(0, 80) },
        'Incoming message',
      );

      // Serialized per-peer: enqueue so concurrent messages from the same user
      // never overlap on the same session (prevents race conditions).
      dualSessionManager.peerQueue.enqueue(msg.peerId, async () => {
        try {
          const session = await dualSessionManager.getOrCreate(msg.channel, msg.peerId);
          log.info({ sessionId: String(session.id) }, 'Session resolved');

          // Surface consciousness context for logging/debugging; the loop reads it via onInteractionStart.
          if (consciousness) {
            try {
              const consciousnessCtx = consciousness.getConsciousnessContext();
              log.debug({ ctxLen: consciousnessCtx.length }, 'Consciousness context available for turn');
            } catch (ctxErr) {
              log.warn({ err: String(ctxErr) }, 'Could not retrieve consciousness context — continuing');
            }
          }

          const result = await finalAgentLoop.run(String(session.id), msg.text ?? '', undefined, { race: true });
          const replyText = result?.text ?? 'No response generated.';
          const attachments = result?.attachments ?? [];

          // Save turn to daily memory log
          try {
            const turnSummary = `**User:** ${(msg.text ?? '').slice(0, 200)}\n**Agent:** ${replyText.slice(0, 500)}`;
            await dailyLog.append(turnSummary);
          } catch { /* daily log write is non-fatal */ }

          // Append user + assistant message events to JSONL journal in real-time
          try {
            const nowTs = new Date().toISOString();
            await dualSessionManager.appendEvent(String(session.id), {
              ts: nowTs,
              sessionId: String(session.id),
              type: 'message',
              role: 'user',
              content: msg.text ?? '',
            });
            await dualSessionManager.appendEvent(String(session.id), {
              ts: nowTs,
              sessionId: String(session.id),
              type: 'message',
              role: 'assistant',
              content: replyText,
            });
          } catch { /* journal append is non-fatal */ }

          log.info(
            { replyLen: replyText.length, preview: replyText.substring(0, 100), attachmentCount: attachments.length },
            'Agent reply ready',
          );

          // Send file attachments before the text reply (images, screenshots, etc.)
          if (attachments.length > 0) {
            const { readFileSync, existsSync } = await import('node:fs');
            for (const att of attachments) {
              try {
                if (!existsSync(att.path)) {
                  log.warn({ path: att.path }, 'Attachment file not found on disk — skipping');
                  continue;
                }
                const buffer = readFileSync(att.path);
                await telegram.sendMedia(msg.peerId, {
                  type: att.type,
                  mimeType: att.type === 'image' ? 'image/png'
                    : att.type === 'video' ? 'video/mp4'
                    : att.type === 'audio' ? 'audio/ogg'
                    : 'application/octet-stream',
                  buffer,
                  filename: att.filename ?? att.path.split('/').pop() ?? 'file',
                });
                log.info({ peerId: msg.peerId, path: att.path, type: att.type }, 'Attachment sent to Telegram');
              } catch (attErr) {
                log.warn({ err: String(attErr), path: att.path }, 'Failed to send attachment — continuing');
              }
            }
          }

          // Send reply + feedback keyboard (skip for greetings/very short replies)
          const isSubstantialReply = (replyText.length > 80);
          if (isSubstantialReply) {
            const { keyboard } = createFeedbackKeyboard(
              String(session.id),
              (msg.text ?? replyText).slice(0, 120),
              'telegram',
            );
            await telegram.sendWithKeyboard(msg.peerId, replyText, keyboard);
          } else {
            await telegram.send(msg.peerId, replyText);
          }
          log.info({ peerId: msg.peerId }, 'Reply sent to Telegram');
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          log.error({ err: errMsg, peerId: msg.peerId }, 'Agent turn failed');
          // Send decline feedback option
          try {
            const { keyboard } = createFeedbackKeyboard(
              'error',
              `DECLINED: ${(msg.text ?? '').slice(0, 100)}`,
              'telegram',
            );
            await telegram.sendWithKeyboard(
              msg.peerId,
              `⚠️ Error: ${errMsg.substring(0, 200)}`,
              keyboard,
            );
          } catch { try { await telegram.send(msg.peerId, `Error: ${errMsg.substring(0, 200)}`); } catch {} }
        }
      }).catch((err: unknown) => {
        log.error({ err: String(err), peerId: msg.peerId }, 'Queued agent turn failed');
      });
    });

    // Register built-in slash commands
    try {
      const { registerBuiltinCommands } = await import('./core/commands/builtin.js');
      registerBuiltinCommands(commandRegistry, {
        toolRegistry: registry,
        sessionManager: dualSessionManager as unknown as SessionManager,
        costTracker,
        consciousness: consciousness ?? undefined,
      });
      log.info('Built-in slash commands registered');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err: msg }, 'Built-in command registration failed — continuing without slash commands');
    }

    // Wire CommandRegistry to the Telegram adapter
    telegram.setCommandRegistry(commandRegistry, async (msg) => {
      try {
        const session = await dualSessionManager.getOrCreate(msg.channel, msg.peerId);
        return {
          channel: msg.channel,
          peerId: msg.peerId,
          sessionId: session.id,
          agentLoop: finalAgentLoop,
          toolRegistry: registry,
          config,
          db,
        };
      } catch (err) {
        log.error({ peerId: msg.peerId, err: String(err) }, 'CommandContext factory failed');
        return null;
      }
    });
    log.info('CommandRegistry wired to Telegram adapter');

    await telegram.start();
    registerShutdown(() => telegram.stop());
    log.info('TelegramAdapter started');
  } else {
    log.info('Telegram channel disabled in config — skipping');
  }

  // -------------------------------------------------------------------------
  // 7.1 Discord channel adapter (conditional)
  // -------------------------------------------------------------------------
  if (process.env['DISCORD_TOKEN']) {
    try {
      const { DiscordAdapter } = await import('./core/channels/discord.js');

      const discordAllowedChannels = (process.env['DISCORD_ALLOWED_CHANNELS'] ?? '')
        .split(',').map((s) => s.trim()).filter(Boolean);

      const discord = new DiscordAdapter('DISCORD_TOKEN', discordAllowedChannels);
      discord.setHookEmitter(hooks);
      discordAdapter = discord;

      discord.onMessage(async (msg) => {
        log.info(
          { channel: msg.channel, peerId: msg.peerId, text: msg.text?.slice(0, 80) },
          'Discord incoming message',
        );

        dualSessionManager.peerQueue.enqueue(msg.peerId, async () => {
          try {
            const session = await dualSessionManager.getOrCreate(msg.channel, msg.peerId);
            log.info({ sessionId: String(session.id) }, 'Discord session resolved');

            const result = await finalAgentLoop.run(String(session.id), msg.text ?? '', undefined, { race: true });
            const replyText = result?.text ?? 'No response generated.';

            try {
              const turnSummary = `**User (discord):** ${(msg.text ?? '').slice(0, 200)}\n**Agent:** ${replyText.slice(0, 500)}`;
              await dailyLog.append(turnSummary);
            } catch { /* daily log write is non-fatal */ }

            try {
              const nowTs = new Date().toISOString();
              await dualSessionManager.appendEvent(String(session.id), {
                ts: nowTs,
                sessionId: String(session.id),
                type: 'message',
                role: 'user',
                content: msg.text ?? '',
              });
              await dualSessionManager.appendEvent(String(session.id), {
                ts: nowTs,
                sessionId: String(session.id),
                type: 'message',
                role: 'assistant',
                content: replyText,
              });
            } catch { /* journal append is non-fatal */ }

            await discord.send(msg.peerId, replyText);
            log.info({ peerId: msg.peerId }, 'Reply sent to Discord');
          } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            log.error({ err: errMsg, peerId: msg.peerId }, 'Discord agent turn failed');
            try { await discord.send(msg.peerId, 'Something went wrong. Please try again.'); } catch {}
          }
        }).catch((err: unknown) => {
          log.error({ err: String(err), peerId: msg.peerId }, 'Queued Discord agent turn failed');
        });
      });

      await discord.start();
      registerShutdown(() => discord.stop());
      log.info('Discord channel active');
    } catch (err) {
      log.warn({ err: String(err) }, 'Discord adapter failed to start (non-fatal)');
    }
  } else {
    log.info('Discord channel disabled (set DISCORD_TOKEN in .env to enable)');
  }

  // -------------------------------------------------------------------------
  // 7.2 Slack channel adapter (conditional)
  // -------------------------------------------------------------------------
  if (process.env['SLACK_BOT_TOKEN']) {
    try {
      const { SlackAdapter } = await import('./core/channels/slack.js');

      // SlackAdapter reads SLACK_BOT_TOKEN and SLACK_APP_TOKEN from env internally.
      const slack = new SlackAdapter();
      slackAdapter = slack;

      slack.onMessage(async (msg) => {
        log.info(
          { channel: msg.channel, peerId: msg.peerId, text: msg.text?.slice(0, 80) },
          'Slack incoming message',
        );

        dualSessionManager.peerQueue.enqueue(msg.peerId, async () => {
          try {
            const session = await dualSessionManager.getOrCreate(msg.channel, msg.peerId);
            log.info({ sessionId: String(session.id) }, 'Slack session resolved');

            const result = await finalAgentLoop.run(String(session.id), msg.text ?? '', undefined, { race: true });
            const replyText = result?.text ?? 'No response generated.';

            try {
              const turnSummary = `**User (slack):** ${(msg.text ?? '').slice(0, 200)}\n**Agent:** ${replyText.slice(0, 500)}`;
              await dailyLog.append(turnSummary);
            } catch { /* daily log write is non-fatal */ }

            try {
              const nowTs = new Date().toISOString();
              await dualSessionManager.appendEvent(String(session.id), {
                ts: nowTs,
                sessionId: String(session.id),
                type: 'message',
                role: 'user',
                content: msg.text ?? '',
              });
              await dualSessionManager.appendEvent(String(session.id), {
                ts: nowTs,
                sessionId: String(session.id),
                type: 'message',
                role: 'assistant',
                content: replyText,
              });
            } catch { /* journal append is non-fatal */ }

            await slack.send(msg.peerId, replyText);
            log.info({ peerId: msg.peerId }, 'Reply sent to Slack');
          } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            log.error({ err: errMsg, peerId: msg.peerId }, 'Slack agent turn failed');
            try { await slack.send(msg.peerId, 'Something went wrong. Please try again.'); } catch {}
          }
        }).catch((err: unknown) => {
          log.error({ err: String(err), peerId: msg.peerId }, 'Queued Slack agent turn failed');
        });
      });

      await slack.start();
      registerShutdown(() => slack.stop());
      log.info('Slack channel active');
    } catch (err) {
      log.warn({ err: String(err) }, 'Slack adapter failed to start (non-fatal)');
    }
  } else {
    log.info('Slack channel disabled (set SLACK_BOT_TOKEN in .env to enable)');
  }

  // -------------------------------------------------------------------------
  // 7.3 WhatsApp channel adapter (conditional)
  //     WHATSAPP_TOKEN is an activation flag only; the adapter uses Baileys
  //     file-based auth stored in data/whatsapp-auth/ — no token is consumed.
  // -------------------------------------------------------------------------
  if (process.env['WHATSAPP_TOKEN']) {
    try {
      const { WhatsAppAdapter } = await import('./core/channels/whatsapp.js');

      const whatsAppAllowedJids = (process.env['WHATSAPP_ALLOWED_JIDS'] ?? '')
        .split(',').map((s) => s.trim()).filter(Boolean);

      const whatsapp = new WhatsAppAdapter(undefined, whatsAppAllowedJids);
      whatsapp.setHookEmitter(hooks);
      whatsAppAdapter = whatsapp;

      whatsapp.onMessage(async (msg) => {
        log.info(
          { channel: msg.channel, peerId: msg.peerId, text: msg.text?.slice(0, 80) },
          'WhatsApp incoming message',
        );

        dualSessionManager.peerQueue.enqueue(msg.peerId, async () => {
          try {
            const session = await dualSessionManager.getOrCreate(msg.channel, msg.peerId);
            log.info({ sessionId: String(session.id) }, 'WhatsApp session resolved');

            const result = await finalAgentLoop.run(String(session.id), msg.text ?? '', undefined, { race: true });
            const replyText = result?.text ?? 'No response generated.';

            try {
              const turnSummary = `**User (whatsapp):** ${(msg.text ?? '').slice(0, 200)}\n**Agent:** ${replyText.slice(0, 500)}`;
              await dailyLog.append(turnSummary);
            } catch { /* daily log write is non-fatal */ }

            try {
              const nowTs = new Date().toISOString();
              await dualSessionManager.appendEvent(String(session.id), {
                ts: nowTs,
                sessionId: String(session.id),
                type: 'message',
                role: 'user',
                content: msg.text ?? '',
              });
              await dualSessionManager.appendEvent(String(session.id), {
                ts: nowTs,
                sessionId: String(session.id),
                type: 'message',
                role: 'assistant',
                content: replyText,
              });
            } catch { /* journal append is non-fatal */ }

            await whatsapp.send(msg.peerId, replyText);
            log.info({ peerId: msg.peerId }, 'Reply sent to WhatsApp');
          } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            log.error({ err: errMsg, peerId: msg.peerId }, 'WhatsApp agent turn failed');
            try { await whatsapp.send(msg.peerId, 'Something went wrong. Please try again.'); } catch {}
          }
        }).catch((err: unknown) => {
          log.error({ err: String(err), peerId: msg.peerId }, 'Queued WhatsApp agent turn failed');
        });
      });

      await whatsapp.start();
      registerShutdown(() => whatsapp.stop());
      log.info('WhatsApp channel active');
    } catch (err) {
      log.warn({ err: String(err) }, 'WhatsApp adapter failed to start (non-fatal)');
    }
  } else {
    log.info('WhatsApp channel disabled (set WHATSAPP_TOKEN in .env to enable)');
  }

  // -------------------------------------------------------------------------
  // 7.5 Web chat adapter (HTTP + WebSocket) — disabled by default
  //     Enable with: WEB_CHAT_ENABLED=true in config/.env
  // -------------------------------------------------------------------------
  if (process.env['WEB_CHAT_ENABLED'] === 'true') try {
    const { WebAdapter } = await import('./core/channels/web.js');
    const web = new WebAdapter();

    web.onMessage(async (msg) => {
      log.info(
        { channel: msg.channel, peerId: msg.peerId, text: msg.text?.slice(0, 80) },
        'Web incoming message',
      );

      // Serialized per-peer: enqueue so concurrent messages from the same user
      // never overlap on the same session (prevents race conditions).
      dualSessionManager.peerQueue.enqueue(msg.peerId, async () => {
        // taskStartMs measured at execution time (excludes queue wait).
        const taskStartMs = Date.now();
        try {
          const session = await dualSessionManager.getOrCreate(msg.channel, msg.peerId);
          const webResult = await finalAgentLoop.run(String(session.id), msg.text ?? '', undefined, { race: true });
          const webReplyText = webResult?.text ?? 'No response generated.';
          log.info({ replyLen: webReplyText.length }, 'Web agent reply ready');

          // Save web turn to daily memory log
          try {
            const webTurnSummary = `**User (web):** ${(msg.text ?? '').slice(0, 200)}\n**Agent:** ${webReplyText.slice(0, 500)}`;
            await dailyLog.append(webTurnSummary);
          } catch { /* daily log write is non-fatal */ }

          await web.send(msg.peerId, webReplyText);
          log.info({ peerId: msg.peerId }, 'Reply sent to Web');

          // For long tasks (>60s), also notify via Telegram so the owner always knows
          // even if the web tab was closed or WebSocket dropped during the build.
          const durationMs = Date.now() - taskStartMs;
          if (durationMs > 60_000 && telegramNotifier) {
            const tgChatId = (process.env['TELEGRAM_CHAT_ID'] ?? '').split(',')[0]?.trim();
            if (tgChatId) {
              const mins = Math.round(durationMs / 60_000);
              const preview = webReplyText.slice(0, 300);
              try {
                await telegramNotifier.send(tgChatId, `✅ Web task done (${mins}m):\n\n${preview}${preview.length < webReplyText.length ? '…' : ''}`);
              } catch { /* telegram send failure is non-fatal */ }
            }
          }
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          log.error({ err: errMsg, peerId: msg.peerId }, 'Web agent turn failed');
          try { await web.send(msg.peerId, `Error: ${errMsg.substring(0, 200)}`); } catch {}
          // Also notify Telegram on long-running task failure
          const durationMs = Date.now() - taskStartMs;
          if (durationMs > 60_000 && telegramNotifier) {
            const tgChatId = (process.env['TELEGRAM_CHAT_ID'] ?? '').split(',')[0]?.trim();
            if (tgChatId) {
              try { await telegramNotifier.send(tgChatId, `❌ Web task failed after ${Math.round(durationMs / 60_000)}m:\n${errMsg.slice(0, 200)}`); } catch { /* non-fatal */ }
            }
          }
        }
      }).catch((err: unknown) => {
        log.error({ err: String(err), peerId: msg.peerId }, 'Queued web agent turn failed');
      });
    });

    // Attach to gateway server (no new port opened)
    if (!gatewayServer) throw new Error('gatewayServer not ready — cannot attach WebAdapter');
    web.attach(gatewayServer);
    registerShutdown(() => web.stop());
    log.info({ gateway: '18900', chatPath: '/chat', wsPath: '/chat/ws' }, 'WebAdapter attached to gateway');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ err: msg }, 'Web adapter failed to start — running without web chat');
  } else {
    log.info('Web chat disabled (set WEB_CHAT_ENABLED=true in .env to enable)');
  }

  // -------------------------------------------------------------------------
  // 7.6 Email channel adapter (conditional)
  // -------------------------------------------------------------------------
  if (process.env['EMAIL_IMAP_USER']) {
    try {
      const { EmailAdapter } = await import('./core/channels/email.js');
      const email = new EmailAdapter();
      email.setHookEmitter(hooks);
      emailAdapter = email;

      email.onMessage(async (msg) => {
        log.info(
          { channel: msg.channel, peerId: msg.peerId, text: msg.text?.slice(0, 80) },
          'Email incoming message',
        );

        dualSessionManager.peerQueue.enqueue(msg.peerId, async () => {
          try {
            const session = await dualSessionManager.getOrCreate(msg.channel, msg.peerId);
            log.info({ sessionId: String(session.id) }, 'Email session resolved');

            const result = await finalAgentLoop.run(String(session.id), msg.text ?? '', undefined, { race: true });
            const replyText = result?.text ?? 'No response generated.';

            try {
              const turnSummary = `**User (email):** ${(msg.text ?? '').slice(0, 200)}\n**Agent:** ${replyText.slice(0, 500)}`;
              await dailyLog.append(turnSummary);
            } catch { /* daily log write is non-fatal */ }

            try {
              const nowTs = new Date().toISOString();
              await dualSessionManager.appendEvent(String(session.id), {
                ts: nowTs,
                sessionId: String(session.id),
                type: 'message',
                role: 'user',
                content: msg.text ?? '',
              });
              await dualSessionManager.appendEvent(String(session.id), {
                ts: nowTs,
                sessionId: String(session.id),
                type: 'message',
                role: 'assistant',
                content: replyText,
              });
            } catch { /* journal append is non-fatal */ }

            await email.send(msg.peerId, replyText);
            log.info({ peerId: msg.peerId }, 'Reply sent via Email');
          } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            log.error({ err: errMsg, peerId: msg.peerId }, 'Email agent turn failed');
            try { await email.send(msg.peerId, 'Something went wrong. Please try again.'); } catch {}
          }
        }).catch((err: unknown) => {
          log.error({ err: String(err), peerId: msg.peerId }, 'Queued Email agent turn failed');
        });
      });

      await email.start();
      registerShutdown(() => email.stop());
      log.info('Email channel active');
    } catch (err) {
      log.warn({ err: String(err) }, 'Email adapter failed to start (non-fatal)');
    }
  } else {
    log.info('Email channel disabled (set EMAIL_IMAP_USER in .env to enable)');
  }

  // -------------------------------------------------------------------------
  // 7.7 SMS channel adapter (conditional)
  // -------------------------------------------------------------------------
  if (process.env['TWILIO_ACCOUNT_SID']) {
    try {
      const { SmsAdapter } = await import('./core/channels/sms.js');
      const sms = new SmsAdapter();
      sms.setHookEmitter(hooks);
      smsAdapter = sms;

      sms.onMessage(async (msg) => {
        log.info(
          { channel: msg.channel, peerId: msg.peerId, text: msg.text?.slice(0, 80) },
          'SMS incoming message',
        );

        dualSessionManager.peerQueue.enqueue(msg.peerId, async () => {
          try {
            const session = await dualSessionManager.getOrCreate(msg.channel, msg.peerId);
            log.info({ sessionId: String(session.id) }, 'SMS session resolved');

            const result = await finalAgentLoop.run(String(session.id), msg.text ?? '', undefined, { race: true });
            const replyText = result?.text ?? 'No response generated.';

            try {
              const turnSummary = `**User (sms):** ${(msg.text ?? '').slice(0, 200)}\n**Agent:** ${replyText.slice(0, 500)}`;
              await dailyLog.append(turnSummary);
            } catch { /* daily log write is non-fatal */ }

            try {
              const nowTs = new Date().toISOString();
              await dualSessionManager.appendEvent(String(session.id), {
                ts: nowTs,
                sessionId: String(session.id),
                type: 'message',
                role: 'user',
                content: msg.text ?? '',
              });
              await dualSessionManager.appendEvent(String(session.id), {
                ts: nowTs,
                sessionId: String(session.id),
                type: 'message',
                role: 'assistant',
                content: replyText,
              });
            } catch { /* journal append is non-fatal */ }

            await sms.send(msg.peerId, replyText);
            log.info({ peerId: msg.peerId }, 'Reply sent via SMS');
          } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            log.error({ err: errMsg, peerId: msg.peerId }, 'SMS agent turn failed');
          }
        }).catch((err: unknown) => {
          log.error({ err: String(err), peerId: msg.peerId }, 'Queued SMS agent turn failed');
        });
      });

      await sms.start();
      registerShutdown(() => sms.stop());
      log.info('SMS channel active');
    } catch (err) {
      log.warn({ err: String(err) }, 'SMS adapter failed to start (non-fatal)');
    }
  } else {
    log.info('SMS channel disabled (set TWILIO_ACCOUNT_SID in .env to enable)');
  }

  // -------------------------------------------------------------------------
  // 8.5 OpenAI-compatible API — merged into port 3001 (no separate server)
  // Register brain + models into shared singleton so WebAdapter's /v1/ handler
  // can serve OpenAI-compatible requests on the same port.
  // -------------------------------------------------------------------------
  try {
    const { setSharedBrain } = await import('./core/api/http-server.js');
    const availableModels: string[] = [
      ...config.models.primary.map((m) => m.id),
      config.models.fallback.id,
    ].filter((id, idx, arr) => id && arr.indexOf(id) === idx);
    setSharedBrain(brain, availableModels);
    log.info({ models: availableModels.length }, 'OpenAI-compatible API mounted on port 3001 (/v1/*)');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ err: msg }, 'Failed to register shared brain for /v1/ routes');
  }

  // -------------------------------------------------------------------------
  // 8. CronScheduler + HeartbeatRunner
  // -------------------------------------------------------------------------

  // Hoisted so the cronRunner closure can call autoDream.runDream() when the
  // dream cron job fires. Section 9 assigns the real instance.
  let autoDream: AutoDream | null = null;

  // Hoisted so the cronRunner closure can dispatch self-build sentinel messages.
  // Assigned after section 8.5 once finalAgentLoop is available.
  let selfBuildDepsRef: import('./core/self-build/orchestrator.js').SelfBuildDeps | null = null;

  /**
   * Payload runner: executes a cron job payload as an isolated agent turn.
   * Creates or reuses a dedicated session for the cron job.
   *
   * Supports both payload kinds:
   *  - agentTurn    -> feeds the message into the agent.
   *  - systemEvent  -> dispatches internal events (e.g. dream:run).
   */
  const cronRunner = async (payload: CronPayload, job: CronJob): Promise<void> => {
    log.info({ jobId: job.id, jobName: job.name, payloadKind: payload.kind }, 'Cron job firing');

    if (payload.kind === 'systemEvent') {
      if (payload.event === 'dream:run') {
        if (autoDream) {
          try {
            await autoDream.runDream();
            log.info({ jobId: job.id }, 'AutoDream consolidation completed');
          } catch (dreamErr) {
            log.warn({ err: String(dreamErr) }, 'AutoDream consolidation failed');
          }
        } else {
          log.warn({ jobId: job.id }, 'AutoDream not initialized — skipping dream:run');
        }
      } else {
        log.info({ event: payload.event, jobId: job.id }, 'System event dispatched');
      }
      return;
    }

    // payload.kind === 'agentTurn'

    // Self-build sentinel dispatch — intercept before generic agent-turn path.
    if (job.name === 'system.self-build' || job.name === 'system.self-build-report') {
      if (!selfBuildDepsRef) {
        log.warn({ jobId: job.id, jobName: job.name }, 'self-build cron fired but deps not wired — skipping');
        return;
      }
      try {
        const { handleSelfBuildTick, handleDailyReport, SELF_BUILD_TICK_MSG } = await import('./core/self-build/cron-entry.js');
        const msg = (payload as { message?: string }).message;
        if (msg === SELF_BUILD_TICK_MSG) {
          const result = await handleSelfBuildTick(selfBuildDepsRef);
          log.info({ jobId: job.id, selfBuildResult: result }, 'self-build tick dispatched');
        } else {
          const result = await handleDailyReport(selfBuildDepsRef);
          log.info({ jobId: job.id, dailyReportResult: result }, 'self-build daily report dispatched');
        }
      } catch (sbErr: unknown) {
        log.error({ jobId: job.id, err: String(sbErr) }, 'self-build cron dispatch failed');
      }
      return;
    }

    // Gate heartbeat jobs with quiet hours before spinning up an agent turn.
    if (job.name === 'system.heartbeat') {
      const { isWithinActiveHours, parseHour } = await import('./core/cron/heartbeat-hours.js');
      const tz = process.env['HEARTBEAT_TIMEZONE'] ?? 'UTC';
      const start = parseHour(process.env['HEARTBEAT_ACTIVE_START']);
      const end = parseHour(process.env['HEARTBEAT_ACTIVE_END']);
      if (!isWithinActiveHours(new Date(), tz, start, end)) {
        log.debug({ jobId: job.id }, 'Heartbeat skipped — outside active hours');
        return;
      }
    }

    const sessionTarget = job.sessionTarget === 'isolated' ? `cron:isolated:${job.id}` : `cron:main`;
    const channel = 'web' as const;
    const session = await dualSessionManager.getOrCreate(channel, sessionTarget);
    const cronResult = await finalAgentLoop.run(session.id, payload.message);

    // Save cron-triggered agent turn to daily memory log
    try {
      const cronTurnSummary = `**Cron (${job.name}):** ${payload.message.slice(0, 200)}\n**Agent:** ${(cronResult?.text ?? '').slice(0, 500)}`;
      await dailyLog.append(cronTurnSummary);
    } catch { /* daily log write is non-fatal */ }

    log.info({ jobId: job.id }, 'Cron job agent turn completed');
  };

  // -------------------------------------------------------------------------
  // 7.9 DB file permission hardening — chmod 0600 on all SQLite DB files (LOW-2).
  // Runs after all DBs are initialised, before cron starts any agent activity.
  // -------------------------------------------------------------------------
  try {
    const dbDir = path.resolve('data');
    const { readdirSync, chmodSync } = await import('node:fs');
    for (const file of readdirSync(dbDir)) {
      if (file.endsWith('.db') || file.endsWith('.db-wal') || file.endsWith('.db-shm')) {
        try { chmodSync(path.join(dbDir, file), 0o600); } catch {}
      }
    }
    log.info({ dbDir }, 'DB files chmod 0600 sweep complete');
  } catch (err) {
    log.warn({ err: String(err) }, 'DB chmod 0600 sweep failed');
  }

  const cronStore = new CronStore();
  const cronScheduler = new CronScheduler(cronStore, cronRunner);
  cronScheduler.start();
  registerShutdown(async () => cronScheduler.stop());
  log.info('CronScheduler started');

  const heartbeat = new HeartbeatRunner(cronStore, cronScheduler);
  heartbeat.start();
  registerShutdown(() => heartbeat.stop());
  log.info('HeartbeatRunner started');

  // Wire proactive-notifier to channel adapters
  proactiveNotifier.onNotification(async (n) => {
    const isHighCrit = n.priority === 'high' || n.priority === 'critical';
    const tgText = `[${n.priority.toUpperCase()}] ${n.title}\n${n.message.slice(0, 400)}`;

    // HIGH/CRITICAL → WhatsApp + Telegram
    if (isHighCrit && whatsAppAdapter?.isConnected) {
      const waJid = (process.env['WHATSAPP_ALLOWED_JIDS'] ?? '').split(',')[0]?.trim();
      if (waJid) {
        try { await whatsAppAdapter.send(waJid, tgText); }
        catch (err) { log.warn({ err: String(err) }, 'proactive-notifier: WhatsApp send failed'); }
      }
    }

    // LOW/MEDIUM/HIGH/CRITICAL → Telegram (LOW gated by env)
    const sendToTg = n.priority !== 'low' || process.env['NOTIFY_LOW_PRIORITY'] === '1';
    if (sendToTg && telegramNotifier?.isConnected) {
      const tgChatId = (process.env['TELEGRAM_CHAT_ID'] ?? '').split(',')[0]?.trim();
      if (tgChatId) {
        try { await telegramNotifier.send(tgChatId, tgText); }
        catch (err) { log.warn({ err: String(err) }, 'proactive-notifier: Telegram send failed'); }
      }
    }
  });

  // Schedule AutoDream memory consolidation every 6 hours
  try {
    const dreamJobId = 'auto-dream-consolidation';
    const existingDream = cronStore.get(dreamJobId);
    if (!existingDream) {
      cronStore.upsert({
        id: dreamJobId,
        name: 'Memory Consolidation (AutoDream)',
        enabled: true,
        schedule: { kind: 'every', ms: 6 * 60 * 60 * 1000 },
        payload: { kind: 'systemEvent', event: 'dream:run' },
        sessionTarget: 'isolated',
        consecutiveErrors: 0,
      });
    }
    log.info('AutoDream scheduled every 6 hours');
  } catch (err) {
    log.warn({ err: String(err) }, 'AutoDream scheduling failed');
  }

  // -------------------------------------------------------------------------
  // Kairos — autonomous background daemon
  // -------------------------------------------------------------------------
  try {
    const { Kairos } = await import('./core/consciousness/kairos.js');
    const kairos = new Kairos({
      refreshIntervalMs: 5 * 60 * 1000,
      autonomousActions: true,
      // Kairos CRITICAL alerts now route through proactiveNotifier → channel adapters.
      // telegramBotToken/chatId still passed as fallback for when notifier has no listeners.
      telegramBotToken: process.env['TELEGRAM_BOT_TOKEN'],
      telegramChatId: process.env['TELEGRAM_CHAT_ID'],
      onCritical: (obs: import('./core/consciousness/kairos.js').KairosObservation) => {
        proactiveNotifier.notify(
          'alert',
          `KAIROS CRITICAL: ${obs.type}`,
          obs.message + (obs.acted ? ` | Auto-fixed: ${obs.actionResult}` : ''),
          'critical',
        );
      },
    });
    kairos.start();
    registerShutdown(() => kairos.stop());
    log.info('Kairos daemon started — watching codebase, system, tasks, memory');
  } catch (err) {
    log.warn({ err: String(err) }, 'Kairos failed to start — running without daemon');
  }

  // -------------------------------------------------------------------------
  // 8.5 Self-build autopilot (Wave SelfBuild)
  // Only wired; inert until SUDO_SELF_BUILD_MODE=1
  // -------------------------------------------------------------------------
  try {
    const { registerSelfBuildCron } = await import('./core/self-build/cron-entry.js');

    const rawDb = (db as unknown as Record<string, unknown>)['db'] ?? db;
    // Wrap finalAgentLoop to create a session before each self-build tick.
    // Orchestrator passes its own synthetic sessionId but doesn't create the
    // session in sessionManager first — AgentLoop.run rejects with
    // "session not found". Wrapper creates a fresh 'web'-channel session
    // per tick and forwards its real id.
    const selfBuildAgentLoop = {
      async run(_sessionId: string, message: string): Promise<{ text: string }> {
        const session = await sessionManager.getOrCreate(
          'web',
          `self-build-tick-${Date.now()}`,
        );
        return finalAgentLoop.run(session.id, message);
      },
    };
    selfBuildDepsRef = {
      agentLoop: selfBuildAgentLoop,
      mindDb: rawDb as import('better-sqlite3').Database,
      alignmentAggregator: finalAgentLoop.getAlignmentAggregator() ?? null,
      // mistakeAutoBlockGuard not accessible as a standalone var at this scope;
      // the orchestrator treats absent guard as skip — safe.
      mistakeAutoBlockGuard: undefined,
      logger: createLogger('self-build'),
      gitCwd: '/root/sudo-ai-v4',
    };

    registerSelfBuildCron(cronScheduler, selfBuildDepsRef);

    if (process.env['SUDO_SELF_BUILD_MODE'] === '1') {
      log.info('Self-build autopilot WIRED — SUDO_SELF_BUILD_MODE=1 is active');
    } else {
      log.info('Self-build autopilot OFF — set SUDO_SELF_BUILD_MODE=1 to enable');
    }
  } catch (err) {
    log.warn({ err: String(err) }, 'Self-build wiring failed — autopilot unavailable');
  }

  // -------------------------------------------------------------------------
  // 9. SUDO-AI v5 modules
  // -------------------------------------------------------------------------
  let goalEngine: GoalEngineV2 | null = null;
  let outcomesLedger: OutcomesLedger | null = null;
  let auditTrail: AuditTrail | null = null;

  try {
    console.log('[boot] Initializing SUDO-AI v5 modules...');
    const crossChannelMemory = new CrossChannelMemory();
    goalEngine = new GoalEngineV2();
    outcomesLedger = new OutcomesLedger();
    auditTrail = new AuditTrail();
    const agentWallet = new AgentWallet();
    const agentIdentity = new AgentIdentity('sudo-ai-v5');
    const steeringChannel = new InMemorySteeringChannel();

    // AutoDream: pass a stub brain caller and a raw better-sqlite3 Database
    const dreamDb = (db as any)?.db ?? db; // unwrap MindDB wrapper if needed
    autoDream = new AutoDream(
      async (prompt: string) => brain.chat([{ role: 'user', content: prompt }]),
      dreamDb as any,
    );

    // Background agent executor (needs an agentRunner function)
    const _backgroundExecutor = new BackgroundAgentExecutor(
      async (sessionId: string, prompt: string) => {
        console.log(`[background] stub runner: session=${sessionId} prompt=${prompt.slice(0, 50)}`);
        return 'background-stub-result';
      },
    );
    void _backgroundExecutor;
    // Teammate idle detector (needs getIdleAgents + onIdle callbacks)
    const _idleDetector = new TeammateIdleDetector(
      () => [],  // Will be wired to swarm.getIdleAgents() when swarm is initialized
      (agentId: string) => console.log(`[idle] Agent ${agentId} is idle`),
    );
    void _idleDetector;

    // Suppress unused-variable warnings for modules registered but not yet
    // exposed via their own shutdown hooks.
    void crossChannelMemory;
    void agentWallet;
    void agentIdentity;
    void steeringChannel;

    // Markdown skill loader
    const mdSkills = await loadMarkdownSkills(path.resolve(process.cwd(), 'skills'));
    // Wave 10C: build skill→tool reverse index and wire into ToolRegistry (fail-open)
    registry.setSkillIndex(buildSkillToolIndex(mdSkills));

    // Register shutdown handlers for closeable v5 modules
    registerShutdown(() => goalEngine?.close?.());
    registerShutdown(() => outcomesLedger?.close?.());

    console.log(
      `[boot] v5 ready: goals=${goalEngine ? 'ok' : 'no'} wallet=${agentWallet ? 'ok' : 'no'} skills=${mdSkills.length} channels=cross`,
    );
    log.info(
      { skillCount: mdSkills.length },
      'SUDO-AI v5 modules initialized',
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ err: msg }, 'v5 module initialization failed — running without v5 features');
  }

  // -------------------------------------------------------------------------
  // 9.5 WebSocket RPC Gateway
  // -------------------------------------------------------------------------
  try {
    if (gatewayServer) {
      attachWsRpc({
        httpServer: gatewayServer,
        sessionManager: dualSessionManager,
        toolRegistry: registry,
        agentLoop: finalAgentLoop,
        cronManager: cronScheduler,
        hookManager: hooks,
      }, { secret: process.env['GATEWAY_SECRET'] });
      console.log('[boot] WebSocket RPC attached to gateway');

      // Attach OpenAI-compatible HTTP API (auth gating is handled inside attachHttpApi
      // via GATEWAY_TOKEN env var; when unset, all requests are accepted).

      // Wave 8E: Wire AlignmentAutoRemediator as observer on the aggregator.
      // finalAgentLoop.getAlignmentAggregator() is available now that the loop is built.
      if (alignmentAutoRemediator) {
        try {
          const agg = finalAgentLoop.getAlignmentAggregator();
          if (agg && typeof agg.setReportObserver === 'function') {
            const rem = alignmentAutoRemediator;
            agg.setReportObserver((report) => {
              rem.observeAlignment({
                status: report.level,
                overallScore: report.score,
                ts: Date.now(),
              });
            });
            log.info('Wave 8E: AlignmentAutoRemediator wired to alignment aggregator observer');
          }
        } catch (wireErr: unknown) {
          log.warn({ err: String(wireErr) }, 'Wave 8E: failed to wire remediator observer (non-fatal)');
        }
      }

      // Wave 2 — Federation Error Protocol (init now that finalAgentLoop is available)
      try {
        const { FederationErrorIngestor } = await import('./core/federation/federation-error-ingestor.js');
        const { FederationTokenPool } = await import('./core/federation/federation-token-pool.js');
        const { vault } = await import('./core/security/vault.js');
        // Create errorReporter wrapper — AgentLoop doesn't have capture/normalizeSignature,
        // so we provide a stub that logs errors (fail-open, non-critical).
        const errorReporterWrapper = {
          capture: async (error: Error, severity: string, context: Record<string, unknown>) => {
            log.warn({ err: error.message, severity, context }, '[FederationErrorIngestor] Error captured (stub)');
          },
          normalizeSignature: (error: Error) => {
            // Simple normalization: lowercase message, strip volatile tokens
            return error.message
              .toLowerCase()
              .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
              .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '<ip>')
              .replace(/\b\d+\b/g, '<n>');
          },
        };
        federationErrorIngestor = new FederationErrorIngestor({ errorReporter: errorReporterWrapper, githubIssues: { isConfigured: () => !!process.env['GITHUB_TOKEN'], searchIssues: async () => ({ success: false }), createIssue: async () => ({ success: false }), addComment: async () => ({ success: false }) }, db: db.db });
        federationTokenPool = new FederationTokenPool({ vault, db: db.db });
        registerShutdown(() => { federationErrorIngestor?.destroy(); federationTokenPool?.destroy(); });
        log.info('Wave 2: Federation Error Protocol initialised');
      } catch (err) { log.warn({ err: String(err) }, '[Wave 2] Federation Error Protocol init failed (non-critical)'); }

      // -----------------------------------------------------------------------
      // Wave 10: instantiate BenchStore + ProposalStore for HTTP route groups.
      // These are pure store objects (no live LLM needed). Fail-open: if the
      // DB open fails, the respective route group is simply not registered.
      // -----------------------------------------------------------------------
      let wave10BenchStore: BenchStore | undefined;
      try {
        wave10BenchStore = new BenchStore('data/bench.db');
        log.info('Wave 10: BenchStore initialised at data/bench.db');
      } catch (benchErr: unknown) {
        log.warn({ err: String(benchErr) }, 'Wave 10: BenchStore failed to initialise — bench routes will be unavailable');
      }

      let wave10ProposalStore: ProposalStore | undefined;
      try {
        wave10ProposalStore = new ProposalStore('data/proposals.db');
        log.info('Wave 10: ProposalStore initialised at data/proposals.db');
      } catch (proposalErr: unknown) {
        log.warn({ err: String(proposalErr) }, 'Wave 10: ProposalStore failed to initialise — learning routes will be unavailable');
      }

      // -----------------------------------------------------------------------
      // Wave 13: SkillOptimizer full init (AgentConfigEvolver + SkillOptimizer).
      // SkillDiscovery + SkillOptimizationStore were pre-initialised at 6.45.
      // SkillOptimizer is injected into SleepCycle via setSkillOptimizer() setter.
      // -----------------------------------------------------------------------
      let wave13AgentConfigEvolver: AgentConfigEvolver | undefined;
      let wave13SkillOptimizer: SkillOptimizer | undefined;
      try {
        if (wave13SkillDiscovery && wave13SkillOptimizationStore) {
          if (wave10ProposalStore) {
            wave13AgentConfigEvolver = new AgentConfigEvolver(wave10ProposalStore);
          }
          const calibTracker = typeof finalAgentLoop.getConfidenceCalibrationTracker === 'function'
            ? (finalAgentLoop.getConfidenceCalibrationTracker() ?? undefined)
            : undefined;
          const wave13SkillRegistry = new SkillRegistry(db.db);
          wave13SkillOptimizer = new SkillOptimizer(
            wave13SkillDiscovery,
            mistakePatternRecognizer,
            calibTracker,
            wave13SkillOptimizationStore,
            wave13SkillRegistry,
            sleepTrustTracker, // P2-d: trust gate for autoApplyApproved()
            new URL('./core/skills', import.meta.url).pathname, // skillsDir: enable on-disk SKILL.md writes
          );
          // Inject into SleepCycle via setter (sleepCycle was captured at 6.5).
          if (wave13SleepCycleRef) {
            wave13SleepCycleRef.setSkillOptimizer(wave13SkillOptimizer);
          }
          log.info('Wave 13: AgentConfigEvolver + SkillOptimizer initialised and wired into SleepCycle');
          // Wave 10B: wire AgentConfigEvolver into agent loop (fail-open)
          if (wave13AgentConfigEvolver) {
            try {
              finalAgentLoop.setAgentConfigEvolver(wave13AgentConfigEvolver);
            } catch (err: unknown) {
              log.warn({ err: String(err) }, 'Wave 10B: AgentConfigEvolver wiring failed — trace feed disabled');
            }
          }
        } else {
          log.warn('Wave 13: SkillDiscovery or SkillOptimizationStore unavailable — SkillOptimizer skipped');
        }
      } catch (err13: unknown) {
        log.warn(
          { err: String(err13) },
          'Wave 13: SkillOptimizer init failed — skill optimization disabled (fail-open)',
        );
      }

      attachHttpApi(gatewayServer, {
        sessionManager: dualSessionManager,
        agentLoop: finalAgentLoop,
        auditTrail: auditTrail ?? undefined,
        inspectionQueue,
        alignmentAggregator: finalAgentLoop.getAlignmentAggregator() ?? undefined,
        vetoOverrideStore: finalAgentLoop.getVetoOverrideStore() ?? undefined,
        epistemicGate: finalAgentLoop.getEpistemicGate(),
        commitmentAuditor,
        trustTierTracker: finalAgentLoop.getTrustTierTracker() ?? undefined,
        mistakePatternRecognizer,
        confidenceCalibrationTracker: finalAgentLoop.getConfidenceCalibrationTracker(),
        crossSignalDiagnostics,
        commitmentResolutionTracker,
        reanchorMonitor,
        autoThresholdTuner,
        federation: federationDeps,
        errorIngestor: federationErrorIngestor,
        tokenPool: federationTokenPool,
        fedAuth: peerRegistryForAuth?.isInboundTokenValid?.bind(peerRegistryForAuth),
        alignmentAutoRemediator,
        skillOptimizationStore: wave13SkillOptimizationStore,
        bench: wave10BenchStore ? { benchStore: wave10BenchStore } : undefined,
        learning: wave10ProposalStore ? { proposalStore: wave10ProposalStore } : undefined,
        savings: { costTracker },
        // C1: Wire compare route via brain.chat() shim.
        // brain.chat(messages, model?) is the per-model entry point already used
        // elsewhere; compare-routes.ts duck-types BrainLike.runWithModel.
        compare: {
              brain: {
                async runWithModel(modelId: string, prompt: string) {
                  const text = await brain.chat([{ role: 'user', content: prompt }], modelId);
                  return { text };
                },
              },
              complexityScorer: {
                score: (prompt: string, modelName?: string) =>
                  scoreComplexity({ prompt, modelName }),
              },
            },
      });
      log.info('HTTP API attached (OpenAI-compatible + alignment admin routes)');

      // Wave 5: REST APIs (/v1/sessions, /v1/agents, SSE streams)
      try {
        const sessionDeps = buildSessionRouteDeps(db.db);
        // -----------------------------------------------------------------------
        // Wave 5 P3: Wire real SessionStateMachine events to sandboxProxyBus
        // -----------------------------------------------------------------------
        // sandboxManager was pre-initialized at step 5.6 with a proxy EventEmitter.
        // Forward terminal session events from the real stateMachine so the
        // SandboxManager tears down workspaces on session termination/archival.
        for (const ev of ['session:status:terminated', 'session:status:archived'] as const) {
          sessionDeps.stateMachine.on(ev, (payload: { sessionId: string }) => {
            sandboxProxyBus.emit(ev, payload);
          });
        }
        log.info('SandboxManager wired to real SessionStateMachine events');
        registerSessionRoutes(gatewayServer, sessionDeps);
        log.info('Session REST API attached (/v1/sessions)');

        const agentStore = new AgentConfigStore(db.db);
        registerAgentRoutes(gatewayServer, agentStore);
        log.info('Agent config REST API attached (/v1/agents)');

        const sseBroker = registerSseRoutes(gatewayServer, hooks);
        log.info('SSE event stream attached (/v1/sessions/:id/stream)');
        registerShutdown(() => sseBroker.destroy());

        // Wave 5 P2: MCP credential vault routes
        registerVaultCredentialRoutes(gatewayServer);
        log.info('Vault credential routes attached (/v1/vaults/:ns/credentials)');

        // Wave 5 P2: OAuth refresh daemon — start background token refresh
        oauthRefreshDaemon.start();
        registerShutdown(() => oauthRefreshDaemon.stop());
        log.info('OAuth refresh daemon started');

        // Wave 5 P2: Files API
        const fileStore = new FileStore(db.db, 'data/files');
        registerFileRoutes(gatewayServer, fileStore);
        log.info('Files API attached (/v1/files)');

        // Wave 5 P2: Skills Registry
        const skillRegistry = new SkillRegistry(db.db);
        skillRegistry.scanAndRegister();
        // Wave 12: scan bundled SKILL.md files from src/core/skills subdirectories
        const bundledSkillsDir = new URL('./core/skills', import.meta.url).pathname;
        skillRegistry.scanBundledSkills(bundledSkillsDir);
        registerSkillRoutes(gatewayServer, skillRegistry, sessionDeps.store);
        log.info('Skills API attached (/v1/skills)');
        const { registerRegistryRoutes } = await import('./core/skills/registry-routes.js');
        registerRegistryRoutes(gatewayServer, skillRegistry);
        log.info('Public skill registry attached (/v1/registry/skills)');

        // Wave 10 P1: agentskills.io discovery endpoint (public no-auth)
        const { registerWellKnownRoutes } = await import('./core/gateway/well-known-routes.js');
        registerWellKnownRoutes(gatewayServer, skillRegistry);
        log.info('agentskills.io well-known route attached (GET /.well-known/agentskills.json)');

        const goalEvaluator = createGoalEvaluator();

        const { buildOutcomeAdapters } = await import('./core/sessions/outcome-adapters.js');

        const outcomeAdapters =
          process.env['SUDO_OUTCOME_ADAPTERS_DISABLE'] === '1'
            ? {
                getSessionGoal: (_sessionId: string): string | null => null,
                getRecentMessages: (
                  _sessionId: string,
                  _n: number,
                ): Array<{ role: string; content: string }> => [],
                getToolStats: (
                  _sessionId: string,
                ): { successCount: number; failureCount: number } => ({
                  successCount: 0,
                  failureCount: 0,
                }),
              }
            : buildOutcomeAdapters(sessionDeps.store);

        const sessionOutcomeListener = new SessionOutcomeListener({
          stateMachine: sessionDeps.stateMachine,
          // outcomesLedger is guaranteed non-null here: assigned in step 9 try block above.
          // If it is null (v5 init failed), constructing SessionOutcomeListener will throw,
          // which is caught by the outer Wave 5 try/catch, making this safe.
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          ledger: outcomesLedger!,
          evaluator: goalEvaluator,
          ...outcomeAdapters,
        });
        registerShutdown(() => sessionOutcomeListener.destroy());
        log.info('SessionOutcomeListener initialized');
      } catch (err) {
        log.warn({ err: String(err) }, 'Wave 5 REST APIs failed to attach — running without session/agent/SSE routes');
      }
    }
  } catch (err) {
    log.warn({ err: String(err) }, 'WebSocket RPC failed to attach — running without WS');
  }


  // -------------------------------------------------------------------------
  // 9.55 Social ScheduleDispatcher — post scheduling daemon
  // -------------------------------------------------------------------------
  try {
    const { ScheduleDispatcher, setDispatcherInstance } = await import('./core/social/schedule-dispatcher.js');
    const dispatcher = new ScheduleDispatcher(db.db);
    setDispatcherInstance(dispatcher);
    dispatcher.start();
    registerShutdown(() => dispatcher.stop());
    log.info('ScheduleDispatcher started (60s tick)');
  } catch (err) {
    log.warn({ err: String(err) }, 'ScheduleDispatcher failed to start — scheduled posts will not be dispatched');
  }

  // -------------------------------------------------------------------------
  // 9.6 Meta tool dependency injection
  // -------------------------------------------------------------------------
  try {
    const { injectMetaToolDeps } = await import('./core/tools/builtin/meta/index.js');

    // Build a thin channelRouter wrapper that delegates to all active channel adapters.
    const channelRouter = (telegramNotifier || discordAdapter || slackAdapter || whatsAppAdapter || emailAdapter || smsAdapter) ? {
      send: async (channel: string, peerId: string, text: string) => {
        if (channel === 'telegram' && telegramNotifier) {
          await telegramNotifier.send(peerId, text);
          return { timestamp: new Date().toISOString() };
        }
        if (channel === 'discord' && discordAdapter) {
          await discordAdapter.send(peerId, text);
          return { timestamp: new Date().toISOString() };
        }
        if (channel === 'slack' && slackAdapter) {
          await slackAdapter.send(peerId, text);
          return { timestamp: new Date().toISOString() };
        }
        if (channel === 'whatsapp' && whatsAppAdapter) {
          await whatsAppAdapter.send(peerId, text);
          return { timestamp: new Date().toISOString() };
        }
        if (channel === 'email' && emailAdapter) {
          await emailAdapter.send(peerId, text);
          return { timestamp: new Date().toISOString() };
        }
        if (channel === 'sms' && smsAdapter) {
          await smsAdapter.send(peerId, text);
          return { timestamp: new Date().toISOString() };
        }
        throw new Error(`Channel "${channel}" not available`);
      },
    } : undefined;

    // Build a thin memoryEngine wrapper over RAGEngine's retrieveContext.
    const memoryEngine = ragEngine ? {
      search: async (query: string, limit: number) => ragEngine!.retrieveContext(query, limit),
    } : undefined;

    injectMetaToolDeps({
      sessionManager: dualSessionManager,
      agentLoop: finalAgentLoop,
      cronManager: cronScheduler,
      channelRouter,
      memoryEngine,
    });
    log.info('Meta tool dependencies injected');
  } catch (err) {
    log.warn({ err: String(err) }, 'Meta tool injection failed — meta tools will return errors');
  }

  // -------------------------------------------------------------------------
  // 9.7 Health Watchdog
  // -------------------------------------------------------------------------
  try {
    const { Watchdog } = await import('./core/health/watchdog.js');
    const watchdog = new Watchdog();
    watchdog.start();
    registerShutdown(() => watchdog.stop());
    log.info('Health watchdog started');
  } catch (err) {
    log.warn({ err: String(err) }, 'Health watchdog failed to start — running without');
  }

  // -------------------------------------------------------------------------
  // 9.9 IDE Bridge Adapter (VS Code / JetBrains extension protocol)
  //     Kill-switch: SUDO_IDE_BRIDGE_DISABLE=1
  // -------------------------------------------------------------------------
  if (process.env['SUDO_IDE_BRIDGE_DISABLE'] !== '1') {
    try {
      const { IdeBridgeAdapter } = await import('./core/ide/bridge-adapter.js');
      const { progress } = await import('./core/gateway/progress.js');

      const bridgeAdapter = new IdeBridgeAdapter(
        {
          sessionManager: dualSessionManager,
          agentLoop: finalAgentLoop,
          progressBroadcaster: progress,
          hookManager: hooks,
        },
        {
          gatewayToken: process.env['GATEWAY_TOKEN'],
          jwtTtlMs: parseInt(process.env['SUDO_BRIDGE_JWT_TTL_MS'] ?? '3600000', 10),
        },
      );

      if (!gatewayServer) throw new Error('gatewayServer not ready — cannot attach IDE Bridge');
      bridgeAdapter.attach(gatewayServer);

      // Start discovery after gateway is listening
      if (gatewayPort) {
        bridgeAdapter.startDiscovery(gatewayPort);
      }

      registerShutdown(() => { bridgeAdapter.stop(); });
      log.info({ path: '/ide/bridge', port: gatewayPort }, 'IDE Bridge adapter attached to gateway');
    } catch (err) {
      log.warn({ err: String(err) }, 'IDE Bridge failed to start — running without IDE extension support');
    }
  } else {
    log.info('IDE Bridge disabled (SUDO_IDE_BRIDGE_DISABLE=1)');
  }

  // -------------------------------------------------------------------------
  // Done
  // -------------------------------------------------------------------------
  log.info('SUDO-AI v5 is online');
  console.log('SUDO-AI v5 is online');
}

// ---------------------------------------------------------------------------
// chat subcommand — intercept BEFORE full boot so readline owns SIGINT
// ---------------------------------------------------------------------------

if (process.argv[2] === 'chat') {
  import('./cli/commands/chat.js').then(({ runChat }) => {
    runChat().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[chat] Fatal error:', msg);
      process.exit(1);
    });
  }).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[chat] Failed to load chat module:', msg);
    process.exit(1);
  });
} else {
  // ---------------------------------------------------------------------------
  // Signal handlers — wire before boot so any early failure still cleans up
  // ---------------------------------------------------------------------------

  process.once('SIGINT', () => runShutdown('SIGINT'));
  process.once('SIGTERM', () => runShutdown('SIGTERM'));

  // ---------------------------------------------------------------------------
  // Main
  // ---------------------------------------------------------------------------

  boot().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    // Use console.error here as the logger may not have been created yet.
    console.error('[cli] FATAL boot error:', msg);
    if (stack) console.error(stack);
    process.exit(1);
  });
}
