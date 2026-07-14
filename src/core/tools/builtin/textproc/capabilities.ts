/**
 * textproc capability registry (Spec 10, docs/textproc-toolchain-spec.md §5.1).
 *
 * Probes a static catalog of text-processing binaries against the live PATH,
 * caches the result to data/textproc-manifest.json (PATH-hash invalidated),
 * and resolves abstract ROLES ("csv-stats", "yaml", "find-replace") to the
 * best available provider: native binary → alternative binary → pure-Python
 * fallback → honest 'none'. Extra catalog entries merge from
 * config/textproc-plugins.json5 so future tools need zero code changes.
 *
 * The manifest is keyed by exec backend. This module probes the HOST; the
 * docker (untrusted-tier) manifest is probed lazily per image by the caller
 * supplying a runner — never report host capabilities for an untrusted turn.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import JSON5 from 'json5';
import { createLogger } from '../../../shared/logger.js';
import { dataPath, projectPath } from '../../../shared/paths.js';

const logger = createLogger('textproc-capabilities');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TextprocCategory =
  | 'classic' | 'modern' | 'structured' | 'workflow' | 'diff' | 'bonus';

export interface CatalogEntry {
  /** Canonical binary name (what the docs call it). */
  name: string;
  /** Debian/renamed alternatives probed when `name` is absent. */
  aliases?: string[];
  category: TextprocCategory;
  /** Abstract roles this tool can serve, best-first order set by ROLES. */
  roles: string[];
  /** True when the tool processes stdin→stdout without slurping input. */
  streaming: boolean;
  /** Python fallback script name under textproc/fallbacks/ (sans .py). */
  fallback?: string;
  safety?: {
    /** Never run in agent paths (interactive/TUI). */
    banned?: boolean;
    /** Flags that MUST be present for agent use (e.g. fzf --filter). */
    requiredFlags?: string[];
    /** Flags that force the full approval path (e.g. sed -i). */
    approvalFlags?: string[];
    note?: string;
  };
  /** One-line agent-facing usage hint. */
  hint?: string;
}

export interface DetectedTool {
  name: string;
  path: string | null;
  /** Which probe matched: the canonical name or one of its aliases. */
  via: string | null;
}

export interface TextprocManifest {
  backend: 'host' | 'docker';
  createdAt: string;
  pathHash: string;
  tools: Record<string, DetectedTool>;
}

export interface RoleResolution {
  role: string;
  provider: string | null;
  binary: string | null;
  via: 'native' | 'alias' | 'alt' | 'python' | 'none';
  hint?: string;
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

function e(
  name: string,
  category: TextprocCategory,
  roles: string[],
  streaming: boolean,
  extra?: Partial<CatalogEntry>,
): CatalogEntry {
  return { name, category, roles, streaming, ...extra };
}

/** Static catalog. Provisioned by scripts/provision-textproc.sh. */
export const CATALOG: CatalogEntry[] = [
  // -- classic Unix ---------------------------------------------------------
  e('sed', 'classic', ['stream-edit', 'extract-lines'], true, {
    safety: { approvalFlags: ['-i', '--in-place'], note: 'in-place writes go through approval' },
    hint: "line ranges: sed -n 'A,Bp;Bq' (the q makes it stream-exit early)",
  }),
  e('awk', 'classic', ['field-extract', 'stream-edit', 'stats'], true, {
    aliases: ['gawk', 'mawk'],
    safety: { approvalFlags: ['-i'], note: 'gawk -i inplace goes through approval' },
  }),
  e('grep', 'classic', ['search'], true),
  e('cut', 'classic', ['field-extract'], true),
  e('tr', 'classic', ['stream-edit'], true),
  e('sort', 'classic', ['sort'], true, { hint: 'sort -S for big files; LC_ALL=C for speed' }),
  e('uniq', 'classic', ['dedupe'], true),
  e('head', 'classic', ['extract-lines'], true),
  e('tail', 'classic', ['extract-lines'], true),
  e('paste', 'classic', ['join-columns'], true),
  e('join', 'classic', ['join-relational'], true),
  e('comm', 'classic', ['set-compare'], true),
  e('csplit', 'classic', ['split'], true),
  e('xargs', 'classic', ['parallel'], true, { hint: 'xargs -P N is the preferred parallelism' }),
  e('diff', 'classic', ['diff'], false),
  e('patch', 'classic', ['patch'], false),
  e('wc', 'classic', ['count'], true),
  e('file', 'classic', ['inspect'], false),
  e('strings', 'classic', ['binary-text'], true),
  e('iconv', 'classic', ['encoding'], true),
  e('perl', 'classic', ['find-replace', 'stream-edit'], true, {
    hint: "perl -pe 's/find/replace/g' — the portable sed-with-real-regex",
  }),
  e('python3', 'classic', ['script'], true),
  // -- moreutils ------------------------------------------------------------
  e('sponge', 'classic', ['in-place-pipe'], false, { fallback: 'sponge_fallback', hint: 'cmd file | ... | sponge file' }),
  e('ifne', 'classic', ['conditional-pipe'], true),
  e('ts', 'classic', ['timestamp'], true, { fallback: 'ts_fallback' }),
  e('combine', 'classic', ['set-compare'], false),
  e('pee', 'classic', ['tee-pipes'], true),
  e('vipe', 'classic', [], false, { safety: { banned: true, note: 'interactive editor — never in agent paths' } }),
  // -- modern replacements ---------------------------------------------------
  e('rg', 'modern', ['search'], true, { hint: 'default search tool; -c count, --max-count cap' }),
  e('bat', 'modern', ['pager'], false, { aliases: ['batcat'], safety: { requiredFlags: ['--plain'], note: 'use --plain (no pager) in agent paths' } }),
  e('fd', 'modern', ['find-files'], true, { aliases: ['fdfind'] }),
  e('sd', 'modern', ['find-replace'], true, { hint: 'sd is sed-s with sane regex; preferred for replace' }),
  e('choose', 'modern', ['field-extract'], true),
  e('ugrep', 'modern', ['search'], true),
  e('fzf', 'modern', ['fuzzy-filter'], true, { safety: { requiredFlags: ['--filter'], note: 'non-interactive --filter mode only' } }),
  e('teip', 'modern', ['partial-pipe'], true, { hint: 'teip -f N -- cmd: pipe only field N through cmd' }),
  // -- structured data -------------------------------------------------------
  e('jq', 'structured', ['json-query'], true),
  e('gron', 'structured', ['json-flatten'], true, { hint: 'gron | rg | gron -u to grep JSON' }),
  e('yq', 'structured', ['yaml'], true, { fallback: 'yq_fallback', hint: 'python-yq: jq syntax over YAML' }),
  e('dasel', 'structured', ['multi-format'], true),
  e('mlr', 'structured', ['csv', 'csv-stats'], true, { fallback: 'csv_fallback', hint: 'mlr --icsv --ojson for csv→json' }),
  e('qsv', 'structured', ['csv', 'csv-stats'], true, { fallback: 'csv_fallback' }),
  e('csvlook', 'structured', ['csv'], false, { fallback: 'csv_fallback' }),
  e('csvstat', 'structured', ['csv-stats'], false, { fallback: 'csv_fallback' }),
  e('in2csv', 'structured', ['csv-convert'], false),
  e('jo', 'structured', ['json-create'], false),
  e('fx', 'structured', ['json-view'], false),
  e('jless', 'structured', ['json-view'], false, { safety: { requiredFlags: [], note: 'TUI; agent paths should prefer jq' } }),
  e('xq', 'structured', ['xml'], true, { fallback: 'xml_fallback' }),
  e('hxselect', 'structured', ['html'], true, { fallback: 'html_fallback' }),
  e('htmlq', 'structured', ['html'], true, { fallback: 'html_fallback', hint: 'CSS selectors over HTML' }),
  e('datamash', 'structured', ['stats'], true, { fallback: 'datamash_fallback', hint: 'datamash groupby 1 mean 2' }),
  // -- workflow ---------------------------------------------------------------
  e('parallel', 'workflow', ['parallel'], true, {
    safety: { requiredFlags: ['-j'], note: 'always cap jobs with -j (default guidance -j4); prefer xargs -P' },
  }),
  e('entr', 'workflow', ['watch'], false, { safety: { note: 'wrap in timeout; agent paths rarely need it' } }),
  e('pyp', 'workflow', ['script'], true),
  // -- diff/versioning --------------------------------------------------------
  e('delta', 'diff', ['diff-pretty'], false),
  e('difft', 'diff', ['diff-pretty'], false, { aliases: ['difftastic'] }),
  e('colordiff', 'diff', ['diff-pretty'], false),
  e('sdiff', 'diff', ['diff'], false),
  // -- bonus -------------------------------------------------------------------
  e('rga', 'bonus', ['pdf-search'], true, { hint: 'ripgrep-all: rg over PDFs/docs/archives' }),
  e('vd', 'bonus', ['tui-data'], false, {
    aliases: ['visidata'],
    safety: { requiredFlags: ['--batch'], note: 'headless: vd --batch --output out.csv' },
  }),
];

/**
 * Role → provider preference order (best first). Only providers listed here
 * are considered for resolve(); catalog `roles` document capability, this
 * table documents PREFERENCE.
 */
export const ROLES: Record<string, string[]> = {
  'search': ['rg', 'ugrep', 'grep'],
  'find-files': ['fd'],
  'find-replace': ['sd', 'perl', 'sed'],
  'stream-edit': ['sed', 'awk', 'perl'],
  'extract-lines': ['sed', 'head', 'tail'],
  'field-extract': ['awk', 'cut', 'choose'],
  'json-query': ['jq'],
  'json-flatten': ['gron'],
  'yaml': ['yq'],
  'xml': ['xq', 'dasel'],
  'html': ['htmlq', 'hxselect'],
  'csv': ['mlr', 'qsv', 'csvlook'],
  'csv-stats': ['mlr', 'qsv', 'csvstat', 'datamash'],
  'csv-convert': ['in2csv', 'mlr'],
  'multi-format': ['dasel', 'yq'],
  'stats': ['datamash', 'mlr', 'awk'],
  'diff': ['diff', 'sdiff'],
  'diff-pretty': ['difft', 'delta', 'colordiff'],
  'sort': ['sort'],
  'dedupe': ['uniq', 'sort'],
  'parallel': ['xargs', 'parallel'],
  'timestamp': ['ts'],
  'in-place-pipe': ['sponge'],
  'pdf-search': ['rga'],
  'fuzzy-filter': ['fzf'],
  'json-create': ['jo', 'jq'],
  'json-view': ['jq', 'fx'],
  'pager': ['bat'],
  'watch': ['entr'],
};

// ---------------------------------------------------------------------------
// Plugin merge (config/textproc-plugins.json5)
// ---------------------------------------------------------------------------

const PLUGIN_PATH = projectPath('config', 'textproc-plugins.json5');

/** Exported with a path override for tests; production callers use the default. */
export function loadPluginEntries(pluginPath: string = PLUGIN_PATH): CatalogEntry[] {
  if (!existsSync(pluginPath)) return [];
  try {
    const raw = JSON5.parse(readFileSync(pluginPath, 'utf-8')) as unknown;
    const list = Array.isArray(raw) ? raw : (raw as { tools?: unknown[] })?.tools;
    if (!Array.isArray(list)) {
      logger.warn({ path: pluginPath }, 'textproc plugin config: expected array or {tools:[]} — ignored');
      return [];
    }
    const valid: CatalogEntry[] = [];
    for (const item of list) {
      const t = item as Partial<CatalogEntry>;
      if (typeof t.name === 'string' && t.name.length > 0 && Array.isArray(t.roles)) {
        valid.push({
          name: t.name,
          aliases: Array.isArray(t.aliases) ? t.aliases : undefined,
          category: (t.category as TextprocCategory) ?? 'bonus',
          roles: t.roles.filter((r): r is string => typeof r === 'string'),
          streaming: t.streaming === true,
          fallback: typeof t.fallback === 'string' ? t.fallback : undefined,
          safety: t.safety,
          hint: typeof t.hint === 'string' ? t.hint : undefined,
        });
      } else {
        logger.warn({ item }, 'textproc plugin entry missing name/roles — ignored');
      }
    }
    return valid;
  } catch (err) {
    logger.warn({ path: pluginPath, err }, 'textproc plugin config unreadable — ignored');
    return [];
  }
}

/** Full catalog = built-in entries + validated plugin entries (name-deduped, built-ins win). */
export function fullCatalog(): CatalogEntry[] {
  const seen = new Set(CATALOG.map((c) => c.name));
  const plugins = loadPluginEntries().filter((p) => !seen.has(p.name));
  return [...CATALOG, ...plugins];
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

const MANIFEST_PATH = dataPath('textproc-manifest.json');
const FALLBACKS_DIR = join(dirname(new URL(import.meta.url).pathname), 'fallbacks');
const MANIFEST_TTL_MS = 24 * 60 * 60 * 1000;

function pathHash(): string {
  return createHash('sha256').update(process.env['PATH'] ?? '').digest('hex').slice(0, 16);
}

/**
 * Build the single-process probe script for a catalog: prints
 * `<probe-name>\t<path-or-empty>` per line for every name and alias.
 * Exported so the docker backend can run the SAME probe inside its image.
 */
export function buildProbeScript(catalog: CatalogEntry[]): { script: string; probes: string[] } {
  const probes: string[] = [];
  for (const entry of catalog) {
    probes.push(entry.name, ...(entry.aliases ?? []));
  }
  const unique = [...new Set(probes)];
  const script = unique
    .map((n) => `printf '%s\\t%s\\n' ${JSON.stringify(n)} "$(command -v -- ${JSON.stringify(n)} || true)"`)
    .join('\n');
  return { script, probes: unique };
}

/** Parse probe output (`name\tpath` lines) into a name→path map. */
export function parseProbeOutput(output: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const line of output.split('\n')) {
    const idx = line.indexOf('\t');
    if (idx <= 0) continue;
    const name = line.slice(0, idx);
    const path = line.slice(idx + 1).trim();
    if (path) found.set(name, path);
  }
  return found;
}

function probeHost(catalog: CatalogEntry[]): Promise<Map<string, string>> {
  const { script } = buildProbeScript(catalog);
  return new Promise((resolvePromise) => {
    execFile('/bin/bash', ['-c', script], { timeout: 15_000 }, (err, stdout) => {
      if (err && !stdout) {
        logger.warn({ err }, 'textproc probe failed — reporting nothing available');
        resolvePromise(new Map());
        return;
      }
      resolvePromise(parseProbeOutput(stdout));
    });
  });
}

function toManifest(catalog: CatalogEntry[], found: Map<string, string>): TextprocManifest {
  const tools: Record<string, DetectedTool> = {};
  for (const entry of catalog) {
    const candidates = [entry.name, ...(entry.aliases ?? [])];
    const hit = candidates.find((c) => found.has(c));
    tools[entry.name] = hit
      ? { name: entry.name, path: found.get(hit) ?? null, via: hit }
      : { name: entry.name, path: null, via: null };
  }
  return { backend: 'host', createdAt: new Date().toISOString(), pathHash: pathHash(), tools };
}

let cached: TextprocManifest | null = null;

/**
 * Host manifest, cached in-memory and on disk (data/textproc-manifest.json).
 * Invalidates on PATH change, TTL expiry, or `refresh: true`.
 */
export async function getManifest(opts?: { refresh?: boolean }): Promise<TextprocManifest> {
  const hash = pathHash();
  if (!opts?.refresh) {
    if (cached && cached.pathHash === hash) return cached;
    try {
      if (existsSync(MANIFEST_PATH)) {
        const disk = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8')) as TextprocManifest;
        const fresh = Date.now() - new Date(disk.createdAt).getTime() < MANIFEST_TTL_MS;
        if (disk.pathHash === hash && fresh && disk.tools) {
          cached = disk;
          return disk;
        }
      }
    } catch (err) {
      logger.warn({ err }, 'textproc manifest cache unreadable — re-probing');
    }
  }
  const catalog = fullCatalog();
  const found = await probeHost(catalog);
  const manifest = toManifest(catalog, found);
  cached = manifest;
  try {
    mkdirSync(dirname(MANIFEST_PATH), { recursive: true });
    writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  } catch (err) {
    logger.warn({ err }, 'textproc manifest cache write failed (non-fatal)');
  }
  return manifest;
}

/** Test seam: drop the in-memory cache. */
export function clearManifestCache(): void {
  cached = null;
}

// ---------------------------------------------------------------------------
// Role resolution: native → alias → alt → python → none
// ---------------------------------------------------------------------------

function fallbackAvailable(entry: CatalogEntry, manifest: TextprocManifest): boolean {
  if (!entry.fallback) return false;
  const py = manifest.tools['python3'];
  return Boolean(py?.path) && existsSync(join(FALLBACKS_DIR, `${entry.fallback}.py`));
}

/** Resolve a role to the best available provider per the D2 order. */
export function resolveRole(role: string, manifest: TextprocManifest): RoleResolution {
  const prefs = ROLES[role];
  const catalog = fullCatalog();
  const byName = new Map(catalog.map((c) => [c.name, c]));
  const providers = prefs ?? catalog.filter((c) => c.roles.includes(role)).map((c) => c.name);
  for (let i = 0; i < providers.length; i++) {
    const name = providers[i]!;
    const detected = manifest.tools[name];
    const entry = byName.get(name);
    if (entry?.safety?.banned) continue;
    if (detected?.path) {
      const via: RoleResolution['via'] =
        detected.via === name ? (i === 0 ? 'native' : 'alt') : 'alias';
      return { role, provider: name, binary: detected.path, via, hint: entry?.hint };
    }
  }
  // No binary anywhere — python fallback from ANY provider of this role.
  for (const name of providers) {
    const entry = byName.get(name);
    if (entry && fallbackAvailable(entry, manifest)) {
      return { role, provider: `python:${entry.fallback}`, binary: null, via: 'python', hint: entry.hint };
    }
  }
  return { role, provider: null, binary: null, via: 'none' };
}

/** Resolve every known role at once (for textproc.capabilities). */
export function resolveAllRoles(manifest: TextprocManifest): RoleResolution[] {
  return Object.keys(ROLES).map((role) => resolveRole(role, manifest));
}

/**
 * ≤200-char one-line capability summary for the model's tool manifest —
 * generated from the cached manifest, NEVER probes at prompt-build time.
 */
export function summaryLine(manifest: TextprocManifest): string {
  const key: Array<[string, string]> = [
    ['search', 'search'], ['json-query', 'json'], ['yaml', 'yaml'], ['csv', 'csv'],
    ['xml', 'xml'], ['html', 'html'], ['find-replace', 'replace'], ['stats', 'stats'],
    ['diff-pretty', 'diff'],
  ];
  const parts: string[] = [];
  for (const [role, label] of key) {
    const r = resolveRole(role, manifest);
    if (r.via === 'none') parts.push(`${label}:none`);
    else if (r.via === 'python') parts.push(`${label}:py`);
    else parts.push(`${label}:${r.provider}`);
  }
  return `textproc ${parts.join(' ')}`.slice(0, 200);
}
