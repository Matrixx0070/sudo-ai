/**
 * coder.review — Static code analysis for bugs, security, and performance issues.
 * Performs regex-based pattern matching; no external tools required.
 * Handles both single files and directories (recursive).
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, join, extname, relative } from 'node:path';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';

type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
type Focus = 'security' | 'performance' | 'bugs' | 'all';

interface Finding {
  severity: Severity;
  category: string;
  file: string;
  line: number;
  code: string;
  message: string;
  suggestion: string;
}

interface Rule {
  id: string;
  category: 'security' | 'performance' | 'bugs';
  severity: Severity;
  pattern: RegExp;
  message: string;
  suggestion: string;
}

const RULES: Rule[] = [
  // Security
  { id: 'sec-hardcoded-secret', category: 'security', severity: 'critical',
    pattern: /(?:password|secret|api[_-]?key|auth[_-]?token|private[_-]?key)\s*[:=]\s*['"][^'"]{6,}['"]/i,
    message: 'Hardcoded secret or API key detected.',
    suggestion: 'Move secrets to environment variables and use a secrets manager.' },
  { id: 'sec-sql-injection', category: 'security', severity: 'critical',
    pattern: /(?:query|execute|run)\s*\(\s*[`'"]\s*(?:SELECT|INSERT|UPDATE|DELETE|DROP).*?\$\{/i,
    message: 'Potential SQL injection via template string interpolation.',
    suggestion: 'Use parameterized queries or prepared statements.' },
  { id: 'sec-xss-innerhtml', category: 'security', severity: 'high',
    pattern: /\.innerHTML\s*=\s*(?!['"`]<\/)/,
    message: 'Assignment to innerHTML may introduce XSS vulnerabilities.',
    suggestion: 'Use textContent, createElement, or a sanitization library (DOMPurify).' },
  { id: 'sec-xss-dangerously', category: 'security', severity: 'high',
    pattern: /dangerouslySetInnerHTML\s*=\s*\{\s*\{/,
    message: 'dangerouslySetInnerHTML used — potential XSS vector.',
    suggestion: 'Sanitize HTML before passing to dangerouslySetInnerHTML or avoid it.' },
  { id: 'sec-eval', category: 'security', severity: 'critical',
    pattern: /\beval\s*\(/,
    message: 'eval() usage detected — arbitrary code execution risk.',
    suggestion: 'Replace eval() with safer alternatives (JSON.parse, Function constructor with strict sandboxing).' },
  { id: 'sec-exec-shell', category: 'security', severity: 'high',
    pattern: /exec\s*\(\s*[`'"][^'"]*\$\{/,
    message: 'Shell exec with template string interpolation — command injection risk.',
    suggestion: 'Use execFile() with argument arrays instead of exec() with string interpolation.' },
  { id: 'sec-child-process-shell', category: 'security', severity: 'high',
    pattern: /shell\s*:\s*true/,
    message: 'child_process with shell:true — enables shell injection.',
    suggestion: 'Remove shell:true and use execFile() with argument arrays.' },
  { id: 'sec-open-redirect', category: 'security', severity: 'medium',
    pattern: /res\.redirect\s*\(\s*req\./,
    message: 'Possible open redirect — redirecting to user-supplied URL.',
    suggestion: 'Validate and allowlist redirect destinations.' },

  // Bugs
  { id: 'bug-no-error-handling', category: 'bugs', severity: 'medium',
    pattern: /\.then\s*\([^)]+\)(?!\s*\.catch)/,
    message: 'Promise .then() without .catch() — unhandled rejection possible.',
    suggestion: 'Add .catch() or use try/catch in an async function.' },
  { id: 'bug-console-log', category: 'bugs', severity: 'low',
    pattern: /console\.log\s*\(/,
    message: 'console.log() left in code.',
    suggestion: 'Replace with a structured logger (pino, winston) before production.' },
  { id: 'bug-todo-fixme', category: 'bugs', severity: 'info',
    pattern: /\/\/\s*(?:TODO|FIXME|HACK|XXX):/i,
    message: 'TODO/FIXME comment found.',
    suggestion: 'Track in issue tracker and resolve before release.' },
  { id: 'bug-empty-catch', category: 'bugs', severity: 'high',
    pattern: /catch\s*\([^)]*\)\s*\{\s*\}/,
    message: 'Empty catch block — errors are swallowed silently.',
    suggestion: 'Log the error or rethrow it.' },
  { id: 'bug-floating-promise', category: 'bugs', severity: 'medium',
    pattern: /^\s+(?!return|await|void )(?:\w+\.)*\w+\s*\(.*\);\s*$/m,
    message: 'Possible floating promise (async call without await/return).',
    suggestion: 'Add await, return, or void if intentionally fire-and-forget.' },

  // Performance
  { id: 'perf-nested-loops', category: 'performance', severity: 'medium',
    pattern: /for\s*\([^)]*\)[^{]*\{[^}]*for\s*\(/,
    message: 'Nested loop detected — O(n²) complexity possible.',
    suggestion: 'Consider using a Map/Set for O(1) lookups or restructure algorithm.' },
  { id: 'perf-sync-fs', category: 'performance', severity: 'high',
    pattern: /\bfs\.\w+Sync\s*\(/,
    message: 'Synchronous fs operation blocks the event loop.',
    suggestion: 'Replace with async equivalent (fs.promises.* or fs/promises).' },
  { id: 'perf-json-stringify-loop', category: 'performance', severity: 'medium',
    pattern: /for\s*\([^)]*\)[^{]*\{[^}]*JSON\.stringify/,
    message: 'JSON.stringify inside a loop — potential performance issue.',
    suggestion: 'Move serialization outside the loop where possible.' },
  { id: 'perf-memory-leak-listener', category: 'performance', severity: 'medium',
    pattern: /addEventListener\s*\([^)]+\)(?![\s\S]{0,200}removeEventListener)/,
    message: 'Event listener added without visible removeEventListener — possible memory leak.',
    suggestion: 'Store and remove listeners when the component/object is destroyed.' },
  { id: 'perf-await-in-loop', category: 'performance', severity: 'high',
    pattern: /for\s*(?:await\s*)?\s*\([^)]*\)[^{]*\{[^}]*\bawait\b/,
    message: 'await inside a loop — sequential execution instead of parallel.',
    suggestion: 'Collect promises and use Promise.all() for parallel execution.' },
  { id: 'perf-array-find-hot', category: 'performance', severity: 'low',
    pattern: /\bArray\.from\s*\([^)]+\)\.(?:find|filter|map)\s*\(/,
    message: 'Array.from() chained with iteration — creates intermediate array.',
    suggestion: 'Use a for...of loop or convert to Set/Map for repeated lookups.' },
  { id: 'perf-string-concat-loop', category: 'performance', severity: 'medium',
    pattern: /for\s*\([^)]*\)[^{]*\{[^}]*\+=\s*['"]/,
    message: 'String concatenation inside loop — O(n²) memory allocation.',
    suggestion: 'Push to array then join() outside the loop.' },
  { id: 'perf-date-now-loop', category: 'performance', severity: 'low',
    pattern: /for\s*\([^)]*\)[^{]*\{[^}]*Date\.now\(\)/,
    message: 'Date.now() called inside loop — cache the value before the loop.',
    suggestion: 'Cache Date.now() in a variable before the loop.' },

  // Security — OWASP / CWE advanced
  { id: 'sec-path-traversal', category: 'security', severity: 'critical',
    pattern: /(?:readFile|readFileSync|createReadStream|access|stat)\s*\([^)]*(?:req\.|params\.|query\.|body\.)/i,
    message: 'File system access with user-supplied path — path traversal risk.',
    suggestion: 'Use path.basename() and validate against an allowlist of directories.' },
  { id: 'sec-prototype-pollution', category: 'security', severity: 'critical',
    pattern: /\[(?:req|body|params|query|input|data)\s*(?:\.\w+)*\]\s*=/,
    message: 'Dynamic property assignment with user-controlled key — prototype pollution risk.',
    suggestion: 'Validate key against allowlist. Use Object.create(null) for dynamic maps.' },
  { id: 'sec-ssrf', category: 'security', severity: 'critical',
    pattern: /(?:fetch|axios|request|got|http\.get)\s*\(\s*(?:req\.|params\.|query\.|body\.)/i,
    message: 'HTTP request with user-supplied URL — SSRF risk (internal network access).',
    suggestion: 'Validate URL against allowlist. Block private IP ranges (10.x, 172.16.x, 192.168.x, 127.x).' },
  { id: 'sec-timing-attack', category: 'security', severity: 'high',
    pattern: /(?:token|secret|password|hash|key|sig)\s*(?:===|!==|==|!=)\s*/i,
    message: 'Direct string comparison of secrets — timing attack vector.',
    suggestion: 'Use crypto.timingSafeEqual() for constant-time comparison of secrets.' },
  { id: 'sec-insecure-random', category: 'security', severity: 'high',
    pattern: /Math\.random\s*\(\s*\).*(?:token|session|nonce|key|id|secret|otp|code)/i,
    message: 'Math.random() used for security-sensitive value — cryptographically weak.',
    suggestion: 'Use crypto.randomBytes() or crypto.randomUUID() for security tokens.' },
  { id: 'sec-weak-hash', category: 'security', severity: 'critical',
    pattern: /(?:createHash|hash)\s*\(\s*['"](?:md5|sha1|sha-1)['"]/i,
    message: 'Weak hash algorithm (MD5/SHA1) — collision attacks possible.',
    suggestion: 'Use SHA-256 or SHA-512 for hashing. Use bcrypt/argon2 for passwords.' },
  { id: 'sec-jwt-none-alg', category: 'security', severity: 'critical',
    pattern: /(?:algorithm|alg)\s*:\s*['"]none['"]/i,
    message: 'JWT "none" algorithm — authentication bypass vulnerability.',
    suggestion: 'Explicitly specify and enforce a strong algorithm (RS256 or HS256). Never trust alg header.' },
  { id: 'sec-regex-dos', category: 'security', severity: 'high',
    pattern: /new RegExp\s*\(\s*(?:req\.|params\.|query\.|body\.)/i,
    message: 'RegExp constructed from user input — ReDoS (Regex Denial of Service) risk.',
    suggestion: 'Sanitize and validate regex input. Use a timeout or safe-regex library.' },
  { id: 'sec-mass-assignment', category: 'security', severity: 'high',
    pattern: /(?:Object\.assign|\.\.\.(?:req\.body|req\.query|req\.params))/,
    message: 'Mass assignment from request body — unauthorized field injection risk.',
    suggestion: 'Use explicit field allowlist: pick only expected fields from req.body.' },
  { id: 'sec-cors-wildcard', category: 'security', severity: 'high',
    pattern: /(?:Access-Control-Allow-Origin|origin)\s*[:'"\s]+\*/,
    message: 'CORS wildcard (*) allows any origin to make cross-origin requests.',
    suggestion: 'Specify an explicit allowlist of trusted origins.' },
  { id: 'sec-sensitive-log', category: 'security', severity: 'high',
    pattern: /(?:console\.log|logger\.\w+)\s*\([^)]*(?:password|token|secret|key|auth|credential)/i,
    message: 'Sensitive data (password/token/key) logged — credentials may appear in log files.',
    suggestion: 'Never log secrets. Redact before logging: { ...user, password: "[REDACTED]" }.' },
  { id: 'sec-deserialize-unsafe', category: 'security', severity: 'critical',
    pattern: /(?:unserialize|deserialize|fromJSON|JSON\.parse)\s*\([^)]*(?:req\.|params\.|body\.)/i,
    message: 'Deserializing user input — untrusted deserialization risk.',
    suggestion: 'Validate schema before deserializing. Use zod/joi for input validation.' },
  { id: 'sec-hardcoded-creds-url', category: 'security', severity: 'critical',
    pattern: /(?:mongodb|postgres|mysql|redis|amqp|smtp):\/\/[^"'\s:]+:[^"'\s@]+@/i,
    message: 'Database/service credentials hardcoded in connection string.',
    suggestion: 'Move credentials to environment variables. Never commit connection strings.' },
  { id: 'sec-http-not-https', category: 'security', severity: 'medium',
    pattern: /['"]http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0)/,
    message: 'HTTP (not HTTPS) URL in production code — data transmitted unencrypted.',
    suggestion: 'Use HTTPS for all external communications.' },
  { id: 'sec-child-process-user-input', category: 'security', severity: 'critical',
    pattern: /(?:exec|execSync|spawn|spawnSync)\s*\([^)]*(?:req\.|params\.|query\.|body\.)/i,
    message: 'Shell command with user-supplied input — OS command injection vulnerability.',
    suggestion: 'Use execFile() with an argument array. Never interpolate user input into shell commands.' },
  { id: 'sec-xml-external-entity', category: 'security', severity: 'critical',
    pattern: /(?:parseXml|parseString|xml2js|DOMParser)\s*\([^)]*(?:req\.|body\.|input)/i,
    message: 'XML parsing of user input — XXE (XML External Entity) injection risk.',
    suggestion: 'Disable external entity processing: { explicitCharKey: false, ignoreAttrs: false }.' },
  { id: 'sec-noauth-route', category: 'security', severity: 'medium',
    pattern: /(?:router|app)\s*\.\s*(?:post|put|delete|patch)\s*\([^)]+\)\s*(?:,\s*)?(?:async\s*)?\([^)]*req[^)]*\)\s*=>/,
    message: 'Mutating HTTP route without visible auth middleware.',
    suggestion: 'Ensure authentication middleware is applied: router.post("/", authMiddleware, handler).' },

  // Bugs — advanced
  { id: 'bug-object-spread-merge', category: 'bugs', severity: 'medium',
    pattern: /\{\s*\.\.\.\w+,\s*\.\.\.\w+\s*\}/,
    message: 'Object spread merge — later keys silently overwrite earlier ones.',
    suggestion: 'Use explicit merge with conflict detection when merging user/config objects.' },
  { id: 'bug-number-nan-check', category: 'bugs', severity: 'medium',
    pattern: /===\s*NaN|NaN\s*===/,
    message: 'NaN comparison with === always returns false.',
    suggestion: 'Use Number.isNaN() or isNaN() to check for NaN values.' },
  { id: 'bug-typeof-null', category: 'bugs', severity: 'low',
    pattern: /typeof\s+\w+\s*===\s*['"]object['"]/,
    message: 'typeof null === "object" — null check may be missing.',
    suggestion: 'Add explicit null check: value !== null && typeof value === "object".' },
  { id: 'bug-catch-rethrow-lost', category: 'bugs', severity: 'high',
    pattern: /catch\s*\([^)]+\)\s*\{[^}]*throw\s+new\s+Error\s*\(['"]/,
    message: 'catch block creates new Error without chaining original — stack trace lost.',
    suggestion: 'Chain original error: throw new Error("message", { cause: err }) or re-throw err.' },
  { id: 'bug-race-setstate', category: 'bugs', severity: 'medium',
    pattern: /async[^{]+\{[^}]*await[^}]*setState\s*\(/,
    message: 'setState after await — component may have unmounted, causing memory leak.',
    suggestion: 'Check if component is still mounted before calling setState after async operations.' },
  { id: 'bug-integer-division', category: 'bugs', severity: 'low',
    pattern: /(?:const|let|var)\s+\w+\s*=\s*\d+\s*\/\s*\d+(?!\s*\*)/,
    message: 'Integer division may produce unexpected float result.',
    suggestion: 'Use Math.floor(), Math.ceil(), or Math.trunc() for integer division.' },
  { id: 'bug-missing-break', category: 'bugs', severity: 'medium',
    pattern: /case\s+[^:]+:\s*\n(?:(?!\s*break|\s*return|\s*throw|\s*case|\s*default)[^\n]*\n){3,}\s*case\s+/,
    message: 'Switch case fall-through without explicit break/return/throw.',
    suggestion: 'Add break or return. If fall-through is intentional, add /* falls through */ comment.' },
];

const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.java', '.c', '.cpp', '.cs',
  '.json', '.yaml', '.yml', '.toml', '.env',
  '.sql', '.html', '.vue', '.svelte',
]);

async function collectFiles(dir: string, results: string[], signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  let entries: string[];
  try { entries = await readdir(dir); } catch { return; }
  for (const entry of entries) {
    if (signal?.aborted) return;
    if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;
    const full = join(dir, entry);
    let s;
    try { s = await stat(full); } catch { continue; }
    if (s.isDirectory()) await collectFiles(full, results, signal);
    else if (TEXT_EXTENSIONS.has(extname(entry).toLowerCase())) results.push(full);
  }
}

function analyzeText(filePath: string, content: string, focus: Focus, rules: Rule[]): Finding[] {
  const findings: Finding[] = [];
  const lines = content.split('\n');

  for (const rule of rules) {
    if (focus !== 'all' && rule.category !== focus) continue;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (rule.pattern.test(line)) {
        findings.push({
          severity: rule.severity,
          category: rule.category,
          file: filePath,
          line: i + 1,
          code: line.trim().slice(0, 120),
          message: rule.message,
          suggestion: rule.suggestion,
        });
      }
    }
  }
  return findings;
}

function formatReport(findings: Finding[], basePath: string): string {
  if (findings.length === 0) return 'No issues found.';

  const bySeverity: Record<Severity, Finding[]> = {
    critical: [], high: [], medium: [], low: [], info: [],
  };
  for (const f of findings) bySeverity[f.severity].push(f);

  const lines: string[] = [];
  const order: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

  for (const sev of order) {
    const group = bySeverity[sev];
    if (group.length === 0) continue;
    lines.push(`\n${'='.repeat(50)}`);
    lines.push(`${sev.toUpperCase()} (${group.length})`);
    lines.push('='.repeat(50));
    for (const f of group) {
      const rel = relative(basePath, f.file) || f.file;
      lines.push(`[${f.category}] ${rel}:${f.line}`);
      lines.push(`  Issue: ${f.message}`);
      lines.push(`  Code:  ${f.code}`);
      lines.push(`  Fix:   ${f.suggestion}`);
    }
  }

  const counts = order.map((s) => `${s}: ${bySeverity[s].length}`).join(', ');
  return `Code Review Summary — ${findings.length} issue(s) [${counts}]` + lines.join('\n');
}

export const codeReviewTool: ToolDefinition = {
  name: 'coder.review',
  description:
    'Adversarial code review — finds bugs, security vulnerabilities, and performance issues. ' +
    'MANDATORY before committing any code that handles: auth, user input, external APIs, file I/O, or database. ' +
    'Detects: hardcoded secrets, SQL injection, XSS, eval(), command injection, open redirects, ' +
    'unhandled promises, sync I/O in async paths, memory leaks, N+1 queries. ' +
    'Severity: CRITICAL (fix now) → HIGH (fix before commit) → MEDIUM (fix this sprint) → LOW/INFO. ' +
    'Use focus="security" for auth code, focus="performance" for hot paths, focus="all" for final review. ' +
    'Returns structured findings with file:line citations and specific fix instructions.',
  category: 'coder',
  timeout: 60_000,
  parameters: {
    path: {
      type: 'string',
      required: true,
      description: 'File or directory to analyze.',
    },
    focus: {
      type: 'string',
      required: false,
      default: 'all',
      description: 'Narrow the review focus.',
      enum: ['security', 'performance', 'bugs', 'all'],
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const log = ctx.logger as { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void };

    const rawPath = params['path'];
    if (typeof rawPath !== 'string' || rawPath.trim() === '') {
      return { success: false, output: 'coder.review: "path" parameter is required.' };
    }

    const targetPath = resolve(ctx.workingDir, rawPath);
    const focus: Focus = (typeof params['focus'] === 'string' && ['security', 'performance', 'bugs', 'all'].includes(params['focus']))
      ? (params['focus'] as Focus)
      : 'all';

    try {
      let filesToReview: string[] = [];
      const s = await stat(targetPath);
      if (s.isFile()) {
        filesToReview = [targetPath];
      } else {
        await collectFiles(targetPath, filesToReview, ctx.signal);
      }

      const allFindings: Finding[] = [];
      for (const filePath of filesToReview) {
        if (ctx.signal?.aborted) break;
        let content: string;
        try { content = await readFile(filePath, 'utf-8'); } catch { continue; }
        allFindings.push(...analyzeText(filePath, content, focus, RULES));
      }

      log.info({ tool: 'coder.review', path: targetPath, focus, findings: allFindings.length }, 'Review complete');

      return {
        success: true,
        output: formatReport(allFindings, targetPath),
        data: {
          path: targetPath,
          focus,
          filesAnalyzed: filesToReview.length,
          totalFindings: allFindings.length,
          findings: allFindings,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ tool: 'coder.review', path: targetPath, err }, 'Code review failed');
      return { success: false, output: `coder.review error: ${msg}` };
    }
  },
};

export default codeReviewTool;
