/**
 * @file commands/builtin.ts
 * @description Built-in slash commands for SUDO-AI.
 *
 * Commands registered here are available to all channel adapters.
 * Each command is a pure function: takes (args, ctx) and returns a string.
 *
 * Registered commands:
 *   /status  /cost  /tools  /clear  /export  /tasks  /think  /help
 */

import { createLogger } from '../shared/logger.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandRegistry } from './registry.js';
import type { CommandContext } from './types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { SessionManager } from '../sessions/manager.js';
import type { CostTracker } from '../brain/cost-tracker.js';

const log = createLogger('commands:builtin');

// ---------------------------------------------------------------------------
// Dependencies injected at registration time
// ---------------------------------------------------------------------------

export interface BuiltinDeps {
  toolRegistry: ToolRegistry;
  sessionManager: SessionManager;
  costTracker: CostTracker;
  /** Optional consciousness orchestrator (duck-typed). */
  consciousness?: {
    getConsciousnessContext(): string;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format bytes to human-readable string. */
function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** Resolve the export directory, creating it if needed. */
function ensureExportDir(): string {
  const dir = join(process.cwd(), 'data', 'exports');
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // already exists
  }
  return dir;
}

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

function makeStatusCommand(deps: BuiltinDeps) {
  return async (_args: string, _ctx: CommandContext): Promise<string> => {
    const uptime = process.uptime();
    const uptimeStr = `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${Math.floor(uptime % 60)}s`;
    const mem = process.memoryUsage();
    const toolCount = deps.toolRegistry.listAll().length;
    const enabledCount = deps.toolRegistry.listEnabled().length;

    let consciousnessState = 'not available';
    if (deps.consciousness) {
      try {
        const ctx = deps.consciousness.getConsciousnessContext();
        consciousnessState = ctx.slice(0, 80) || 'active';
      } catch {
        consciousnessState = 'error';
      }
    }

    return [
      'SUDO-AI System Status',
      '====================',
      `Uptime       : ${uptimeStr}`,
      `Tools        : ${enabledCount}/${toolCount} enabled`,
      `Memory (RSS) : ${fmtBytes(mem.rss)}`,
      `Heap used    : ${fmtBytes(mem.heapUsed)} / ${fmtBytes(mem.heapTotal)}`,
      `Consciousness: ${consciousnessState}`,
      `Node.js      : ${process.version}`,
    ].join('\n');
  };
}

function makeCostCommand(deps: BuiltinDeps) {
  return async (_args: string, ctx: CommandContext): Promise<string> => {
    return deps.costTracker.formatReport(ctx.sessionId);
  };
}

function makeToolsCommand(deps: BuiltinDeps) {
  return async (args: string, _ctx: CommandContext): Promise<string> => {
    const all = deps.toolRegistry.listAll();
    if (all.length === 0) return 'No tools registered.';

    // Group by category
    const byCategory = new Map<string, string[]>();
    for (const tool of all) {
      const cat = tool.category ?? 'uncategorized';
      const list = byCategory.get(cat) ?? [];
      list.push(tool.name);
      byCategory.set(cat, list);
    }

    const filter = args.trim().toLowerCase();
    const lines: string[] = [`Tools (${all.length} total)`, ''];
    for (const [cat, names] of [...byCategory.entries()].sort()) {
      if (filter && cat !== filter) continue;
      lines.push(`[${cat}]`);
      for (const name of names.sort()) lines.push(`  ${name}`);
      lines.push('');
    }
    return lines.join('\n').trim();
  };
}

function makeClearCommand(deps: BuiltinDeps) {
  return async (_args: string, ctx: CommandContext): Promise<string> => {
    try {
      const session = await deps.sessionManager.get(ctx.sessionId);
      if (!session) return 'No active session found.';
      session.messages = [];
      await deps.sessionManager.save(session);
      log.info({ sessionId: ctx.sessionId }, 'Session history cleared via /clear');
      return 'Conversation history cleared.';
    } catch (err) {
      log.error({ sessionId: ctx.sessionId, err: String(err) }, '/clear failed');
      return `Failed to clear session: ${String(err)}`;
    }
  };
}

function makeExportCommand(deps: BuiltinDeps) {
  return async (_args: string, ctx: CommandContext): Promise<string> => {
    try {
      const markdown = await deps.sessionManager.exportSession(ctx.sessionId);
      if (!markdown) return 'No session data to export.';

      const dateStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filename = `conversation-${dateStr}.md`;
      const dir = ensureExportDir();
      const fullPath = join(dir, filename);

      writeFileSync(fullPath, markdown, 'utf-8');
      log.info({ sessionId: ctx.sessionId, path: fullPath }, 'Session exported');
      return `Conversation exported to: ${fullPath}`;
    } catch (err) {
      log.error({ sessionId: ctx.sessionId, err: String(err) }, '/export failed');
      return `Export failed: ${String(err)}`;
    }
  };
}

function makeTasksCommand() {
  return async (_args: string, _ctx: CommandContext): Promise<string> => {
    // system.tasks is not yet implemented as a module — return informational message.
    return 'Task queue is empty (no tasks scheduled).';
  };
}

function makeThinkCommand(deps: BuiltinDeps) {
  return async (_args: string, _ctx: CommandContext): Promise<string> => {
    if (!deps.consciousness) {
      return 'Consciousness layer is not active.';
    }
    try {
      const context = deps.consciousness.getConsciousnessContext();
      return context.trim() || 'No recent thoughts available.';
    } catch (err) {
      return `Could not retrieve thoughts: ${String(err)}`;
    }
  };
}

function makeHelpCommand(registry: CommandRegistry) {
  return async (_args: string, _ctx: CommandContext): Promise<string> => {
    const cmds = registry.listAll();
    if (cmds.length === 0) return 'No commands registered.';

    const lines: string[] = ['Available Commands', '=================='];
    for (const cmd of [...cmds].sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(`/${cmd.name.padEnd(10)} — ${cmd.description}`);
    }
    return lines.join('\n');
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register all built-in slash commands into the provided CommandRegistry.
 *
 * @param registry - The CommandRegistry to populate.
 * @param deps     - Runtime service dependencies.
 */
export function registerBuiltinCommands(
  registry: CommandRegistry,
  deps: BuiltinDeps,
): void {
  const commands = [
    {
      name: 'status',
      description: 'Show system status (uptime, memory, tools)',
      usage: '/status',
      execute: makeStatusCommand(deps),
    },
    {
      name: 'cost',
      description: 'Show token cost for the current session',
      usage: '/cost',
      execute: makeCostCommand(deps),
    },
    {
      name: 'tools',
      description: 'List all registered tools by category',
      usage: '/tools [category]',
      execute: makeToolsCommand(deps),
    },
    {
      name: 'clear',
      description: 'Clear current session message history',
      usage: '/clear',
      execute: makeClearCommand(deps),
    },
    {
      name: 'export',
      description: 'Export current conversation as markdown file',
      usage: '/export',
      execute: makeExportCommand(deps),
    },
    {
      name: 'tasks',
      description: 'List pending scheduled tasks',
      usage: '/tasks',
      execute: makeTasksCommand(),
    },
    {
      name: 'think',
      description: 'Show recent thoughts from the cognitive stream',
      usage: '/think',
      execute: makeThinkCommand(deps),
    },
    {
      name: 'help',
      description: 'List all available slash commands',
      usage: '/help',
      execute: makeHelpCommand(registry),
    },
  ];

  for (const cmd of commands) {
    try {
      registry.register(cmd);
      log.info({ name: cmd.name }, 'Built-in command registered');
    } catch (err) {
      log.error({ name: cmd.name, err: String(err) }, 'Failed to register built-in command');
    }
  }

  log.info({ count: commands.length }, 'All built-in commands registered');
}
