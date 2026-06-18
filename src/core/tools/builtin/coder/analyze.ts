/**
 * coder.analyze — Elite AI-powered deep code analysis using Grok 4 (2M context).
 *
 * Goes far beyond regex pattern matching. Uses full LLM reasoning to:
 * - Identify architectural flaws and design anti-patterns
 * - Find logic bugs that static analysis misses
 * - Map the full attack surface with exploit chains
 * - Detect race conditions, TOCTOU, concurrency issues
 * - Analyze complexity hotspots and refactor opportunities
 * - Generate actionable, file:line specific findings
 *
 * Modes: architecture | security | performance | complexity | refactor | full | attack-surface
 */

import { streamText } from 'ai';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';
import { getModel } from '../../../brain/providers.js';
import { PROJECT_ROOT } from '../../../shared/paths.js';

const logger = createLogger('coder.analyze');

// ---------------------------------------------------------------------------
// AI model cascade — Grok 4 first (2M context, elite reasoning)
// ---------------------------------------------------------------------------

const MODEL_CASCADE = [
  { model: 'xai/grok-4-0709',              label: 'Grok 4 (2M ctx)'      },
  { model: 'xai/grok-4.20-0309-reasoning', label: 'Grok 4.20 Reasoning'  },
  { model: 'xai/grok-4-1-fast-reasoning',  label: 'Grok Fast Reasoning'  },
  { model: 'claude-oauth/claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5 (OAuth)' },
  { model: 'google/gemini-2.5-flash',      label: 'Gemini 2.5 Flash'     },
];

// ---------------------------------------------------------------------------
// Analysis system prompts — one per mode
// ---------------------------------------------------------------------------

const SYSTEM_PROMPTS: Record<string, string> = {
  architecture: `You are a principal software architect conducting an elite-level architecture review.

Analyze for:
1. SOLID principle violations — identify which principle, where, and exact refactoring needed
2. Circular dependencies — map the cycle, explain why it causes runtime issues
3. God objects / fat controllers — functions >50 lines, classes with >10 responsibilities
4. Tight coupling — modules that can't be unit tested without mocking half the codebase
5. Missing abstraction layers — business logic leaking into infrastructure
6. Wrong layer ownership — DB queries in route handlers, HTTP logic in domain layer
7. Inconsistent error handling patterns — mix of throws, returns, and callbacks
8. Missing interfaces — concrete dependencies that prevent swapping implementations
9. Configuration anti-patterns — magic numbers, hardcoded values that should be config

Format each finding as:
FINDING [SEVERITY]: Title
Location: file:line
Problem: (what's wrong and why it matters)
Impact: (what breaks or becomes painful as the codebase grows)
Fix: (exact refactoring steps with code example)`,

  security: `You are an elite offensive security engineer performing adversarial code review.
Think like an attacker. Find every exploitable path.

Analyze for (OWASP Top 10 + CWE Top 25 + beyond):
1. INJECTION: SQL, NoSQL, LDAP, OS command, SSTI, log injection
2. BROKEN AUTH: weak session management, insecure JWT, missing MFA enforcement, password in URL
3. SENSITIVE DATA: unencrypted PII, secrets in code/logs/errors, weak crypto (MD5/SHA1/DES)
4. XXE: XML parsers with external entity resolution enabled
5. BROKEN ACCESS CONTROL: missing authz checks, IDOR, path traversal (../../), privilege escalation
6. SECURITY MISCONFIG: CORS wildcard, missing security headers, verbose errors exposing stack traces
7. XSS: reflected, stored, DOM-based — eval, innerHTML, document.write, dangerouslySetInnerHTML
8. INSECURE DESERIALIZATION: JSON.parse of untrusted input, Object.assign from req.body
9. PROTOTYPE POLLUTION: obj[key] = value where key is user-controlled (__proto__, constructor)
10. SSRF: fetch/axios/request with user-supplied URLs, internal network access
11. TIMING ATTACKS: string comparison instead of crypto.timingSafeEqual for secrets
12. ReDoS: catastrophic backtracking regex patterns on user input
13. RACE CONDITIONS / TOCTOU: check-then-act patterns in file ops, auth checks
14. SUPPLY CHAIN: require() with dynamic strings, eval of downloaded content
15. INSECURE RANDOMNESS: Math.random() for tokens, nonces, or session IDs
16. MASS ASSIGNMENT: spreading req.body directly into DB models
17. ERROR INFORMATION LEAKAGE: stack traces, DB errors, internal paths in responses

For each vulnerability:
VULN [CRITICAL/HIGH/MEDIUM/LOW]: CVE-class name
Location: file:line
Attack Vector: (how an attacker exploits this — write the actual payload)
Impact: (what the attacker achieves)
PoC: (minimal proof-of-concept showing the exploit)
Fix: (exact code fix with before/after)`,

  performance: `You are a performance engineering specialist. Find every bottleneck.

Analyze for:
1. ALGORITHMIC COMPLEXITY: O(n²), O(n³) loops — identify and suggest O(n log n) or O(n) alternatives
2. AWAIT IN LOOPS: sequential awaits that should be Promise.all() — compute actual latency impact
3. N+1 QUERIES: ORM/DB calls inside loops — identify and suggest batch queries
4. UNNECESSARY RE-RENDERS: React components without memo/useCallback/useMemo where needed
5. MEMORY LEAKS: event listeners, timers, subscriptions never cleaned up — identify the objects that leak
6. BLOCKING EVENT LOOP: sync operations (fs.readFileSync, crypto.pbkdf2Sync) in hot paths
7. EXCESSIVE OBJECT CREATION: new objects inside tight loops, String concatenation in loops
8. UNNECESSARY SERIALIZATION: JSON.stringify/parse in hot paths
9. CACHE MISSES: repeated expensive computations that could be memoized
10. LARGE BUNDLE PROBLEMS: importing entire libraries for one function (import _ from 'lodash')
11. WATERFALL REQUESTS: sequential API calls that could be parallelized
12. INEFFICIENT DATA STRUCTURES: Array.find/filter when Map/Set lookups would be O(1)
13. MISSING DATABASE INDEXES: query patterns on non-indexed columns
14. UNBOUNDED GROWTH: arrays/maps that grow forever without eviction

Format: PERF [HIGH/MEDIUM/LOW]: Title | file:line | Current: O(?) | Expected: O(?) | Fix: ...`,

  complexity: `You are a code quality expert focused on maintainability and cognitive load.

Analyze for:
1. CYCLOMATIC COMPLEXITY: functions with >10 decision paths (if/else/switch/ternary/&&/||)
2. COGNITIVE COMPLEXITY: code that takes >30 seconds to understand — deeply nested logic
3. LONG FUNCTIONS: >50 lines — identify responsibility boundaries and suggest splits
4. LONG PARAMETER LISTS: >4 parameters — suggest object parameter or builder pattern
5. DEEP NESTING: >3 levels of if/for/try — suggest early returns, guard clauses, extraction
6. MAGIC NUMBERS/STRINGS: unexplained literals — suggest named constants
7. DUPLICATE CODE: repeated logic blocks >5 lines — suggest extraction
8. INCONSISTENT NAMING: variables/functions that don't communicate intent
9. COMMENT DEBT: complex code with no explanation, OR obvious code with useless comments
10. DEAD CODE: unused variables, functions, imports, unreachable branches
11. TEST COVERAGE GAPS: public APIs or critical paths with no test coverage
12. FRAGILE TESTS: tests that test implementation details instead of behavior

Format: COMPLEXITY [HIGH/MEDIUM/LOW]: Title | file:line | Complexity: N/10 | Fix: ...`,

  refactor: `You are a senior refactoring specialist. Design the optimal restructured version.

Analyze and produce:
1. EXTRACTION OPPORTUNITIES: code that should be its own function/class/module
2. ABSTRACTION OPPORTUNITIES: repeated patterns that need a shared interface
3. SIMPLIFICATION OPPORTUNITIES: complex code with a simpler equivalent
4. MODERNIZATION: old patterns (callbacks → async/await, var → const, prototype → class)
5. TYPE SAFETY IMPROVEMENTS: any/unknown types that can be narrowed, missing generics
6. DEPENDENCY INJECTION: hardcoded dependencies that should be injected
7. IMMUTABILITY: mutable state that should be immutable
8. COMPOSITION OVER INHERITANCE: deep inheritance hierarchies to flatten
9. PURE FUNCTIONS: impure functions with side effects that should be separated

For each opportunity: show BEFORE code → AFTER code with explanation.`,

  'attack-surface': `You are a red team security researcher mapping the complete attack surface.

Produce a full attack surface map:

1. ENTRY POINTS: Every place external input enters the system
   - HTTP endpoints (routes, params, body, headers, cookies)
   - WebSocket messages
   - File uploads
   - Environment variables
   - Config files
   - IPC / process messages

2. TRUST BOUNDARIES: Where data crosses from untrusted → trusted zone
   - Mark each boundary that lacks validation

3. SENSITIVE DATA FLOWS: Trace how credentials, tokens, PII move through the system
   - Source → processing → storage → transmission
   - Mark each step where data is at risk

4. PRIVILEGE ESCALATION PATHS: Ways a low-privilege user can gain higher access

5. DENIAL OF SERVICE VECTORS: Inputs that cause CPU/memory exhaustion

6. DEPENDENCY ATTACK SURFACE: Third-party packages with known CVEs or suspicious patterns

7. EXPLOIT CHAINS: Combine 2+ medium findings into a critical attack chain

Output as a structured threat model with risk ratings (CRITICAL/HIGH/MEDIUM/LOW).`,

  full: `You are an elite principal engineer and security researcher conducting a comprehensive code audit.
Combine architecture review, security analysis, performance profiling, and code quality assessment.

Structure your analysis as:

## EXECUTIVE SUMMARY
Overall health score (0-100), top 3 critical issues, recommended action priority.

## SECURITY FINDINGS
(Apply the full OWASP Top 10 + CWE Top 25 analysis)

## ARCHITECTURE FINDINGS
(Apply SOLID, coupling, layering analysis)

## PERFORMANCE FINDINGS
(Apply complexity, blocking, memory analysis)

## CODE QUALITY FINDINGS
(Apply complexity, duplication, naming analysis)

## ATTACK SURFACE MAP
(Entry points, trust boundaries, exploit chains)

## REMEDIATION ROADMAP
Priority order: Critical (fix now) → High (this sprint) → Medium (next sprint) → Low (backlog)
Include effort estimate (S/M/L/XL) for each finding.

Be specific — every finding must have file:line citation and exact fix.`,
};

// ---------------------------------------------------------------------------
// File reader
// ---------------------------------------------------------------------------

async function readFilesForAnalysis(targetPath: string, maxBytes = 800_000): Promise<string> {
  const abs = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(PROJECT_ROOT, targetPath);

  if (!existsSync(abs)) {
    return `[File not found: ${targetPath}]`;
  }

  const st = statSync(abs);

  if (st.isFile()) {
    try {
      const content = readFileSync(abs, 'utf-8');
      const rel = path.relative(PROJECT_ROOT, abs);
      return `### ${rel}\n\`\`\`\n${content}\n\`\`\``;
    } catch {
      return `[Cannot read: ${targetPath}]`;
    }
  }

  // Directory — collect all TS/JS files
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: string[];
    try { entries = await readdir(dir); } catch { return; }
    for (const entry of entries) {
      if (['node_modules', '.git', 'dist', 'build', '__pycache__'].includes(entry)) continue;
      const full = path.join(dir, entry);
      let s;
      try { s = statSync(full); } catch { continue; }
      if (s.isDirectory()) { await walk(full); continue; }
      const ext = path.extname(entry).toLowerCase();
      if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.py', '.go', '.rs'].includes(ext)) {
        files.push(full);
      }
    }
  }
  await walk(abs);

  const parts: string[] = [];
  let totalBytes = 0;
  for (const file of files.sort()) {
    if (totalBytes >= maxBytes) {
      parts.push(`\n[... ${files.length - parts.length} more files truncated — context limit reached]`);
      break;
    }
    try {
      const content = readFileSync(file, 'utf-8');
      const rel = path.relative(PROJECT_ROOT, file);
      const chunk = `### ${rel}\n\`\`\`\n${content}\n\`\`\`\n`;
      parts.push(chunk);
      totalBytes += chunk.length;
    } catch { /* skip unreadable */ }
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const analyzeCodeTool: ToolDefinition = {
  name: 'coder.analyze',
  description:
    'ELITE AI-powered deep code analysis using Grok 4 (2M token context). ' +
    'Goes far beyond regex — uses full LLM reasoning to find: architectural flaws, ' +
    'exploit chains, race conditions, logic bugs static analysis misses, O(n²) algorithms, ' +
    'memory leaks, attack surface mapping, and refactoring blueprints. ' +
    'Modes: "security" (OWASP+CWE adversarial), "architecture" (SOLID+coupling), ' +
    '"performance" (complexity+bottlenecks), "complexity" (cognitive load+duplication), ' +
    '"refactor" (restructuring blueprint), "attack-surface" (full red-team threat model), ' +
    '"full" (comprehensive audit with remediation roadmap). ' +
    'Pass a file path, directory, or raw code. Returns file:line specific findings with exact fixes. ' +
    'Use for: pre-commit final check, security audits, onboarding to unfamiliar code, ' +
    'architecture decisions, performance investigations.',
  category: 'coder',
  timeout: 180_000,
  parameters: {
    path: {
      type: 'string',
      description:
        `File path or directory to analyze (relative to ${PROJECT_ROOT}/ or absolute). ` +
        'For directories, all source files are included up to 800KB context.',
    },
    code: {
      type: 'string',
      description:
        'Raw code to analyze directly. Use this when you already have the code in context ' +
        'instead of re-reading from disk.',
    },
    mode: {
      type: 'string',
      enum: ['security', 'architecture', 'performance', 'complexity', 'refactor', 'attack-surface', 'full'],
      description:
        'Analysis mode. "full" for comprehensive audit. "security" for adversarial vuln hunt. ' +
        '"architecture" for design review. "attack-surface" for red-team threat model. Default: "full".',
    },
    context: {
      type: 'string',
      description:
        'Additional context: what the code does, known issues, focus areas, acceptance criteria, ' +
        'recent changes. More context = more targeted analysis.',
    },
    model: {
      type: 'string',
      description: 'Force a specific model (e.g. "xai/grok-4-0709"). Default: auto-cascade.',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const filePath   = typeof params['path']    === 'string' ? params['path'].trim()    : '';
    const rawCode    = typeof params['code']    === 'string' ? params['code'].trim()    : '';
    const mode       = typeof params['mode']    === 'string' ? params['mode'].trim()    : 'full';
    const context    = typeof params['context'] === 'string' ? params['context'].trim() : '';
    const forcedModel= typeof params['model']   === 'string' ? params['model'].trim()   : '';

    if (!filePath && !rawCode) {
      return { success: false, output: 'coder.analyze: provide "path" (file/dir) or "code" (raw).' };
    }

    const systemPrompt = SYSTEM_PROMPTS[mode] ?? SYSTEM_PROMPTS['full']!;

    // Gather code content
    let codeContent = '';
    if (rawCode) {
      codeContent = `### [Inline Code]\n\`\`\`\n${rawCode}\n\`\`\``;
    } else {
      codeContent = await readFilesForAnalysis(filePath);
    }

    const userPrompt = [
      `Perform a ${mode.toUpperCase()} analysis on the following code.`,
      context ? `\nContext provided by engineer: ${context}` : '',
      `\n\n${codeContent}`,
    ].filter(Boolean).join('');

    logger.info({ session: ctx.sessionId, mode, filePath: filePath || '[inline]', forcedModel }, 'coder.analyze invoked');

    // Model cascade
    const cascade = forcedModel
      ? [{ model: forcedModel, label: forcedModel }, ...MODEL_CASCADE]
      : MODEL_CASCADE;

    const errors: string[] = [];

    for (const option of cascade) {
      try {
        const model = getModel(option.model);
        logger.info({ model: option.model, mode }, 'Trying model for analysis');

        // Stream: a non-streaming generateText holds claude-oauth response headers
        // until the full generation completes, tripping the fast-fail headers timer
        // on the sonnet OAuth tier (same trap as PR #277). streamText lands headers
        // in ~1-2s; awaiting result.text drains the stream to the full completion.
        const result = streamText({
          model,
          system: systemPrompt,
          prompt: userPrompt,
          maxOutputTokens: 16384,
          temperature: 0.2,
        });

        const output = (await result.text)?.trim() ?? '';
        if (!output) {
          errors.push(`${option.label}: empty response`);
          continue;
        }

        logger.info({ model: option.model, chars: output.length, mode }, 'Analysis complete');

        return {
          success: true,
          output: `**[CODER.ANALYZE — ${option.label} — ${mode.toUpperCase()}]**\n\n${output}`,
          data: { model: option.model, mode, chars: output.length, path: filePath || '[inline]' },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const skip = msg.includes('not configured') || msg.includes('API key');
        if (skip) { logger.debug({ model: option.model }, 'Not configured — skipping'); continue; }
        logger.warn({ model: option.model, err: msg }, 'Model failed — trying next');
        errors.push(`${option.label}: ${msg.slice(0, 80)}`);
      }
    }

    return {
      success: false,
      output: [
        'coder.analyze: All models failed.',
        '',
        'Attempted:',
        ...errors.map(e => `  • ${e}`),
        '',
        'Check XAI_API_KEY in config/.env',
      ].join('\n'),
    };
  },
};
