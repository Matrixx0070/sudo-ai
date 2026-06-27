/**
 * ToolRouter — keyword-based smart tool selector for SUDO-AI v4.
 *
 * Analyses the user's latest message with pure keyword/regex matching
 * (zero LLM calls) and returns an OpenAI-compatible tool schema array
 * capped at MAX_ROUTED_TOOLS entries.
 *
 * Routing priority:
 *   1. BASE_TOOLS (always present, BASE_TOOL_SLOTS slots)
 *   2. CONTINUITY tools from recent usage (up to 3 slots)
 *   3. Category-ranked tools (remaining slots, highest score first)
 *   4. FALLBACK sampling when no category matched
 * Phase 3 strict: comment sync (naming fix, no code/behavior change; avoids category logic per breakage history)
 */

import { createLogger } from '../shared/logger.js';
import type { ToolRegistryLike } from './loop-helpers.js';
import type { ToolSchema } from '../tools/types.js';

const log = createLogger('agent:tool-router');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hard cap on tools returned per LLM call. */
export const MAX_ROUTED_TOOLS = 30;

/** Slots reserved for always-on base tools. */
export const BASE_TOOL_SLOTS = 10;

/** Slots reserved for recently-used tools (continuity). */
export const CONTINUITY_SLOTS = 3;

/**
 * Generic words filtered out of within-category relevance ranking — structural
 * filler plus visual/output vocabulary shared by most media tools ("image",
 * "png", "render"…). Removing them leaves the DISTINCTIVE words (equation, code,
 * chart, qr, diagram…) so a tool the user actually describes outranks siblings
 * that merely also produce an image. Domain/action words (code, data, chart,
 * generate, edit, video…) are deliberately NOT here.
 */
const ROUTER_GENERIC_WORDS = new Set<string>([
  'the', 'and', 'for', 'with', 'this', 'that', 'into', 'from', 'your', 'you', 'our', 'make', 'making',
  'nice', 'clean', 'shareable', 'please', 'want', 'need', 'show', 'give', 'create', 'creates',
  'image', 'images', 'picture', 'pictures', 'photo', 'visual', 'graphic', 'graphics', 'png', 'jpg',
  'jpeg', 'svg', 'webp', 'file', 'files', 'output', 'inline', 'chat', 'render', 'rendered',
  'renders', 'rendering', 'style', 'styled', 'theme', 'deliver', 'delivered', 'attach', 'attached',
  'use', 'used', 'using', 'supply', 'optional', 'default', 'about', 'them', 'their',
]);

/**
 * Tools that are ALWAYS included regardless of message content.
 * These cover the most common operations the owner requests.
 * Ordered by priority (first = highest).
 */
const BASE_TOOLS: readonly string[] = [
  'meta.self-modify',      // The owner's primary way to update SUDO-AI
  'system.exec',           // Run any shell command
  'browser.search',        // Search the web
  'meta.health-check',     // Check system status
  'coder.read-file',       // Read any file
  'coder.smart-edit',      // Edit code + typecheck
  'meta.service-control',  // Restart/manage service
  'meta.task-manager',     // Manage tasks
  'coder.multi-read',      // Read multiple files
  'meta.self-update',      // Git pull + build
] as const;

// ---------------------------------------------------------------------------
// Category map
// ---------------------------------------------------------------------------

interface CategoryRule {
  /** Lowercase plain keywords to check (each hit +1). */
  keywords: string[];
  /** Regex patterns to test (each match +2). */
  patterns: RegExp[];
  /** Weighting multiplier applied to raw score (1–10). */
  priority: number;
  /** Maximum tools to pull from this category per routing pass. */
  maxFromCategory: number;
}

type CategoryName =
  | 'browser' | 'coder' | 'system' | 'content' | 'media' | 'document'
  | 'research' | 'comms' | 'social' | 'marketing' | 'data'
  | 'meta' | 'dev' | 'github' | 'knowledge' | 'voice' | 'business'
  | 'finance' | 'personal' | 'pm' | 'earning' | 'learn' | 'legal';

/**
 * Full category → routing rule map.
 * Keyword arrays and patterns are taken directly from the architect spec.
 */
const CATEGORY_MAP: Record<CategoryName, CategoryRule> = {
  browser: {
    keywords: [
      'navigate', 'browse', 'chrome', 'chromium', 'webpage', 'website',
      'click', 'scrape', 'screenshot', 'tab', 'login', 'form', 'download',
      'fetch', 'url', 'http', 'page', 'captcha', 'cookie', 'auth', 'popup',
      'open site',
      // The owner's natural language search phrases
      'search', 'search for', 'search online', 'search web', 'google',
      'look up', 'find online', 'find info', 'what is', 'how much',
      'latest', 'current price', 'pricing', 'check online', 'look online',
      'any news', 'news about', 'trending',
    ],
    patterns: [
      /https?:\/\//i,
      /www\./i,
      /\.(com|org|net|io)\b/i,
      /open\s+(the\s+)?site/i,
      /search\s+(for|about|online)/i,
      /\b(google|bing|search)\b/i,
    ],
    priority: 9,
    maxFromCategory: 8,
  },
  coder: {
    keywords: [
      'code', 'file', 'edit', 'write file', 'read file', 'debug', 'test',
      'git', 'commit', 'push', 'pull', 'branch', 'merge', 'npm',
      'scaffold', 'grep', 'glob', 'review', 'refactor', 'lint',
      // The owner's natural language coder phrases
      'show me the code', 'read the file', 'open the file', 'check the file',
      'typecheck', 'type error', 'typescript error', 'build error',
      'find the function', 'find the class', 'where is', 'which file',
      'look at the code', 'project structure', 'codebase',
    ],
    patterns: [
      /\.(ts|js|py|json|yaml|md|html|css|json5)\b/i,
      /src\//i,
      /show.*\b(code|file|function|class)\b/i,
    ],
    priority: 8,
    maxFromCategory: 8,
  },
  system: {
    keywords: [
      'terminal', 'command', 'exec', 'process', 'docker', 'pm2', 'nginx',
      'ssh', 'cron', 'backup', 'disk', 'monitor', 'service', 'server',
      'deploy', 'network', 'api call', 'credentials',
    ],
    patterns: [
      /sudo\s/i,
      /systemctl/i,
      /apt\s/i,
    ],
    priority: 8,
    maxFromCategory: 6,
  },
  content: {
    keywords: [
      'write article', 'blog', 'copy', 'script', 'proofread', 'rewrite',
      'summarize', 'seo', 'content', 'email sequence', 'presentation',
      'social post', 'docx', 'word doc', 'word document',
    ],
    patterns: [/write\s+(a|an|the)\s+/i],
    priority: 7,
    maxFromCategory: 5,
  },
  // Generate / parse documents (PDF + DOCX). Without this the document.* tools
  // (category 'document') were never routed, so the agent couldn't make a PDF.
  document: {
    keywords: [
      'pdf', 'document', 'docx', 'word document', 'report', 'render pdf',
      'generate pdf', 'create pdf', 'export pdf', 'make a pdf', 'to pdf',
      'extract text', 'extract tables', 'from html',
      'presentation', 'slide deck', 'slides', 'powerpoint', 'keynote',
      'webpage', 'web page', 'landing page', 'website', 'html page', 'interactive', 'web app', 'widget',
      'merge pdf', 'combine pdf', 'split pdf', 'extract pages', 'concatenate pdf', 'pdf pages',
    ],
    patterns: [
      /\b(pdf|docx?)\b/i,
      /\b(generate|create|make|export|render)\s+(a\s+)?(pdf|document|report)\b/i,
      /\bword\s+document\b/i,
      /\b(presentation|slide\s*deck|slides|powerpoint)\b/i,
      /\b(web\s*page|webpage|landing\s*page|web\s*app|html\s*page)\b/i,
      /\b(merge|combine|concatenate|split)\s+(the\s+)?pdf/i,
      /\bextract\s+pages?\b/i,
    ],
    priority: 7,
    maxFromCategory: 4,
  },
  media: {
    keywords: [
      'image', 'video', 'thumbnail', 'generate image', 'edit image',
      'shorts', 'clips', 'render', 'animation',
      'qr', 'qr code', 'qrcode', 'barcode',
      'diagram', 'org chart', 'mind map', 'hierarchy', 'flowchart', 'tree diagram',
      'code image', 'code screenshot', 'code snippet', 'snippet image', 'carbon', 'syntax highlight',
      'equation', 'formula', 'latex', 'math',
      'animation', 'animated', 'gif', 'looping',
      'mermaid', 'sequence diagram', 'gantt', 'gantt chart', 'er diagram', 'entity relationship', 'class diagram', 'state diagram', 'user journey',
    ],
    patterns: [/\.(png|jpg|jpeg|gif|mp4|webm|svg)\b/i, /\bqr\s*code\b/i, /\b(org\s*chart|mind\s*map|tree\s*diagram|flow\s*chart)\b/i, /\bcode\s*(image|screenshot|snippet)\b/i, /\bsyntax\s*highlight/i, /\b(equation|formula|latex)\b/i, /\b(animated|animation|gif)\b/i, /\b(mermaid|sequence\s*diagram|gantt|er\s*diagram|class\s*diagram|state\s*diagram)\b/i],
    priority: 7,
    maxFromCategory: 4,
  },
  research: {
    keywords: [
      'research', 'search', 'find info', 'paper', 'literature', 'study',
      'market research', 'deep search', 'academic',
    ],
    patterns: [],
    priority: 6,
    maxFromCategory: 4,
  },
  comms: {
    keywords: [
      'email', 'send message', 'slack', 'sms', 'notify', 'notification',
      'webhook', 'meeting', 'transcribe',
    ],
    patterns: [],
    priority: 6,
    maxFromCategory: 4,
  },
  social: {
    keywords: [
      'youtube', 'twitter', 'tweet', 'post', 'upload video', 'analytics',
      'schedule post', 'social media', 'instagram', 'tiktok',
    ],
    patterns: [],
    priority: 6,
    maxFromCategory: 4,
  },
  marketing: {
    keywords: [
      'seo', 'keyword research', 'ad', 'campaign', 'competitor',
      'marketing', 'advertising', 'content calendar',
    ],
    patterns: [],
    priority: 5,
    maxFromCategory: 3,
  },
  data: {
    keywords: [
      'data', 'csv', 'sql', 'database', 'query', 'chart',
      'spreadsheet', 'excel', 'workbook', 'visualize', 'graph data',
    ],
    patterns: [/\.(csv|xlsx|sql)\b/i, /\b(excel|spreadsheet|workbook|pivot\s*table)\b/i],
    priority: 5,
    maxFromCategory: 3,
  },
  meta: {
    keywords: [
      'schedule', 'task', 'skill', 'workflow', 'optimize', 'cost',
      'trend', 'predict', 'avatar', 'creative', 'swarm',
      'health', 'diagnostic', 'self-check', 'status', 'config',
      'consciousness', 'cognitive', 'stream', 'restart', 'service',
      'cron', 'cronjob', 'autonomy', 'autonomous', 'self-manage',
      'tool creator', 'create tool', 'new tool', 'disable', 'enable',
      'module', 'control', 'upgrade', 'self',
      // The owner's natural language phrases
      'change the code', 'update the code', 'change your', 'update your',
      'change yourself', 'update yourself', 'fix the bug', 'fix this',
      'modify', 'edit the config', 'change config', 'change setting',
      'change the model', 'switch model', 'change prompt', 'system prompt',
      'make sure', 'verify', 'check if', 'is it working', 'working correctly',
      'how many tools', 'count tools', 'list tools',
      'show me the code', 'show me the file', 'read the code',
      'rebuild', 'build again', 'compile', 'recompile',
      'sudo ai', 'sudo-ai', 'yourself',
    ],
    patterns: [
      /meta\./i,
      /self[- ]?(config|manage|test|heal|diagnos|modif|updat)/i,
      /consciousness/i,
      /stop.*(stream|module)/i,
      /start.*(stream|module)/i,
      /change.*\b(code|file|config|setting|model|prompt|behavior)\b/i,
      /update.*\b(code|file|config|setting|yourself|itself)\b/i,
      /\bsudo[\s-]?ai\b/i,
    ],
    priority: 9,
    maxFromCategory: 10,
  },
  dev: {
    keywords: [
      'api design', 'ci', 'cd', 'pipeline', 'dependency', 'audit',
      'database design', 'architecture',
    ],
    patterns: [],
    priority: 5,
    maxFromCategory: 3,
  },
  github: {
    keywords: [
      'github', 'pull request', 'open pr', 'merge pr', 'pr comment',
      'review pr', 'close pr', 'draft pr', 'list prs', 'pr diff',
      'pr status', 'rebase', 'issue', 'gh pr', 'gh issue', 'merge',
      'fix ci', 'ci logs', 'ci failing', 'failing checks',
      'autopilot', 'ship it', 'ship the', 'ship this', 'open a pr',
    ],
    patterns: [
      /\bpull request\b/i, /\bpr\b/i, /\bgithub\b/i, /\bissues?\b/i,
      /\bmerge\b/i, /\brebase\b/i, /\bci\b/i,
    ],
    priority: 9,
    maxFromCategory: 25, // cover the whole github.* connector when github-relevant
  },
  knowledge: {
    keywords: ['knowledge', 'notes', 'remember', 'recall', 'zettelkasten', 'wiki'],
    patterns: [],
    priority: 5,
    maxFromCategory: 3,
  },
  voice: {
    keywords: ['voice', 'speak', 'speech', 'tts', 'stt', 'transcribe', 'audio', 'phone call'],
    patterns: [],
    priority: 5,
    maxFromCategory: 3,
  },
  business: {
    keywords: [
      'invoice', 'crm', 'calendar', 'business analytics',
      'reports', 'client', 'customer',
    ],
    patterns: [],
    priority: 4,
    maxFromCategory: 3,
  },
  finance: {
    keywords: [
      'finance', 'tax', 'payment', 'bookkeeping',
      'accounting', 'revenue', 'expense',
    ],
    patterns: [],
    priority: 4,
    maxFromCategory: 3,
  },
  personal: {
    keywords: ['reminder', 'personal calendar', 'inbox', 'personal', 'todo'],
    patterns: [],
    priority: 4,
    maxFromCategory: 3,
  },
  pm: {
    keywords: [
      'project plan', 'timeline', 'milestone', 'time track',
      'sprint', 'kanban',
    ],
    patterns: [],
    priority: 4,
    maxFromCategory: 3,
  },
  earning: {
    keywords: ['earn', 'monetize', 'income', 'optimize revenue'],
    patterns: [],
    priority: 3,
    maxFromCategory: 2,
  },
  learn: {
    keywords: ['learn', 'teach', 'explain concept', 'study', 'exam', 'homework', 'tutor'],
    patterns: [],
    priority: 3,
    maxFromCategory: 3,
  },
  legal: {
    keywords: ['legal', 'terms', 'privacy policy', 'contract', 'compliance'],
    patterns: [],
    priority: 2,
    maxFromCategory: 1,
  },
};

/** Fallback categories sampled when no keyword matched (2 tools each). */
const FALLBACK_CATEGORIES: CategoryName[] = [
  'browser', 'coder', 'system', 'content', 'research', 'meta',
];

// ---------------------------------------------------------------------------
// Slim tool descriptor (mirrors ToolDefinition shape from the registry)
// ---------------------------------------------------------------------------

interface SlimTool {
  name: string;
  description: string;
  category: string;
  parameters: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// ToolRouter
// ---------------------------------------------------------------------------

/**
 * Keyword-driven tool selector.
 *
 * The router analyses the user's message, scores each category, and
 * returns the most relevant OpenAI-compatible tool schemas up to
 * MAX_ROUTED_TOOLS.  No LLM calls are made.
 */
export class ToolRouter {
  private readonly registry: ToolRegistryLike;

  constructor(registry: ToolRegistryLike) {
    if (!registry || typeof registry.getSchemaForLLM !== 'function') {
      throw new TypeError('ToolRouter: registry must implement ToolRegistryLike');
    }
    this.registry = registry;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Route the user message to a filtered set of tool schemas.
   *
   * @param message          - Latest user message text.
   * @param recentToolNames  - Names of the last few tools used (continuity).
   * @returns Array of OpenAI-compatible tool schemas, at most MAX_ROUTED_TOOLS.
   */
  route(message: string, recentToolNames: string[] = []): ToolSchema[] {
    if (typeof message !== 'string') {
      log.warn({ messageType: typeof message }, 'ToolRouter.route: message must be a string — using empty string');
      message = '';
    }

    const allSchemas = this._getAllSchemas();
    const schemasByName = this._indexByName(allSchemas);

    // Step 1: normalise
    const normalised = message.toLowerCase();

    // Step 2 & 3: score and rank categories
    const rankedCategories = this._rankCategories(normalised);

    const selectedNames = new Set<string>();
    const result: ToolSchema[] = [];

    // Step 4: always add base tools
    for (const baseName of BASE_TOOLS) {
      if (selectedNames.has(baseName)) continue;
      const schema = schemasByName.get(baseName);
      if (schema) {
        result.push(schema);
        selectedNames.add(baseName);
      } else {
        log.debug({ tool: baseName }, 'Base tool not found in registry — skipping');
      }
    }

    // Step 5: continuity — add recently used tools
    let continuitySlotsUsed = 0;
    for (const recentName of recentToolNames) {
      if (continuitySlotsUsed >= CONTINUITY_SLOTS) break;
      if (selectedNames.has(recentName)) continue;
      const schema = schemasByName.get(recentName);
      if (schema) {
        result.push(schema);
        selectedNames.add(recentName);
        continuitySlotsUsed++;
      }
    }

    // Step 6 or 7: fill from ranked categories, or fallback
    const anyMatched = rankedCategories.some(([, score]) => score > 0);

    if (anyMatched) {
      this._fillFromCategories(
        rankedCategories,
        normalised,
        schemasByName,
        selectedNames,
        result,
      );
    } else {
      // Step 7: fallback — 2 tools from each of the diverse fallback categories
      log.info({ message: normalised.slice(0, 60) }, 'No category matched — using diverse fallback');
      this._fillFallback(normalised, schemasByName, selectedNames, result);
    }

    log.info(
      {
        totalSelected: result.length,
        matchedCategories: anyMatched
          ? rankedCategories.filter(([, s]) => s > 0).map(([c]) => c).join(', ')
          : 'none (fallback)',
      },
      'Tool routing complete',
    );

    log.debug(
      { tools: [...selectedNames].join(', ') },
      'Selected tool names',
    );

    return result;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _getAllSchemas(): ToolSchema[] {
    return this.registry.getSchemaForLLM();
  }

  /** Build a name → schema map for O(1) lookups. */
  private _indexByName(schemas: ToolSchema[]): Map<string, ToolSchema> {
    const map = new Map<string, ToolSchema>();
    for (const s of schemas) {
      const name = this._schemaName(s);
      if (name) map.set(name, s);
    }
    return map;
  }

  /** Extract the tool name from an OpenAI-format schema object. */
  private _schemaName(schema: ToolSchema): string {
    return schema.function?.name ?? '';
  }

  /**
   * Within-category relevance: how many DISTINCTIVE words of a tool (its name plus
   * its description) the message mentions, after filtering generic visual/filler
   * words ({@link ROUTER_GENERIC_WORDS}). This lets a tool the user actually
   * describes outrank a sibling that merely also makes an image — e.g. "render this
   * equation" picks media.equation (matches "equation") over media.code-image
   * (whose only hit would be the now-filtered "image"), while "code screenshot"
   * still picks media.code-image (matches "code"/"screenshot"). Each distinct word
   * counts once across name+description; description influence is capped so a long
   * description can't dominate.
   */
  private _relevanceScore(schema: ToolSchema, normalised: string): number {
    const name = this._schemaName(schema);
    const nameWords = name.split(/[.\-_]/).filter((w) => w.length >= 3 && !ROUTER_GENERIC_WORDS.has(w));
    const counted = new Set<string>();
    let score = 0;
    for (const w of nameWords) {
      if (!counted.has(w) && normalised.includes(w)) { counted.add(w); score += 1; }
    }
    const desc = (schema.function?.description ?? '').toLowerCase();
    let descHits = 0;
    for (const w of desc.split(/[^a-z0-9]+/)) {
      if (w.length < 4 || ROUTER_GENERIC_WORDS.has(w) || counted.has(w)) continue;
      if (normalised.includes(w)) { counted.add(w); descHits += 1; }
    }
    return score + Math.min(descHits, 3);
  }

  /**
   * Score every category against the normalised message and return
   * them sorted by (rawScore * priority) descending.
   */
  private _rankCategories(normalised: string): Array<[CategoryName, number]> {
    const scored: Array<[CategoryName, number]> = [];

    for (const [catName, rule] of Object.entries(CATEGORY_MAP) as Array<[CategoryName, CategoryRule]>) {
      let raw = 0;

      for (const kw of rule.keywords) {
        if (normalised.includes(kw)) raw += 1;
      }

      for (const re of rule.patterns) {
        // Test against original message (patterns may be case-insensitive themselves).
        if (re.test(normalised)) raw += 2;
      }

      scored.push([catName, raw * rule.priority]);
    }

    return scored.sort((a, b) => b[1] - a[1]);
  }

  /**
   * Pull tools from matched categories into the result array.
   * Within each category, prefer tools whose action segment appears in the message.
   */
  private _fillFromCategories(
    rankedCategories: Array<[CategoryName, number]>,
    normalised: string,
    schemasByName: Map<string, ToolSchema>,
    selectedNames: Set<string>,
    result: ToolSchema[],
  ): void {
    const toolsByCategory = this._groupByCategory(schemasByName);

    for (const [catName, score] of rankedCategories) {
      if (score <= 0) continue;
      if (result.length >= MAX_ROUTED_TOOLS) break;

      const rule = CATEGORY_MAP[catName];
      const candidates = toolsByCategory.get(catName) ?? [];
      const remaining = MAX_ROUTED_TOOLS - result.length;
      const limit = Math.min(rule.maxFromCategory, remaining);

      // Rank within the category by distinctive-word relevance (name + description,
      // generic words filtered), so the tool the user actually describes surfaces
      // ahead of siblings that merely share a category. Stable for ties →
      // registration order preserved.
      const sorted = [...candidates].sort(
        (a, b) => this._relevanceScore(b, normalised) - this._relevanceScore(a, normalised),
      );

      let added = 0;
      for (const schema of sorted) {
        if (added >= limit) break;
        const name = this._schemaName(schema);
        if (!name || selectedNames.has(name)) continue;
        result.push(schema);
        selectedNames.add(name);
        added++;
      }
    }
  }

  /**
   * Fallback: add 2 tools each from diverse categories when no keyword matched.
   * Result will be at most: 5 base + 3 continuity + 12 fallback = 20 tools.
   */
  private _fillFallback(
    normalised: string,
    schemasByName: Map<string, ToolSchema>,
    selectedNames: Set<string>,
    result: ToolSchema[],
  ): void {
    const toolsByCategory = this._groupByCategory(schemasByName);

    for (const catName of FALLBACK_CATEGORIES) {
      if (result.length >= MAX_ROUTED_TOOLS) break;
      const candidates = toolsByCategory.get(catName) ?? [];
      let added = 0;

      for (const schema of candidates) {
        if (added >= 2) break;
        if (result.length >= MAX_ROUTED_TOOLS) break;
        const name = this._schemaName(schema);
        if (!name || selectedNames.has(name)) continue;
        result.push(schema);
        selectedNames.add(name);
        added++;
      }
    }

    log.debug(
      { fallbackCategories: FALLBACK_CATEGORIES.join(', '), totalAfterFallback: result.length },
      'Fallback tool fill complete',
    );
  }

  /**
   * Group name-indexed schemas by their category prefix (e.g. "coder" from "coder.read-file").
   *
   * Prefers the `listEnabled()` method on the registry when available (richer
   * ToolDefinition objects).  Falls back to parsing the schema name for the
   * category prefix, which works for any registry that uses `<category>.<action>`
   * naming conventions.
   */
  private _groupByCategory(schemasByName: Map<string, ToolSchema>): Map<string, ToolSchema[]> {
    const map = new Map<string, ToolSchema[]>();

    // Prefer registry-native category data when available.
    if (typeof (this.registry as unknown as { listEnabled?: () => SlimTool[] }).listEnabled === 'function') {
      const enabledTools = (this.registry as unknown as { listEnabled: () => SlimTool[] }).listEnabled();

      for (const tool of enabledTools) {
        const schema = schemasByName.get(tool.name);
        if (!schema) continue;

        const cat = tool.category ?? this._categoryFromName(tool.name);
        if (!cat) continue;

        const existing = map.get(cat);
        if (existing) {
          existing.push(schema);
        } else {
          map.set(cat, [schema]);
        }
      }
      return map;
    }

    // Fallback: derive category from the tool name prefix.
    for (const [name, schema] of schemasByName) {
      const cat = this._categoryFromName(name);
      if (!cat) continue;

      const existing = map.get(cat);
      if (existing) {
        existing.push(schema);
      } else {
        map.set(cat, [schema]);
      }
    }

    return map;
  }

  /**
   * Extract the category prefix from a dot-namespaced tool name.
   * e.g. "coder.read-file" → "coder"
   */
  private _categoryFromName(name: string): string {
    if (!name || typeof name !== 'string') return '';
    const dotIndex = name.indexOf('.');
    return dotIndex > 0 ? name.slice(0, dotIndex) : '';
  }
}
