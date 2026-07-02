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
import { registerShutdown, runShutdown } from './core/cli/shutdown.js';
import { PROJECT_ROOT, DATA_DIR, WORKSPACE_DIR, projectPath } from './core/shared/paths.js';
import { ConfigLoader } from './core/config/loader.js';
import { MindDB } from './core/memory/db.js';
import { EmbeddingService } from './core/memory/embeddings.js';
import { compactSemanticDuplicates, type EmbeddingFn as SemanticEmbeddingFn } from './core/memory/semantic-compactor.js';
import {
  resolveChunkContradictions,
  isChunkContradictionEnabled,
  type ContradictionJudge,
} from './core/memory/chunk-contradiction.js';
import {
  backfillChunkVectors,
  isVectorBackfillEnabled,
  MindDBVectorStore,
} from './core/memory/vector-backfill.js';
import { LocalEmbeddingProvider, LOCAL_EMBED_DIM, makeLocalFirstEmbed } from './core/memory/local-embeddings.js';
import { Brain } from './core/brain/brain.js';
import { ToolRegistry } from './core/tools/registry.js';
import { loadBuiltinTools } from './core/tools/loader.js';
import { SessionManager } from './core/sessions/manager.js';
import { runGenerations } from './core/sessions/run-generation.js';
import { AgentLoop } from './core/agent/loop.js';
import { approvalManager } from './core/agent/approval.js';
import { TelegramAdapter } from './core/channels/telegram.js';
import { registerOutboundAdapter, sendToChannelOutbox, registeredOutboundChannels } from './core/channels/channel-outbox.js';
import { MessageCoalescer, isAddressedToBot } from './core/channels/message-coalescer.js';
import type { UnifiedMessage } from './core/channels/types.js';
import { CronStore } from './core/cron/store.js';
import { CronScheduler } from './core/cron/scheduler.js';
import { HeartbeatRunner, type HeartbeatPayloadRunner } from './core/cron/heartbeat.js';
import { maybeGuardedSend } from './core/comms/idempotency.js';
import { CommandRegistry } from './core/commands/registry.js';
import { tryDispatchDirective } from './core/commands/dispatch.js';
import type { CommandContext } from './core/commands/types.js';
import { HookManager } from './core/hooks/index.js';
import { CostTracker } from './core/brain/cost-tracker.js';
import { createFeedbackKeyboard, saveFeedback } from './core/feedback/index.js';
import type { SudoConfig } from './core/config/types.js';
import type { CronPayload, CronJob } from './core/cron/types.js';
import { CrossChannelMemory } from './core/channels/cross-channel-memory.js';
import { GoalEngineV2 } from './core/autonomy/goal-engine-v2.js';
import { OutcomesLedger } from './core/autonomy/outcomes.js';
import { AuditTrail } from './core/security/audit-trail.js';
import { AutoUpdateManager } from './core/update/update-manager.js';
import { DEFAULT_UPDATE_CONFIG } from './core/update/update-manager-types.js';
import { AutoDream } from './core/memory/auto-dream.js';
import { TeammateIdleDetector } from './core/agent/teammate-idle.js';
import { BackgroundAgentExecutor } from './core/agent/background-agent.js';
import { InMemorySteeringChannel } from './core/agent/steering.js';
import { loadMarkdownSkills, parseSkillRoots } from './core/skills/markdown-loader.js';
import { startGateway, gatewayServer } from './core/gateway/server.js';
import { attachWsRpc } from './core/gateway/ws-server.js';
import { attachHttpApi } from './core/gateway/http-api.js';
import { DualSessionManager } from './core/sessions/dual-manager.js';
import { JournalSessionStore } from './core/sessions/journal-store.js';
import { scanInterruptedSessions, reconcileInterruptedSessions } from './core/sessions/crash-safe.js';
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
import { shouldSkipDailyLogForMessage } from './core/workspace/diagnostic-peer.js';
import { FileStore, registerFileRoutes } from './core/files/index.js';
import { SkillRegistry, registerSkillRoutes } from './core/skills/index.js';
import {
  SandboxManager,
  DEFAULT_SANDBOX_POLICY,
  resolveAgentNetworkMode,
  resolveEgressAllowlist,
} from './core/sandbox/index.js';
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
import { startPolicyRefreshLoop, POLICY_REFRESH_MIN_MS } from './core/learning/policy-refresh.js';
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

// Shutdown registry (registerShutdown / runShutdown) extracted to
// ./core/cli/shutdown.js — pure move, no behaviour change.

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
  const configLoader = new ConfigLoader();
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
  // 2.15 LoopSignatureStore (architectural fix #5)
  //     Cross-session loop memory: when LoopGuard aborts a turn, the
  //     signature gets persisted; subsequent sessions short-circuit the
  //     in-turn thresholds (10/20) the moment a known-bad signature shows
  //     up again. Set via a module-level singleton so the per-loop
  //     LoopGuard instances don't need a constructor change.
  //     Disable with SUDO_LOOP_SIGNATURE_PERSIST=0; tunable via
  //     SUDO_LOOP_SIGNATURE_SUPPRESS_HITS (default 2).
  // -------------------------------------------------------------------------
  if (process.env['SUDO_LOOP_SIGNATURE_PERSIST'] !== '0') {
    try {
      const { LoopSignatureStore, setGlobalLoopSignatureStore } = await import('./core/agent/loop-signature-store.js');
      const store = new LoopSignatureStore(db.db);
      setGlobalLoopSignatureStore(store);
      // Prune entries last seen >30 days ago at boot, then on a daily schedule.
      const pruned = store.prune();
      log.info({ pruned, total: store.count() }, 'LoopSignatureStore wired');
      const pruneTimer = setInterval(() => {
        try { store.prune(); } catch (err) { log.warn({ err: String(err) }, 'LoopSignatureStore prune failed'); }
      }, 24 * 60 * 60 * 1000);
      if (pruneTimer.unref) pruneTimer.unref();
      registerShutdown(() => clearInterval(pruneTimer));
    } catch (err) {
      log.warn({ err: String(err) }, 'LoopSignatureStore wiring failed — LoopGuard runs without persistence');
    }
  }

  // -------------------------------------------------------------------------
  // 2.2 Persistent exec-policy rules (gap #16)
  //     (opt-in: SUDO_EXEC_POLICY=1; persists "always allow / always deny"
  //      decisions across sessions in mind.db, force-denies the hardcoded
  //      DANGEROUS_PREFIXES list. ApprovalManager consults the store BEFORE
  //      prompting; a matching rule short-circuits the chat round-trip.)
  // -------------------------------------------------------------------------
  if (process.env['SUDO_EXEC_POLICY'] === '1') {
    try {
      const { ExecPolicyStore } = await import('./core/agent/exec-policy.js');
      approvalManager.setPolicyStore(new ExecPolicyStore(db.db));
      log.info('Persistent exec-policy store wired (SUDO_EXEC_POLICY=1)');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err: msg }, 'exec-policy store wiring failed — continuing without persistence');
    }
  }

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

      claudeTokenManager = claudeToken;
      registerShutdown(() => claudeToken.stopAutoRefresh());

      // The daemon-internal auto-refresh competes with sudo-ai's own
      // claude-oauth PKCE manager — and any external `claude` CLI — on the SAME
      // OAuth client_id grant. Anthropic rotates/revokes prior tokens per
      // (account, client_id), so multiple refreshers invalidate each other (the
      // observed 401 "Invalid bearer token" storm). The brain's failover chain
      // routes claude-oauth/* (not anthropic/*), so this refresh loop adds no
      // routing value today; default OFF. SUDO_CLAUDE_CLI_TOKEN_REFRESH=1
      // restores the legacy self-refresh (e.g. if anthropic/* is put back in
      // the chain and this host is the sole holder of the grant).
      if (process.env['SUDO_CLAUDE_CLI_TOKEN_REFRESH'] === '1') {
        claudeToken.startAutoRefresh();

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
        log.info('Claude CLI token auto-refresh disabled (default) — prevents multi-refresher OAuth grant collision; set SUDO_CLAUDE_CLI_TOKEN_REFRESH=1 to re-enable');
      }
    } else {
      log.info('Claude credentials not found — Claude provider unavailable; using configured providers');
    }
  } catch (err) {
    log.warn({ err: String(err) }, 'Claude token manager failed to initialize — using existing providers');
  }

  // -------------------------------------------------------------------------
  // 3.0b Claude OAuth (PKCE) Manager — independent of the `claude` CLI
  //
  // Boots the sudo-ai-owned PKCE OAuth connector. If the user has previously
  // run `sudo-ai claude-oauth login` (or used the admin UI button), the store
  // at <DATA_DIR>/claude-oauth.json contains a usable token: load it, start the
  // background refresh loop, and the `claude-oauth` provider in providers.ts
  // will be registered by initProviders() further down. If not, this is a
  // no-op — login can happen later and reinitProvider() picks it up.
  // -------------------------------------------------------------------------
  try {
    const { getClaudeOAuthManager } = await import('./core/brain/claude-oauth-manager.js');
    const oauthMgr = getClaudeOAuthManager();
    if (oauthMgr.isAvailable()) {
      oauthMgr.startAutoRefresh();
      registerShutdown(() => oauthMgr.stopAutoRefresh());
      log.info('Claude OAuth (PKCE) manager active — claude-oauth/* models available');
    } else {
      log.info('Claude OAuth (PKCE) not connected — run `sudo-ai claude-oauth login` to enable');
    }
  } catch (err) {
    log.warn({ err: String(err) }, 'Claude OAuth manager failed to initialize — continuing without it');
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

  // Wire TaintTracker into HookManager (fail-open, kill-switch: SUDO_TAINT_DISABLE=1).
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
    // Pass an EmbeddingService so RAG's hybrid search actually uses the vector
    // path (it falls back to BM25-only when absent — which it always was). Pairs
    // with the corpus vector backfill that populates chunks_vec; without both,
    // vector recall is silently keyword-only. Self-degrades to BM25 if the
    // embedding key is missing/quota-dead.
    ragEngine = new RAGEngine(db, new EmbeddingService(db));
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
  // 4.5 Plugin SDK — manifest-first plugins from DATA_DIR/plugins
  //     (opt-in: SUDO_PLUGINS=1; plugins run host code, so off by default)
  // -------------------------------------------------------------------------
  if (process.env['SUDO_PLUGINS'] === '1') {
    try {
      const { bootPlugins, shutdownPlugins } = await import('./core/plugins/boot.js');
      const pluginBoot = await bootPlugins(hooks);
      log.info(
        { loaded: pluginBoot.loaded, enabled: pluginBoot.enabled, hooksRegistered: pluginBoot.hooksRegistered },
        'Plugin SDK initialized',
      );
      registerShutdown(async () => {
        try {
          await shutdownPlugins(pluginBoot.loader, hooks);
        } catch (err) {
          log.warn({ err: String(err) }, 'Plugin shutdown failed — continuing');
        }
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err: msg }, 'Plugin SDK failed to initialize — continuing without plugins');
    }
  }

  // -------------------------------------------------------------------------
  // 4.6 User hooks file — script lifecycle events without writing a plugin
  //     (opt-in: SUDO_USER_HOOKS=1; command hooks run shell, so off by default;
  //      file: SUDO_HOOKS_FILE or DATA_DIR/hooks.json)
  // -------------------------------------------------------------------------
  if (process.env['SUDO_USER_HOOKS'] === '1') {
    try {
      const { loadUserHooks } = await import('./core/hooks/user-hooks.js');
      const userHooks = loadUserHooks(hooks, process.env['SUDO_HOOKS_FILE']);
      log.info(
        { registered: userHooks.registered, skipped: userHooks.skipped, invalid: userHooks.errors.length },
        'User hooks initialized',
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err: msg }, 'User hooks failed to initialize — continuing without them');
    }
  }

  // -------------------------------------------------------------------------
  // 4.7 Claude/Cursor ecosystem compat (gap #13)
  //     (opt-in: SUDO_CLAUDE_COMPAT=1; ingests .mcp.json + Cursor mcp.json,
  //      Claude settings.json hooks, ~/.claude/skills + <root>/.claude/skills,
  //      and .claude-plugin/marketplace.json catalog entries. Must run BEFORE
  //      §9.1 (markdown skill loader) and §8.6+ (skill registry scan), both
  //      of which read SUDO_SKILLS_DIRS — this section mutates it.)
  // -------------------------------------------------------------------------
  if (process.env['SUDO_CLAUDE_COMPAT'] === '1') {
    try {
      const { ingestClaudeCompat } = await import('./core/plugins/claude-compat.js');
      const compat = await ingestClaudeCompat(hooks, { projectRoot: PROJECT_ROOT });
      log.info(
        {
          mcpRegistered: compat.mcp.registered,
          mcpSkipped: compat.mcp.skipped,
          mcpErrors: compat.mcp.errors.length,
          hooksRegistered: compat.hooks.registered,
          hooksSkipped: compat.hooks.skipped,
          hooksErrors: compat.hooks.errors.length,
          skillRootsAdded: compat.skillRootsAdded.length,
          marketplacePlugins: compat.marketplacePlugins.length,
          marketplaceErrors: compat.marketplaceErrors.length,
        },
        'Claude/Cursor compat initialized',
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err: msg }, 'Claude/Cursor compat failed to initialize — continuing without it');
    }
  }

  // -------------------------------------------------------------------------
  // 5. SessionManager
  // -------------------------------------------------------------------------
  const sessionManager = new SessionManager(db);
  const journalStore = new JournalSessionStore();
  // gap #17 — opt-in journal-first save ordering + boot-time interrupted-turn scan.
  // Default OFF: behaviour byte-identical to the pre-gap-#17 SQLite-first path.
  const crashSafe = process.env['SUDO_CRASH_SAFE'] === '1';
  const dualSessionManager = new DualSessionManager(sessionManager, journalStore, { crashSafe });
  log.info({ crashSafe }, 'SessionManager initialized');
  if (crashSafe) {
    try {
      // B5.1 scope fix: exclude ephemeral machine-generated peers (cron/swarm/
      // probe one-shots) and resolve a journal session to its canonical
      // `<channel>:<peerId>` message total before counting drift — journal forks
      // use non-canonical ids whose per-id mirror reads 0 even though the
      // messages are persisted under the canonical title. Filter default-ON;
      // SUDO_RECONCILE_NO_FILTER=1 disables it.
      const filterEphemeral = process.env['SUDO_RECONCILE_NO_FILTER'] !== '1';
      const resolveCanonicalCount = (channel: string, peerId: string): number | null => {
        const n = db.countMessagesByTitle(`${channel}:${peerId}`);
        return n > 0 ? n : null;
      };
      const interrupted = await scanInterruptedSessions(journalStore, sessionManager, {
        journalDir: journalStore.journalDir,
        filterEphemeral,
        resolveCanonicalCount,
      });
      if (interrupted.length > 0) {
        log.warn(
          { count: interrupted.length, sample: interrupted.slice(0, 3) },
          'crash-safe boot scan: JSONL leads SQLite for some sessions — operator should review',
        );
      } else {
        log.info('crash-safe boot scan: no interrupted sessions detected');
      }

      // Crash-safe reconcile (NP.5). Replays the missing JSONL message tail into
      // SQLite, additive-only + idempotent. DRY-RUN by default (writes NOTHING,
      // just reports the drift) — real INSERTs require SUDO_SESSION_RECONCILE_APPLY=1
      // (and a per-session backup first). Disable the pass entirely with
      // SUDO_SESSION_RECONCILE=0.
      if (process.env['SUDO_SESSION_RECONCILE'] !== '0') {
        const reconcileApply = process.env['SUDO_SESSION_RECONCILE_APPLY'] === '1';
        try {
          const recon = await reconcileInterruptedSessions(journalStore, db, {
            journalDir: journalStore.journalDir,
            apply: reconcileApply,
            filterEphemeral,
            resolveCanonicalCount,
          });
          const reconcilable = recon.filter((r) => r.cleanPrefix);
          const drift = reconcilable.reduce((n, r) => n + r.missingCount, 0);
          const insertedTotal = recon.reduce((n, r) => n + r.insertedCount, 0);
          const divergent = recon.filter((r) => !r.cleanPrefix).length;
          log.info(
            {
              mode: reconcileApply ? 'apply' : 'dry-run',
              candidateSessions: reconcilable.length,
              driftMessages: drift,
              divergentSessions: divergent,
              inserted: insertedTotal,
            },
            reconcileApply
              ? 'crash-safe reconcile: backfilled missing journal messages into SQLite'
              : 'crash-safe reconcile DRY-RUN: missing journal messages detected — set SUDO_SESSION_RECONCILE_APPLY=1 to backfill',
          );
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn({ err: msg }, 'crash-safe reconcile failed — continuing without backfill');
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err: msg }, 'crash-safe boot scan failed — continuing without report');
    }
  }

  const dailyLog = new DailyLogManager();

  // -------------------------------------------------------------------------
  // 5.5 Multi-agent orchestration
  // -------------------------------------------------------------------------
  // Hoisted out of the try block so section 8.6 can register the orchestrator
  // as the dashboard's `agentSwarm` source — getSnapshot() drives the
  // FleetView endpoint (gap #25 slice 1).
  let multiAgent: import('./core/agents/index.js').MultiAgentOrchestrator | null = null;
  try {
    const { MultiAgentOrchestrator, createMultiAgentTool } = await import('./core/agents/index.js');
    multiAgent = new MultiAgentOrchestrator(brain, registry, dualSessionManager);
    // Session manager enables opt-in fork-mode parent context (SUDO_FORK_CONTEXT=1).
    registry.register(createMultiAgentTool(multiAgent, dualSessionManager));
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
  // Network mode for the agent's exec sandbox. Default 'host' so the autonomous
  // agent can download model files / reach external APIs itself; the runner binds
  // DNS+CA into the sandbox so egress actually works. SUDO_SANDBOX_NETWORK=none
  // restores --unshare-net isolation. Only the agent's injected policy changes —
  // DEFAULT_SANDBOX_POLICY (used by eval/verifier sandboxes) stays network:'none'.
  const agentNetworkMode = resolveAgentNetworkMode();
  const sandboxManager = new SandboxManager({
    stateMachine: sandboxProxyBus,
    workspaceRoot: path.join(WORKSPACE_DIR, 'sessions'),
    defaultPolicy: { ...DEFAULT_SANDBOX_POLICY, network: agentNetworkMode },
  });
  registerShutdown(async () => sandboxManager.teardownAll());
  // Background shells (gap #10): kill all on daemon shutdown so none orphan.
  // Dynamic import keeps the bg-shell graph unloaded when the flag is off.
  if (process.env['SUDO_BG_SHELL'] === '1') {
    registerShutdown(async () => {
      const { killAll } = await import('./core/tools/builtin/system/bg-shell/index.js');
      killAll();
    });
  }
  if (agentNetworkMode === 'host') {
    const allow = resolveEgressAllowlist();
    log.warn(
      { network: 'host', trustedHostCount: allow.length },
      'Sandbox egress OPEN: agent system.exec shares the host network (DNS+CA bound in), ' +
        'so the autonomous agent can reach ANY external host. ' +
        'Set SUDO_SANDBOX_NETWORK=none to restore network isolation. ' +
        `Declared trusted set (advisory, NOT enforced in host mode): ${allow.join(', ')}`,
    );
  } else {
    log.info({ network: 'none' }, 'SandboxManager: agent exec network isolated (--unshare-net)');
  }
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

      // Lazy audit_chain schema seed (idempotent, fail-open).
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

      // Identity re-anchor instrumentation at startup.
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
      // Wire MistakeAutoBlockGuard into veto-gate pre-check (fail-open).
      // MistakePatternRecognizer.findSimilar returns MistakePattern[] which
      // structurally satisfies PatternRecognizerLike — the guard only reads
      // signatureHash + occurrences, the rest is width-extension.
      if (mistakePatternRecognizer) {
        try {
          const autoBlockGuard = new MistakeAutoBlockGuard({
            patternRecognizer: mistakePatternRecognizer,
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

      // Record startup re-anchor outcome in trust tracker (fail-open).
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
  // 6.4b2 Wire re-anchor callbacks for post-veto, post-discordance,
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
  // 6.4c ConfidenceCalibrationTracker — predicted-vs-actual calibration.
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
  // 6.4g AutoThresholdTuner — dynamic veto threshold from calibration drift.
  //      Requires confidenceCalibrationTracker from 6.4c.
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
  // 6.4e CommitmentResolutionTracker — persistent commitment outcome log.
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
  // 6.4f InjectionDetector — stateless pure detector, no DB.
  //      strictMode controlled by SUDO_INJECTION_STRICT=1 env var.
  // -------------------------------------------------------------------------
  const injectionDetector = new InjectionDetector({
    strictMode: process.env['SUDO_INJECTION_STRICT'] === '1',
  });
  log.info({ strictMode: process.env['SUDO_INJECTION_STRICT'] === '1' }, 'InjectionDetector initialised');

  // -------------------------------------------------------------------------
  // 6.4h Federation — PeerRegistry + AuditChainSync.
  //      Reads peer config from env (fail-open if missing/malformed).
  //      Opens a second handle on audit.db for federation tables.
  //      Instance ID = SUDO_INSTANCE_ID env or "hostname-pid" fallback.
  // -------------------------------------------------------------------------
  let federationDeps: import('./core/gateway/federation-routes.js').FederationRoutesDeps | undefined;
  // Federation Error Protocol (hoisted for later init)
  let federationErrorIngestor: import('./core/federation/federation-error-ingestor.js').FederationErrorIngestor | undefined;
  let federationTokenPool: import('./core/federation/federation-token-pool.js').FederationTokenPool | undefined;
  let peerRegistryForAuth: import('./core/federation/peer-registry.js').PeerRegistry | undefined;
  try {
    const dataDir64h = process.env['DATA_DIR'];
    if (dataDir64h) {
      const Database64h = (await import('better-sqlite3')).default;
      const fedAuditDb = new Database64h(path.join(dataDir64h, 'audit.db'));
      const { PeerRegistry } = await import('./core/federation/peer-registry.js');
      const { AuditChainSync } = await import('./core/federation/audit-chain-sync.js');

      peerRegistryForAuth = PeerRegistry.fromEnv();
      const peerRegistry = peerRegistryForAuth;

      // PeerKeyCache + PeerKeyFetcher for federation ingest verification
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
  // 6.4i AlignmentAutoRemediator — auto-remediation on sustained RED.
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
  // 6.45 Pre-init — SkillDiscovery + SkillOptimizationStore (fail-open)
  // These are initialised before the consciousness layer so they can be wired
  // into the SleepCycle constructor at 6.5. SkillOptimizer is created later
  // (after calibration tracker is available) and injected via setSkillOptimizer().
  // -------------------------------------------------------------------------
  let wave13SkillDiscovery: SkillDiscovery | undefined;
  let wave13SkillOptimizationStore: SkillOptimizationStore | undefined;
  /** Duck-typed ref to sleepCycle so setSkillOptimizer can be called after SkillOptimizer init. */
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
      // Capture ref for SkillOptimizer setter injection (post-calibration-tracker init).
      wave13SleepCycleRef = sleepCycle;
      consciousnessInstance.attachSleepCycle(sleepCycle);
      // Wire federation peer-audit into sleep cycle (section 6.4h.2).
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

  // Wire ConfidenceCalibrationTracker into the resolved agent loop.
  if (confidenceCalibrationTracker) {
    try {
      finalAgentLoop.setConfidenceCalibrationTracker(confidenceCalibrationTracker);
      // Also inject into AlignmentAggregator's 8th signal (Brier-drift) — fail-open.
      // The earlier `as unknown as Record` poke masked that
      // getAlignmentAggregator() can return null; surface it honestly.
      const alignAgg = finalAgentLoop.getAlignmentAggregator();
      if (alignAgg) {
        alignAgg.setConfidenceCalibrationTracker(confidenceCalibrationTracker);
      }
    } catch (err: unknown) {
      log.warn({ err: String(err) }, 'ConfidenceCalibrationTracker wiring failed — calibration hooks disabled');
    }
  }

  // Verify-gate (slice 1: confidence dispatcher + slice 2: grounding check +
  // slice 3: auto-critic). Opt-in via SUDO_VERIFY_GATE=1. Slice 1 reads
  // per-tool live confidence from audit.db before every destructive tool
  // call; 'escalate' decisions emit a hook event. Slice 2 layers a grounding
  // pass (re-read target file / stat referenced path) on top: observable-only
  // by default, hard block when SUDO_VERIFY_GATE_BLOCK=1. Slice 3 auto-invokes
  // the reviewer agent role on observable grounding failures and emits its
  // verdict as a hook event (never blocks). Per-session critic-call budget
  // capped by SUDO_VERIFY_GATE_CRITIC_BUDGET (default 3). Fail-open: any
  // wiring or fs error leaves the loop unchanged.
  if (process.env['SUDO_VERIFY_GATE'] === '1') {
    try {
      const { ConfidenceGate } = await import('./core/agent/verify-gate.js');
      // ToolRegistry.get returns ToolDefinition | undefined; ToolDefinition
      // has both `name` and `safety?: 'readonly' | 'destructive'` — the only
      // two fields ToolRegistryForGate.get's return shape requires — so it
      // structurally satisfies the narrower interface via width-extension.
      const gate = new ConfidenceGate(registry);
      finalAgentLoop.setVerifyGate(gate);

      const { GroundingChecker, isGroundingBlockEnabled } = await import('./core/agent/verify-gate-grounding.js');
      const grounding = new GroundingChecker();
      const blockOnFail = isGroundingBlockEnabled();
      finalAgentLoop.setGroundingChecker(grounding, blockOnFail);

      const { CriticPass, readCriticBudget } = await import('./core/agent/verify-gate-critic.js');
      // Brain structurally satisfies CriticBrainLike (same call(req)→{content}
      // surface) — the earlier unknown bridge papered over three width
      // extensions that all satisfy the critic's narrower type:
      // (a) BrainResponse extends {content: string} with usage/finishReason,
      // (b) BrainRequest extends the input shape with extra optional fields,
      // (c) Brain.call has an extra optional `opts?: BrainCallOpts` parameter
      //     the narrower interface doesn't declare — invisible to callers
      //     using CriticBrainLike, so structurally fine.
      const critic = new CriticPass(brain);
      finalAgentLoop.setCriticPass(critic);

      log.info(
        { blockOnFail, criticBudget: readCriticBudget() },
        'VerifyGate: slice-1 confidence dispatcher + slice-2 grounding check + slice-3 auto-critic wired (SUDO_VERIFY_GATE=1)',
      );
    } catch (err: unknown) {
      log.warn({ err: String(err) }, 'VerifyGate wiring failed — verify-gate disabled');
    }
  }

  // Wire InjectionDetector into the resolved agent loop.
  try {
    finalAgentLoop.setInjectionDetector(injectionDetector);
  } catch (err: unknown) {
    log.warn({ err: String(err) }, 'InjectionDetector wiring failed — injection scan hooks disabled');
  }

  // Wire SkillDiscovery into agent loop (fail-open)
  if (wave13SkillDiscovery) {
    try {
      finalAgentLoop.setSkillDiscovery(wave13SkillDiscovery);
    } catch (err: unknown) {
      log.warn({ err: String(err) }, 'Wave 10B: SkillDiscovery wiring failed — learning feed disabled');
    }
  }

  // Wire TaintTracker into agent loop (fail-open, kill-switch: SUDO_TAINT_DISABLE=1).
  if (process.env['SUDO_TAINT_DISABLE'] !== '1') {
    try {
      finalAgentLoop.setTaintTracker(taintTracker);
    } catch (err: unknown) {
      log.warn({ err: String(err) }, 'TaintTracker wiring into loop failed — taint violation checks disabled');
    }
  }

  // Opt-in ToolOutcomeLearner activation: attach failure learning to the loop
  // (record failed tool calls + inject prevention-rule hints). Default OFF —
  // without this flag the learner is never attached, so the FailureLearner
  // never runs. Honors the SUDO_TOOL_LEARNING_DISABLE kill-switch internally.
  // Fail-open: a wiring failure logs and the loop runs without learning.
  if (process.env['SUDO_TOOL_OUTCOME_LEARNER'] === '1') {
    try {
      const { ToolOutcomeLearner } = await import('./core/agent/tool-outcome-learner.js');
      const failureLearner = await import('./core/learning/failure-learner.js');
      finalAgentLoop.setToolOutcomeLearner(new ToolOutcomeLearner({ failureLearner }));
      log.info('ToolOutcomeLearner wired into agent loop — failure learning active (SUDO_TOOL_OUTCOME_LEARNER=1)');
    } catch (err: unknown) {
      log.warn({ err: String(err) }, 'ToolOutcomeLearner wiring failed — outcome learning disabled');
    }
  }

  // gap #18 — plan mode write-gate. Opt-in via SUDO_PLAN_MODE=1. Wires the
  // latent PlanModeStateMachine (loop.ts already constructs one but its
  // tools were schema-only — no executors, no gate). When the flag is set:
  //   1. The meta.enter-plan-mode / meta.exit-plan-mode executors are
  //      injected with the existing state machine instance.
  //   2. ToolRegistry.setPlanModeGate hooks the state machine so every
  //      destructive tool call is rejected with `plan_mode_blocked` while
  //      the state is `plan_mode` or `plan_approval`.
  //   3. The executors are registered on the registry.
  if (process.env['SUDO_PLAN_MODE'] === '1') {
    try {
      const pms = finalAgentLoop.getPlanModeStateMachine();
      if (!pms) {
        log.warn('SUDO_PLAN_MODE=1 but AgentLoop has no PlanModeStateMachine — skipping');
      } else {
        const { gateFromStateMachine } = await import('./core/agent/plan-mode-gate.js');
        const planModeTools = await import('./core/tools/builtin/meta/plan-mode-tools.js');
        planModeTools.setPlanModeStateMachine(pms);
        registry.register(planModeTools.enterPlanModeTool);
        registry.register(planModeTools.exitPlanModeTool);
        registry.register(planModeTools.planModeStatusTool);
        registry.setPlanModeGate(gateFromStateMachine(pms));
        log.info('plan mode write-gate active (SUDO_PLAN_MODE=1)');
      }
    } catch (err: unknown) {
      log.warn({ err: String(err) }, 'plan-mode wiring failed — gate not installed');
    }
  }

  // gap #20 — LLM-written memory consolidation. Opt-in SUDO_MEMORY_CONSOLIDATE=1
  // registers `meta.memory-consolidate`, an agent/operator-callable tool that
  // distills MEMORY.md into an organized human-readable form via the brain.
  // Default OFF (a brain round-trip per call is the cost; we don't trigger it
  // on a timer in this slice — the agent decides when to call it).
  if (process.env['SUDO_MEMORY_CONSOLIDATE'] === '1') {
    try {
      const { memoryConsolidateTool } = await import('./core/tools/builtin/meta/memory-consolidate.js');
      registry.register(memoryConsolidateTool);
      log.info('meta.memory-consolidate registered (SUDO_MEMORY_CONSOLIDATE=1)');
    } catch (err: unknown) {
      log.warn({ err: String(err) }, 'memory-consolidate wiring failed — tool not registered');
    }
  }

  // gap #22 — always-on read-only meta tools:
  //   meta.classify-bash : static bash safety classifier (no subprocess)
  //   meta.search-tools  : keyword search over the local ToolRegistry so
  //                        the agent can find tools by capability without
  //                        all schemas being injected at boot.
  // Both are safe:'readonly' and require no approval, hence no flag.
  try {
    const { classifyBashTool } = await import('./core/tools/builtin/meta/classify-bash.js');
    const { searchToolsTool, setSearchToolsRegistry } = await import('./core/tools/builtin/meta/search-tools.js');
    registry.register(classifyBashTool);
    setSearchToolsRegistry(registry);
    registry.register(searchToolsTool);
    log.info('gap #22 meta tools registered: meta.classify-bash + meta.search-tools');
  } catch (err: unknown) {
    log.warn({ err: String(err) }, 'gap #22 meta-tool wiring failed — tools not registered');
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

        // Retention: keep traces.db bounded — prune by age + row cap at boot, then
        // daily (mirrors the LoopSignatureStore prune wiring). Defaults
        // (SUDO_TRACE_RETENTION_DAYS=30, SUDO_TRACE_MAX_ROWS=200000) are on; set
        // either to 0 to disable that bound. Fail-open; the timer is unref'd so it
        // never holds the process open and is cleared on shutdown.
        try {
          const prunedTraces = traceStore.prune();
          log.info({ pruned: prunedTraces }, 'TraceStore retention: pruned at boot');
        } catch (err) {
          log.warn({ err: String(err) }, 'TraceStore retention: boot prune failed — continuing');
        }
        const tracePruneTimer = setInterval(() => {
          try { traceStore.prune(); } catch (err) { log.warn({ err: String(err) }, 'TraceStore retention: prune failed'); }
        }, 24 * 60 * 60 * 1000);
        if (tracePruneTimer.unref) tracePruneTimer.unref();
        registerShutdown(() => clearInterval(tracePruneTimer));

        // Theme 1 slice 2: TraceDrivenPolicy — learned ROUTING INFLUENCE.
        // Strictly opt-in BEYOND recording (SUDO_TRACE_POLICY=1) and honoring the
        // module kill-switch (SUDO_POLICY_DISABLE=1). Conservative by construction
        // (rules need >=5 calls and confidence >= 0.3), fail-open, and a no-op until
        // enough trace history accumulates. Rules are built once at boot, then
        // (opt-in) refreshed in the BACKGROUND so they don't go stale as new traces
        // accumulate: SUDO_POLICY_REFRESH_MS schedules a bounded, sync aggregation in
        // a standalone unref'd timer — off every request's critical path.
        if (process.env['SUDO_TRACE_POLICY'] === '1' && process.env['SUDO_POLICY_DISABLE'] !== '1') {
          const traceAnalyzer = new TraceAnalyzer(traceStore);
          const tracePolicy = new TraceDrivenPolicy(traceStore, traceAnalyzer);
          tracePolicy.refreshPolicies();
          finalAgentLoop.setTraceDrivenPolicy(tracePolicy);
          const policyRefreshMs = Number(process.env['SUDO_POLICY_REFRESH_MS'] ?? 0);
          if (policyRefreshMs > 0) {
            const stopPolicyRefresh = startPolicyRefreshLoop(
              tracePolicy,
              policyRefreshMs,
              (err) => log.warn({ err: String(err) }, 'Learning flywheel: background policy refresh failed — continuing'),
            );
            registerShutdown(stopPolicyRefresh);
            log.info({ intervalMs: Math.max(POLICY_REFRESH_MIN_MS, policyRefreshMs) }, 'Learning flywheel: background policy refresh scheduled');
          }
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

  // Chat-based tool approvals (opt-in: SUDO_CHAT_APPROVALS=1). When enabled,
  // tools with requiresConfirmation send a YES/NO prompt to the originating
  // chat instead of auto-approving headless. Approval replies are consumed
  // by the admission guard ABOVE the per-peer turn queue (see
  // tryConsumeApprovalReply call sites) — queued behind the blocked turn
  // they would deadlock until the 60 s timeout denies.
  const chatApprovals = process.env['SUDO_CHAT_APPROVALS'] === '1';
  if (chatApprovals) log.info('Chat-based tool approvals enabled (SUDO_CHAT_APPROVALS=1)');

  // Hoisted so web handler can send Telegram notifications when long tasks finish.
  let telegramNotifier: TelegramAdapter | null = null;

  // Hoisted so the long-task / high-crit notification handlers can reach WhatsApp.
  // (All other adapters dispatch via the channel-outbox registry, not hoisted vars.)
  let whatsAppAdapter: import('./core/channels/whatsapp.js').WhatsAppAdapter | null = null;

  // Slash command registration — shared by ALL channel adapters (previously
  // inside the Telegram block, so a Telegram-disabled boot had no commands).
  // The core set (/model /reset /persona /stop /queue ...) registers first;
  // the deps-injected builtin set then overrides status/tools/help with the
  // richer implementations.
  try {
    const { registerBuiltinCommands: registerCoreCommands } = await import('./core/commands/index.js');
    registerCoreCommands(commandRegistry);
    const { registerBuiltinCommands } = await import('./core/commands/builtin.js');
    registerBuiltinCommands(commandRegistry, {
      toolRegistry: registry,
      sessionManager: dualSessionManager,
      costTracker,
      consciousness: consciousness ?? undefined,
    });
    log.info('Slash commands registered');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ err: msg }, 'Command registration failed — continuing without slash commands');
  }

  // Shared CommandContext factory for every channel's directive dispatch.
  const makeCommandContext = async (msg: { channel: string; peerId: string }): Promise<CommandContext | null> => {
    try {
      const session = await dualSessionManager.getOrCreate(
        msg.channel as import('./core/channels/types.js').ChannelType,
        msg.peerId,
      );
      return {
        channel: msg.channel,
        peerId: msg.peerId,
        sessionId: String(session.id),
        agentLoop: finalAgentLoop,
        toolRegistry: registry,
        config,
        db,
        peerQueue: dualSessionManager.peerQueue,
      };
    } catch (err) {
      log.error({ peerId: msg.peerId, err: String(err) }, 'CommandContext factory failed');
      return null;
    }
  };

  // Directive short-circuits on every channel (opt-in: SUDO_CHANNEL_COMMANDS=1).
  // When enabled, slash commands on Discord/Slack/WhatsApp/Web/Email/SMS and
  // the routed channels are intercepted BEFORE the per-peer turn queue, so
  // /stop and /reset work even while a turn is in flight. Telegram's adapter
  // intercept is always on (pre-existing behaviour).
  const channelDirectives = process.env['SUDO_CHANNEL_COMMANDS'] === '1';
  if (channelDirectives) log.info('Cross-channel slash directives enabled (SUDO_CHANNEL_COMMANDS=1)');

  if (config.channels.telegram.enabled && process.env['SUDO_TELEGRAM_DISABLE'] !== '1') {
    const tgAllowed = (process.env['TELEGRAM_CHAT_ID'] ?? '')
      .split(',').map(s => s.trim()).filter(Boolean);
    const telegram = new TelegramAdapter(
      'TELEGRAM_BOT_TOKEN',  // env key name, not the token value
      tgAllowed.length > 0 ? tgAllowed : config.channels.telegram.allowedUsers,
    );
    telegram.setHookEmitter(hooks);
    telegramNotifier = telegram;
    registerOutboundAdapter(telegram); // proactive scheduled-message delivery (channel-outbox)
    if (chatApprovals) approvalManager.registerSender('telegram', telegram);

    // Serialized per-peer: enqueue so concurrent messages from the same user
    // never overlap on the same session (prevents race conditions). Resolves
    // when the turn fully completes (reply sent) — the coalescer's
    // foreground-reply fence depends on that.
    const handleTelegramTurn = (msg: UnifiedMessage): Promise<void> =>
      dualSessionManager.peerQueue.enqueue(msg.peerId, async () => {
        // Hoisted out of the try-block so the outer catch can cancel it
        // (verifier HIGH #2). When SUDO_STREAM_CHANNELS=1 is unset this
        // stays null and the byte-identical pre-PR send path runs.
        let streamSink: { chunk(t: string): void; finalize(t: string): Promise<void>; cancel(): Promise<void> } | null = null;
        try {
          const convKey = `${msg.channel}:${msg.peerId}`;
          const runGen = runGenerations.current(convKey);
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

          // gap #19 — streamed agent loop on Telegram. Opt-in
          // SUDO_STREAM_CHANNELS=1. Creates a placeholder message that gets
          // edited in place as `stream-chunk` events fire, then a final
          // edit with the canonical replyText. Fail-open: sink construction
          // errors fall through to the normal send path.
          // Use the real AgentEventHandler signature — `ev.chunk` is non-
          // optional on the 'stream-chunk' variant of the discriminated
          // union and the narrow is what we filter on (verifier HIGH #1).
          let onEvent: import('./core/agent/types.js').AgentEventHandler | undefined;
          if (process.env['SUDO_STREAM_CHANNELS'] === '1') {
            try {
              const { createBufferedEditSink } = await import('./core/channels/stream-sink.js');
              streamSink = await createBufferedEditSink(
                (placeholder: string) => telegram.sendForStream(msg.peerId, placeholder),
                (id: string | number, text: string) => telegram.editText(msg.peerId, id, text),
                // maxChars clamps BEFORE same-text suppression so the sink
                // and Telegram's 4096-char editMessageText cap agree on the
                // wire body — preventing duplicate edits whose only delta
                // is past Telegram's truncation point (verifier HIGH #3).
                { intervalMs: 800, maxChars: 4080, placeholder: '…', label: `telegram:${msg.peerId}` },
              );
              onEvent = (ev) => {
                if (ev.type === 'stream-chunk') {
                  streamSink!.chunk(ev.chunk);
                }
              };
            } catch (sinkErr) {
              log.warn({ err: String(sinkErr) }, 'gap #19: stream sink construction failed — falling back to batched send');
              streamSink = null;
              onEvent = undefined;
            }
          }
          const result = await finalAgentLoop.run(String(session.id), msg.text ?? '', onEvent, { race: true });
          if (runGenerations.isStale(convKey, runGen)) {
            if (streamSink) await streamSink.cancel();
            log.info({ peerId: msg.peerId }, 'Run generation changed mid-turn (e.g. /reset) — discarding stale reply');
            return;
          }
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

          // Send reply + feedback keyboard (skip for greetings/very short replies).
          // gap #19: when a stream sink is active, finalize it with the canonical
          // text and send the feedback keyboard as a separate follow-up message
          // (Telegram cannot attach a reply_markup via editMessageText without
          // also editing inline-keyboard state — simpler to keep the keyboard
          // on its own message).
          const isSubstantialReply = (replyText.length > 80);
          if (streamSink) {
            await streamSink.finalize(replyText);
            if (isSubstantialReply) {
              const { keyboard } = createFeedbackKeyboard(
                String(session.id),
                (msg.text ?? replyText).slice(0, 120),
                'telegram',
              );
              try {
                await telegram.sendWithKeyboard(msg.peerId, '⋯', keyboard);
              } catch (kbErr) {
                log.warn({ err: String(kbErr) }, 'gap #19: feedback keyboard follow-up failed');
              }
            }
          } else if (isSubstantialReply) {
            const { keyboard } = createFeedbackKeyboard(
              String(session.id),
              (msg.text ?? replyText).slice(0, 120),
              'telegram',
            );
            await maybeGuardedSend('telegram', msg.peerId, replyText, () => telegram.sendWithKeyboard(msg.peerId, replyText, keyboard));
          } else {
            await maybeGuardedSend('telegram', msg.peerId, replyText, () => telegram.send(msg.peerId, replyText));
          }
          log.info({ peerId: msg.peerId, streamed: streamSink !== null }, 'Reply sent to Telegram');
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          log.error({ err: errMsg, peerId: msg.peerId }, 'Agent turn failed');
          // gap #19 — cancel the stream sink before sending the error so
          // a zombie partial-message stays frozen rather than being
          // edited again after the error has surfaced (verifier HIGH #2).
          if (streamSink) {
            try { await streamSink.cancel(); } catch { /* already-warned */ }
          }
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
      });

    // Burst debounce/coalesce + foreground-reply fence (opt-in: SUDO_MSG_COALESCE=1;
    // idle window via SUDO_MSG_COALESCE_MS, default 1000 ms, 0 = flush on next tick).
    // handleTelegramTurn rejections propagate so the coalescer logs real failures.
    const coalesceWindowMs = Number(process.env['SUDO_MSG_COALESCE_MS']);
    const telegramCoalescer = process.env['SUDO_MSG_COALESCE'] === '1'
      ? new MessageCoalescer({
          deliver: handleTelegramTurn,
          ...(process.env['SUDO_MSG_COALESCE_MS'] !== undefined && Number.isFinite(coalesceWindowMs) && coalesceWindowMs >= 0
            ? { debounceMs: coalesceWindowMs }
            : {}),
        })
      : null;
    if (telegramCoalescer) log.info('Telegram message coalescer enabled');

    // Group-chat mention gating (opt-in: SUDO_GROUP_MENTION_ONLY=1): in groups,
    // only respond when the message mentions the bot by @username.
    const groupMentionOnly = process.env['SUDO_GROUP_MENTION_ONLY'] === '1';

    telegram.onMessage(async (msg) => {
      log.info(
        { channel: msg.channel, peerId: msg.peerId, chatType: msg.chatType, text: msg.text?.slice(0, 80) },
        'Incoming message',
      );

      // Admission guard: approval replies are consumed BEFORE the coalescer
      // and the turn queue (a reply queued behind the turn awaiting it would
      // deadlock; a coalesced reply would be swallowed into a batch).
      if (approvalManager.tryConsumeApprovalReply(msg.text)) {
        log.info({ peerId: msg.peerId }, 'Approval reply consumed — not queued as a turn');
        return;
      }

      if (groupMentionOnly) {
        const botNames = [telegram.botUsername ?? '', process.env['SUDO_BOT_NAME'] ?? ''].filter(Boolean);
        if (!isAddressedToBot(msg, botNames)) {
          log.debug({ peerId: msg.peerId, chatType: msg.chatType }, 'Group message not addressed to bot — ignored');
          return;
        }
      }

      if (telegramCoalescer) {
        telegramCoalescer.push(msg);
      } else {
        // MessageHandler contract: must not throw — catch here, not inside
        // handleTelegramTurn, so the coalescer path sees real rejections.
        await handleTelegramTurn(msg).catch((err: unknown) => {
          log.error({ err: String(err), peerId: msg.peerId }, 'Queued agent turn failed');
        });
      }
    });

    // Wire CommandRegistry to the Telegram adapter (registration happens in
    // the shared block above, before the channel sections).
    telegram.setCommandRegistry(commandRegistry, makeCommandContext);
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
      registerOutboundAdapter(discord);
      discord.setHookEmitter(hooks);      if (chatApprovals) approvalManager.registerSender('discord', discord);

      discord.onMessage(async (msg) => {
        log.info(
          { channel: msg.channel, peerId: msg.peerId, text: msg.text?.slice(0, 80) },
          'Discord incoming message',
        );

        if (approvalManager.tryConsumeApprovalReply(msg.text)) {
          log.info({ peerId: msg.peerId }, 'Approval reply consumed — not queued as a turn');
          return;
        }

        // Directive short-circuit: slash commands bypass the turn queue.
        if (channelDirectives && await tryDispatchDirective({
          registry: commandRegistry, msg, makeContext: makeCommandContext,
          reply: (text) => discord.send(msg.peerId, text),
        })) return;

        dualSessionManager.peerQueue.enqueue(msg.peerId, async () => {
          try {
            const convKey = `${msg.channel}:${msg.peerId}`;
            const runGen = runGenerations.current(convKey);
            const session = await dualSessionManager.getOrCreate(msg.channel, msg.peerId);
            log.info({ sessionId: String(session.id) }, 'Discord session resolved');

            const result = await finalAgentLoop.run(String(session.id), msg.text ?? '', undefined, { race: true });
            if (runGenerations.isStale(convKey, runGen)) {
              log.info({ peerId: msg.peerId }, 'Run generation changed mid-turn (e.g. /reset) — discarding stale reply');
              return;
            }
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
      registerOutboundAdapter(slack);
      if (chatApprovals) approvalManager.registerSender('slack', slack);

      slack.onMessage(async (msg) => {
        log.info(
          { channel: msg.channel, peerId: msg.peerId, text: msg.text?.slice(0, 80) },
          'Slack incoming message',
        );

        if (approvalManager.tryConsumeApprovalReply(msg.text)) {
          log.info({ peerId: msg.peerId }, 'Approval reply consumed — not queued as a turn');
          return;
        }

        // Directive short-circuit: slash commands bypass the turn queue.
        if (channelDirectives && await tryDispatchDirective({
          registry: commandRegistry, msg, makeContext: makeCommandContext,
          reply: (text) => slack.send(msg.peerId, text),
        })) return;

        dualSessionManager.peerQueue.enqueue(msg.peerId, async () => {
          try {
            const convKey = `${msg.channel}:${msg.peerId}`;
            const runGen = runGenerations.current(convKey);
            const session = await dualSessionManager.getOrCreate(msg.channel, msg.peerId);
            log.info({ sessionId: String(session.id) }, 'Slack session resolved');

            const result = await finalAgentLoop.run(String(session.id), msg.text ?? '', undefined, { race: true });
            if (runGenerations.isStale(convKey, runGen)) {
              log.info({ peerId: msg.peerId }, 'Run generation changed mid-turn (e.g. /reset) — discarding stale reply');
              return;
            }
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
  // 7.3 WhatsApp channel adapter (opt-in, default OFF)
  //     Disabled by default. The WhatsApp integration relies on Baileys, which
  //     reverse-engineers WhatsApp Web and is against WhatsApp's Terms of
  //     Service (using it may get your number banned). It must be explicitly
  //     enabled with SUDO_WHATSAPP_ENABLE=1, in addition to WHATSAPP_TOKEN.
  //     WHATSAPP_TOKEN is an activation flag only; the adapter uses Baileys
  //     file-based auth stored in data/whatsapp-auth/ — no token is consumed.
  // -------------------------------------------------------------------------
  const whatsAppOptIn = process.env['SUDO_WHATSAPP_ENABLE'] === '1';
  if (whatsAppOptIn && process.env['WHATSAPP_TOKEN']) {
    log.warn(
      "WhatsApp channel enabled via SUDO_WHATSAPP_ENABLE=1 — this uses Baileys " +
        "(unofficial WhatsApp Web), which violates WhatsApp's Terms of Service and " +
        "may get your number banned. You are responsible for compliant, consented use.",
    );
    try {
      const { WhatsAppAdapter } = await import('./core/channels/whatsapp.js');

      const whatsAppAllowedJids = (process.env['WHATSAPP_ALLOWED_JIDS'] ?? '')
        .split(',').map((s) => s.trim()).filter(Boolean);

      const whatsapp = new WhatsAppAdapter(undefined, whatsAppAllowedJids);
      registerOutboundAdapter(whatsapp);
      whatsapp.setHookEmitter(hooks);
      whatsAppAdapter = whatsapp;
      if (chatApprovals) approvalManager.registerSender('whatsapp', whatsapp);

      whatsapp.onMessage(async (msg) => {
        log.info(
          { channel: msg.channel, peerId: msg.peerId, text: msg.text?.slice(0, 80) },
          'WhatsApp incoming message',
        );

        if (approvalManager.tryConsumeApprovalReply(msg.text)) {
          log.info({ peerId: msg.peerId }, 'Approval reply consumed — not queued as a turn');
          return;
        }

        // Directive short-circuit: slash commands bypass the turn queue.
        if (channelDirectives && await tryDispatchDirective({
          registry: commandRegistry, msg, makeContext: makeCommandContext,
          reply: (text) => whatsapp.send(msg.peerId, text),
        })) return;

        dualSessionManager.peerQueue.enqueue(msg.peerId, async () => {
          try {
            const convKey = `${msg.channel}:${msg.peerId}`;
            const runGen = runGenerations.current(convKey);
            const session = await dualSessionManager.getOrCreate(msg.channel, msg.peerId);
            log.info({ sessionId: String(session.id) }, 'WhatsApp session resolved');

            const result = await finalAgentLoop.run(String(session.id), msg.text ?? '', undefined, { race: true });
            if (runGenerations.isStale(convKey, runGen)) {
              log.info({ peerId: msg.peerId }, 'Run generation changed mid-turn (e.g. /reset) — discarding stale reply');
              return;
            }
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

            await maybeGuardedSend('whatsapp', msg.peerId, replyText, () => whatsapp.send(msg.peerId, replyText));
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
  } else if (process.env['WHATSAPP_TOKEN']) {
    log.info(
      'WhatsApp channel disabled: WHATSAPP_TOKEN is set but SUDO_WHATSAPP_ENABLE=1 ' +
        'is required to opt in (Baileys is against WhatsApp ToS).',
    );
  } else {
    log.info('WhatsApp channel disabled (set SUDO_WHATSAPP_ENABLE=1 and WHATSAPP_TOKEN in .env to enable)');
  }

  // -------------------------------------------------------------------------
  // 7.5 Web chat adapter (HTTP + WebSocket) — disabled by default
  //     Enable with: WEB_CHAT_ENABLED=true in config/.env
  // -------------------------------------------------------------------------
  if (process.env['WEB_CHAT_ENABLED'] === 'true') try {
    const { WebAdapter, agentEventToWebFrame } = await import('./core/channels/web.js');
    const web = new WebAdapter();
    registerOutboundAdapter(web);
    if (chatApprovals) approvalManager.registerSender('web', web);

    web.onMessage(async (msg) => {
      log.info(
        { channel: msg.channel, peerId: msg.peerId, text: msg.text?.slice(0, 80) },
        'Web incoming message',
      );

      if (approvalManager.tryConsumeApprovalReply(msg.text)) {
        log.info({ peerId: msg.peerId }, 'Approval reply consumed — not queued as a turn');
        return;
      }

      // Directive short-circuit: slash commands bypass the turn queue.
      if (channelDirectives && await tryDispatchDirective({
        registry: commandRegistry, msg, makeContext: makeCommandContext,
        reply: (text) => web.send(msg.peerId, text),
      })) return;

      // Serialized per-peer: enqueue so concurrent messages from the same user
      // never overlap on the same session (prevents race conditions).
      dualSessionManager.peerQueue.enqueue(msg.peerId, async () => {
        // taskStartMs measured at execution time (excludes queue wait).
        const taskStartMs = Date.now();
        try {
          const convKey = `${msg.channel}:${msg.peerId}`;
          const runGen = runGenerations.current(convKey);
          const session = await dualSessionManager.getOrCreate(msg.channel, msg.peerId);
          // Stream live activity (tool calls + intermediate text) to the browser so a
          // long turn shows progress instead of a silent wait. Default-on; SUDO_WEB_STREAM=0
          // disables. Best-effort: a failed frame never breaks the turn.
          const webStreaming = process.env['SUDO_WEB_STREAM'] !== '0';
          const onWebEvent: import('./core/agent/types.js').AgentEventHandler | undefined = webStreaming
            ? (ev) => {
                try {
                  const frame = agentEventToWebFrame(ev);
                  if (frame) void web.send(msg.peerId, frame).catch(() => { /* ws closed mid-stream */ });
                } catch { /* never break the turn on a streaming frame */ }
              }
            : undefined;
          const webResult = await finalAgentLoop.run(String(session.id), msg.text ?? '', onWebEvent, { race: true });
          if (runGenerations.isStale(convKey, runGen)) {
            log.info({ peerId: msg.peerId }, 'Run generation changed mid-turn (e.g. /reset) — discarding stale reply');
            return;
          }
          const webReplyText = webResult?.text ?? 'No response generated.';
          const webAttachments = webResult?.attachments ?? [];
          log.info({ replyLen: webReplyText.length, attachmentCount: webAttachments.length }, 'Web agent reply ready');

          // Save web turn to daily memory log (skip loopback/diagnostic probes —
          // those pollute the "## Today" prompt injection; opt-in via
          // SUDO_SKIP_DIAGNOSTIC_DAILY_LOG).
          if (shouldSkipDailyLogForMessage(msg.peerId, msg.peerIp)) {
            log.debug({ peerId: msg.peerId }, 'daily-log: skipped diagnostic/loopback web turn');
          } else {
            try {
              const webTurnSummary = `**User (web):** ${(msg.text ?? '').slice(0, 200)}\n**Agent:** ${webReplyText.slice(0, 500)}`;
              await dailyLog.append(webTurnSummary);
            } catch { /* daily log write is non-fatal */ }
          }

          // Deliver agent file attachments (voice replies, images, generated files)
          // to the browser before the text reply — mirrors the Telegram path.
          if (webAttachments.length > 0) {
            const { readFileSync, existsSync } = await import('node:fs');
            for (const att of webAttachments) {
              try {
                if (!existsSync(att.path)) {
                  log.warn({ path: att.path }, 'Web attachment file not found on disk — skipping');
                  continue;
                }
                const buffer = readFileSync(att.path);
                const ext = att.path.split('.').pop()?.toLowerCase() ?? '';
                const mimeType =
                  att.type === 'image'
                    ? (ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/png')
                    : att.type === 'audio'
                    ? (ext === 'mp3' ? 'audio/mpeg' : ext === 'ogg' ? 'audio/ogg' : 'audio/wav')
                    : att.type === 'video'
                    ? 'video/mp4'
                    : 'application/octet-stream';
                await web.sendMedia(msg.peerId, {
                  type: att.type,
                  mimeType,
                  buffer,
                  filename: att.filename ?? att.path.split('/').pop() ?? 'file',
                });
                log.info({ peerId: msg.peerId, path: att.path, type: att.type }, 'Attachment sent to Web');
              } catch (attErr) {
                log.warn({ err: String(attErr), path: att.path }, 'Failed to send web attachment — continuing');
              }
            }
          }

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
      registerOutboundAdapter(email);
      email.setHookEmitter(hooks);      if (chatApprovals) approvalManager.registerSender('email', email);

      email.onMessage(async (msg) => {
        log.info(
          { channel: msg.channel, peerId: msg.peerId, text: msg.text?.slice(0, 80) },
          'Email incoming message',
        );

        if (approvalManager.tryConsumeApprovalReply(msg.text)) {
          log.info({ peerId: msg.peerId }, 'Approval reply consumed — not queued as a turn');
          return;
        }

        // Directive short-circuit: slash commands bypass the turn queue.
        if (channelDirectives && await tryDispatchDirective({
          registry: commandRegistry, msg, makeContext: makeCommandContext,
          reply: (text) => email.send(msg.peerId, text),
        })) return;

        dualSessionManager.peerQueue.enqueue(msg.peerId, async () => {
          try {
            const convKey = `${msg.channel}:${msg.peerId}`;
            const runGen = runGenerations.current(convKey);
            const session = await dualSessionManager.getOrCreate(msg.channel, msg.peerId);
            log.info({ sessionId: String(session.id) }, 'Email session resolved');

            const result = await finalAgentLoop.run(String(session.id), msg.text ?? '', undefined, { race: true });
            if (runGenerations.isStale(convKey, runGen)) {
              log.info({ peerId: msg.peerId }, 'Run generation changed mid-turn (e.g. /reset) — discarding stale reply');
              return;
            }
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
      registerOutboundAdapter(sms);
      sms.setHookEmitter(hooks);      if (chatApprovals) approvalManager.registerSender('sms', sms);

      sms.onMessage(async (msg) => {
        log.info(
          { channel: msg.channel, peerId: msg.peerId, text: msg.text?.slice(0, 80) },
          'SMS incoming message',
        );

        if (approvalManager.tryConsumeApprovalReply(msg.text)) {
          log.info({ peerId: msg.peerId }, 'Approval reply consumed — not queued as a turn');
          return;
        }

        // Directive short-circuit: slash commands bypass the turn queue.
        if (channelDirectives && await tryDispatchDirective({
          registry: commandRegistry, msg, makeContext: makeCommandContext,
          reply: (text) => sms.send(msg.peerId, text),
        })) return;

        dualSessionManager.peerQueue.enqueue(msg.peerId, async () => {
          try {
            const convKey = `${msg.channel}:${msg.peerId}`;
            const runGen = runGenerations.current(convKey);
            const session = await dualSessionManager.getOrCreate(msg.channel, msg.peerId);
            log.info({ sessionId: String(session.id) }, 'SMS session resolved');

            const result = await finalAgentLoop.run(String(session.id), msg.text ?? '', undefined, { race: true });
            if (runGenerations.isStale(convKey, runGen)) {
              log.info({ peerId: msg.peerId }, 'Run generation changed mid-turn (e.g. /reset) — discarding stale reply');
              return;
            }
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
  // 7.7 Extra channels via MessageRouter — IRC / Matrix / Signal (conditional)
  //     Each adapter activates when its env credentials are present (same
  //     opt-in model as Discord/Slack). One shared turn handler serves all
  //     three; the router serializes per chat and contains handler errors.
  // -------------------------------------------------------------------------
  const extraChannelEnv = {
    irc: Boolean(process.env['IRC_SERVER'] && process.env['IRC_NICK']),
    matrix: Boolean(process.env['MATRIX_HOMESERVER'] && process.env['MATRIX_ACCESS_TOKEN']),
    signal: Boolean(process.env['SIGNAL_PHONE_NUMBER']),
  };
  if (extraChannelEnv.irc || extraChannelEnv.matrix || extraChannelEnv.signal) {
    try {
      const { MessageRouter } = await import('./core/channels/router.js');
      const router = new MessageRouter();

      // Admission guard: approval replies and slash directives bypass the
      // router's per-peer queue (queued behind the blocked turn, an approval
      // reply would deadlock and a /stop could never cancel the turn it
      // targets). Set BEFORE adapters register so no early message can slip
      // past it. Directives are consumed synchronously and executed
      // fire-and-forget; tryDispatchDirective contains its own errors.
      router.setPreDispatchInterceptor((msg) => {
        if (approvalManager.tryConsumeApprovalReply(msg.text)) return true;
        if (channelDirectives && commandRegistry.isCommand(msg.text ?? '')) {
          void tryDispatchDirective({
            registry: commandRegistry, msg, makeContext: makeCommandContext,
            reply: (text) => router.sendToChannel(msg.channel, msg.peerId, text),
          }).then((handled) => {
            // Unlike the cli handlers, the message was already consumed here,
            // so a failed context build cannot fall through to the agent.
            if (!handled) log.warn({ channel: msg.channel, peerId: msg.peerId }, 'Routed directive context unavailable — command dropped');
          }).catch((err: unknown) => {
            log.error({ channel: msg.channel, peerId: msg.peerId, err: String(err) }, 'Routed directive dispatch failed');
          });
          return true;
        }
        return false;
      });

      if (extraChannelEnv.irc) {
        const { IRCAdapter } = await import('./core/channels/irc.js');
        router.registerAdapter(new IRCAdapter());
      }
      if (extraChannelEnv.matrix) {
        const { MatrixAdapter } = await import('./core/channels/matrix.js');
        router.registerAdapter(new MatrixAdapter());
      }
      if (extraChannelEnv.signal) {
        const { SignalAdapter } = await import('./core/channels/signal.js');
        router.registerAdapter(new SignalAdapter());
      }

      if (chatApprovals) {
        for (const ch of router.registeredChannels) {
          approvalManager.registerSender(ch, {
            send: (peerId, text) => router.sendToChannel(ch, peerId, text),
          });
        }
      }

      const routedMentionOnly = process.env['SUDO_GROUP_MENTION_ONLY'] === '1';
      const routedBotNames = [process.env['IRC_NICK'] ?? '', process.env['SUDO_BOT_NAME'] ?? ''].filter(Boolean);
      if (routedMentionOnly && routedBotNames.length === 0) {
        log.warn('SUDO_GROUP_MENTION_ONLY=1 but no bot names known (set SUDO_BOT_NAME) — group gating fails open on routed channels');
      }

      router.setHandler(async (msg) => {
        log.info(
          { channel: msg.channel, peerId: msg.peerId, chatType: msg.chatType, text: msg.text?.slice(0, 80) },
          'Routed channel incoming message',
        );

        if (routedMentionOnly && !isAddressedToBot(msg, routedBotNames)) {
          log.debug({ channel: msg.channel, peerId: msg.peerId }, 'Group message not addressed to bot — ignored');
          return;
        }

        try {
          const convKey = `${msg.channel}:${msg.peerId}`;
          const runGen = runGenerations.current(convKey);
          const session = await dualSessionManager.getOrCreate(msg.channel, msg.peerId);
          const result = await finalAgentLoop.run(String(session.id), msg.text ?? '', undefined, { race: true });
          if (runGenerations.isStale(convKey, runGen)) {
            log.info({ channel: msg.channel, peerId: msg.peerId }, 'Run generation changed mid-turn (e.g. /reset) — discarding stale reply');
            return;
          }
          const replyText = result?.text ?? 'No response generated.';

          if (shouldSkipDailyLogForMessage(msg.peerId, msg.peerIp)) {
            log.debug({ channel: msg.channel, peerId: msg.peerId }, 'daily-log: skipped diagnostic/loopback turn');
          } else {
            try {
              const turnSummary = `**User (${msg.channel}):** ${(msg.text ?? '').slice(0, 200)}\n**Agent:** ${replyText.slice(0, 500)}`;
              await dailyLog.append(turnSummary);
            } catch { /* daily log write is non-fatal */ }
          }

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

          await router.sendToChannel(msg.channel, msg.peerId, replyText);
          log.info({ channel: msg.channel, peerId: msg.peerId }, 'Reply sent via router');
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          log.error({ err: errMsg, channel: msg.channel, peerId: msg.peerId }, 'Routed channel agent turn failed');
          try { await router.sendToChannel(msg.channel, msg.peerId, 'Something went wrong. Please try again.'); } catch { /* best effort */ }
        }
      });

      await router.startAll();
      registerShutdown(() => router.stopAll());
      log.info({ channels: router.registeredChannels }, 'Extra channels active via MessageRouter');
    } catch (err) {
      log.warn({ err: String(err) }, 'Extra channel wiring failed (non-fatal)');
    }
  } else {
    log.info('Extra channels disabled (set IRC_SERVER+IRC_NICK, MATRIX_HOMESERVER+MATRIX_ACCESS_TOKEN, or SIGNAL_PHONE_NUMBER to enable IRC/Matrix/Signal)');
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

  // Single dedup window for heartbeat content. See heartbeat-dedup.ts —
  // suppresses replays of the same heartbeat payload inside the window so
  // the agent doesn't burn turns acknowledging duplicates.
  const { HeartbeatDedup, DEFAULT_HEARTBEAT_DEDUP_WINDOW_MS } = await import('./core/cron/heartbeat-dedup.js');
  const heartbeatDedupWindowMs = Number(process.env['HEARTBEAT_DEDUP_WINDOW_MS'])
    || DEFAULT_HEARTBEAT_DEDUP_WINDOW_MS;
  const heartbeatDedup = new HeartbeatDedup(heartbeatDedupWindowMs);
  log.info(
    { windowMin: Math.round(heartbeatDedupWindowMs / 60_000), disabled: process.env['HEARTBEAT_DEDUP'] === '0' },
    'Heartbeat dedup window initialised',
  );

  // Execute an agent-turn payload in its dedicated session and mirror a summary
  // into the daily memory log. Returns the agent's response text so heartbeat
  // wrapping can inspect it for HEARTBEAT_OK suppression.
  const executeAgentTurn = async (
    payload: Extract<CronPayload, { kind: 'agentTurn' }>,
    job: CronJob,
  ): Promise<string> => {
    const sessionTarget = job.sessionTarget === 'isolated' ? `cron:isolated:${job.id}` : `cron:main`;
    const session = await dualSessionManager.getOrCreate('web', sessionTarget);
    const cronResult = await finalAgentLoop.run(session.id, payload.message);
    try {
      const cronTurnSummary = `**Cron (${job.name}):** ${payload.message.slice(0, 200)}\n**Agent:** ${(cronResult?.text ?? '').slice(0, 500)}`;
      await dailyLog.append(cronTurnSummary);
    } catch { /* daily log write is non-fatal */ }
    log.info({ jobId: job.id }, 'Cron job agent turn completed');
    return cronResult?.text ?? '';
  };

  // Base heartbeat runner, wrapped below by HeartbeatRunner.wrapRunner. Applies
  // the content dedup guard (drop replays inside the window) then runs the turn,
  // returning the response text so wrapRunner can apply HEARTBEAT_OK suppression.
  const runHeartbeatTurn: HeartbeatPayloadRunner = async (payload, job) => {
    if (payload.kind !== 'agentTurn') return; // heartbeat payloads are always agentTurn
    if (process.env['HEARTBEAT_DEDUP'] !== '0') {
      const verdict = heartbeatDedup.check(payload.message);
      if (!verdict.shouldProcess) {
        const ageMin = verdict.firstSeenAt ? Math.round((Date.now() - verdict.firstSeenAt) / 60_000) : 0;
        log.info(
          { jobId: job.id, hash: verdict.hash, firstSeenMinAgo: ageMin },
          'Heartbeat skipped — duplicate content already processed in window',
        );
        return;
      }
    }
    return executeAgentTurn(payload, job);
  };

  // Assigned once the HeartbeatRunner is constructed (it owns wrapRunner). The
  // ?? fallback in cronRunner covers the brief window before assignment.
  let wrappedHeartbeat: HeartbeatPayloadRunner | null = null;

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
        // Semantic compaction (opt-in SUDO_SEMANTIC_COMPACT=1): collapse
        // same-source near-duplicate chunks (cosine >= 0.92) into one canonical
        // row — DELETES the younger duplicate and sums applied_count into the
        // keeper. Evergreen-protected, same-source-only, capped 500/run,
        // fail-open. Adds applied_count + embedding_json columns on first run;
        // when the flag is off the chunks table is never touched. Requires
        // OPENAI_API_KEY (a no-op without it).
        if (process.env['SUDO_SEMANTIC_COMPACT'] === '1') {
          try {
            const emb = new EmbeddingService(db);
            const localEmb = new LocalEmbeddingProvider();
            // Dedup embeds its own texts live for an in-memory cosine compare (no
            // stored cross-model index), so prefer the always-up local model and
            // only fall back to OpenAI — keeps semantic dedup working through the
            // OpenAI quota outage (no 429 "Embedding failed — skipping row").
            if (emb.isAvailable || localEmb.isAvailable) {
              const localFirst = makeLocalFirstEmbed((t: string) => emb.embed(t), localEmb);
              const embedder: SemanticEmbeddingFn = {
                async embed(text: string): Promise<Float32Array> {
                  const v = await localFirst(text);
                  if (!v) throw new Error('embedding unavailable');
                  return v;
                },
              };
              const res = await compactSemanticDuplicates(db.db, embedder, { expectedDim: LOCAL_EMBED_DIM });
              log.info({ jobId: job.id, ...res }, 'Semantic compaction pass complete');
            } else {
              log.debug({ jobId: job.id }, 'Semantic compaction skipped — no embedding API key');
            }
          } catch (scErr) {
            log.warn({ err: String(scErr) }, 'Semantic compaction failed (non-fatal)');
          }
        }
        // Corpus vector backfill (opt-in SUDO_VECTOR_BACKFILL=1): embed active
        // chunks missing an ANN vector into chunks_vec so hybrid-search's vector
        // path returns results instead of silently falling back to BM25. Bounded
        // per run and self-healing — clears the backlog over successive dreams.
        if (isVectorBackfillEnabled() && db.vecLoaded) {
          try {
            const res = await backfillChunkVectors(
              db,
              new EmbeddingService(db),
              new MindDBVectorStore(db.db),
            );
            log.info({ jobId: job.id, ...res }, 'Vector backfill pass complete');
          } catch (vbErr) {
            log.warn({ err: String(vbErr) }, 'Vector backfill failed (non-fatal)');
          }
          // Local fallback index (chunks_vec_local, 384-dim): keep it populated so
          // semantic search survives OpenAI outages (quota/circuit). Local embedding
          // is CPU + key-free, so this runs independently of the OpenAI quota above
          // (disable with SUDO_LOCAL_EMBED=0).
          const localEmbedder = new LocalEmbeddingProvider();
          if (localEmbedder.isAvailable) {
            try {
              const localRes = await backfillChunkVectors(
                db,
                localEmbedder,
                new MindDBVectorStore(db.db, 'chunks_vec_local'),
                { expectedDim: LOCAL_EMBED_DIM },
              );
              log.info({ jobId: job.id, space: 'local', ...localRes }, 'Local vector backfill pass complete');
            } catch (lvErr) {
              log.warn({ err: String(lvErr) }, 'Local vector backfill failed (non-fatal)');
            }
          }
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

    // Heartbeat jobs route through HeartbeatRunner.wrapRunner (assigned below),
    // which layers quiet-hours, per-task interval due-filtering, live
    // HEARTBEAT.md re-read, task-state persistence, and HEARTBEAT_OK
    // suppression on top of runHeartbeatTurn (dedup guard + the agent turn).
    if (job.name === 'system.heartbeat') {
      const run = wrappedHeartbeat ?? runHeartbeatTurn;
      await run(payload, job);
      return;
    }

    // Generic agent-turn payload (non-heartbeat). payload is narrowed to the
    // agentTurn variant here (systemEvent returned above).
    if (payload.kind === 'agentTurn') {
      await executeAgentTurn(payload, job);
    }
  };

  // -------------------------------------------------------------------------
  // 7.9 DB file permission hardening — chmod 0600 on all SQLite DB files (LOW-2).
  // Runs after all DBs are initialised, before cron starts any agent activity.
  // -------------------------------------------------------------------------
  try {
    const dbDir = DATA_DIR;
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

  // Pass mindDb as the optional secondary sink so cron run history mirrors
  // into mind.db.cron_runs. Without this, the table stays empty forever even
  // though jobs fire on schedule, and self-diagnostic reports "Last run: never"
  // for every cron health probe.
  const cronStore = new CronStore(db);
  const cronScheduler = new CronScheduler(cronStore, cronRunner);
  cronScheduler.start();
  registerShutdown(async () => cronScheduler.stop());
  log.info('CronScheduler started');

  const heartbeat = new HeartbeatRunner(cronStore, cronScheduler);
  // Route the live heartbeat through wrapRunner so per-task intervals,
  // HEARTBEAT_OK suppression, live HEARTBEAT.md re-read, and task-state
  // persistence apply (previously wrapRunner was defined but never wired).
  wrappedHeartbeat = heartbeat.wrapRunner(runHeartbeatTurn);
  heartbeat.start();
  registerShutdown(() => heartbeat.stop());
  log.info('HeartbeatRunner started (wrapRunner wired)');

  // Cost-rate watchdog (opt-in, default OFF). Samples $/hour from the
  // api_call_log on a timer and emits a `cost_rate_alert` hook event when spend
  // crosses an absolute ceiling or deviates sharply above the rolling baseline —
  // the live counterpart to the on-demand day-grain predictor anomaly detector.
  // Observable-only: never blocks spend. Fail-open.
  if (process.env['SUDO_COST_RATE_ALERT'] === '1') {
    const { CostRateMonitor, resolveCostRateMonitorConfig } = await import('./core/billing/cost-rate-monitor.js');
    // NB: the billing-module CostTracker (api_call_log / $/hr), distinct from the
    // session-level brain CostTracker constructed above.
    const { getCostTracker } = await import('./core/billing/cost-tracker.js');
    // Adapt HookManager onto the monitor's single-event emitter. `cost_rate_alert`
    // is a first-class HookEvent member, so no cast is needed; the structured alert
    // payload rides the designated `meta` channel.
    const hookEmitter = {
      emit: (event: 'cost_rate_alert', context: Record<string, unknown>): Promise<void> =>
        hooks.emit(event, { event, meta: context }),
    };
    const costRateMonitor = new CostRateMonitor(getCostTracker(), hookEmitter, resolveCostRateMonitorConfig());
    costRateMonitor.start();
    registerShutdown(() => costRateMonitor.stop());
    log.info('CostRateMonitor started (SUDO_COST_RATE_ALERT=1)');
  }

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

  // Schedule AutoDream memory consolidation. Interval defaults to 6h; override
  // with SUDO_DREAM_INTERVAL_MS (e.g. for verification or tuning). The schedule
  // is re-upserted whenever the configured interval differs from the persisted
  // job, so changing the env actually takes effect on the next boot (and reverts
  // when unset) instead of being pinned by the original registration.
  try {
    const dreamJobId = 'auto-dream-consolidation';
    const rawMs = Number(process.env['SUDO_DREAM_INTERVAL_MS']);
    const dreamMs = Number.isFinite(rawMs) && rawMs >= 1000 ? rawMs : 6 * 60 * 60 * 1000;
    const existingDream = cronStore.get(dreamJobId);
    const current = existingDream?.schedule;
    const needsUpsert = !existingDream || current?.kind !== 'every' || current.ms !== dreamMs;
    if (needsUpsert) {
      cronStore.upsert({
        id: dreamJobId,
        name: 'Memory Consolidation (AutoDream)',
        enabled: true,
        schedule: { kind: 'every', ms: dreamMs },
        payload: { kind: 'systemEvent', event: 'dream:run' },
        sessionTarget: 'isolated',
        consecutiveErrors: 0,
      });
    }
    log.info({ intervalMs: dreamMs, rescheduled: needsUpsert }, 'AutoDream scheduled');
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
      gitCwd: PROJECT_ROOT,
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
  // 8.5b Admin-power dependencies (#28b slice 1)
  // Hoisted ahead of the §8.6 dashboard wiring so the dashboard can register
  // the audit chain + updater for /api/admin/* mutation endpoints. §9 below
  // reuses the same auditTrail instance (one SQLite file, one chain writer).
  // -------------------------------------------------------------------------
  let auditTrail: AuditTrail | null = null;
  try {
    auditTrail = new AuditTrail();
  } catch (err) {
    log.warn({ err: String(err) }, 'AuditTrail construction failed (non-fatal) — admin actions will not be audited');
  }
  // Verified fail-open: attachHttpApi (cli.ts:2870, http-api.ts:70) declares
  // `auditTrail?:` and gates all uses (http-api.ts:446, :465) on truthy, so
  // passing `auditTrail ?? undefined` here when construction failed leaves
  // the gateway healthy — just with no inspection-route audit binding.
  let autoUpdater: AutoUpdateManager | null = null;
  try {
    autoUpdater = new AutoUpdateManager({
      config: { ...DEFAULT_UPDATE_CONFIG, projectRoot: PROJECT_ROOT },
    });
    // Note: we don't call .start() here — that would enable the periodic
    // auto-update timer. Slice 1 ships manual-trigger only via the dashboard
    // endpoint; the periodic loop is a follow-up slice.
  } catch (err) {
    log.warn({ err: String(err) }, 'AutoUpdateManager construction failed (non-fatal) — /api/admin/update will report updater_not_registered');
  }

  // Log-ring capture for GET /api/admin/logs (#28b slice 3). Attaches stdout/
  // stderr capture so the dashboard can serve the last N lines without
  // grepping a file. Kill switch: SUDO_DASHBOARD_LOG_RING_DISABLE=1.
  //
  // The ring is process-local — pm2 logs / journald still receive everything,
  // and a process restart starts a fresh ring (slice 3 docs make this honest).
  try {
    const { attachLogRing } = await import('./core/dashboard/log-ring.js');
    const ring = attachLogRing();
    if (ring) {
      log.info({ capacity: ring.capacity() }, 'Dashboard log-ring attached (SUDO_DASHBOARD_LOG_RING_DISABLE=1 to disable)');
    } else {
      log.info('Dashboard log-ring disabled (SUDO_DASHBOARD_LOG_RING_DISABLE=1)');
    }
  } catch (err) {
    log.warn({ err: String(err) }, 'attachLogRing failed (non-fatal) — /api/admin/logs will report log_ring_not_registered');
  }

  // -------------------------------------------------------------------------
  // 8.5c Fleet device identity + registrar wiring (#28c slice 1).
  //
  // ALWAYS: load or create this device's Ed25519 identity at
  //   DATA_DIR/device-identity.json. Cheap (one file read or one keypair gen
  //   on first boot) and idempotent. Slice 2's back-channel will use the
  //   same key to sign heartbeat/result messages, so we want it loaded
  //   regardless of registrar mode.
  //
  // OPT-IN: when SUDO_FLEET_REGISTRAR_MODE=1, construct a RegistryStore over
  //   DATA_DIR/fleet.db and register it under __sudoFleetRegistrar so the
  //   dashboard's POST /api/fleet/register + GET /api/admin/fleet/devices
  //   routes go live. Otherwise both routes 503.
  //
  // OPT-IN: when SUDO_FLEET_REGISTRAR_URL is set, POST a signed registration
  //   to that URL after the dashboard finishes wiring (so devices behind
  //   the same daemon can register with a remote registrar). Best-effort —
  //   network errors log warn and boot continues.
  // -------------------------------------------------------------------------
  let fleetIdentity: import('./core/fleet/device-identity.js').DeviceIdentity | null = null;
  let fleetRegistrar: import('./core/fleet/registry-store.js').RegistryStore | null = null;
  let fleetCommandQueue: import('./core/fleet/command-queue.js').CommandQueue | null = null;
  let fleetNonceStore: import('./core/fleet/nonce-store.js').NonceStore | null = null;
  try {
    const { loadOrCreateDeviceIdentity, defaultIdentityPath } =
      await import('./core/fleet/device-identity.js');
    const dataDir = process.env['DATA_DIR'] ?? '/tmp';
    fleetIdentity = loadOrCreateDeviceIdentity(defaultIdentityPath(dataDir));
    log.info({ deviceId: fleetIdentity.deviceId }, 'Fleet device identity loaded (#28c slice 1)');

    if (process.env['SUDO_FLEET_REGISTRAR_MODE'] === '1') {
      const { RegistryStore, defaultRegistryDbPath, resolveAdmissionDefault } =
        await import('./core/fleet/registry-store.js');
      // Slice-4 follow-up: SUDO_FLEET_ADMISSION_DEFAULT=pending stamps
      // newly-registered devices as `pending`, requiring an admin admit
      // before they can dispatch or poll the back-channel. Default
      // (anything else) is `approved`, preserving slice-1+2+3 behavior.
      const admissionDefault = resolveAdmissionDefault(process.env);
      fleetRegistrar = new RegistryStore({
        dbPath: defaultRegistryDbPath(dataDir),
        admissionDefault,
      });
      log.info({
        dbPath: defaultRegistryDbPath(dataDir),
        existingDevices: fleetRegistrar.count(),
        admissionDefault,
      }, 'Fleet registrar enabled (SUDO_FLEET_REGISTRAR_MODE=1) — POST /api/fleet/register + GET /api/admin/fleet/devices live');
      registerShutdown(() => fleetRegistrar?.close());

      // Slice 2 — back-channel command queue. Same fleet.db so registry
      // and queue share durable state; SQLite WAL handles concurrency.
      const { CommandQueue } = await import('./core/fleet/command-queue.js');
      fleetCommandQueue = new CommandQueue({ dbPath: defaultRegistryDbPath(dataDir) });
      log.info({
        existingCommands: fleetCommandQueue.count(),
      }, 'Fleet command queue enabled (#28c slice 2) — POST /api/admin/fleet/dispatch + GET /api/fleet/device/:id/inbox + POST /api/fleet/device/:id/result + GET /api/admin/fleet/commands/:id live');
      registerShutdown(() => fleetCommandQueue?.close());

      // Slice 4 — nonce store for the registration challenge round-trip.
      // Slice-4-follow-up: SQLite-backed (same fleet.db) so a multi-process
      // registrar behind a load balancer can consume a nonce issued by a
      // peer process. The SQLite WAL writer-lock serializes concurrent
      // DELETE … RETURNING, so a captured-nonce race across processes
      // produces exactly one winner.
      const { NonceStore } = await import('./core/fleet/nonce-store.js');
      fleetNonceStore = new NonceStore({ dbPath: defaultRegistryDbPath(dataDir) });
      log.info({}, 'Fleet nonce store enabled (#28c slice 4) — GET /api/fleet/challenge live; POST /api/fleet/register now requires nonce + admin admit/revoke routes live');
      registerShutdown(() => fleetNonceStore?.close());
    }
  } catch (err) {
    log.warn({ err: String(err) }, 'Fleet identity/registrar wiring failed (non-fatal) — /api/fleet/* routes will report fleet_registrar_not_enabled');
  }

  // -------------------------------------------------------------------------
  // 8.6 Observability dashboard (kill switch: SUDO_DASHBOARD_DISABLE=1)
  // -------------------------------------------------------------------------
  // Hoisted out of the §8.6 try-block so §8.6b's fleet executor can pass
  // the SAME closure as its alignment.digest handler (gap #28d slice 2).
  // Both consumers see the identical snapshot from
  // finalAgentLoop.getAlignmentAggregator() — fleet rollup never drifts
  // from the local /api/alignment value. Declared here (rather than at
  // first use) so dashboard init failure doesn't strand the fleet handler.
  const alignmentDigestSource = {
    getDigest: (): { overallScore?: number; signals?: Record<string, number> } | undefined => {
      const report = finalAgentLoop.getAlignmentAggregator()?.getLastReport();
      if (!report) return undefined;
      return {
        overallScore: report.score,
        signals: Object.fromEntries(Object.entries(report.signals)),
      };
    },
  };

  // Gap #28d slice 3 — federation state aggregator for the admin URL.
  //
  // The closure captures the *bindings* of peerRegistryForAuth /
  // federationDeps / federationTokenPool (all `let` declared in outer
  // scope), so calls made AFTER §9.5 finishes initialising
  // federationTokenPool still see the live value. Each request to
  // `/api/admin/federation/state` re-aggregates — no caching; the
  // numbers should change as inbound events land.
  //
  // Projection logic lives in `federation-state-projector.ts` so the
  // secret-redaction contract can be unit-tested without booting the
  // CLI. See its file header for the secret-discipline notes.
  const { projectFederationState } = await import('./core/federation/federation-state-projector.js');
  const federationStateSource = {
    getState: (): import('./core/dashboard/dashboard-types.js').FederationState => {
      const instanceId = process.env['SUDO_INSTANCE_ID'] || (() => {
        try { return `${require('node:os').hostname()}-${process.pid}`; }
        catch { return `unknown-${process.pid}`; }
      })();
      return projectFederationState({
        instanceId,
        peerRegistry: peerRegistryForAuth ?? undefined,
        auditChainSync: federationDeps?.auditChainSync,
        federationTokenPool: federationTokenPool ?? undefined,
        onError: (err, context) => log.warn({ err: String(err), context }, 'federation projector subsystem threw — surfacing zero counts'),
      });
    },
  };
  try {
    const { initDashboard, shutdownDashboard, registerDashboardGlobals, classifyBind, parseHostAllowlist } =
      await import('./core/dashboard/dashboard-server.js');

    const dashboardPort = parseInt(process.env['SUDO_DASHBOARD_PORT'] ?? '18910', 10) || 18910;
    const pinnedToken = process.env['SUDO_DASHBOARD_TOKEN'] ?? process.env['GATEWAY_TOKEN'];
    const dashboardToken = pinnedToken ?? randomUUID();
    if (!pinnedToken) {
      log.info({ token: dashboardToken }, 'Dashboard API token generated for this boot (set SUDO_DASHBOARD_TOKEN to pin)');
    }

    // Slice 2 — bind + Host + loopback-trust wiring (Hermes parity).
    const dashboardBind = process.env['SUDO_DASHBOARD_BIND'] ?? '127.0.0.1';
    const bindMode = classifyBind(dashboardBind);
    const insecureOptIn = process.env['SUDO_DASHBOARD_INSECURE'] === '1';
    if (bindMode !== 'loopback' && !insecureOptIn) {
      // Refuse non-loopback bind without explicit opt-in. The dashboard would
      // be reachable from the network with full admin powers (if SUDO_ADMIN_
      // POWERS=1) — operator must acknowledge by setting SUDO_DASHBOARD_INSECURE=1.
      throw new Error(`SUDO_DASHBOARD_BIND=${dashboardBind} is non-loopback (${bindMode}); set SUDO_DASHBOARD_INSECURE=1 to confirm operator intent`);
    }
    if (dashboardBind === '0.0.0.0') {
      // classifyBind labels 0.0.0.0 as 'lan' for opt-in symmetry, but it binds
      // EVERY interface including public NICs. Operator should know.
      log.warn({ bind: dashboardBind }, 'SUDO_DASHBOARD_BIND=0.0.0.0 binds every interface including public NICs; treat as if public');
    }
    const hostAllowlist = parseHostAllowlist(process.env['SUDO_DASHBOARD_HOSTS']);
    // Loopback-trust GET-skip-auth is ON for loopback binds UNLESS the operator
    // explicitly opted into insecure mode (which forces full auth back on so
    // network callers can't skip).
    const loopbackTrust = bindMode === 'loopback' && !insecureOptIn;

    // Slice 4 — pluggable OAuth/JWT backend selection via SUDO_DASHBOARD_AUTH.
    // `basic` (default, OR env unset) preserves slice-2 Bearer + ?token
    // semantics. `nous` and `self-hosted` wire JWT verification against a
    // configured IdP (Hermes parity: plugins/dashboard_auth/{nous,self_hosted}/).
    //
    // **No silent fallback.** When the operator explicitly opts into OAuth
    // (SUDO_DASHBOARD_AUTH=nous|self-hosted) and the supporting env is
    // missing/invalid, `selectDashboardAuthBackend` throws. The outer try/
    // catch turns that into "Dashboard wiring failed (non-fatal)" + the
    // dashboard does not start. This mirrors the non-loopback bind check
    // a few lines above and matches Hermes's "fail loud on misconfig" auth
    // posture. Silently dropping to basic Bearer would be a security
    // downgrade: operator believes OAuth is on, every request actually
    // checks against the shared Bearer token.
    const { selectDashboardAuthBackend } =
      await import('./core/dashboard/select-auth-backend.js');
    const oauthBackend = selectDashboardAuthBackend(process.env);
    const authMode = (process.env['SUDO_DASHBOARD_AUTH'] ?? 'basic').toLowerCase();
    if (oauthBackend) {
      log.info({
        mode: authMode,
        algorithm: process.env['SUDO_DASHBOARD_OAUTH_ALG'] ?? 'RS256',
        issuer: process.env['SUDO_DASHBOARD_OAUTH_ISSUER'] ?? '(none)',
        audience: process.env['SUDO_DASHBOARD_OAUTH_AUDIENCE'] ?? '(none)',
        requiredScope: process.env['SUDO_DASHBOARD_OAUTH_REQUIRED_SCOPE'] ?? '(none)',
      }, 'Dashboard OAuth backend wired (slice 4 — Hermes parity)');
    }

    registerDashboardGlobals({
      brain,
      // gatewayServer stays null when the gateway failed to start; omit so the
      // health check honestly reports "not detected".
      gateway: gatewayServer ?? undefined,
      alignment: alignmentDigestSource,
      // Gap #28d slice 3 — federation state aggregator. Always wired so
      // the route returns honest `enabled: false` when §6.4h didn't boot.
      federation: federationStateSource,
      // FleetView source (gap #25 slice 1). multiAgent.getSnapshot() chains
      // through to AgentSwarm.snapshot(). When orchestrator wiring failed in
      // section 5.5, multiAgent is null and the dashboard's getLiveAgents()
      // serves a zero default rather than 500ing.
      ...(multiAgent ? { agentSwarm: { getSnapshot: () => multiAgent!.getSnapshot() } } : {}),
      // Admin-power sources (#28b slice 1). Each is optional — endpoints
      // serve a structured "not_registered" response when the global is missing.
      ...(autoUpdater ? { updater: autoUpdater } : {}),
      ...(auditTrail ? { audit: auditTrail } : {}),
      // OAuth backend (#28b slice 4). Only registered when an external IdP
      // is configured AND wiring succeeded; otherwise the dashboard's
      // default BasicAuthBackend handles auth.
      ...(oauthBackend ? { authBackend: oauthBackend } : {}),
      // Fleet registrar (#28c slice 1). Only registered when
      // SUDO_FLEET_REGISTRAR_MODE=1 AND the store constructed cleanly. When
      // absent, fleet routes serve a structured 503.
      ...(fleetRegistrar ? { fleetRegistrar } : {}),
      // Fleet command queue (#28c slice 2). Same opt-in as the registrar.
      ...(fleetCommandQueue ? { fleetCommandQueue } : {}),
      // Fleet nonce store (#28c slice 4). Same opt-in as the registrar.
      ...(fleetNonceStore ? { fleetNonceStore } : {}),
    });

    initDashboard({
      port: dashboardPort,
      authToken: dashboardToken,
      refreshIntervalMs: 5000,
      bindAddress: dashboardBind,
      hostAllowlist,
      loopbackTrust,
    });
    registerShutdown(() => shutdownDashboard());
    log.info({
      port: dashboardPort,
      bind: dashboardBind,
      mode: bindMode,
      loopbackTrust,
      hostAllowlistSize: hostAllowlist.length,
      adminPowers: process.env['SUDO_ADMIN_POWERS'] === '1',
      authMode: oauthBackend ? authMode : 'basic',
    }, 'Observability dashboard wired (SUDO_DASHBOARD_DISABLE=1 to disable; SUDO_ADMIN_POWERS=1 enables mutation endpoints; loopback-trust skips GET auth unless SUDO_DASHBOARD_INSECURE=1; SUDO_DASHBOARD_AUTH=nous|self-hosted swaps in OAuth/JWT backends)');
  } catch (err) {
    log.warn({ err: String(err) }, 'Dashboard wiring failed (non-fatal)');
  }

  // -------------------------------------------------------------------------
  // 8.6b Fleet registrar client (#28c slice 1, device-side).
  //
  // Opt-in via SUDO_FLEET_REGISTRAR_URL. When set, this device sends a
  // signed registration POST to that URL after the dashboard finishes
  // wiring. Best-effort — failures log warn and boot continues, the next
  // boot retries. Slice 2 will add a periodic heartbeat-re-register so the
  // registrar's last_registered_at tracks liveness, not just last-boot.
  // -------------------------------------------------------------------------
  // Gap #28d slice 1 — hoisted so §9.2 autonomy wiring can late-bind the
  // WakeSleepCycle adapter via fleetExecutorHandle.setAutonomy(...). The
  // executor is built here in §8.6b; the cycle in §9.2 — by then this var
  // is whatever the inner if() assigned (handle, or still null on opt-out).
  let fleetExecutorHandle: import('./core/fleet/fleet-executor.js').FleetExecutorHandle | null = null;
  if (fleetIdentity && process.env['SUDO_FLEET_REGISTRAR_URL']) {
    try {
      const { registerWithRegistrar } = await import('./core/fleet/registrar-client.js');
      // package.json version — best-effort, fall back to 'unknown' rather
      // than failing registration if the read throws (very rare; package.json
      // is bundled into dist/ but might be missing in some edge-case layouts).
      let versionStr = 'unknown';
      try {
        const pkg = JSON.parse(
          (await import('node:fs')).readFileSync(
            (await import('node:path')).resolve(PROJECT_ROOT, 'package.json'),
            'utf8',
          ),
        ) as { version?: string };
        if (typeof pkg.version === 'string') versionStr = pkg.version;
      } catch { /* keep 'unknown' */ }

      const result = await registerWithRegistrar({
        registrarUrl: process.env['SUDO_FLEET_REGISTRAR_URL'],
        identity: fleetIdentity,
        versionStr,
      });
      if (result.ok) {
        log.info({
          registrarUrl: process.env['SUDO_FLEET_REGISTRAR_URL'],
          deviceId: result.deviceId,
          registeredAt: result.registeredAt,
        }, 'Registered with fleet registrar (#28c slice 1)');
      } else {
        log.warn({
          registrarUrl: process.env['SUDO_FLEET_REGISTRAR_URL'],
          reason: result.reason,
          status: result.status,
          detail: result.detail,
        }, 'Fleet registration failed (non-fatal)');
      }

      // Slice 2 — start the device-side back-channel executor only if
      // registration succeeded (otherwise the inbox poll would 404 with
      // device_not_registered until the next boot retry).
      if (result.ok) {
        const { startFleetExecutor } = await import('./core/fleet/registrar-client.js')
          .then(() => import('./core/fleet/fleet-executor.js'));
        // Brain handle for model.get/set — Brain class guarantees both
        // methods at construction (brain.ts:334/347), so the earlier
        // defensive duck-probe is unnecessary; if the surface ever changes,
        // the compiler catches it here.
        const brainHandle = {
          getModel: brain.getModel.bind(brain),
          setModel: brain.setModel.bind(brain),
        };
        const handle = startFleetExecutor({
          registrarUrl: process.env['SUDO_FLEET_REGISTRAR_URL']!,
          identity: fleetIdentity,
          brain: brainHandle,
          // Gap #28d slice 2 — same closure as registerDashboardGlobals so
          // fleet rollup and local /api/alignment never diverge. Method
          // name differs (`digest` vs `getDigest`) so the adapter is
          // ultra-thin and just forwards the call.
          alignment: { digest: () => alignmentDigestSource.getDigest() },
        });
        // Gap #28d slice 1 — hoist into outer scope so §9.2 autonomy block
        // can late-bind the WakeSleepCycle adapter via handle.setAutonomy().
        // The autonomy cycle is built strictly AFTER the fleet executor: v5
        // module init (which creates goalEngine) runs in §9, and the cycle
        // itself is constructed in §9.2.
        fleetExecutorHandle = handle;
        log.info({ deviceId: fleetIdentity.deviceId }, 'Fleet executor started (#28c slice 2)');
        registerShutdown(async () => { await handle.stop(); });
      }
    } catch (err) {
      log.warn({ err: String(err) }, 'Fleet registration/executor wiring failed (non-fatal)');
    }
  }

  // -------------------------------------------------------------------------
  // 9. SUDO-AI v5 modules
  // -------------------------------------------------------------------------
  // Note: auditTrail is hoisted ahead of §8.6 above so the dashboard can share
  // the same chain writer; we reuse the same instance here.
  let goalEngine: GoalEngineV2 | null = null;
  let outcomesLedger: OutcomesLedger | null = null;

  try {
    console.log('[boot] Initializing SUDO-AI v5 modules...');
    const crossChannelMemory = new CrossChannelMemory();
    goalEngine = new GoalEngineV2();
    outcomesLedger = new OutcomesLedger();
    const steeringChannel = new InMemorySteeringChannel();

    // Semantic contradiction resolution for dreamed facts (#7, opt-in via
    // SUDO_CHUNK_CONTRADICT=1). Stage 1 = embedding cosine (text-embedding-3-small,
    // threshold validated at 0.65); stage 2 = a Claude-backed opposition judge.
    // Scoped to source='learning' so a free-text fact is only compared against
    // other facts, not session-meta JSON. Fail-open throughout.
    const chunkEmbeddings = new EmbeddingService(db);
    const contradictionJudge: ContradictionJudge = async (incoming, existing) => {
      const prompt = [
        'You compare two stored memory facts and decide if the NEW one CONTRADICTS the EXISTING one.',
        'Answer with exactly one word: YES or NO.',
        'YES only when they concern the SAME subject and assert incompatible/opposing things.',
        'NO when the new fact merely restates, refines, adds to, or is unrelated to the existing one.',
        '',
        `NEW fact:      ${incoming}`,
        `EXISTING fact: ${existing}`,
        '',
        'Does the NEW fact contradict the EXISTING fact? Answer YES or NO.',
      ].join('\n');
      try {
        const resp = await brain.chat([{ role: 'user', content: prompt }]);
        return resp.trim().toLowerCase().startsWith('yes');
      } catch {
        return false; // judge unavailable → treat as non-contradiction (fail-open)
      }
    };
    // Contradiction narrowing embeds its own texts live + compares cosines, so it
    // doesn't need the OpenAI 1536-dim stored index — prefer the always-up local
    // ONNX model (free, no 429s) and only fall back to OpenAI if local is disabled.
    const contradictionEmbed = makeLocalFirstEmbed((t: string) => chunkEmbeddings.embed(t));
    const resolveFactContradiction = async (chunkId: number): Promise<void> => {
      if (!isChunkContradictionEnabled()) return;
      const chunk = db.getChunk(chunkId);
      if (!chunk) return;
      const res = await resolveChunkContradictions(
        chunk,
        { db, embed: contradictionEmbed, judge: contradictionJudge },
        { candidateFilter: (c) => c.source === 'learning' },
      );
      // Observable per-fact so the live hook is verifiable (no-op otherwise stays silent).
      log.info({ chunkId, superseded: res.supersededIds.length }, 'dream fact: contradiction check');
    };

    // AutoDream: brain caller + the raw better-sqlite3 Database (MindDB exposes
    // it as the public readonly `db` field) + the post-write contradiction hook.
    autoDream = new AutoDream(
      async (prompt: string) => brain.chat([{ role: 'user', content: prompt }]),
      db.db,
      undefined,
      resolveFactContradiction,
    );

    // Heal an over-cap MEMORY.md on boot so a stuck file (which silently drops
    // new learnings) is trimmed promptly instead of waiting for the next dream.
    try {
      const healed = autoDream.healMemoryFileIfOverCap();
      if (healed > 0) log.info({ trimmed: healed }, 'Boot: trimmed over-cap MEMORY.md under its size limit');
    } catch (err) {
      log.warn({ err: String(err) }, 'Boot MEMORY.md heal failed (non-fatal)');
    }

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
    void steeringChannel;

    // Markdown skill loader — project skills/ (flat .md files plus
    // agentskills.io <skill>/SKILL.md directories) and optional extra roots
    // (SUDO_SKILLS_DIRS, colon-separated; e.g. ~/.claude/skills to ingest
    // Claude Code / agentskills.io skill trees). First-seen name wins.
    const mdSkills = await loadMarkdownSkills(projectPath('skills'));
    const extraSkillRoots = parseSkillRoots(process.env['SUDO_SKILLS_DIRS']);
    const seenSkillNames = new Set(mdSkills.map((s) => s.name));
    for (const root of extraSkillRoots) {
      for (const skill of await loadMarkdownSkills(root)) {
        if (seenSkillNames.has(skill.name)) continue;
        mdSkills.push(skill);
        seenSkillNames.add(skill.name);
      }
    }
    // Build skill→tool reverse index and wire into ToolRegistry (fail-open)
    registry.setSkillIndex(buildSkillToolIndex(mdSkills));

    // Register shutdown handlers for closeable v5 modules
    registerShutdown(() => goalEngine?.close?.());
    registerShutdown(() => outcomesLedger?.close?.());

    console.log(
      `[boot] v5 ready: goals=${goalEngine ? 'ok' : 'no'} skills=${mdSkills.length} channels=cross`,
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
  // 9.2 Autonomy v1 — background goal work + persistent think cycle
  //     (opt-in: SUDO_AUTONOMY_V1=1; runs agent turns unattended, so off by
  //      default. SUDO_AUTONOMY_V1_INTERVAL_MS tunes the tick/think cadence,
  //      SUDO_AUTONOMY_V1_REWAKE_MS how long a worked goal sleeps before the
  //      next turn.)
  // -------------------------------------------------------------------------
  if (process.env['SUDO_AUTONOMY_V1'] === '1') {
    try {
      if (!goalEngine) throw new Error('GoalEngineV2 unavailable (v5 module init failed)');
      const engine = goalEngine;
      const { AutonomousEventLoop } = await import('./core/autonomy/event-loop.js');
      const { WakeSleepCycle } = await import('./core/autonomy/wake-sleep-cycle.js');

      const tickRaw = Number(process.env['SUDO_AUTONOMY_V1_INTERVAL_MS']);
      const tickMs = Number.isFinite(tickRaw) && tickRaw >= 1_000 ? tickRaw : 300_000;
      const rewakeRaw = Number(process.env['SUDO_AUTONOMY_V1_REWAKE_MS']);
      const rewakeMs = Number.isFinite(rewakeRaw) && rewakeRaw >= 60_000 ? rewakeRaw : 3_600_000;

      const wakeSleep = new WakeSleepCycle(
        engine,
        hooks,
        async (goal) => {
          // Claim the goal by re-sleeping it BEFORE the agent turn: ticks are
          // not serialized, so a turn outlasting the tick interval would
          // otherwise get the same goal dispatched twice. Completion (via the
          // agent or the user) overrides the wake schedule.
          engine.scheduleWake(goal.id, new Date(Date.now() + rewakeMs).toISOString());
          // Same per-peer serialization as the channel handlers, so nothing
          // else can run a turn on this session while the goal turn is live.
          await dualSessionManager.peerQueue.enqueue(`goal:${goal.id}`, async () => {
            const session = await dualSessionManager.getOrCreate('autonomy', `goal:${goal.id}`);
            const prompt = [
              '[autonomous goal turn] Work on this goal now and make concrete progress.',
              `Goal: ${goal.title}`,
              goal.description ? `Description: ${goal.description}` : '',
              `Current progress: ${goal.progress}%`,
            ].filter(Boolean).join('\n');
            await finalAgentLoop.run(String(session.id), prompt, undefined, { race: true });
          });
        },
        { tickIntervalMs: tickMs },
      );
      wakeSleep.start();
      registerShutdown(() => wakeSleep.stop());

      // Gap #28d slice 1 — late-bind the autonomy adapter onto the fleet
      // executor (if §8.6b opted into fleet mode). The executor was started
      // earlier in boot when the cycle did not yet exist; this setter is the
      // contract that lets admin `autonomy.{pause,resume,status}` commands
      // reach the live WakeSleepCycle without re-ordering boot. Detach on
      // shutdown so a torn-down cycle can't be invoked by a late-arriving
      // inbox poll.
      if (fleetExecutorHandle) {
        const cycle = wakeSleep;
        fleetExecutorHandle.setAutonomy({
          pause: () => cycle.pause(),
          resume: () => cycle.resume(),
          status: () => ({
            state: cycle.getStatus(),
            paused: cycle.isPaused(),
            activeCount: cycle.activeCount,
          }),
        });
        registerShutdown(() => { fleetExecutorHandle?.setAutonomy(undefined); });
        log.info({ deviceId: process.env['SUDO_INSTANCE_ID'] }, 'Autonomy adapter wired into fleet executor (#28d slice 1)');
      }

      // The event loop persists plans/self-initiated actions in mind.db. It
      // opens its own connection to the same file — safe alongside MindDB's
      // WAL connection, and they write disjoint tables. The WakeSleepCycle is
      // deliberately NOT passed in: it already runs its own scheduler above,
      // and a second tick driver could double-dispatch goals.
      const eventLoop = new AutonomousEventLoop(db.db.name, engine);
      eventLoop.start(tickMs);
      // Shutdown runs LIFO: eventLoop stops before wakeSleep above. If the
      // cycle is ever passed into the event loop, swap the registration order.
      registerShutdown(() => eventLoop.stop());

      log.info({ tickMs, rewakeMs }, 'Autonomy v1 wired (wake/sleep cycle + event loop)');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err: msg }, 'Autonomy v1 failed to initialize — continuing without it');
    }
  } else {
    log.info('Autonomy v1 disabled (set SUDO_AUTONOMY_V1=1 to enable)');
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

      // Wire AlignmentAutoRemediator as observer on the aggregator.
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

      // Federation Error Protocol (init now that finalAgentLoop is available)
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
      // Instantiate BenchStore + ProposalStore for HTTP route groups.
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
      // SkillOptimizer full init (AgentConfigEvolver + SkillOptimizer).
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
            sleepTrustTracker, // trust gate for autoApplyApproved()
            new URL('./core/skills', import.meta.url).pathname, // skillsDir: enable on-disk SKILL.md writes
          );
          // Inject into SleepCycle via setter (sleepCycle was captured at 6.5).
          if (wave13SleepCycleRef) {
            wave13SleepCycleRef.setSkillOptimizer(wave13SkillOptimizer);
          }
          log.info('Wave 13: AgentConfigEvolver + SkillOptimizer initialised and wired into SleepCycle');
          // Wire AgentConfigEvolver into agent loop (fail-open)
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

      // REST APIs (/v1/sessions, /v1/agents, SSE streams)
      try {
        const sessionDeps = buildSessionRouteDeps(db.db);
        // -----------------------------------------------------------------------
        // Wire real SessionStateMachine events to sandboxProxyBus
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
        // Background shells (gap #10): kill a session's shells on its terminal events.
        if (process.env['SUDO_BG_SHELL'] === '1') {
          const { killSession } = await import('./core/tools/builtin/system/bg-shell/index.js');
          for (const ev of ['session:status:terminated', 'session:status:archived'] as const) {
            sessionDeps.stateMachine.on(ev, (payload: { sessionId: string }) => {
              killSession(payload.sessionId);
            });
          }
          log.info('Background-shell per-session cleanup wired (SUDO_BG_SHELL=1)');
        }
        registerSessionRoutes(gatewayServer, sessionDeps);
        log.info('Session REST API attached (/v1/sessions)');

        const agentStore = new AgentConfigStore(db.db);
        registerAgentRoutes(gatewayServer, agentStore);
        log.info('Agent config REST API attached (/v1/agents)');

        const sseBroker = registerSseRoutes(gatewayServer, hooks);
        log.info('SSE event stream attached (/v1/sessions/:id/stream)');
        registerShutdown(() => sseBroker.destroy());

        // MCP credential vault routes
        registerVaultCredentialRoutes(gatewayServer);
        log.info('Vault credential routes attached (/v1/vaults/:ns/credentials)');

        // OAuth refresh daemon — start background token refresh
        oauthRefreshDaemon.start();
        registerShutdown(() => oauthRefreshDaemon.stop());
        log.info('OAuth refresh daemon started');

        // Files API
        const fileStore = new FileStore(db.db, 'data/files');
        registerFileRoutes(gatewayServer, fileStore);
        log.info('Files API attached (/v1/files)');

        // Admin REST API (/api/admin/*) — opt-in (SUDO_ADMIN_API=1), fail-closed,
        // Bearer token-gated. No-op + zero side effects when the flag is off.
        if (process.env['SUDO_ADMIN_API'] === '1') {
          const { registerAdminApi } = await import('./core/api/admin/register.js');
          const mounted = await registerAdminApi(gatewayServer);
          log.info({ mounted }, mounted
            ? 'Admin API attached (/api/admin/*) — token-gated'
            : 'Admin API NOT mounted (fail-closed: no admin token set)');
        }

        // Skills Registry
        const skillRegistry = new SkillRegistry(db.db);
        skillRegistry.scanAndRegister();
        // Scan bundled SKILL.md files from src/core/skills subdirectories
        const bundledSkillsDir = new URL('./core/skills', import.meta.url).pathname;
        skillRegistry.scanBundledSkills(bundledSkillsDir);
        // agentskills.io directory-layout skills in the user skills/ tree and
        // optional extra roots (SUDO_SKILLS_DIRS, colon-separated)
        skillRegistry.scanBundledSkills(projectPath('skills'));
        for (const root of parseSkillRoots(process.env['SUDO_SKILLS_DIRS'])) {
          skillRegistry.scanBundledSkills(root);
        }
        registerSkillRoutes(gatewayServer, skillRegistry, sessionDeps.store);
        log.info('Skills API attached (/v1/skills)');
        const { registerRegistryRoutes } = await import('./core/skills/registry-routes.js');
        registerRegistryRoutes(gatewayServer, skillRegistry);
        log.info('Public skill registry attached (/v1/registry/skills)');

        // agentskills.io discovery endpoint (public no-auth)
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
          // which is caught by the outer REST-API try/catch, making this safe.
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
  // 9.56 Proactive scheduled messaging — chat-channel scheduling daemon
  //      (opt-in: SUDO_SCHEDULED_MESSAGES=1. Lets the agent enqueue reminders /
  //      digests / follow-ups the daemon delivers to a chat channel WITHOUT the
  //      user prompting first. Delivery routes through the channel-outbox each
  //      adapter registered into above, so it reaches any enabled channel.)
  // -------------------------------------------------------------------------
  if (process.env['SUDO_SCHEDULED_MESSAGES'] === '1') {
    try {
      const { ScheduledMessageDispatcher, setScheduledMessageInstance } = await import('./core/channels/scheduled-messages.js');
      // Dynamic digests: when a scheduled message carries a `prompt` instead of
      // fixed content, the brain expands it into the body at delivery time.
      const digestGenerator = async (prompt: string): Promise<string> => {
        const resp = await brain.call({
          messages: [{
            role: 'user',
            content: `Generate a single proactive chat message to send to a user on a schedule. Output ONLY the message body — concise, friendly, ready to send, with no preamble, quotes, or meta-commentary.\n\nWhat to say: ${prompt}`,
          }],
          maxTokens: 800,
        });
        return (resp.content ?? '').trim();
      };
      const smDispatcher = new ScheduledMessageDispatcher(db.db, sendToChannelOutbox, digestGenerator);
      setScheduledMessageInstance(smDispatcher);
      smDispatcher.start();
      registerShutdown(() => smDispatcher.stop());
      const { scheduleMessageTool } = await import('./core/tools/builtin/comms/schedule-message-tool.js');
      registry.register(scheduleMessageTool);
      log.info('Proactive scheduled messaging enabled (SUDO_SCHEDULED_MESSAGES=1) — comms.schedule-message live, dispatcher 60s tick');
    } catch (err) {
      log.warn({ err: String(err) }, 'Scheduled messaging failed to start — comms.schedule-message unavailable');
    }
  }

  // -------------------------------------------------------------------------
  // 9.6 Meta tool dependency injection
  // -------------------------------------------------------------------------
  try {
    const { injectMetaToolDeps } = await import('./core/tools/builtin/meta/index.js');

    // channelRouter for meta tools — delegates to the channel-outbox registry that
    // every channel adapter registered into at construction. Replaces the former
    // per-adapter if-chain (and also covers web). Undefined when no channel is
    // active so meta tools still see "channels unavailable"; an unregistered
    // channel throws from sendToChannelOutbox, same as the old "not available".
    const channelRouter = registeredOutboundChannels().length > 0 ? {
      send: async (channel: string, peerId: string, text: string) => {
        await sendToChannelOutbox(channel as import('./core/channels/types.js').ChannelType, peerId, text);
        return { timestamp: new Date().toISOString() };
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
  // 9.6b Programmatic Tool Calling — meta.ptc (gap #15)
  //      (opt-in: SUDO_PTC=1; script-driven multi-tool dispatch in one model
  //      turn. The script runs in a sealed VM and reaches the registry only
  //      through `await tool(name, args)` — every call hits the normal
  //      permission/approval gates.)
  // -------------------------------------------------------------------------
  if (process.env['SUDO_PTC'] === '1') {
    try {
      const { ptcTool, setPtcRegistry } = await import('./core/tools/builtin/meta/ptc.js');
      setPtcRegistry(registry);
      registry.register(ptcTool);
      log.info('meta.ptc registered (SUDO_PTC=1)');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err: msg }, 'meta.ptc registration failed — continuing without it');
    }
  }

  // -------------------------------------------------------------------------
  // 9.6b' Programmatic Tool Calling (Python) — meta.ptc-python (gap #15)
  //      (opt-in: SUDO_PTC_PYTHON=1, default OFF. A python3 subprocess reaches
  //      the registry only through synchronous `tool(name, args)` — same gates.
  //      Unlike meta.ptc's sealed VM the script has full Python, so it is
  //      requiresConfirmation + opt-in; bwrap confinement is a follow-up.)
  // -------------------------------------------------------------------------
  if (process.env['SUDO_PTC_PYTHON'] === '1') {
    try {
      const { ptcPythonTool, setPtcPythonRegistry } = await import('./core/tools/builtin/meta/ptc-python.js');
      setPtcPythonRegistry(registry);
      registry.register(ptcPythonTool);
      log.info('meta.ptc-python registered (SUDO_PTC_PYTHON=1)');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err: msg }, 'meta.ptc-python registration failed — continuing without it');
    }
  }

  // -------------------------------------------------------------------------
  // 9.6c Workflow system — meta.run-workflow (gap #24, slices 1-3)
  //      (opt-in: SUDO_WORKFLOWS=1; runs deterministic multi-step .yaml
  //      workflows. Shell steps run one argv command each; tool steps dispatch
  //      through registry.execute() — the same permission/approval gates a
  //      normal tool call hits. Slice 1 sequential engine + tool steps;
  //      slice 2 parallel_group fan-out + {{steps.<id>.<field>}} templating +
  //      on-disk SHA-256 resume journal; slice 3 phase synchronization
  //      barriers. Cross-workflow scheduling lives in 9.6d.)
  // -------------------------------------------------------------------------
  if (process.env['SUDO_WORKFLOWS'] === '1') {
    try {
      const { runWorkflowTool, setWorkflowRegistry } = await import(
        './core/tools/builtin/meta/run-workflow.js'
      );
      setWorkflowRegistry(registry);
      registry.register(runWorkflowTool);
      log.info('meta.run-workflow registered (SUDO_WORKFLOWS=1)');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err: msg }, 'meta.run-workflow registration failed — continuing without it');
    }
  }

  // -------------------------------------------------------------------------
  // 9.6d Cross-workflow scheduler — meta.enqueue-workflow (gap #24, slice 4)
  //      (opt-in: SUDO_WORKFLOWS_QUEUE=1; initializes the WorkflowQueue
  //      singleton on mind.db, registers a workflow.run TaskExecutor handler,
  //      and exposes meta.enqueue-workflow for persistent / async / multi-run
  //      scheduling. Capped by SUDO_WORKFLOWS_QUEUE_CONCURRENT (default 2);
  //      poll interval SUDO_WORKFLOWS_QUEUE_POLL_MS (default 5000). Pending
  //      runs survive process restarts. Queued runs auto-approve internal
  //      approval gates; the enqueue tool refuses workflows with approval
  //      steps unless auto_approve:true is set. Registered independently of
  //      SUDO_WORKFLOWS=1 — operators can opt into queue-only or sync-only.)
  // -------------------------------------------------------------------------
  if (process.env['SUDO_WORKFLOWS_QUEUE'] === '1') {
    try {
      const { initWorkflowQueue } = await import('./core/workflows/queue.js');
      const { enqueueWorkflowTool } = await import(
        './core/tools/builtin/meta/enqueue-workflow.js'
      );

      const concurrentRaw = process.env['SUDO_WORKFLOWS_QUEUE_CONCURRENT'];
      const concurrent = concurrentRaw ? parseInt(concurrentRaw, 10) : 2;
      const pollRaw = process.env['SUDO_WORKFLOWS_QUEUE_POLL_MS'];
      const pollMs = pollRaw ? parseInt(pollRaw, 10) : 5_000;

      // Synthetic ctx for queued tool-step dispatch. The queue has no original
      // operator session — sessionId is a stable identifier for log
      // correlation; workingDir matches the workspace so tool steps using
      // ctx.workingDir as a base path land where the workflow author expects.
      const queueCtx = {
        sessionId: 'workflow-queue',
        workingDir: process.cwd(),
        config: {},
        logger: console,
      };

      const wq = initWorkflowQueue({
        registry,
        ctx: queueCtx,
        maxConcurrent: Number.isFinite(concurrent) && concurrent >= 1 ? concurrent : 2,
        pollIntervalMs: Number.isFinite(pollMs) && pollMs >= 100 ? pollMs : 5_000,
      });
      registry.register(enqueueWorkflowTool);
      registerShutdown(() => wq.shutdown());
      log.info(
        { concurrent: wq.taskQueue.maxConcurrent },
        'WorkflowQueue + meta.enqueue-workflow registered (SUDO_WORKFLOWS_QUEUE=1)',
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(
        { err: msg },
        'WorkflowQueue registration failed — continuing without cross-workflow scheduler',
      );
    }
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
// Process-level safety net — the daemon runs unsupervised under PM2/systemd.
// Without these, an unhandled promise rejection terminates the process with no
// diagnostics (Node's default since v15) and an uncaught exception leaves it in
// an undefined state. Registered before the subcommand dispatch so the chat,
// replay, and daemon paths are all covered.
// ---------------------------------------------------------------------------

const processLog = createLogger('process');

process.on('unhandledRejection', (reason: unknown) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  // Log loudly but stay alive: a single stray rejection should not drop active
  // Telegram/web sessions on a long-running daemon.
  processLog.error({ err }, 'unhandledRejection — kept alive (investigate)');
});

process.on('uncaughtException', (err: Error, origin: string) => {
  // Undefined state after an uncaught throw: drain the shutdown registry
  // (close DBs, flush sessions) then exit so the supervisor restarts clean.
  processLog.fatal({ err, origin }, 'uncaughtException — draining then exiting');
  // Backstop: force-exit if the graceful drain stalls (within the pm2 kill grace).
  setTimeout(() => process.exit(1), 8000).unref();
  void runShutdown('uncaughtException');
});

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
} else if (process.argv[2] === 'replay') {
  // replay subcommand — read-only inspection of a captured session trace
  // (traces.db). Intercept BEFORE full boot so it never starts the daemon.
  import('./cli/commands/replay.js').then(({ runReplay }) => {
    runReplay(process.argv.slice(3))
      .then((code) => process.exit(code))
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[replay] Fatal error:', msg);
        process.exit(1);
      });
  }).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[replay] Failed to load replay module:', msg);
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
