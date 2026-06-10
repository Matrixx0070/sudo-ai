/**
 * meta.consciousness-control — Runtime control of SUDO-AI consciousness modules.
 *
 * Allows the brain to start, stop, or query the status of consciousness
 * subsystems (cognitive stream, embodied state) without restarting the process.
 *
 * Mechanism:
 *   1. Writes desired state to `data/consciousness-control.json` (persists across restarts).
 *   2. Emits a `sudo:consciousness:control` event on `process` for immediate effect
 *      (the ConsciousnessOrchestrator listens for this event).
 *
 * Actions:
 *   status          — Read current control state from the persisted file
 *   start-stream    — Enable the cognitive stream
 *   stop-stream     — Disable the cognitive stream
 *   start-embodied  — Enable embodied state processing
 *   stop-embodied   — Disable embodied state processing
 *   start-all       — Enable all consciousness modules
 *   stop-all        — Disable all consciousness modules
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';
import { DATA_DIR, dataPath } from '../../../shared/paths.js';
import Database from 'better-sqlite3';

const logger = createLogger('meta.consciousness-control');

// ---------------------------------------------------------------------------
// Control file path
// ---------------------------------------------------------------------------

const CONTROL_FILE = dataPath('consciousness-control.json');

// ---------------------------------------------------------------------------
// Control state shape
// ---------------------------------------------------------------------------

interface ControlState {
  cognitiveStream: boolean;
  embodiedState: boolean;
  lastUpdated: string;
  lastAction: string;
  lastSessionId: string;
}

const DEFAULT_STATE: ControlState = {
  cognitiveStream: true,
  embodiedState: true,
  lastUpdated: new Date().toISOString(),
  lastAction: 'init',
  lastSessionId: '',
};

// ---------------------------------------------------------------------------
// File I/O helpers
// ---------------------------------------------------------------------------

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
    logger.debug('Created data directory: %s', DATA_DIR);
  }
}

function readState(): ControlState {
  try {
    if (!existsSync(CONTROL_FILE)) {
      return { ...DEFAULT_STATE };
    }
    const raw = readFileSync(CONTROL_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<ControlState>;

    // Merge with defaults so missing keys are filled in
    return {
      cognitiveStream: typeof parsed.cognitiveStream === 'boolean' ? parsed.cognitiveStream : DEFAULT_STATE.cognitiveStream,
      embodiedState: typeof parsed.embodiedState === 'boolean' ? parsed.embodiedState : DEFAULT_STATE.embodiedState,
      lastUpdated: typeof parsed.lastUpdated === 'string' ? parsed.lastUpdated : DEFAULT_STATE.lastUpdated,
      lastAction: typeof parsed.lastAction === 'string' ? parsed.lastAction : DEFAULT_STATE.lastAction,
      lastSessionId: typeof parsed.lastSessionId === 'string' ? parsed.lastSessionId : DEFAULT_STATE.lastSessionId,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg }, 'Failed to read control file, using defaults');
    return { ...DEFAULT_STATE };
  }
}

function writeState(state: ControlState): void {
  ensureDataDir();
  writeFileSync(CONTROL_FILE, JSON.stringify(state, null, 2) + '\n', 'utf-8');
  logger.info({ state }, 'Wrote consciousness control state');
}

// ---------------------------------------------------------------------------
// Process event emitter
// ---------------------------------------------------------------------------

function emitControlEvent(module: string, action: 'start' | 'stop'): void {
  try {
    process.emit('sudo:consciousness:control' as never, { module, action } as never);
    logger.debug({ module, action }, 'Emitted sudo:consciousness:control event');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg }, 'Failed to emit process event (non-fatal)');
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Module activity reader (from consciousness.db)
// ---------------------------------------------------------------------------

interface ModuleActivity {
  thoughts: number;
  bodyStates: number;
  episodes: number;
  userModels: number;
  driveLogs: number;
  emotionalLogs: number;
  surprises: number;
  counterfactuals: number;
  debates: number;
  reflections: number;
  relationships: number;
  worldModel: number;
  selfSnapshots: number;
  intentions: number;
}

function readModuleActivity(): ModuleActivity | null {
  const dbPath = dataPath('consciousness.db');
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const count = (table: string): number => {
      try { return (db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number }).c; }
      catch { return -1; }
    };
    const result: ModuleActivity = {
      thoughts:       count('thoughts'),
      bodyStates:     count('body_state_log'),
      episodes:       count('episodes'),
      userModels:     count('user_models'),
      driveLogs:      count('drive_log'),
      emotionalLogs:  count('emotional_state_log'),
      surprises:      count('surprise_events'),
      counterfactuals: count('counterfactuals'),
      debates:        count('debates'),
      reflections:    count('reflections'),
      relationships:  count('relationships'),
      worldModel:     count('world_model'),
      selfSnapshots:  count('self_snapshots'),
      intentions:     count('intentions'),
    };
    db.close();
    return result;
  } catch {
    return null;
  }
}

function formatState(state: ControlState): string {
  const streamIcon   = state.cognitiveStream ? '● RUNNING' : '○ STOPPED';
  const embodiedIcon = state.embodiedState   ? '● RUNNING' : '○ STOPPED';

  const act = readModuleActivity();

  const modLine = (label: string, active: boolean, detail: string) =>
    `  ${active ? '●' : '○'} ${label.padEnd(24)} ${detail}`;

  const rows: string[] = [
    'Consciousness Module Status:',
    '',
    '  [Continuous Background Loops]',
    modLine('Cognitive Stream',   state.cognitiveStream, `${streamIcon} | thoughts: ${act?.thoughts ?? '?'}`),
    modLine('Embodied State',     state.embodiedState,   `${embodiedIcon} | body-state logs: ${act?.bodyStates ?? '?'}`),
    '',
    '  [Event-Driven / Always Initialized]',
    modLine('Episodic Memory',    true, `initialized | episodes: ${act?.episodes ?? '?'}`),
    modLine('Emotional State',    true, `initialized | log entries: ${act?.emotionalLogs ?? '?'}`),
    modLine('Drive Manager',      true, `initialized | drive logs: ${act?.driveLogs ?? '?'}`),
    modLine('Prospective Memory', true, `initialized | intentions: ${act?.intentions ?? '?'}`),
    modLine('World Model',        true, `initialized | world facts: ${act?.worldModel ?? '?'}`),
    modLine('Self Model',         true, `initialized | snapshots: ${act?.selfSnapshots ?? '?'}`),
    modLine('Theory of Mind',     true, `initialized | user models: ${act?.userModels ?? '?'}`),
    modLine('Counterfactual Eng.',true, `initialized | counterfactuals: ${act?.counterfactuals ?? '?'}`),
    modLine('Metacognition',      true, `initialized | reflections: ${act?.reflections ?? '?'}`),
    modLine('Internal Dialogue',  true, `initialized | debates: ${act?.debates ?? '?'}`),
    modLine('Relationship Tracker',true,`initialized | relationships: ${act?.relationships ?? '?'}`),
    modLine('Temporal Self',      true, `initialized | episodes: ${act?.episodes ?? '?'}`),
    modLine('Spreading Activation',true,`initialized`),
    modLine('Attention Manager',  true, `initialized`),
    modLine('Surprise Engine',    true, `initialized | surprises: ${act?.surprises ?? '?'}`),
    '',
    `  Last Action  : ${state.lastAction}`,
    `  Last Updated : ${state.lastUpdated}`,
    `  Last Session : ${state.lastSessionId || '(none)'}`,
  ];

  return rows.join('\n');
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const consciousnessControlTool: ToolDefinition = {
  name: 'meta.consciousness-control',
  description:
    'Control SUDO-AI consciousness modules at runtime. Use this tool to start or stop the ' +
    'cognitive stream (continuous thought processing) or embodied state (environmental awareness) ' +
    'without restarting the process. Useful when you need to conserve resources, debug consciousness ' +
    'behaviour, or temporarily pause self-reflection loops. The "status" action shows what is ' +
    'currently running.',
  category: 'meta',
  timeout: 10_000,
  parameters: {
    action: {
      type: 'string',
      required: true,
      description: 'The control action to perform.',
      enum: [
        'status',
        'start-stream',
        'stop-stream',
        'start-embodied',
        'stop-embodied',
        'start-all',
        'stop-all',
      ],
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = params['action'] as string | undefined;
    logger.info({ session: ctx.sessionId, action }, 'meta.consciousness-control invoked');

    if (!action?.trim()) {
      return { success: false, output: 'action is required.' };
    }

    const validActions = [
      'status', 'start-stream', 'stop-stream',
      'start-embodied', 'stop-embodied', 'start-all', 'stop-all',
    ];

    if (!validActions.includes(action)) {
      return {
        success: false,
        output: `Unknown action: "${action}". Valid actions: ${validActions.join(', ')}`,
      };
    }

    try {
      // ------ STATUS (read-only) ------
      if (action === 'status') {
        const state = readState();
        return {
          success: true,
          output: formatState(state),
          data: state,
        };
      }

      // ------ MUTATING ACTIONS ------
      const state = readState();
      const now = new Date().toISOString();

      switch (action) {
        case 'start-stream':
          state.cognitiveStream = true;
          emitControlEvent('cognitiveStream', 'start');
          break;

        case 'stop-stream':
          state.cognitiveStream = false;
          emitControlEvent('cognitiveStream', 'stop');
          break;

        case 'start-embodied':
          state.embodiedState = true;
          emitControlEvent('embodiedState', 'start');
          break;

        case 'stop-embodied':
          state.embodiedState = false;
          emitControlEvent('embodiedState', 'stop');
          break;

        case 'start-all':
          state.cognitiveStream = true;
          state.embodiedState = true;
          emitControlEvent('cognitiveStream', 'start');
          emitControlEvent('embodiedState', 'start');
          break;

        case 'stop-all':
          state.cognitiveStream = false;
          state.embodiedState = false;
          emitControlEvent('cognitiveStream', 'stop');
          emitControlEvent('embodiedState', 'stop');
          break;
      }

      state.lastAction = action;
      state.lastUpdated = now;
      state.lastSessionId = ctx.sessionId;

      writeState(state);

      const verb = action.startsWith('start') ? 'Started' : 'Stopped';
      const target =
        action.endsWith('-all') ? 'all consciousness modules' :
        action.endsWith('-stream') ? 'cognitive stream' :
        'embodied state';

      return {
        success: true,
        output: `${verb} ${target}.\n\n${formatState(state)}`,
        data: state,
        artifacts: [
          { path: CONTROL_FILE, action: 'modified', size: undefined },
        ],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ action, err: msg }, 'meta.consciousness-control error');
      return { success: false, output: `Consciousness control error: ${msg}` };
    }
  },
};
