/**
 * meta.self-config — Read and modify SUDO-AI's own configuration file.
 *
 * Actions:
 *   read               — Return full config or a specific section
 *   get                — Get a value by dot-notation path (e.g. "models.primary.0.id")
 *   set                — Set a value by dot-notation path (auto-backs up first)
 *   add-disabled-tool  — Add a tool name to tools.disabled
 *   remove-disabled-tool — Remove a tool name from tools.disabled
 *   add-cron-job       — Add a cron job object to cron.jobs
 *   remove-cron-job    — Remove a cron job by index or name
 *   backup             — Create a timestamped backup of the config
 *
 * Safety:
 *   - All write operations auto-backup before modifying
 *   - Writes to auth.* paths are rejected (secrets protection)
 *   - Config is validated as parseable before writing
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const logger = createLogger('meta.self-config');
const CONFIG_PATH = path.resolve('config/sudo-ai.json5');

// ---------------------------------------------------------------------------
// JSON5-lite helpers
// ---------------------------------------------------------------------------

/**
 * Strip single-line comments (// ...) and trailing commas so the result is
 * valid JSON that `JSON.parse` can handle.  Does NOT strip block comments.
 */
function stripJson5(raw: string): string {
  // Remove single-line comments that are NOT inside strings.
  // Strategy: walk through, skip quoted strings, strip // to EOL elsewhere.
  let result = '';
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];

    // Handle strings — pass through verbatim
    if (ch === '"' || ch === "'") {
      const quote = ch;
      result += ch;
      i++;
      while (i < raw.length && raw[i] !== quote) {
        if (raw[i] === '\\') {
          result += raw[i++]; // backslash
        }
        if (i < raw.length) result += raw[i++];
      }
      if (i < raw.length) result += raw[i++]; // closing quote
      continue;
    }

    // Single-line comment
    if (ch === '/' && raw[i + 1] === '/') {
      // Skip to end of line
      while (i < raw.length && raw[i] !== '\n') i++;
      continue;
    }

    // Block comment
    if (ch === '/' && raw[i + 1] === '*') {
      i += 2;
      while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) i++;
      i += 2; // skip */
      continue;
    }

    result += ch;
    i++;
  }

  // Remove trailing commas before } or ]
  result = result.replace(/,\s*([\]}])/g, '$1');

  // Replace single-quoted strings with double-quoted (simple JSON5 compat)
  // Only for unquoted property values — skip if already double-quoted
  // This is intentionally conservative.

  // Handle unquoted keys: word: → "word":
  result = result.replace(/(?<=[\n,{]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)(\s*:)/g, '"$1"$2');

  return result;
}

/** Parse a JSON5-ish string into an object. */
function parseConfig(raw: string): Record<string, unknown> {
  const cleaned = stripJson5(raw);
  return JSON.parse(cleaned) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Dot-notation path helpers
// ---------------------------------------------------------------------------

function getByPath(obj: any, dotPath: string): any {
  return dotPath.split('.').reduce((o, k) => o?.[k], obj);
}

function setByPath(obj: any, dotPath: string, value: any): void {
  const keys = dotPath.split('.');
  const last = keys.pop()!;
  const target = keys.reduce((o, k) => {
    if (o[k] === undefined || o[k] === null) o[k] = {};
    return o[k];
  }, obj);
  target[last] = value;
}

// ---------------------------------------------------------------------------
// Backup helper
// ---------------------------------------------------------------------------

function createBackup(): string {
  const dir = path.dirname(CONFIG_PATH);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${CONFIG_PATH}.bak.${timestamp}`;
  copyFileSync(CONFIG_PATH, backupPath);
  logger.info({ backupPath }, 'Config backup created');
  return backupPath;
}

// ---------------------------------------------------------------------------
// Read / write config
// ---------------------------------------------------------------------------

function readConfig(): Record<string, unknown> {
  const raw = readFileSync(CONFIG_PATH, 'utf8');
  return parseConfig(raw);
}

function writeConfig(config: Record<string, unknown>): void {
  const json = JSON.stringify(config, null, 2);
  // Validate it round-trips cleanly
  JSON.parse(json);
  writeFileSync(CONFIG_PATH, json + '\n', 'utf8');
  logger.info('Config written');
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const selfConfigTool: ToolDefinition = {
  name: 'meta.self-config',
  description:
    'Read and modify SUDO-AI\'s own configuration (config/sudo-ai.json5). ' +
    'Supports reading full config or sections, getting/setting values by dot-notation path, ' +
    'managing disabled tools and cron jobs, and creating backups. ' +
    'Auth/secret keys cannot be modified through this tool.',
  category: 'meta',
  timeout: 15_000,
  parameters: {
    action: {
      type: 'string',
      required: true,
      description: 'Operation to perform.',
      enum: [
        'read',
        'get',
        'set',
        'add-disabled-tool',
        'remove-disabled-tool',
        'add-cron-job',
        'remove-cron-job',
        'backup',
      ],
    },
    section: {
      type: 'string',
      description:
        'Top-level config section to read (e.g. "models", "channels"). Used with action=read.',
    },
    path: {
      type: 'string',
      description:
        'Dot-notation path to a config value (e.g. "models.primary.0.id"). Used with action=get/set.',
    },
    value: {
      type: 'string',
      description:
        'New value to set (JSON-encoded). For strings pass \'"hello"\', for numbers pass \'42\', for objects pass \'{"key":"val"}\'. Used with action=set/add-cron-job.',
    },
    toolName: {
      type: 'string',
      description:
        'Tool name to add or remove from the disabled list. Used with add-disabled-tool / remove-disabled-tool.',
    },
    cronJob: {
      type: 'object',
      description:
        'Cron job object with at minimum { name, schedule, action }. Used with action=add-cron-job.',
      properties: {
        name: { type: 'string', description: 'Unique name for the cron job.' },
        schedule: { type: 'string', description: 'Cron expression (e.g. "0 */6 * * *").' },
        action: { type: 'string', description: 'Tool name or action to run.' },
      },
    },
    jobIdentifier: {
      type: 'string',
      description:
        'Cron job name or numeric index to remove. Used with action=remove-cron-job.',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = params['action'] as string;
    logger.info({ session: ctx.sessionId, action }, 'meta.self-config invoked');

    if (!existsSync(CONFIG_PATH)) {
      return {
        success: false,
        output: `Config file not found at ${CONFIG_PATH}`,
      };
    }

    try {
      switch (action) {
        // -------------------------------------------------------------------
        // READ
        // -------------------------------------------------------------------
        case 'read': {
          const config = readConfig();
          const section = params['section'] as string | undefined;
          if (section) {
            const data = config[section];
            if (data === undefined) {
              return {
                success: false,
                output: `Section "${section}" not found. Available sections: ${Object.keys(config).join(', ')}`,
              };
            }
            return {
              success: true,
              output: `Config section "${section}":\n${JSON.stringify(data, null, 2)}`,
              data,
            };
          }
          return {
            success: true,
            output: `Full config:\n${JSON.stringify(config, null, 2)}`,
            data: config,
          };
        }

        // -------------------------------------------------------------------
        // GET
        // -------------------------------------------------------------------
        case 'get': {
          const dotPath = params['path'] as string | undefined;
          if (!dotPath?.trim()) {
            return { success: false, output: 'path is required for action=get.' };
          }
          const config = readConfig();
          const value = getByPath(config, dotPath);
          if (value === undefined) {
            return {
              success: false,
              output: `Path "${dotPath}" not found in config.`,
            };
          }
          return {
            success: true,
            output: `config.${dotPath} = ${JSON.stringify(value, null, 2)}`,
            data: value,
          };
        }

        // -------------------------------------------------------------------
        // SET
        // -------------------------------------------------------------------
        case 'set': {
          const dotPath = params['path'] as string | undefined;
          const rawValue = params['value'] as string | undefined;
          if (!dotPath?.trim()) {
            return { success: false, output: 'path is required for action=set.' };
          }
          if (rawValue === undefined || rawValue === null) {
            return { success: false, output: 'value is required for action=set.' };
          }

          // Security: reject auth.* writes
          if (dotPath.startsWith('auth.') || dotPath === 'auth') {
            return {
              success: false,
              output: 'SECURITY: Modifying auth/secret keys through this tool is not allowed. Edit the config file directly.',
            };
          }

          let parsedValue: unknown;
          try {
            parsedValue = JSON.parse(rawValue);
          } catch {
            // Treat as plain string if not valid JSON
            parsedValue = rawValue;
          }

          const config = readConfig();
          const backupPath = createBackup();
          setByPath(config, dotPath, parsedValue);
          writeConfig(config);

          logger.info({ path: dotPath, value: parsedValue }, 'Config value set');
          return {
            success: true,
            output: `Set config.${dotPath} = ${JSON.stringify(parsedValue)}\nBackup: ${backupPath}`,
            data: { path: dotPath, value: parsedValue, backupPath },
            artifacts: [
              { path: CONFIG_PATH, action: 'modified' },
              { path: backupPath, action: 'created' },
            ],
          };
        }

        // -------------------------------------------------------------------
        // ADD-DISABLED-TOOL
        // -------------------------------------------------------------------
        case 'add-disabled-tool': {
          const toolName = params['toolName'] as string | undefined;
          if (!toolName?.trim()) {
            return { success: false, output: 'toolName is required for add-disabled-tool.' };
          }

          const config = readConfig();
          const tools = (config['tools'] ?? {}) as Record<string, unknown>;
          const disabled = (tools['disabled'] ?? []) as string[];

          if (disabled.includes(toolName)) {
            return {
              success: true,
              output: `Tool "${toolName}" is already in the disabled list.`,
              data: { disabled },
            };
          }

          const backupPath = createBackup();
          disabled.push(toolName);
          tools['disabled'] = disabled;
          config['tools'] = tools;
          writeConfig(config);

          logger.info({ toolName }, 'Tool added to disabled list');
          return {
            success: true,
            output: `Added "${toolName}" to disabled tools. Disabled list: [${disabled.join(', ')}]\nBackup: ${backupPath}`,
            data: { disabled, backupPath },
            artifacts: [
              { path: CONFIG_PATH, action: 'modified' },
              { path: backupPath, action: 'created' },
            ],
          };
        }

        // -------------------------------------------------------------------
        // REMOVE-DISABLED-TOOL
        // -------------------------------------------------------------------
        case 'remove-disabled-tool': {
          const toolName = params['toolName'] as string | undefined;
          if (!toolName?.trim()) {
            return { success: false, output: 'toolName is required for remove-disabled-tool.' };
          }

          const config = readConfig();
          const tools = (config['tools'] ?? {}) as Record<string, unknown>;
          const disabled = (tools['disabled'] ?? []) as string[];
          const idx = disabled.indexOf(toolName);

          if (idx === -1) {
            return {
              success: false,
              output: `Tool "${toolName}" is not in the disabled list. Current disabled: [${disabled.join(', ')}]`,
            };
          }

          const backupPath = createBackup();
          disabled.splice(idx, 1);
          tools['disabled'] = disabled;
          config['tools'] = tools;
          writeConfig(config);

          logger.info({ toolName }, 'Tool removed from disabled list');
          return {
            success: true,
            output: `Removed "${toolName}" from disabled tools. Disabled list: [${disabled.join(', ')}]\nBackup: ${backupPath}`,
            data: { disabled, backupPath },
            artifacts: [
              { path: CONFIG_PATH, action: 'modified' },
              { path: backupPath, action: 'created' },
            ],
          };
        }

        // -------------------------------------------------------------------
        // ADD-CRON-JOB
        // -------------------------------------------------------------------
        case 'add-cron-job': {
          let cronJob = params['cronJob'] as Record<string, unknown> | undefined;

          // Also accept value param as JSON
          if (!cronJob && params['value']) {
            try {
              cronJob = JSON.parse(params['value'] as string) as Record<string, unknown>;
            } catch {
              return { success: false, output: 'cronJob or value (as JSON) is required for add-cron-job.' };
            }
          }

          if (!cronJob || typeof cronJob !== 'object') {
            return { success: false, output: 'cronJob object is required for add-cron-job. Must include name, schedule, and action.' };
          }
          if (!cronJob['name'] || !cronJob['schedule'] || !cronJob['action']) {
            return { success: false, output: 'cronJob must include name, schedule, and action fields.' };
          }

          const config = readConfig();
          const cron = (config['cron'] ?? {}) as Record<string, unknown>;
          const jobs = (cron['jobs'] ?? []) as Record<string, unknown>[];

          // Check for duplicate name
          const existingIdx = jobs.findIndex(j => j['name'] === cronJob!['name']);
          if (existingIdx !== -1) {
            return {
              success: false,
              output: `Cron job named "${cronJob['name']}" already exists at index ${existingIdx}. Remove it first or use a different name.`,
            };
          }

          const backupPath = createBackup();
          jobs.push(cronJob);
          cron['jobs'] = jobs;
          config['cron'] = cron;
          writeConfig(config);

          logger.info({ cronJob: cronJob['name'] }, 'Cron job added');
          return {
            success: true,
            output: `Added cron job "${cronJob['name']}" (schedule: ${cronJob['schedule']}). Total jobs: ${jobs.length}\nBackup: ${backupPath}`,
            data: { job: cronJob, totalJobs: jobs.length, backupPath },
            artifacts: [
              { path: CONFIG_PATH, action: 'modified' },
              { path: backupPath, action: 'created' },
            ],
          };
        }

        // -------------------------------------------------------------------
        // REMOVE-CRON-JOB
        // -------------------------------------------------------------------
        case 'remove-cron-job': {
          const jobIdentifier = params['jobIdentifier'] as string | undefined;
          if (!jobIdentifier?.trim()) {
            return { success: false, output: 'jobIdentifier (name or index) is required for remove-cron-job.' };
          }

          const config = readConfig();
          const cron = (config['cron'] ?? {}) as Record<string, unknown>;
          const jobs = (cron['jobs'] ?? []) as Record<string, unknown>[];

          if (jobs.length === 0) {
            return { success: false, output: 'No cron jobs to remove.' };
          }

          // Try as numeric index first
          let removeIdx = -1;
          const numIdx = parseInt(jobIdentifier, 10);
          if (!isNaN(numIdx) && numIdx >= 0 && numIdx < jobs.length) {
            removeIdx = numIdx;
          } else {
            // Try as name
            removeIdx = jobs.findIndex(j => j['name'] === jobIdentifier);
          }

          if (removeIdx === -1) {
            const names = jobs.map((j, i) => `  ${i}: ${j['name'] ?? '(unnamed)'}`).join('\n');
            return {
              success: false,
              output: `Cron job "${jobIdentifier}" not found. Current jobs:\n${names}`,
            };
          }

          const backupPath = createBackup();
          const removed = jobs.splice(removeIdx, 1)[0]!;
          cron['jobs'] = jobs;
          config['cron'] = cron;
          writeConfig(config);

          logger.info({ removed: removed['name'] }, 'Cron job removed');
          return {
            success: true,
            output: `Removed cron job "${removed['name'] ?? `index ${removeIdx}`}". Remaining jobs: ${jobs.length}\nBackup: ${backupPath}`,
            data: { removed, remainingJobs: jobs.length, backupPath },
            artifacts: [
              { path: CONFIG_PATH, action: 'modified' },
              { path: backupPath, action: 'created' },
            ],
          };
        }

        // -------------------------------------------------------------------
        // BACKUP
        // -------------------------------------------------------------------
        case 'backup': {
          const backupPath = createBackup();
          return {
            success: true,
            output: `Config backed up to: ${backupPath}`,
            data: { backupPath },
            artifacts: [{ path: backupPath, action: 'created' }],
          };
        }

        default:
          return { success: false, output: `Unknown action: "${action}"` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ action, err: msg }, 'meta.self-config error');
      return { success: false, output: `Config error: ${msg}` };
    }
  },
};
