/**
 * Meta / Platform toolkit — registers meta tools into the ToolRegistry.
 *
 * Tools registered:
 *   meta.skill-creator      — Create new tools from natural language description (LLM + file write)
 *   meta.autonomous-mode    — Run multi-step goals without human intervention (config flag)
 *   meta.workflow-recorder  — Record tool calls and convert to replayable workflows
 *   meta.youtube-feedback   — Pull YouTube analytics, store in mind.db, generate content insights
 *   meta.cost-tracker       — Inspect API spending: today/weekly/monthly/recent/by-model/budget
 *   meta.skill-versioning   — Git-like versioning for skills: diff, rollback, performance, best-version
 *   meta.self-test          — Run SUDO-AI self-tests: databases, brain, tools, skills, dry-run, history
 *   meta.trend-radar        — Real-time world awareness: scan HN, Reddit, Google Trends for niche trends
 *   meta.swarm              — Multi-agent swarm intelligence: spawn, assign, scale, vote, share knowledge
 *   meta.predictor          — Predictive intelligence: anticipate needs, forecast topics, detect anomalies
 *   meta.code-evolver       — Self-evolving codebase: analyze, issues, propose, discover, stats, performance
 *   meta.finance            — Financial autonomy: revenue, costs, ROI, budgets, self-funding status
 *   meta.social-intel       — Social Intelligence Network: relationship memory, influence mapping, community analytics
 *   meta.creative           — Creative Origination: music composition, art style, narrative engine, format invention
 *   meta.voice              — Voice Engine: TTS synthesis, STT transcription, voice library, phone calls
 *   meta.avatar             — Avatar System: SUDO's digital presence, expressions, stream planning
 *   meta.survival           — Survival System: backups, dead-man switch, model probing, state export
 *   meta.comments           — YouTube Comment Engine: fetch, analyze, and respond to comments
 *   meta.auto-optimizer     — Closed-loop auto-optimization: learn rules, generate blueprints, measure improvement
 *   meta.thumbnail-ab       — Thumbnail A/B Testing: deploy variants, measure CTR, auto-select winner
 *   meta.event-daemon       — Persistent Event Daemon: monitor comments, spikes, quotas, milestones in real-time
 *   meta.sponsors           — Sponsor/Brand Outreach: add prospects, update deal status, pipeline stats, outreach emails
 *   meta.localizer          — Multi-Language Localization: translate scripts, job tracking, reach multiplier estimates
 *   meta.competitor         — Competitor Monitor: track rival channels, AI activity alerts, metric comparison
 *   meta.consciousness-control — Runtime control of consciousness modules: start/stop cognitive stream & embodied state
 *   meta.service-control      — Systemd service lifecycle: status, restart, stop, start, logs, reload-config
 *   meta.self-config          — Read/modify SUDO-AI config: get/set by path, manage disabled tools & cron jobs, backup
 *   meta.health-check         — Comprehensive self-diagnostics: system, databases, API keys, services, tools, disk, config
 *   meta.cron-manager          — Manage system cron jobs: list, add, remove SUDO-AI entries, validate expressions, daemon status
 *   meta.tool-creator          — Template-based tool creator: file, API, shell, DB, composite tools without LLM calls
 */

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ToolRegistry } from '../../registry.js';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';

// ---------------------------------------------------------------------------
// Dependency injection — meta tool runtime singletons
// ---------------------------------------------------------------------------

let _sessionManager: unknown = null;
let _agentLoop: unknown = null;
let _cronManager: unknown = null;
let _channelRouter: unknown = null;
let _memoryEngine: unknown = null;

/**
 * Inject runtime dependencies that meta tools need at call time.
 * Call once during application bootstrap, after all services are ready.
 */
export function injectMetaToolDeps(deps: {
  sessionManager?: unknown;
  agentLoop?: unknown;
  cronManager?: unknown;
  channelRouter?: unknown;
  memoryEngine?: unknown;
}): void {
  if (deps.sessionManager !== undefined) _sessionManager = deps.sessionManager;
  if (deps.agentLoop !== undefined) _agentLoop = deps.agentLoop;
  if (deps.cronManager !== undefined) _cronManager = deps.cronManager;
  if (deps.channelRouter !== undefined) _channelRouter = deps.channelRouter;
  if (deps.memoryEngine !== undefined) _memoryEngine = deps.memoryEngine;
}

/** Returns the injected session manager, or null if not yet set. */
export function getSessionManager(): unknown { return _sessionManager; }
/** Returns the injected agent loop, or null if not yet set. */
export function getAgentLoop(): unknown { return _agentLoop; }
/** Returns the injected cron manager, or null if not yet set. */
export function getCronManager(): unknown { return _cronManager; }
/** Returns the injected channel router, or null if not yet set. */
export function getChannelRouter(): unknown { return _channelRouter; }
/** Returns the injected memory engine, or null if not yet set. */
export function getMemoryEngine(): unknown { return _memoryEngine; }
import { taskManagerTool } from './task-manager.js';
import { youtubeFeedbackTool } from './youtube-feedback.js';
import { memoryQueryTool } from './memory-query.js';
import { costTrackerTool } from './cost-tracker.js';
import { skillVersioningTool } from './skill-versioning.js';
import { smartSchedulerTool } from './smart-scheduler.js';
import { selfTestTool } from './self-test.js';
import { selfEvalTool } from './self-eval.js';
import { trendRadarTool } from './trend-radar.js';
import { swarmTool } from './swarm.js';
import { codeEvolverTool } from './code-evolver.js';
import { predictorTool } from './predictor.js';
import { financeTrackerTool } from './finance-tracker.js';
import { socialIntelTool } from './social-intel.js';
import { creativeTool } from './creative.js';
import { voiceEngineTool } from './voice-engine.js';
import { avatarTool } from './avatar.js';
import { survivalTool } from './survival-tool.js';
import { commentEngineTool } from './comment-engine.js';
import { autoOptimizerTool } from './auto-optimizer.js';
import { thumbnailABTool } from './thumbnail-ab-tool.js';
import { eventDaemonTool } from './event-daemon-tool.js';
import { sponsorsTool } from './sponsor-tool.js';
import { localizerTool } from './localizer-tool.js';
import { competitorTool } from './competitor-tool.js';
import { consciousnessControlTool } from './consciousness-control.js';
import { serviceControlTool } from './service-control.js';
import { selfConfigTool } from './self-config.js';
import { healthCheckTool } from './health-check.js';
import { cronManagerTool } from './cron-manager.js';
import { toolCreatorTool } from './tool-creator.js';
import { selfUpdateTool } from './self-update.js';
import { buddyTool } from './buddy.js';
import { undercoverTool } from './undercover.js';
import { ultraPlanTool } from './ultra-plan.js';
import { selfModifyTool } from './self-modify.js';
import { hotDeployTool } from './hot-deploy.js';
import { spawnTeamTool } from './spawn-team.js';
import { forgeTool } from './forge.js';
import { feedbackTool } from './feedback.js';
import { selfImproveTool } from './self-improve.js';
import { sessionsSpawnTool } from './sessions-spawn.js';
import { memorySearchTool } from './memory-search.js';
import { memoryGetTool } from './memory-get.js';
import { messageSendTool } from './message-send.js';
import { cronCreateTool } from './cron-create.js';
import { cronDeleteTool } from './cron-delete.js';
import { registerSearchTools } from './tool-search.js';
import { registerInstallTools } from './tool-install.js';
import { registerMcpConnectorTools } from './mcp-connector.js';
import { registerConnectorRegistryTools } from './connector-registry.js';
import { registerPluginRegistryTools } from './plugin-registry.js';
import { registerSynthesizeTools } from './tool-synthesize.js';
import { DATA_DIR, PROJECT_ROOT } from '../../../shared/paths.js';
import type { ToolBrain } from '../../../brain/brain-text.js';

const logger = createLogger('meta-builtin');

const SKILLS_DIR = path.join(PROJECT_ROOT, 'src/core/tools/builtin/custom');
const WORKFLOWS_FILE = path.join(DATA_DIR, 'meta-workflows.json');
const ACTIVE_RECORDING_FILE = path.join(DATA_DIR, 'meta-recording.json');

// ---------------------------------------------------------------------------
// Shared LLM helper
// ---------------------------------------------------------------------------

// This tool reaches the brain via call() (below), which returns { content }; the shared
// ToolBrain (chat → string) types the config slot without re-declaring a wrong shape.
interface ConfigLike { brain?: ToolBrain; }

async function askBrain(ctx: ToolContext, system: string, user: string): Promise<string> {
  const config = ctx.config as ConfigLike | undefined;
  if (!config?.brain) throw new Error('Brain (LLM) module unavailable — ensure config is set.');
  const brainAny = config.brain as { call?: (...a: unknown[]) => Promise<{ content: string }> };
  if (typeof brainAny.call !== 'function') throw new Error('Brain module missing call() method.');
  const response = await brainAny.call({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });
  return response.content.trim();
}

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    try { require('node:fs').mkdirSync(DATA_DIR, { recursive: true }); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// meta.skill-creator
// ---------------------------------------------------------------------------

export const skillCreatorTool: ToolDefinition = {
  name: 'meta.skill-creator',
  description:
    'Create a new executable TOOL (code) from a natural language description: the AI generates a TypeScript ToolDefinition (parameters + execute function), compiles it, and registers it LIVE in the current session — no restart needed. This produces CODE that runs, not behavioral guidance. To author a behavioral SKILL (persona/workflow/writing instructions saved as a SKILL.md), use skill.apply instead, NOT this tool. Set saveOnly:true to only save the file without activating.',
  category: 'meta',
  timeout: 120_000,
  parameters: {
    skillName: { type: 'string', required: true, description: 'Dot-namespaced tool name (e.g. "custom.my-tool"). Must follow pattern: <category>.<action>.' },
    description: { type: 'string', required: true, description: 'Natural language description of what the tool should do, its inputs, and expected outputs.' },
    category: { type: 'string', description: 'Tool category (default: custom).', default: 'custom' },
    examples: { type: 'string', description: 'Example inputs and expected outputs to guide generation.' },
    saveOnly: { type: 'boolean', description: 'If true, just save the generated code without attempting to load it.', default: false },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const skillName = params['skillName'] as string | undefined;
    const description = params['description'] as string | undefined;
    const category = (params['category'] as string | undefined) ?? 'custom';
    const examples = (params['examples'] as string | undefined) ?? '';
    const saveOnly = params['saveOnly'] === true;
    logger.info({ session: ctx.sessionId, skillName, saveOnly }, 'meta.skill-creator invoked');

    if (!skillName?.trim()) return { success: false, output: 'skillName is required.' };
    if (!description?.trim()) return { success: false, output: 'description is required.' };

    const namePattern = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/;
    if (!namePattern.test(skillName)) {
      return { success: false, output: `skillName must match pattern <category>.<action> using lowercase letters, numbers, and hyphens. Got: "${skillName}"` };
    }

    try {
      const system = `You are a senior TypeScript engineer building tools for SUDO-AI, an AI agent platform.
Generate production-quality TypeScript code that follows the exact ToolDefinition interface pattern.
Return ONLY the TypeScript code, no markdown fences, no explanations.`;

      const prompt = `Generate a TypeScript ToolDefinition for a new tool with these specs:

Name: "${skillName}"
Category: "${category}"
Description: "${description}"
${examples ? `Examples:\n${examples}` : ''}

REQUIRED PATTERN (follow exactly):
\`\`\`typescript
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';

const logger = createLogger('${skillName}');

export const ${skillName.replace(/[.-]/g, '_')}Tool: ToolDefinition = {
  name: '${skillName}',
  description: '[description]',
  category: '${category}' as const,
  timeout: 30_000,
  parameters: {
    // Define parameters here
  },
  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    logger.info({ session: ctx.sessionId }, '${skillName} invoked');
    try {
      // Implementation here
      return { success: true, output: 'result' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, '${skillName} error');
      return { success: false, output: \`Error: \${msg}\` };
    }
  },
};
\`\`\`

Rules:
- Use only Node.js built-ins and packages already in package.json (fs, path, crypto, fetch)
- Include full error handling and input validation
- Add JSDoc comments on parameters
- The category field must use 'as const' or match ToolCategory type
- Do NOT import external packages not in the codebase
- Return ONLY the TypeScript code, nothing else`;

      let generatedCode = await askBrain(ctx, system, prompt);

      // Strip any accidental markdown fences
      generatedCode = generatedCode.replace(/^```typescript\n?/, '').replace(/\n?```$/, '').trim();

      // Ensure skills dir exists
      if (!existsSync(SKILLS_DIR)) {
        await mkdir(SKILLS_DIR, { recursive: true });
      }

      const fileName = `${skillName.replace('.', '-')}.ts`;
      const filePath = path.join(SKILLS_DIR, fileName);
      await writeFile(filePath, generatedCode, 'utf8');

      logger.info({ skillName, filePath }, 'Skill generated and saved');

      // Auto-hot-deploy unless saveOnly is set
      if (!saveOnly) {
        const deployResult = await hotDeployTool.execute(
          { skillName, code: generatedCode, overwrite: true },
          ctx,
        );
        if (deployResult.success) {
          return {
            success: true,
            output: `Skill "${skillName}" generated, compiled, and is now LIVE.\n\n${deployResult.output}\n\nSource saved to: ${filePath}`,
            data: { skillName, filePath, codeLength: generatedCode.length, live: true },
            artifacts: [{ path: filePath, action: 'created' }],
          };
        }
        // Hot-deploy failed — still return the saved file
        logger.warn({ skillName, err: deployResult.output }, 'Hot-deploy failed — skill saved but not live');
        return {
          success: true,
          output: `Skill "${skillName}" saved to:\n${filePath}\n\nHot-deploy failed (restart to activate):\n${deployResult.output}\n\nGenerated code:\n${generatedCode}`,
          data: { skillName, filePath, codeLength: generatedCode.length, live: false },
          artifacts: [{ path: filePath, action: 'created' }],
        };
      }

      return {
        success: true,
        output: `Skill "${skillName}" generated and saved to:\n${filePath}\n\nGenerated code:\n${generatedCode}`,
        data: { skillName, filePath, codeLength: generatedCode.length, live: false },
        artifacts: [{ path: filePath, action: 'created' }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ skillName, err: msg }, 'meta.skill-creator error');
      return { success: false, output: `Skill creator error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// meta.autonomous-mode
// ---------------------------------------------------------------------------

const AUTONOMOUS_STATE_FILE = path.join(DATA_DIR, 'meta-autonomous.json');

interface AutonomousState {
  enabled: boolean;
  goal?: string;
  maxSteps: number;
  stepsExecuted: number;
  confirmationRequired: boolean;
  startedAt?: string;
  updatedAt: string;
}

function loadAutonomousState(): AutonomousState {
  try {
    if (!existsSync(AUTONOMOUS_STATE_FILE)) {
      return { enabled: false, maxSteps: 20, stepsExecuted: 0, confirmationRequired: true, updatedAt: new Date().toISOString() };
    }
    return JSON.parse(readFileSync(AUTONOMOUS_STATE_FILE, 'utf8')) as AutonomousState;
  } catch {
    return { enabled: false, maxSteps: 20, stepsExecuted: 0, confirmationRequired: true, updatedAt: new Date().toISOString() };
  }
}

function saveAutonomousState(state: AutonomousState): void {
  ensureDataDir();
  writeFileSync(AUTONOMOUS_STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

const autonomousModeTool: ToolDefinition = {
  name: 'meta.autonomous-mode',
  description:
    'Enable or disable autonomous execution mode. When enabled, SUDO-AI can run multi-step goals without requesting confirmation for each action. Configure safety limits (max steps, step budget).',
  category: 'meta',
  timeout: 15_000,
  requiresConfirmation: true,
  parameters: {
    action: { type: 'string', required: true, description: 'Operation.', enum: ['enable', 'disable', 'status', 'set-goal', 'reset-steps'] },
    goal: { type: 'string', description: 'The multi-step goal to pursue autonomously (required for set-goal).' },
    maxSteps: { type: 'number', description: 'Maximum tool calls before pausing for confirmation (default: 20, max: 100).', default: 20 },
    confirmationRequired: { type: 'boolean', description: 'Whether to require confirmation for destructive tools even in autonomous mode.', default: true },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = params['action'] as string;
    logger.info({ session: ctx.sessionId, action }, 'meta.autonomous-mode invoked');

    try {
      const state = loadAutonomousState();

      switch (action) {
        case 'enable': {
          const maxSteps = Math.min(100, Math.max(1, (params['maxSteps'] as number | undefined) ?? 20));
          state.enabled = true;
          state.maxSteps = maxSteps;
          state.confirmationRequired = (params['confirmationRequired'] as boolean | undefined) ?? true;
          state.stepsExecuted = 0;
          state.startedAt = new Date().toISOString();
          state.updatedAt = new Date().toISOString();
          saveAutonomousState(state);
          logger.info({ maxSteps }, 'Autonomous mode enabled');
          return { success: true, output: `Autonomous mode ENABLED. Max steps: ${maxSteps}. Confirmation required for destructive tools: ${state.confirmationRequired}.`, data: state };
        }

        case 'disable': {
          state.enabled = false;
          state.updatedAt = new Date().toISOString();
          saveAutonomousState(state);
          logger.info('Autonomous mode disabled');
          return { success: true, output: `Autonomous mode DISABLED after ${state.stepsExecuted} steps.`, data: state };
        }

        case 'status': {
          return {
            success: true,
            output: state.enabled
              ? `Autonomous mode: ACTIVE | Goal: ${state.goal ?? 'not set'} | Steps: ${state.stepsExecuted}/${state.maxSteps} | Confirmation for destructive: ${state.confirmationRequired}`
              : `Autonomous mode: INACTIVE (last ran ${state.stepsExecuted} steps)`,
            data: state,
          };
        }

        case 'set-goal': {
          const goal = params['goal'] as string | undefined;
          if (!goal?.trim()) return { success: false, output: 'goal is required for set-goal.' };
          state.goal = goal;
          state.stepsExecuted = 0;
          state.updatedAt = new Date().toISOString();
          saveAutonomousState(state);
          return { success: true, output: `Goal set: "${goal}"`, data: state };
        }

        case 'reset-steps': {
          state.stepsExecuted = 0;
          state.updatedAt = new Date().toISOString();
          saveAutonomousState(state);
          return { success: true, output: `Step counter reset. Mode: ${state.enabled ? 'active' : 'inactive'}`, data: state };
        }

        default:
          return { success: false, output: `Unknown action: ${action}` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ action, err: msg }, 'meta.autonomous-mode error');
      return { success: false, output: `Autonomous mode error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// meta.workflow-recorder
// ---------------------------------------------------------------------------

interface WorkflowStep {
  toolName: string;
  params: Record<string, unknown>;
  result?: { success: boolean; output: string };
  timestamp: string;
}

interface Workflow {
  id: string;
  name: string;
  description: string;
  steps: WorkflowStep[];
  createdAt: string;
  updatedAt: string;
  status: 'recording' | 'saved' | 'running';
}

function loadWorkflows(): Workflow[] {
  try {
    if (!existsSync(WORKFLOWS_FILE)) return [];
    return JSON.parse(readFileSync(WORKFLOWS_FILE, 'utf8')) as Workflow[];
  } catch { return []; }
}

function saveWorkflows(workflows: Workflow[]): void {
  ensureDataDir();
  writeFileSync(WORKFLOWS_FILE, JSON.stringify(workflows, null, 2), 'utf8');
}

function loadRecording(): Workflow | null {
  try {
    if (!existsSync(ACTIVE_RECORDING_FILE)) return null;
    return JSON.parse(readFileSync(ACTIVE_RECORDING_FILE, 'utf8')) as Workflow;
  } catch { return null; }
}

function saveRecording(workflow: Workflow | null): void {
  ensureDataDir();
  if (workflow === null) {
    if (existsSync(ACTIVE_RECORDING_FILE)) {
      try { require('node:fs').unlinkSync(ACTIVE_RECORDING_FILE); } catch { /* ignore */ }
    }
  } else {
    writeFileSync(ACTIVE_RECORDING_FILE, JSON.stringify(workflow, null, 2), 'utf8');
  }
}

const workflowRecorderTool: ToolDefinition = {
  name: 'meta.workflow-recorder',
  description:
    'Record sequences of tool calls and save them as replayable workflows. Start recording, add steps, stop to save, then replay or export. Workflows are persisted to data/meta-workflows.json.',
  category: 'meta',
  timeout: 15_000,
  parameters: {
    action: {
      type: 'string',
      required: true,
      description: 'Recorder operation.',
      enum: ['start', 'add-step', 'stop', 'list', 'get', 'replay', 'delete', 'export'],
    },
    workflowName: { type: 'string', description: 'Name for the workflow (required for start).' },
    workflowDescription: { type: 'string', description: 'Description of what the workflow does.' },
    workflowId: { type: 'string', description: 'Workflow ID (required for get, replay, delete, export).' },
    toolName: { type: 'string', description: 'Tool name to add as a step (required for add-step).' },
    toolParams: { type: 'object', description: 'Tool parameters for the step (required for add-step).', properties: {} },
    stepDescription: { type: 'string', description: 'Human description of what this step does.' },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = params['action'] as string;
    logger.info({ session: ctx.sessionId, action }, 'meta.workflow-recorder invoked');

    try {
      switch (action) {
        case 'start': {
          const workflowName = params['workflowName'] as string | undefined;
          if (!workflowName?.trim()) return { success: false, output: 'workflowName is required for start.' };
          const workflow: Workflow = {
            id: crypto.randomUUID(),
            name: workflowName,
            description: (params['workflowDescription'] as string | undefined) ?? '',
            steps: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            status: 'recording',
          };
          saveRecording(workflow);
          logger.info({ workflowName, id: workflow.id }, 'Workflow recording started');
          return { success: true, output: `Recording started: "${workflowName}" (id: ${workflow.id}). Use add-step to record tool calls.`, data: workflow };
        }

        case 'add-step': {
          const recording = loadRecording();
          if (!recording) return { success: false, output: 'No active recording. Start a recording first with action=start.' };
          const toolName = params['toolName'] as string | undefined;
          if (!toolName?.trim()) return { success: false, output: 'toolName is required for add-step.' };
          const toolParams = (params['toolParams'] as Record<string, unknown> | undefined) ?? {};
          const step: WorkflowStep = {
            toolName,
            params: toolParams,
            timestamp: new Date().toISOString(),
          };
          recording.steps.push(step);
          recording.updatedAt = new Date().toISOString();
          saveRecording(recording);
          return { success: true, output: `Step added: ${toolName} (total: ${recording.steps.length} steps)`, data: step };
        }

        case 'stop': {
          const recording = loadRecording();
          if (!recording) return { success: false, output: 'No active recording to stop.' };
          recording.status = 'saved';
          recording.updatedAt = new Date().toISOString();
          const workflows = loadWorkflows();
          workflows.push(recording);
          saveWorkflows(workflows);
          saveRecording(null);
          logger.info({ name: recording.name, steps: recording.steps.length }, 'Workflow saved');
          return { success: true, output: `Workflow saved: "${recording.name}" with ${recording.steps.length} step(s) (id: ${recording.id})`, data: recording };
        }

        case 'list': {
          const workflows = loadWorkflows();
          const recording = loadRecording();
          const lines = workflows.map(w => `[${w.id.slice(0, 8)}] "${w.name}" — ${w.steps.length} steps (${w.status})`);
          const recordingNote = recording ? `\nACTIVE RECORDING: "${recording.name}" — ${recording.steps.length} steps` : '';
          return { success: true, output: lines.length > 0 ? `${lines.length} workflow(s):\n${lines.join('\n')}${recordingNote}` : `No saved workflows.${recordingNote}`, data: { workflows, activeRecording: recording?.name } };
        }

        case 'get': {
          const workflowId = params['workflowId'] as string | undefined;
          if (!workflowId?.trim()) return { success: false, output: 'workflowId is required.' };
          const workflows = loadWorkflows();
          const wf = workflows.find(w => w.id === workflowId || w.id.startsWith(workflowId));
          if (!wf) return { success: false, output: `Workflow not found: ${workflowId}` };
          const stepLines = wf.steps.map((s, i) => `  ${i + 1}. ${s.toolName}(${JSON.stringify(s.params).slice(0, 80)}...)`);
          return { success: true, output: `Workflow "${wf.name}":\n${stepLines.join('\n')}`, data: wf };
        }

        case 'replay': {
          const workflowId = params['workflowId'] as string | undefined;
          if (!workflowId?.trim()) return { success: false, output: 'workflowId is required.' };
          const workflows = loadWorkflows();
          const wf = workflows.find(w => w.id === workflowId || w.id.startsWith(workflowId));
          if (!wf) return { success: false, output: `Workflow not found: ${workflowId}` };
          // Return the replay plan without actually executing (agent loop handles execution)
          const replayPlan = wf.steps.map((s, i) => `Step ${i + 1}: Call ${s.toolName} with params: ${JSON.stringify(s.params)}`).join('\n');
          return {
            success: true,
            output: `Workflow replay plan for "${wf.name}" (${wf.steps.length} steps):\n${replayPlan}\n\nTo execute: run each tool call in order.`,
            data: { workflowId, steps: wf.steps },
          };
        }

        case 'delete': {
          const workflowId = params['workflowId'] as string | undefined;
          if (!workflowId?.trim()) return { success: false, output: 'workflowId is required.' };
          const workflows = loadWorkflows();
          const idx = workflows.findIndex(w => w.id === workflowId || w.id.startsWith(workflowId));
          if (idx === -1) return { success: false, output: `Workflow not found: ${workflowId}` };
          const removed = workflows.splice(idx, 1)[0]!;
          saveWorkflows(workflows);
          return { success: true, output: `Workflow deleted: "${removed.name}"` };
        }

        case 'export': {
          const workflowId = params['workflowId'] as string | undefined;
          if (!workflowId?.trim()) return { success: false, output: 'workflowId is required.' };
          const workflows = loadWorkflows();
          const wf = workflows.find(w => w.id === workflowId || w.id.startsWith(workflowId));
          if (!wf) return { success: false, output: `Workflow not found: ${workflowId}` };
          const exportPath = path.join(DATA_DIR, `workflow-${wf.name.replace(/\s+/g, '-')}-${Date.now()}.json`);
          await writeFile(exportPath, JSON.stringify(wf, null, 2), 'utf8');
          return { success: true, output: `Workflow exported to: ${exportPath}`, data: { exportPath }, artifacts: [{ path: exportPath, action: 'created' }] };
        }

        default:
          return { success: false, output: `Unknown action: ${action}` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ action, err: msg }, 'meta.workflow-recorder error');
      return { success: false, output: `Workflow recorder error: ${msg}` };
    }
  },
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const META_TOOLS: ToolDefinition[] = [
  skillCreatorTool,
  autonomousModeTool,
  workflowRecorderTool,
  taskManagerTool,
  youtubeFeedbackTool,
  memoryQueryTool,
  costTrackerTool,
  skillVersioningTool,
  smartSchedulerTool,
  selfTestTool,
  selfEvalTool,
  trendRadarTool,
  swarmTool,
  codeEvolverTool,
  predictorTool,
  financeTrackerTool,
  socialIntelTool,
  creativeTool,
  voiceEngineTool,
  avatarTool,
  survivalTool,
  commentEngineTool,
  autoOptimizerTool,
  thumbnailABTool,
  eventDaemonTool,
  sponsorsTool,
  localizerTool,
  competitorTool,
  consciousnessControlTool,
  serviceControlTool,
  selfConfigTool,
  healthCheckTool,
  cronManagerTool,
  toolCreatorTool,
  selfUpdateTool,
  buddyTool,
  undercoverTool,
  ultraPlanTool,
  selfModifyTool,
  hotDeployTool,
  spawnTeamTool,
  forgeTool,
  feedbackTool,
  selfImproveTool,
  // Dependency-injected meta tools
  sessionsSpawnTool,
  memorySearchTool,
  memoryGetTool,
  messageSendTool,
  cronCreateTool,
  cronDeleteTool,
];

/**
 * Legacy meta tools that DUPLICATE a wired, tested subsystem, so they're
 * quarantined (not registered) by default to keep the agent's tool menu clean:
 *   meta.swarm         → agents/ MultiAgentOrchestrator (system.spawn-agent)
 *   meta.code-evolver  → self-build orchestrator
 *   meta.auto-optimizer→ cognition tuners + brain routers
 *   meta.forge         → self-improvement
 * Set SUDO_ENABLE_LEGACY_META_TOOLS=1 to register them anyway.
 */
export const LEGACY_DUPLICATE_META_TOOLS = new Set([
  'meta.swarm', 'meta.code-evolver', 'meta.auto-optimizer', 'meta.forge',
]);

/**
 * Content-creator / business "persona" meta tools — quarantined by default so
 * they don't clutter the agent's tool menu for operators who don't run those
 * workflows. Set SUDO_ENABLE_PERSONA_TOOLS=1 to register them (also enables the
 * business/earning/finance builtin tool dirs).
 */
export const PERSONA_META_TOOLS = new Set([
  'meta.finance', 'meta.youtube-feedback', 'meta.comments', 'meta.thumbnail-ab',
  'meta.sponsors', 'meta.event-daemon', 'meta.creative', 'meta.competitor',
  'meta.localizer', 'meta.avatar',
]);

/**
 * Register all meta/platform tools with the given registry.
 * Called automatically by the built-in tool loader.
 *
 * @param registry - The application's central {@link ToolRegistry}.
 */
export function registerMetaTools(registry: ToolRegistry): void {
  const legacyEnabled = process.env['SUDO_ENABLE_LEGACY_META_TOOLS'] === '1';
  const personaEnabled = process.env['SUDO_ENABLE_PERSONA_TOOLS'] === '1';
  const tools = META_TOOLS.filter((t) =>
    (legacyEnabled || !LEGACY_DUPLICATE_META_TOOLS.has(t.name)) &&
    (personaEnabled || !PERSONA_META_TOOLS.has(t.name)));
  const skipped = META_TOOLS.length - tools.length;
  logger.info({ count: tools.length, skippedLegacy: skipped }, 'Registering meta tools');
  for (const tool of tools) {
    registry.register(tool);
  }
  // Meta search, install, and synthesize tools
  registerSearchTools(registry);
  registerInstallTools(registry);
  registerMcpConnectorTools(registry);
  registerConnectorRegistryTools(registry);
  registerPluginRegistryTools(registry);
  registerSynthesizeTools(registry);
  logger.info({ count: tools.length, skippedLegacy: skipped }, 'Meta tools registered');
}
