/**
 * @file error-formatter.ts
 * @description Turns a raw tool failure into an actionable hint a weaker model
 * can recover from. A frontier model can often diagnose "Path traversal
 * blocked: …" on its own; a smaller model (kimi/glm/ollama/local) usually
 * cannot, and burns turns retrying the same broken call. Each hint answers four
 * questions — what went wrong, why, what to do instead, and a correct example —
 * appended to the failed tool result the model sees.
 *
 * Rules are keyed to the REAL error strings SUDO's tools emit (verified against
 * source), so they fire on actual failures, not hypothetical ones. The rule set
 * is ordered: the first match wins, with a light generic nudge as the floor.
 *
 * Pure module. Fail-open by contract: a classifier that finds no specific rule
 * returns the generic nudge; callers append the result and never let it throw.
 */

/** Structured, model-facing recovery guidance for a failed tool call. */
export interface ToolErrorHint {
  /** What went wrong, in one plain sentence. */
  what: string;
  /** The root cause, in one sentence. */
  why: string;
  /** The concrete alternative tool or approach. */
  fix: string;
  /** Optional correct-usage example. */
  example?: string;
}

interface ErrorRule {
  /** Stable id for logging/telemetry. */
  id: string;
  /** Matches against `${toolName}\n${lowercasedError}`. */
  test: (lcError: string, toolName: string) => boolean;
  hint: ToolErrorHint;
}

// Ordered most-specific → least-specific. First match wins.
const RULES: ErrorRule[] = [
  {
    // self-modify.ts / write-file.ts / multi-read.ts / arsenal.ts
    id: 'path-outside-scope',
    test: (e) =>
      e.includes('path traversal blocked') ||
      e.includes('resolves outside working directory') ||
      e.includes('outside project root') ||
      e.includes('outside the project'),
    hint: {
      what: 'The path you used is outside the directory this tool can reach.',
      why: 'coder.* tools and the default sandbox are scoped to the workspace, not the SUDO-AI repo at /root/sudo-ai-v4.',
      fix: 'To read or edit a SUDO-AI repo file, use meta.self-modify (read-file / edit-file) with a repo-relative path. Only use coder.* for files inside the workspace.',
      example: 'meta.self-modify({ action: "read-file", path: "src/core/agent/loop.ts" })',
    },
  },
  {
    // repo-allowlist.ts: 'shell metacharacters are not allowed in repo-exec'
    id: 'repo-exec-metachar',
    test: (e) => e.includes('not allowed in repo-exec') || e.includes('shell metacharacters are not allowed'),
    hint: {
      what: 'system.exec target:"repo" refused the command for an unquoted shell operator.',
      why: 'The real-repo channel runs via execFile (no shell). Pipes BETWEEN read-only commands ARE allowed (up to 4 segments): `rg foo src | head -20`. What is NOT expanded: redirects (>, >>), chaining (&&, ;), substitution ($(), backticks), and globs (*, ?).',
      fix: 'Pipe to filter output (rg ... | head). For a glob, use `rg -g "*.ts" foo` or list explicit paths. Quote any regex you want as literal text (rg -n "a|b\\(\\)" src). Never use >, &&, or $() here.',
      example: 'system.exec({ target: "repo", command: "rg -n \\"as any\\" src | head -20" })',
    },
  },
  {
    // repo-allowlist.ts: `'<head>' is not a repo-allowlisted command`
    id: 'repo-exec-not-allowlisted',
    test: (e) => e.includes('is not a repo-allowlisted command'),
    hint: {
      what: 'That command is not on the repo-exec allowlist.',
      why: 'target:"repo" permits read/verify commands only. ALLOWED: pnpm/npm test|lint|build; read-only git (status/log/diff/branch/rev-parse/describe/blame/shortlog/ls-files); rg; grep; ls; wc; cat; head; tail; stat; sort; uniq; read-only pm2 (list/status/logs sudo-ai-v5). NOT allowed: find, sed, awk, echo, curl, node/npx, mkdir/touch/rm (writes), git write ops, pm2 restart.',
      fix: 'Search with rg or grep; read a file with cat/head/tail (or meta.self-modify read-file); list files with `rg --files -g "<glob>"` or ls; EDIT with meta.self-modify. Network and writes are blocked here.',
      example: 'system.exec({ target: "repo", command: "grep -rn \\"TODO\\" src | head -20" })',
    },
  },
  {
    // repo-allowlist.ts: `'<command>' is not an allowed form of '<head>'`
    id: 'repo-exec-not-allowed-form',
    test: (e) => e.includes('is not an allowed form of'),
    hint: {
      what: 'That command is allowlisted, but THIS form of it is not (a write/mutating variant).',
      why: 'repo-exec is read-and-verify only: git → read-only subcommands (status/log/diff/branch/rev-parse/describe/blame/shortlog/ls-files); pm2 → list/status/logs sudo-ai-v5; npm/pnpm → test/lint/build.',
      fix: 'Use a read-only form, or route the mutating action through the right tool: git commit/checkout → meta.self-modify (or the self-build flow); pm2 restart → meta.self-modify restart. Do not try to mutate via repo-exec.',
      example: 'system.exec({ target: "repo", command: "git log --oneline -5" })',
    },
  },
  {
    // self-modify.ts edit: `Text not found in <file>` (old_string mismatch)
    id: 'edit-text-not-found',
    test: (e) => e.includes('text not found in') || e.includes('old_string') || e.includes('no match found for'),
    hint: {
      what: 'The text you asked to replace was not found in the file.',
      why: 'Edits match old_string byte-for-byte, including exact whitespace and indentation.',
      fix: 'Read the file first and copy the target text verbatim (exact indentation and punctuation), then retry the edit. If it appears more than once, include enough surrounding context to make it unique.',
      example: 'meta.self-modify({ action: "read-file", path: "..." }) → copy the exact lines → edit-file',
    },
  },
  {
    id: 'file-not-found',
    test: (e) => e.includes('file not found') || e.includes('enoent') || e.includes('no such file'),
    hint: {
      what: 'The file does not exist at that path.',
      why: 'The path is wrong, or the file lives in a different root (repo vs workspace).',
      fix: 'Search or list first to confirm the real path (search-code, or read the directory). For a SUDO-AI repo file, use meta.self-modify with a repo-relative path.',
    },
  },
  {
    id: 'tool-not-found',
    test: (e) =>
      e.includes('tool_not_found') ||
      e.includes('not in registry') ||
      e.includes('unknown tool') ||
      e.includes('no such tool'),
    hint: {
      what: 'No tool by that name is available this turn.',
      why: 'The name is misspelled, or the tool is not in the current per-turn tool set.',
      fix: 'Call tool.search with a keyword to discover the right tool and its exact name, then call it. Do not invent tool names.',
      example: 'tool.search({ query: "read a file" })',
    },
  },
  {
    id: 'approval-blocked',
    test: (e) =>
      e.includes('requires approval') ||
      e.includes('needs approval') ||
      e.includes('not approved') ||
      e.includes('denied') ||
      e.includes('blocked by') ||
      e.includes('veto'),
    hint: {
      what: 'The action was stopped by the safety/approval layer.',
      why: 'Destructive or sensitive actions are gated; they run only via an approved or allowlisted path.',
      fix: 'State plainly what you intend and why. For repo commands use system.exec target:"repo" (allowlisted). Do not repeat the identical blocked call — change the approach.',
    },
  },
  {
    id: 'bad-arguments',
    test: (e) =>
      e.includes('required') ||
      e.includes('missing') ||
      e.includes('invalid argument') ||
      e.includes('expected') ||
      e.includes('must be') ||
      e.includes('is not valid json') ||
      e.includes('unexpected token'),
    hint: {
      what: 'The tool call arguments were malformed or missing a required field.',
      why: 'The arguments did not match the tool\'s parameter schema.',
      fix: 'Re-check the tool\'s parameters: supply every required field, use the right types, and emit valid JSON (no trailing commas, double-quoted keys and strings).',
    },
  },
];

/** The floor: applied to any failure no specific rule matched. */
const GENERIC_HINT: ToolErrorHint = {
  what: 'The tool call failed.',
  why: 'The current approach hit an error.',
  fix: 'Read the error above and change ONE thing before retrying — the path, the tool, or the arguments. If it fails ~3 times with genuinely different approaches, stop and report what you tried and the exact error.',
};

/**
 * Classify a tool failure into a structured hint. Returns the matching rule's
 * hint, or the generic floor hint when nothing specific matches. Never throws.
 */
export function classifyToolError(toolName: string, rawError: string): ToolErrorHint {
  const lc = `${toolName}\n${String(rawError ?? '')}`.toLowerCase();
  for (const rule of RULES) {
    try {
      if (rule.test(lc, (toolName ?? '').toLowerCase())) return rule.hint;
    } catch {
      // a misbehaving rule must not break the path
    }
  }
  return GENERIC_HINT;
}

/** Render a hint as a compact, model-friendly block to append to a tool result. */
export function formatToolErrorHint(hint: ToolErrorHint): string {
  const lines = [
    '↳ How to fix this:',
    `What: ${hint.what}`,
    `Why: ${hint.why}`,
    `Fix: ${hint.fix}`,
  ];
  if (hint.example) lines.push(`Example: ${hint.example}`);
  return lines.join('\n');
}

/**
 * One-shot: classify a failure and render the appended hint block. Returns the
 * formatted string, ready to concatenate onto the failed tool result.
 */
export function enrichToolError(toolName: string, rawError: string): string {
  return formatToolErrorHint(classifyToolError(toolName, rawError));
}

/** Kill-switch: hints are on by default; SUDO_TOOL_ERROR_HINTS=0 disables them. */
export function isToolErrorHintsEnabled(): boolean {
  return process.env['SUDO_TOOL_ERROR_HINTS'] !== '0';
}
