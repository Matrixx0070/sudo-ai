/**
 * @file claude-compat.ts
 * @description Claude/Cursor ecosystem compat layer (gap #13).
 *
 * Opt-in via SUDO_CLAUDE_COMPAT=1, this discovers and ingests artifacts
 * Claude Code and Cursor users already have on disk:
 *
 *   1. `.mcp.json` (project) and `.cursor/mcp.json` (Cursor) — MCP server
 *      configs in the Anthropic/Cursor `mcpServers` map shape, registered
 *      with the in-process MCP registry.
 *   2. `<home>/.claude/settings.json`, `<project>/.claude/settings.json`,
 *      `<project>/.claude/settings.local.json` — `hooks.<EventName>` entries
 *      translated to sudo hook events and registered via the same plugin-
 *      hooks bridge that user hooks use.
 *   3. `<home>/.claude/skills` and `<project>/.claude/skills` directory
 *      trees — appended to SUDO_SKILLS_DIRS so the existing markdown-loader
 *      picks them up.
 *   4. `<project>/.claude-plugin/marketplace.json` and `<home>/...` — plugin
 *      catalog *enumerated only* (no auto-install); returned to caller for
 *      future UI/CLI surfacing.
 *
 * Each ingest is independent: a malformed .mcp.json never blocks settings-
 * hook ingest. No file is required; absent inputs return zero counts.
 *
 * Security: MCP servers get trust tier `unreviewed` and are not auto-
 * connected (registry just tracks them; connection is a separate step).
 * Settings hooks register `command`/`http` handlers that run arbitrary user
 * code, so the master flag is opt-in (same trust model as SUDO_USER_HOOKS).
 */

import { readFileSync, existsSync, lstatSync } from 'fs';
import path from 'path';
import os from 'os';
import { createLogger } from '../shared/logger.js';
import {
  registerMcpServer,
  type McpTransport,
} from './mcp-registry.js';
import {
  registerPluginHooks,
  unregisterPluginHooks,
  hasPluginHooks,
} from './plugin-hooks.js';
import type { PluginManifest, PluginHookDecl } from './plugin-manifest.js';
import type { HookManager } from '../hooks/index.js';

const log = createLogger('claude-compat');

/** Synthetic plugin ID the bridge tracks Claude settings-hook registrations under. */
export const CLAUDE_COMPAT_HOOKS_ID = 'claude-compat-hooks';

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

export interface McpIngestResult {
  /** Servers found across all discovered files. */
  discovered: number;
  /** Servers successfully passed to registerMcpServer. */
  registered: number;
  /** Entries skipped (validation failure, duplicate name). */
  skipped: number;
  /** Human-readable problems encountered. */
  errors: string[];
}

export interface SettingsHooksIngestResult {
  /** Hook decls extracted from settings files. */
  discovered: number;
  /** Hook decls registered on the HookManager. */
  registered: number;
  /** Decls dropped (enabled:false or unsupported shape). */
  skipped: number;
  /** Human-readable problems encountered. */
  errors: string[];
}

export interface MarketplacePluginEntry {
  /** Plugin id/name from the catalog. */
  id: string;
  /** Display name if distinct from id. */
  name?: string;
  /** Catalog-declared source (e.g. "github:owner/repo"). */
  source?: string;
  /** Catalog-declared description. */
  description?: string;
  /** Path to the marketplace.json this entry came from. */
  catalogPath: string;
}

export interface ClaudeCompatResult {
  mcp: McpIngestResult;
  hooks: SettingsHooksIngestResult;
  /** Skill roots appended to process.env['SUDO_SKILLS_DIRS']. */
  skillRootsAdded: string[];
  /** Plugin entries enumerated from marketplace.json files (read-only). */
  marketplacePlugins: MarketplacePluginEntry[];
  /** Marketplace catalog parse problems (separate lane from mcp/hooks errors). */
  marketplaceErrors: string[];
}

// ---------------------------------------------------------------------------
// Settings-hook event-name translation
// ---------------------------------------------------------------------------

/**
 * Claude Code hook events → sudo HookEvent names. Every target string is a
 * real member of the HookEvent union in `core/hooks/index.ts`; an off-by-one
 * here (e.g. `before:compact` instead of the real `pre:compact`) registers
 * the handler on an event that never fires, silently making the hook dead.
 * Unknown event names pass through unchanged; the bridge fails open on
 * unknown events (warn + skip) so future Claude events don't crash boot.
 *
 * Approximate mappings (no exact sudo equivalent exists):
 *   - UserPromptSubmit → message:received  (inbound user message)
 *   - SubagentStop     → swarm:complete    (subagent finished)
 *   - Notification     → on:message        (fire-and-forget message lane)
 *   - Stop             → command:stop      (turn aborted)
 *
 * Caller-runner caveat: command/http hooks return void, so they never claim.
 * On events that emitters dispatch via emitClaiming (first non-null wins) a
 * separately-registered claiming handler can short-circuit before compat
 * hooks fire. This is by design — compat hooks are advisory.
 */
const HOOK_EVENT_MAP: Record<string, string> = {
  PreToolUse: 'before:tool-call',
  PostToolUse: 'after:tool-call',
  UserPromptSubmit: 'message:received',
  SessionStart: 'session:start',
  SessionEnd: 'session:end',
  Stop: 'command:stop',
  SubagentStop: 'swarm:complete',
  Notification: 'on:message',
  PreCompact: 'pre:compact',
};

export function mapClaudeHookEvent(claudeEventName: string): string {
  return HOOK_EVENT_MAP[claudeEventName] ?? claudeEventName;
}

// ---------------------------------------------------------------------------
// .mcp.json ingest
// ---------------------------------------------------------------------------

interface ParsedMcpEntry {
  id: string;
  url: string;
  transport: McpTransport;
  description?: string;
}

function readJson(file: string, errors: string[]): unknown | null {
  // Reject symlinks to match the markdown-loader skill-walk posture: config
  // files come from a user-writable location, and following a symlink lets
  // a project-local .mcp.json (etc.) exfiltrate any file the host process
  // can read. existsSync() above already returns true for symlinks.
  try {
    if (lstatSync(file).isSymbolicLink()) {
      errors.push(`${file}: symlinks are not followed`);
      return null;
    }
  } catch {
    // lstat itself failed (race / unreadable parent) — treat as absent
    return null;
  }
  let raw: string;
  try {
    raw = readFileSync(file, 'utf-8');
  } catch (err) {
    errors.push(`${file}: read failed (${(err as Error).message})`);
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    errors.push(`${file}: not valid JSON (${(err as Error).message})`);
    return null;
  }
}

/**
 * POSIX-style shell quoting for argv tokens packed into the stdio: synthetic
 * URL. A token without whitespace, quote, or shell-special characters is
 * emitted bare; otherwise it is wrapped in single quotes with embedded
 * single quotes escaped as the `'\''` four-byte sequence (standard sh idiom).
 * Required so `args: ['--root', '/path with spaces']` survives a split.
 */
export function quoteShellToken(token: string): string {
  if (token === '') return "''";
  if (/^[A-Za-z0-9_\-./=:]+$/.test(token)) return token;
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

/**
 * Encode a stdio MCP server's launch config into the registry's synthetic
 * `stdio:command [args]` URL form (the registry uses URL as the primary
 * identifier and pre-dates per-transport config). Shared by the Claude/Cursor
 * ingester and the plugin-manifest mcpServers wiring so both produce an
 * identical, splittable encoding.
 */
export function buildStdioMcpUrl(command: string, args?: readonly unknown[]): string {
  const argTokens = Array.isArray(args) ? args.map((a) => quoteShellToken(String(a))) : [];
  return argTokens.length > 0
    ? `stdio:${quoteShellToken(command)} ${argTokens.join(' ')}`
    : `stdio:${quoteShellToken(command)}`;
}

/**
 * Parse an mcpServers map (Claude/Cursor shape) into registry-ready entries.
 *
 * Stdio servers (the `command`+`args` shape) carry their launch config in
 * the URL field as `stdio:command [args]` since the registry contract pre-
 * dates per-transport config and uses URL as the primary identifier.
 */
export function parseMcpServersMap(
  servers: unknown,
  source: string,
  errors: string[],
): ParsedMcpEntry[] {
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) {
    errors.push(`${source}: mcpServers must be an object map`);
    return [];
  }
  const out: ParsedMcpEntry[] = [];
  for (const [id, raw] of Object.entries(servers as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      errors.push(`${source}: mcpServers.${id} must be an object`);
      continue;
    }
    const cfg = raw as Record<string, unknown>;

    const explicitType = typeof cfg['type'] === 'string' ? (cfg['type'] as string).toLowerCase() : '';
    const url = typeof cfg['url'] === 'string' ? (cfg['url'] as string) : '';
    const command = typeof cfg['command'] === 'string' ? (cfg['command'] as string) : '';

    if (explicitType === 'http' || explicitType === 'sse' || explicitType === 'websocket') {
      if (!url) {
        errors.push(`${source}: mcpServers.${id} declares type='${explicitType}' but no url`);
        continue;
      }
      out.push({
        id,
        url,
        transport: explicitType === 'websocket' ? 'websocket' : (explicitType as McpTransport),
        description: typeof cfg['description'] === 'string' ? (cfg['description'] as string) : undefined,
      });
      continue;
    }

    // Implicit HTTP when url is present and no command
    if (url && !command) {
      out.push({
        id,
        url,
        transport: 'http',
        description: typeof cfg['description'] === 'string' ? (cfg['description'] as string) : undefined,
      });
      continue;
    }

    // stdio (command + args). When both `url` and `command` are present,
    // Claude/Cursor's convention is command-wins; record the dropped url
    // so the operator can see the resolution.
    if (command) {
      if (url) {
        errors.push(
          `${source}: mcpServers.${id} declares both url and command — using command (stdio), url ignored`,
        );
      }
      const argsRaw = cfg['args'];
      const stdioUrl = buildStdioMcpUrl(command, Array.isArray(argsRaw) ? argsRaw : undefined);
      out.push({
        id,
        url: stdioUrl,
        transport: 'stdio',
        description: typeof cfg['description'] === 'string' ? (cfg['description'] as string) : undefined,
      });
      continue;
    }

    errors.push(`${source}: mcpServers.${id} has neither url nor command`);
  }
  return out;
}

function ingestMcpFile(file: string, seenIds: Set<string>): McpIngestResult {
  const result: McpIngestResult = { discovered: 0, registered: 0, skipped: 0, errors: [] };
  const parsed = readJson(file, result.errors);
  if (parsed === null) return result;

  let mcpServers: unknown;
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    mcpServers = (parsed as Record<string, unknown>)['mcpServers'];
  }
  if (mcpServers === undefined) {
    // Not an MCP config — treat as empty silently (e.g. Cursor settings file
    // that doesn't define mcpServers).
    return result;
  }

  const entries = parseMcpServersMap(mcpServers, file, result.errors);
  result.discovered = entries.length;
  for (const entry of entries) {
    if (seenIds.has(entry.id)) {
      result.skipped++;
      log.debug({ id: entry.id, file }, 'MCP server name already seen — skipping duplicate');
      continue;
    }
    try {
      registerMcpServer(entry.id, entry.url, entry.description, 'unreviewed', entry.transport);
      seenIds.add(entry.id);
      result.registered++;
    } catch (err) {
      result.errors.push(`${file}: register ${entry.id} failed (${(err as Error).message})`);
      result.skipped++;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// settings.json hooks ingest
// ---------------------------------------------------------------------------

function syntheticManifest(hooks: PluginHookDecl[]): PluginManifest {
  return {
    id: CLAUDE_COMPAT_HOOKS_ID,
    name: 'Claude/Cursor settings hooks',
    version: '1.0.0',
    description: 'Hooks ingested from Claude Code settings files',
    author: 'user',
    category: 'productivity',
    hooks,
    skills: [],
    mcpServers: [],
    lspServers: [],
    source: { type: 'local' },
  };
}

/**
 * Parse the `hooks` block of a Claude Code settings.json into PluginHookDecl
 * entries. Claude's shape per their docs:
 *
 * ```json
 * { "hooks": { "PreToolUse": [ { "matcher": "Bash",
 *     "hooks": [ { "type": "command", "command": "..." } ] } ] } }
 * ```
 *
 * The outer `matcher` (Claude's tool-name filter) is currently not enforced
 * inside the sudo HookManager — it is recorded on the decl as a marker but
 * does not gate execution. This is acceptable for the v1 compat layer:
 * users who set matchers get the hook to run on the mapped event; tighter
 * scoping is a future slice.
 */
export function parseClaudeSettingsHooks(
  parsed: unknown,
  source: string,
  errors: string[],
): { decls: PluginHookDecl[]; skipped: number } {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    errors.push(`${source}: settings file must be an object`);
    return { decls: [], skipped: 0 };
  }
  const hooksField = (parsed as Record<string, unknown>)['hooks'];
  if (hooksField === undefined) return { decls: [], skipped: 0 };
  if (typeof hooksField !== 'object' || hooksField === null || Array.isArray(hooksField)) {
    errors.push(`${source}: hooks must be an object`);
    return { decls: [], skipped: 0 };
  }

  const decls: PluginHookDecl[] = [];
  let skipped = 0;
  for (const [claudeEvent, groupsRaw] of Object.entries(hooksField as Record<string, unknown>)) {
    if (!Array.isArray(groupsRaw)) {
      errors.push(`${source}: hooks.${claudeEvent} must be an array`);
      continue;
    }
    const mappedEvent = mapClaudeHookEvent(claudeEvent);

    for (let gi = 0; gi < groupsRaw.length; gi++) {
      const group = groupsRaw[gi];
      if (typeof group !== 'object' || group === null) {
        errors.push(`${source}: hooks.${claudeEvent}[${gi}] must be an object`);
        continue;
      }
      const groupObj = group as Record<string, unknown>;
      const innerHooks = groupObj['hooks'];
      if (!Array.isArray(innerHooks)) {
        errors.push(`${source}: hooks.${claudeEvent}[${gi}].hooks must be an array`);
        continue;
      }
      for (let hi = 0; hi < innerHooks.length; hi++) {
        const h = innerHooks[hi];
        if (typeof h !== 'object' || h === null) {
          errors.push(`${source}: hooks.${claudeEvent}[${gi}].hooks[${hi}] must be an object`);
          continue;
        }
        const ho = h as Record<string, unknown>;
        const type = ho['type'];
        if (type !== 'command' && type !== 'http') {
          errors.push(`${source}: hooks.${claudeEvent}[${gi}].hooks[${hi}].type must be 'command' or 'http'`);
          continue;
        }
        if (type === 'command' && (typeof ho['command'] !== 'string' || ho['command'].trim() === '')) {
          errors.push(`${source}: hooks.${claudeEvent}[${gi}].hooks[${hi}].command required`);
          continue;
        }
        if (type === 'http') {
          const url = ho['url'];
          if (typeof url !== 'string') {
            errors.push(`${source}: hooks.${claudeEvent}[${gi}].hooks[${hi}].url required`);
            continue;
          }
          try {
            const parsedUrl = new URL(url);
            if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
              errors.push(`${source}: hooks.${claudeEvent}[${gi}].hooks[${hi}].url must be http(s)`);
              continue;
            }
          } catch {
            errors.push(`${source}: hooks.${claudeEvent}[${gi}].hooks[${hi}].url not a valid URL`);
            continue;
          }
        }
        if (ho['enabled'] === false) {
          skipped++;
          continue;
        }
        decls.push({
          event: mappedEvent,
          type,
          ...(typeof ho['command'] === 'string' ? { command: ho['command'] } : {}),
          ...(typeof ho['url'] === 'string' ? { url: ho['url'] } : {}),
          ...(typeof ho['timeout'] === 'number' && ho['timeout'] > 0 ? { timeout: ho['timeout'] } : {}),
        });
      }
    }
  }
  return { decls, skipped };
}

// ---------------------------------------------------------------------------
// marketplace.json enumerate
// ---------------------------------------------------------------------------

/**
 * Parse a `.claude-plugin/marketplace.json` catalog. The Anthropic format
 * is flexible — `plugins` is an array of objects with at minimum a name/id.
 * Unknown fields are preserved as `source`/`description` when present.
 */
export function parseMarketplaceCatalog(
  parsed: unknown,
  catalogPath: string,
  errors: string[],
): MarketplacePluginEntry[] {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    errors.push(`${catalogPath}: marketplace.json must be an object`);
    return [];
  }
  const pluginsRaw = (parsed as Record<string, unknown>)['plugins'];
  if (pluginsRaw === undefined) return [];
  if (!Array.isArray(pluginsRaw)) {
    errors.push(`${catalogPath}: marketplace.json plugins must be an array`);
    return [];
  }
  const out: MarketplacePluginEntry[] = [];
  for (let i = 0; i < pluginsRaw.length; i++) {
    const entry = pluginsRaw[i];
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      errors.push(`${catalogPath}: plugins[${i}] must be an object`);
      continue;
    }
    const e = entry as Record<string, unknown>;
    const idValue = e['id'] ?? e['name'];
    if (typeof idValue !== 'string' || idValue.trim() === '') {
      errors.push(`${catalogPath}: plugins[${i}] needs an id or name`);
      continue;
    }
    out.push({
      id: idValue,
      ...(typeof e['name'] === 'string' && e['name'] !== idValue ? { name: e['name'] } : {}),
      ...(typeof e['source'] === 'string' ? { source: e['source'] } : {}),
      ...(typeof e['description'] === 'string' ? { description: e['description'] } : {}),
      catalogPath,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface ClaudeCompatOptions {
  /** Project root (e.g. PROJECT_ROOT from cli.ts). */
  projectRoot: string;
  /** Override the user home for tests. Defaults to os.homedir(). */
  homeDir?: string;
}

/**
 * Discover and ingest every supported Claude/Cursor artifact below the
 * given roots. Idempotent: calling again replaces previously registered
 * settings hooks (so a file edit picked up via re-call doesn't accumulate).
 * MCP servers are tracked under a separate name set per call — re-calling
 * de-duplicates by id within the call, but does not unregister prior
 * registrations from the in-process registry (the registry is append-only
 * by design; the ID generator already creates per-call unique ids).
 */
export async function ingestClaudeCompat(
  hookManager: HookManager,
  opts: ClaudeCompatOptions,
): Promise<ClaudeCompatResult> {
  const home = opts.homeDir ?? os.homedir();
  const projectRoot = opts.projectRoot;

  const result: ClaudeCompatResult = {
    mcp: { discovered: 0, registered: 0, skipped: 0, errors: [] },
    hooks: { discovered: 0, registered: 0, skipped: 0, errors: [] },
    skillRootsAdded: [],
    marketplacePlugins: [],
    marketplaceErrors: [],
  };

  // 1. .mcp.json + Cursor + Claude home config
  const mcpCandidates = [
    path.join(projectRoot, '.mcp.json'),
    path.join(projectRoot, '.cursor', 'mcp.json'),
    path.join(home, '.claude', 'mcp.json'),
  ];
  const seenMcp = new Set<string>();
  for (const file of mcpCandidates) {
    if (!existsSync(file)) continue;
    const r = ingestMcpFile(file, seenMcp);
    result.mcp.discovered += r.discovered;
    result.mcp.registered += r.registered;
    result.mcp.skipped += r.skipped;
    result.mcp.errors.push(...r.errors);
  }

  // 2. settings.json hooks
  const settingsCandidates = [
    path.join(home, '.claude', 'settings.json'),
    path.join(projectRoot, '.claude', 'settings.json'),
    path.join(projectRoot, '.claude', 'settings.local.json'),
  ];
  // Re-call idempotence: drop any previous registration first
  if (hasPluginHooks(CLAUDE_COMPAT_HOOKS_ID)) {
    unregisterPluginHooks(syntheticManifest([]), hookManager);
  }
  const allDecls: PluginHookDecl[] = [];
  for (const file of settingsCandidates) {
    if (!existsSync(file)) continue;
    const parsed = readJson(file, result.hooks.errors);
    if (parsed === null) continue;
    const { decls, skipped } = parseClaudeSettingsHooks(parsed, file, result.hooks.errors);
    result.hooks.discovered += decls.length + skipped;
    result.hooks.skipped += skipped;
    allDecls.push(...decls);
  }
  if (allDecls.length > 0) {
    result.hooks.registered = registerPluginHooks(syntheticManifest(allDecls), hookManager);
  }

  // 3. Skill roots — append into SUDO_SKILLS_DIRS so the existing loader picks them up
  const skillRootCandidates = [
    path.join(home, '.claude', 'skills'),
    path.join(projectRoot, '.claude', 'skills'),
  ];
  const existing = (process.env['SUDO_SKILLS_DIRS'] ?? '')
    .split(':')
    .map((s) => s.trim())
    .filter(Boolean);
  const merged = [...existing];
  for (const root of skillRootCandidates) {
    if (!existsSync(root)) continue;
    if (merged.includes(root)) continue;
    merged.push(root);
    result.skillRootsAdded.push(root);
  }
  if (result.skillRootsAdded.length > 0) {
    process.env['SUDO_SKILLS_DIRS'] = merged.join(':');
  }

  // 4. Plugin marketplace catalog — read-only listing
  const marketplaceCandidates = [
    path.join(projectRoot, '.claude-plugin', 'marketplace.json'),
    path.join(home, '.claude-plugin', 'marketplace.json'),
  ];
  for (const file of marketplaceCandidates) {
    if (!existsSync(file)) continue;
    const parsed = readJson(file, result.marketplaceErrors);
    if (parsed === null) continue;
    const entries = parseMarketplaceCatalog(parsed, file, result.marketplaceErrors);
    result.marketplacePlugins.push(...entries);
  }

  log.info(
    {
      mcp: result.mcp,
      hooks: result.hooks,
      skillRootsAdded: result.skillRootsAdded.length,
      marketplacePlugins: result.marketplacePlugins.length,
      marketplaceErrors: result.marketplaceErrors.length,
    },
    'Claude/Cursor compat ingest complete',
  );
  return result;
}
