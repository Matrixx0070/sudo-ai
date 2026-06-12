/**
 * @file security/bash-ast.ts
 * @description Bash AST Parser & Structural Security Analyzer for SUDO-AI.
 *
 * Parses bash commands into abstract syntax trees, then performs structural
 * analysis for risk classification, read-only detection, and safety validation.
 *
 * This closes the competitive gap with Claude Code's 102KB bashSecurity.ts
 * which does AST-based command analysis. SUDO-AI previously relied on regex
 * pattern matching and allowlists — this module adds structural understanding.
 *
 * Key capabilities:
 * - Parse bash commands into AST nodes (pipelines, redirects, substitutions)
 * - Classify commands by risk level (safe/low/medium/high/critical)
 * - Detect 12 risk categories (file destruction, privilege escalation, etc.)
 * - Read-only command detection (structural: a command is read-only if it
 *   doesn't modify filesystem AND doesn't access network destructively)
 * - Pipe chain analysis (a pipeline is as dangerous as its most dangerous stage)
 * - Fork bomb and resource abuse detection
 * - Protected path validation
 *
 * Usage:
 * ```ts
 * import { BashASTParser } from '../core/security/bash-ast.js';
 *
 * const parser = new BashASTParser();
 * const result = parser.parse('rm -rf /tmp/test && echo "done"');
 * // result.valid === true
 * // result.risk.level === 'critical'
 * // result.risk.categories === ['file_destruction']
 * // result.hasPipes === false
 * // result.isPrivileged === false
 * ```
 */

import { createLogger } from '../shared/logger.js';
import type {
  BashASTNode,
  BashParserConfig,
  BashValidationResult,
  CommandNode,
  PipelineNode,
  SequenceNode,
  AndListNode,
  OrListNode,
  BackgroundNode,
  SubshellNode,
  RedirectNode,
  RiskAssessment,
  RiskCategory,
  RiskLevel,
  RiskPattern,
} from './bash-ast-types.js';
import { DEFAULT_BASH_PARSER_CONFIG } from './bash-ast-types.js';

const log = createLogger('security:bash-ast');

// ---------------------------------------------------------------------------
// Risk Classification Tables
// ---------------------------------------------------------------------------

/**
 * Command risk classification map.
 * Each command maps to its default risk level and categories.
 * Specific flags/arguments can escalate the risk.
 */
const COMMAND_RISK_MAP: Record<string, {
  level: RiskLevel;
  categories: RiskCategory[];
  modifiesFilesystem: boolean;
  accessesNetwork: boolean;
  readOnly: boolean;
}> = {
  // --- File destruction ---
  rm: { level: 'high', categories: ['file_destruction'], modifiesFilesystem: true, accessesNetwork: false, readOnly: false },
  rmdir: { level: 'low', categories: ['file_destruction'], modifiesFilesystem: true, accessesNetwork: false, readOnly: false },
  shred: { level: 'critical', categories: ['file_destruction'], modifiesFilesystem: true, accessesNetwork: false, readOnly: false },
  truncate: { level: 'medium', categories: ['file_destruction'], modifiesFilesystem: true, accessesNetwork: false, readOnly: false },
  unlink: { level: 'medium', categories: ['file_destruction'], modifiesFilesystem: true, accessesNetwork: false, readOnly: false },

  // --- File modification ---
  chmod: { level: 'medium', categories: ['file_modification'], modifiesFilesystem: true, accessesNetwork: false, readOnly: false },
  chown: { level: 'medium', categories: ['file_modification'], modifiesFilesystem: true, accessesNetwork: false, readOnly: false },
  chgrp: { level: 'medium', categories: ['file_modification'], modifiesFilesystem: true, accessesNetwork: false, readOnly: false },
  mv: { level: 'medium', categories: ['file_modification'], modifiesFilesystem: true, accessesNetwork: false, readOnly: false },
  cp: { level: 'low', categories: ['file_modification'], modifiesFilesystem: true, accessesNetwork: false, readOnly: false },
  mkdir: { level: 'low', categories: ['file_modification'], modifiesFilesystem: true, accessesNetwork: false, readOnly: false },
  touch: { level: 'low', categories: ['file_modification'], modifiesFilesystem: true, accessesNetwork: false, readOnly: false },
  ln: { level: 'low', categories: ['file_modification'], modifiesFilesystem: true, accessesNetwork: false, readOnly: false },
  install: { level: 'low', categories: ['file_modification'], modifiesFilesystem: true, accessesNetwork: false, readOnly: false },
  tee: { level: 'medium', categories: ['file_modification'], modifiesFilesystem: true, accessesNetwork: false, readOnly: false },

  // --- Privilege escalation ---
  sudo: { level: 'high', categories: ['privilege_escalation'], modifiesFilesystem: false, accessesNetwork: false, readOnly: false },
  doas: { level: 'high', categories: ['privilege_escalation'], modifiesFilesystem: false, accessesNetwork: false, readOnly: false },
  run0: { level: 'high', categories: ['privilege_escalation'], modifiesFilesystem: false, accessesNetwork: false, readOnly: false },
  su: { level: 'high', categories: ['privilege_escalation'], modifiesFilesystem: false, accessesNetwork: false, readOnly: false },
  pkexec: { level: 'high', categories: ['privilege_escalation'], modifiesFilesystem: false, accessesNetwork: false, readOnly: false },

  // --- Network access ---
  curl: { level: 'low', categories: ['network_access'], modifiesFilesystem: false, accessesNetwork: true, readOnly: true },
  wget: { level: 'low', categories: ['network_access'], modifiesFilesystem: false, accessesNetwork: true, readOnly: true },
  nc: { level: 'medium', categories: ['network_access'], modifiesFilesystem: false, accessesNetwork: true, readOnly: false },
  ncat: { level: 'medium', categories: ['network_access'], modifiesFilesystem: false, accessesNetwork: true, readOnly: false },
  ssh: { level: 'medium', categories: ['network_access'], modifiesFilesystem: false, accessesNetwork: true, readOnly: false },
  scp: { level: 'medium', categories: ['network_access', 'data_exfiltration'], modifiesFilesystem: false, accessesNetwork: true, readOnly: false },
  rsync: { level: 'medium', categories: ['network_access', 'data_exfiltration'], modifiesFilesystem: true, accessesNetwork: true, readOnly: false },
  ftp: { level: 'medium', categories: ['network_access'], modifiesFilesystem: false, accessesNetwork: true, readOnly: false },

  // --- Code execution ---
  bash: { level: 'medium', categories: ['code_execution'], modifiesFilesystem: false, accessesNetwork: false, readOnly: false },
  sh: { level: 'medium', categories: ['code_execution'], modifiesFilesystem: false, accessesNetwork: false, readOnly: false },
  zsh: { level: 'medium', categories: ['code_execution'], modifiesFilesystem: false, accessesNetwork: false, readOnly: false },
  eval: { level: 'high', categories: ['code_execution'], modifiesFilesystem: false, accessesNetwork: false, readOnly: false },
  exec: { level: 'high', categories: ['code_execution'], modifiesFilesystem: false, accessesNetwork: false, readOnly: false },
  source: { level: 'low', categories: ['code_execution'], modifiesFilesystem: false, accessesNetwork: false, readOnly: false },
  python3: { level: 'medium', categories: ['code_execution'], modifiesFilesystem: false, accessesNetwork: false, readOnly: false },
  python: { level: 'medium', categories: ['code_execution'], modifiesFilesystem: false, accessesNetwork: false, readOnly: false },
  node: { level: 'medium', categories: ['code_execution'], modifiesFilesystem: false, accessesNetwork: false, readOnly: false },
  perl: { level: 'medium', categories: ['code_execution'], modifiesFilesystem: false, accessesNetwork: false, readOnly: false },
  ruby: { level: 'medium', categories: ['code_execution'], modifiesFilesystem: false, accessesNetwork: false, readOnly: false },

  // --- System modification ---
  systemctl: { level: 'high', categories: ['system_modification'], modifiesFilesystem: true, accessesNetwork: false, readOnly: false },
  service: { level: 'high', categories: ['system_modification'], modifiesFilesystem: true, accessesNetwork: false, readOnly: false },
  sysctl: { level: 'high', categories: ['system_modification'], modifiesFilesystem: true, accessesNetwork: false, readOnly: false },
  iptables: { level: 'high', categories: ['system_modification'], modifiesFilesystem: false, accessesNetwork: true, readOnly: false },
  mount: { level: 'medium', categories: ['system_modification'], modifiesFilesystem: true, accessesNetwork: false, readOnly: false },
  umount: { level: 'medium', categories: ['system_modification'], modifiesFilesystem: true, accessesNetwork: false, readOnly: false },
  fdisk: { level: 'critical', categories: ['system_modification'], modifiesFilesystem: true, accessesNetwork: false, readOnly: false },

  // --- Resource abuse ---
  dd: { level: 'high', categories: ['resource_abuse'], modifiesFilesystem: true, accessesNetwork: false, readOnly: false },
  mkfs: { level: 'critical', categories: ['resource_abuse'], modifiesFilesystem: true, accessesNetwork: false, readOnly: false },

  // --- Environment tampering ---
  export: { level: 'low', categories: ['environment_tampering'], modifiesFilesystem: false, accessesNetwork: false, readOnly: false },
  set: { level: 'low', categories: ['environment_tampering'], modifiesFilesystem: false, accessesNetwork: false, readOnly: true },
  unset: { level: 'low', categories: ['environment_tampering'], modifiesFilesystem: false, accessesNetwork: false, readOnly: false },

  // --- Information disclosure ---
  echo: { level: 'safe', categories: ['none'], modifiesFilesystem: false, accessesNetwork: false, readOnly: true },
  printf: { level: 'safe', categories: ['none'], modifiesFilesystem: false, accessesNetwork: false, readOnly: true },
  cat: { level: 'safe', categories: ['none'], modifiesFilesystem: false, accessesNetwork: false, readOnly: true },
  less: { level: 'safe', categories: ['none'], modifiesFilesystem: false, accessesNetwork: false, readOnly: true },
  more: { level: 'safe', categories: ['none'], modifiesFilesystem: false, accessesNetwork: false, readOnly: true },
  head: { level: 'safe', categories: ['none'], modifiesFilesystem: false, accessesNetwork: false, readOnly: true },
  tail: { level: 'safe', categories: ['none'], modifiesFilesystem: false, accessesNetwork: false, readOnly: true },
  wc: { level: 'safe', categories: ['none'], modifiesFilesystem: false, accessesNetwork: false, readOnly: true },
  file: { level: 'safe', categories: ['none'], modifiesFilesystem: false, accessesNetwork: false, readOnly: true },
  stat: { level: 'safe', categories: ['none'], modifiesFilesystem: false, accessesNetwork: false, readOnly: true },
  du: { level: 'safe', categories: ['none'], modifiesFilesystem: false, accessesNetwork: false, readOnly: true },
  df: { level: 'safe', categories: ['none'], modifiesFilesystem: false, accessesNetwork: false, readOnly: true },

  // --- Read-only search tools ---
  grep: { level: 'safe', categories: ['none'], modifiesFilesystem: false, accessesNetwork: false, readOnly: true },
  find: { level: 'safe', categories: ['none'], modifiesFilesystem: false, accessesNetwork: false, readOnly: true },
  which: { level: 'safe', categories: ['none'], modifiesFilesystem: false, accessesNetwork: false, readOnly: true },
  whereis: { level: 'safe', categories: ['none'], modifiesFilesystem: false, accessesNetwork: false, readOnly: true },
  type: { level: 'safe', categories: ['none'], modifiesFilesystem: false, accessesNetwork: false, readOnly: true },

  // --- Git (mostly read-only) ---
  git: { level: 'low', categories: ['none'], modifiesFilesystem: true, accessesNetwork: true, readOnly: false },

  // --- Package managers ---
  apt: { level: 'high', categories: ['system_modification'], modifiesFilesystem: true, accessesNetwork: true, readOnly: false },
  'apt-get': { level: 'high', categories: ['system_modification'], modifiesFilesystem: true, accessesNetwork: true, readOnly: false },
  yum: { level: 'high', categories: ['system_modification'], modifiesFilesystem: true, accessesNetwork: true, readOnly: false },
  dnf: { level: 'high', categories: ['system_modification'], modifiesFilesystem: true, accessesNetwork: true, readOnly: false },
  npm: { level: 'medium', categories: ['system_modification'], modifiesFilesystem: true, accessesNetwork: true, readOnly: false },
  pnpm: { level: 'medium', categories: ['system_modification'], modifiesFilesystem: true, accessesNetwork: true, readOnly: false },
  yarn: { level: 'medium', categories: ['system_modification'], modifiesFilesystem: true, accessesNetwork: true, readOnly: false },

  // --- Text processing (read-only by default) ---
  sed: { level: 'medium', categories: ['file_modification'], modifiesFilesystem: false, accessesNetwork: false, readOnly: false },
  awk: { level: 'medium', categories: ['code_execution'], modifiesFilesystem: false, accessesNetwork: false, readOnly: false },
  sort: { level: 'safe', categories: ['none'], modifiesFilesystem: false, accessesNetwork: false, readOnly: true },
  uniq: { level: 'safe', categories: ['none'], modifiesFilesystem: false, accessesNetwork: false, readOnly: true },
  cut: { level: 'safe', categories: ['none'], modifiesFilesystem: false, accessesNetwork: false, readOnly: true },
  tr: { level: 'safe', categories: ['none'], modifiesFilesystem: false, accessesNetwork: false, readOnly: true },
  xargs: { level: 'medium', categories: ['code_execution'], modifiesFilesystem: false, accessesNetwork: false, readOnly: false },
  jq: { level: 'safe', categories: ['none'], modifiesFilesystem: false, accessesNetwork: false, readOnly: true },

  // --- Docker/container ---
  docker: { level: 'medium', categories: ['code_execution', 'privilege_escalation'], modifiesFilesystem: true, accessesNetwork: true, readOnly: false },
  podman: { level: 'medium', categories: ['code_execution', 'privilege_escalation'], modifiesFilesystem: true, accessesNetwork: true, readOnly: false },

  // --- Crontab (persistence) ---
  crontab: { level: 'high', categories: ['persistence'], modifiesFilesystem: true, accessesNetwork: false, readOnly: false },
};

/**
 * Dangerous flag patterns that escalate risk.
 */
const DANGEROUS_FLAGS: Record<string, Array<{
  flags: string[];
  escalateTo: RiskLevel;
  category: RiskCategory;
  description: string;
}>> = {
  rm: [
    { flags: ['-r', '-rf', '-fr', '-R', '-rR'], escalateTo: 'critical', category: 'file_destruction', description: 'Recursive deletion' },
    { flags: ['-f', '--force'], escalateTo: 'high', category: 'file_destruction', description: 'Force deletion' },
  ],
  curl: [
    { flags: ['--upload-file', '-T', '-X POST', '-X PUT', '--data', '--data-binary'], escalateTo: 'high', category: 'data_exfiltration', description: 'Data upload via curl' },
  ],
  wget: [
    { flags: ['--post-data', '--post-file'], escalateTo: 'high', category: 'data_exfiltration', description: 'Data upload via wget' },
  ],
  chmod: [
    { flags: ['777', 'a+rw', 'u+s', 'g+s'], escalateTo: 'high', category: 'file_modification', description: 'Overly permissive permissions' },
  ],
  find: [
    { flags: ['-delete', '--exec', '-exec'], escalateTo: 'high', category: 'file_destruction', description: 'Find with destructive action' },
  ],
};

/**
 * Blocked patterns (always blocked regardless of allowlist).
 */
const BLOCKED_PATTERNS: Array<{
  pattern: RegExp;
  category: RiskCategory;
  description: string;
}> = [
  // Fork bombs
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:&\s*\}\s*;?\s*:/, category: 'resource_abuse', description: 'Fork bomb' },
  { pattern: /fork\s+bomb/i, category: 'resource_abuse', description: 'Fork bomb reference' },

  // Destructive rm
  { pattern: /\brm\s+(-\w*r\w*f\w*|--force)\s+\/\s*$/, category: 'file_destruction', description: 'rm -rf /' },
  { pattern: /\brm\s+(-\w*r\w*f\w*|--force)\s+\/\*/, category: 'file_destruction', description: 'rm -rf /*' },

  // Network pipe to shell
  { pattern: /\b(curl|wget)\s+.*\|\s*(ba)?sh/, category: 'code_execution', description: 'Pipe network content to shell' },

  // LD_PRELOAD
  { pattern: /LD_PRELOAD/, category: 'environment_tampering', description: 'LD_PRELOAD injection' },

  // Protected files
  { pattern: />\s*\/etc\/passwd/, category: 'information_disclosure', description: 'Write to /etc/passwd' },
  { pattern: />\s*\/etc\/shadow/, category: 'information_disclosure', description: 'Write to /etc/shadow' },
  { pattern: />\s*\/etc\/sudoers/, category: 'privilege_escalation', description: 'Write to /etc/sudoers' },

  // Disk wipe
  { pattern: /\bdd\s+if=\/dev\/(zero|urandom|random)/, category: 'resource_abuse', description: 'dd disk overwrite' },
  { pattern: /\bmkfs/, category: 'file_destruction', description: 'Format filesystem' },

  // Container escape attempts
  { pattern: /\bnsenter\s+--mount/, category: 'container_escape', description: 'Namespace escape' },
  { pattern: /\bdocker\s+(exec|run).*--privileged/, category: 'container_escape', description: 'Privileged container access' },
];

// ---------------------------------------------------------------------------
// Bash AST Parser
// ---------------------------------------------------------------------------

/**
 * Parses bash commands into AST nodes and performs structural risk analysis.
 *
 * The parser is deliberately conservative — it prefers to classify something
 * as risky rather than safe. Unknown commands default to 'medium' risk.
 */
export class BashASTParser {
  private config: BashParserConfig;

  constructor(config?: Partial<BashParserConfig>) {
    this.config = { ...DEFAULT_BASH_PARSER_CONFIG, ...config };
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Parse and validate a bash command.
   * Returns a full validation result with AST, risk assessment, and flags.
   */
  parse(command: string): BashValidationResult {
    const trimmed = command.trim();

    // Empty command
    if (!trimmed) {
      return {
        valid: true,
        risk: {
          level: 'safe',
          categories: ['none'],
          explanation: 'Empty command',
          blocked: false,
          requiresApproval: false,
          confidence: 1.0,
          patterns: [],
          suggestions: [],
        },
        ast: { type: 'empty', raw: command, start: 0, end: command.length },
        warnings: [],
        errors: [],
        isReadOnly: true,
        estimatedTime: 'instant',
        hasPipes: false,
        hasRedirects: false,
        hasSubstitution: false,
        isPrivileged: false,
        modifiesFilesystem: false,
        accessesNetwork: false,
      };
    }

    // Length check
    if (trimmed.length > this.config.maxCommandLength) {
      return {
        valid: false,
        risk: {
          level: 'high',
          categories: ['code_execution'],
          explanation: `Command exceeds maximum length (${trimmed.length} > ${this.config.maxCommandLength})`,
          blocked: false,
          requiresApproval: true,
          confidence: 1.0,
          patterns: [{ pattern: 'max_length', category: 'code_execution', description: 'Command too long', matched: trimmed.slice(0, 50) }],
          suggestions: ['Break the command into smaller parts'],
        },
        warnings: [`Command length ${trimmed.length} exceeds maximum ${this.config.maxCommandLength}`],
        errors: ['Command too long'],
        isReadOnly: false,
        estimatedTime: 'unknown',
        hasPipes: trimmed.includes('|'),
        hasRedirects: /[<>]/.test(trimmed),
        hasSubstitution: /\$\(/.test(trimmed) || /`/.test(trimmed),
        isPrivileged: /\b(sudo|doas|run0)\b/.test(trimmed),
        modifiesFilesystem: false,
        accessesNetwork: false,
      };
    }

    // Parse into AST
    const ast = this.parseToAST(trimmed);

    // Analyze risk
    const risk = this.assessRisk(trimmed, ast);

    // Check blocked patterns
    const blockedPatterns = this.checkBlockedPatterns(trimmed);
    if (blockedPatterns.length > 0) {
      risk.level = 'critical';
      risk.blocked = true;
      risk.patterns.push(...blockedPatterns);
      risk.categories = [...new Set([...risk.categories, ...blockedPatterns.map((p) => p.category)])];
    }

    // Determine flags
    const hasPipes = trimmed.includes('|');
    const hasRedirects = /[<>]{1,2}/.test(trimmed) && !/[<>]=/.test(trimmed);
    const hasSubstitution = /\$\(/.test(trimmed) || /`[^`]+`/.test(trimmed);
    const isPrivileged = /\b(sudo|doas|run0)\b/.test(trimmed);

    // Check if read-only
    const isReadOnly = this.isReadOnlyCommand(trimmed, ast);

    // Check filesystem/network effects
    const { modifiesFilesystem, accessesNetwork } = this.analyzeEffects(trimmed, ast);

    // Estimate time
    const estimatedTime = this.estimateExecutionTime(trimmed);

    // Determine validity
    const valid = !risk.blocked;
    const errors: string[] = [];
    const warnings: string[] = [];

    if (risk.blocked) {
      errors.push(`Command blocked: ${risk.explanation}`);
    }
    if (risk.requiresApproval && !risk.blocked) {
      warnings.push(`Command requires approval: ${risk.explanation}`);
    }
    if (isPrivileged) {
      warnings.push('Command runs with elevated privileges');
    }

    return {
      valid,
      risk,
      ast,
      warnings,
      errors,
      isReadOnly,
      estimatedTime,
      hasPipes,
      hasRedirects,
      hasSubstitution,
      isPrivileged,
      modifiesFilesystem,
      accessesNetwork,
    };
  }

  /**
   * Quick check if a command is safe to execute without approval.
   */
  isSafe(command: string): boolean {
    const result = this.parse(command);
    return result.valid && !result.risk.requiresApproval && result.risk.level === 'safe';
  }

  /**
   * Quick check if a command is read-only (doesn't modify filesystem or network).
   */
  isReadOnly(command: string): boolean {
    return this.parse(command).isReadOnly;
  }

  /**
   * Get the risk level for a command.
   */
  getRiskLevel(command: string): RiskLevel {
    return this.parse(command).risk.level;
  }

  // ---------------------------------------------------------------------------
  // AST Parsing (simplified structural analysis)
  // ---------------------------------------------------------------------------

  /**
   * Parse a command string into a simplified AST.
   *
   * This is NOT a full bash parser — it handles common patterns:
   * - Simple commands
   * - Pipelines (cmd1 | cmd2)
   * - AND lists (cmd1 && cmd2)
   * - OR lists (cmd1 || cmd2)
   * - Sequential commands (cmd1; cmd2)
   * - Background jobs (cmd &)
   * - Redirections (>, >>, <, 2>)
   * - Command substitution ($() or ``)
   * - Subshells ((...))
   * - Variable assignments (X=1 cmd)
   *
   * For complex bash syntax (case statements, function definitions, heredocs
   * with complex delimiters), the parser falls back to 'unknown' nodes.
   */
  private parseToAST(command: string): BashASTNode {
    const trimmed = command.trim();

    // Sequential commands (cmd1; cmd2)
    if (trimmed.includes(';') && !trimmed.startsWith('(')) {
      const parts = this.splitRespectingQuotes(trimmed, ';');
      if (parts.length > 1) {
        return {
          type: 'sequence',
          raw: trimmed,
          start: 0,
          end: trimmed.length,
          commands: parts.map((p) => this.parseToAST(p.trim())).filter((n) => n.type !== 'empty'),
        } as SequenceNode;
      }
    }

    // AND list (cmd1 && cmd2)
    if (trimmed.includes('&&')) {
      const parts = this.splitRespectingQuotes(trimmed, '&&');
      if (parts.length > 1) {
        let node: BashASTNode = this.parseToAST(parts[0].trim());
        for (let i = 1; i < parts.length; i++) {
          node = {
            type: 'and_list',
            raw: parts.slice(0, i + 1).join(' && '),
            start: 0,
            end: trimmed.length,
            left: node,
            right: this.parseToAST(parts[i].trim()),
          } as AndListNode;
        }
        return node;
      }
    }

    // OR list (cmd1 || cmd2)
    if (trimmed.includes('||')) {
      const parts = this.splitRespectingQuotes(trimmed, '||');
      if (parts.length > 1) {
        let node: BashASTNode = this.parseToAST(parts[0].trim());
        for (let i = 1; i < parts.length; i++) {
          node = {
            type: 'or_list',
            raw: parts.slice(0, i + 1).join(' || '),
            start: 0,
            end: trimmed.length,
            left: node,
            right: this.parseToAST(parts[i].trim()),
          } as OrListNode;
        }
        return node;
      }
    }

    // Pipeline (cmd1 | cmd2)
    if (trimmed.includes('|') && !trimmed.includes('||')) {
      // Check for || (OR list) vs | (pipe)
      const pipeParts = this.splitRespectingQuotes(trimmed, '|').filter((p) => p.trim());
      if (pipeParts.length > 1) {
        return {
          type: 'pipeline',
          raw: trimmed,
          start: 0,
          end: trimmed.length,
          commands: pipeParts.map((p) => this.parseToAST(p.trim())),
          negated: trimmed.startsWith('! '),
        } as PipelineNode;
      }
    }

    // Background job (cmd &)
    if (trimmed.endsWith('&') && !trimmed.includes('&&')) {
      return {
        type: 'background',
        raw: trimmed,
        start: 0,
        end: trimmed.length,
        command: this.parseToAST(trimmed.slice(0, -1).trim()),
      } as BackgroundNode;
    }

    // Subshell ((...))
    if (trimmed.startsWith('(') && trimmed.endsWith(')')) {
      return {
        type: 'subshell',
        raw: trimmed,
        start: 0,
        end: trimmed.length,
        body: this.parseToAST(trimmed.slice(1, -1).trim()),
      } as SubshellNode;
    }

    // Simple command
    return this.parseSimpleCommand(trimmed);
  }

  /**
   * Parse a simple command into a CommandNode.
   */
  // Returns the base node type because an all-whitespace input yields an
  // 'empty' node, which is not a CommandNode (the sole caller, parseToAST,
  // returns BashASTNode anyway).
  private parseSimpleCommand(command: string): BashASTNode {
    const tokens = this.tokenize(command);
    if (tokens.length === 0) {
      const empty: BashASTNode = {
        type: 'empty',
        raw: command,
        start: 0,
        end: command.length,
      };
      return empty;
    }

    // Extract prefix assignments (VAR=value before command)
    const prefixAssignments: Array<{ key: string; value: string }> = [];
    let cmdIndex = 0;
    while (cmdIndex < tokens.length && tokens[cmdIndex].includes('=')) {
      const eqIndex = tokens[cmdIndex].indexOf('=');
      if (eqIndex > 0) {
        prefixAssignments.push({
          key: tokens[cmdIndex].slice(0, eqIndex),
          value: tokens[cmdIndex].slice(eqIndex + 1),
        });
        cmdIndex++;
      } else {
        break;
      }
    }

    // Extract command name
    const cmd = tokens[cmdIndex] ?? '';
    const args = tokens.slice(cmdIndex + 1);

    // Check for redirects
    const redirects = this.extractRedirects(args);

    // Check for privilege escalation
    const isPrivileged = /^(sudo|doas|run0|pkexec|su)$/.test(cmd);

    // Check for background
    const isBackground = args.length > 0 && args[args.length - 1] === '&';

    const node: CommandNode = {
      type: 'command',
      raw: command,
      start: 0,
      end: command.length,
      command: isPrivileged && args.length > 0 ? args[0] : cmd,
      args: isPrivileged ? args.slice(1) : args,
      prefixAssignments,
      redirects,
      isPrivileged,
      isBackground,
    };
    return node;
  }

  // ---------------------------------------------------------------------------
  // Risk Assessment
  // ---------------------------------------------------------------------------

  /**
   * Assess the risk of a command based on its AST.
   */
  private assessRisk(command: string, ast: BashASTNode): RiskAssessment {
    const patterns: RiskPattern[] = [];
    const categories = new Set<RiskCategory>();
    let maxLevel: RiskLevel = 'safe';
    let modifiesFilesystem = false;
    let accessesNetwork = false;

    // Walk the AST and assess each node
    const walkResults = this.walkAST(ast);
    for (const result of walkResults) {
      if (result.riskLevel !== 'safe') {
        const levelOrder: RiskLevel[] = ['safe', 'low', 'medium', 'high', 'critical'];
        const currentIdx = levelOrder.indexOf(maxLevel);
        const resultIdx = levelOrder.indexOf(result.riskLevel);
        if (resultIdx > currentIdx) {
          maxLevel = result.riskLevel;
        }
      }
      for (const cat of result.categories) {
        categories.add(cat);
      }
      for (const pat of result.patterns) {
        patterns.push(pat);
      }
      if (result.modifiesFilesystem) modifiesFilesystem = true;
      if (result.accessesNetwork) accessesNetwork = true;
    }

    // Check dangerous flags
    const flagPatterns = this.checkDangerousFlags(command);
    for (const pat of flagPatterns) {
      patterns.push(pat);
      categories.add(pat.category);
      const levelOrder: RiskLevel[] = ['safe', 'low', 'medium', 'high', 'critical'];
      const currentIdx = levelOrder.indexOf(maxLevel);
      const patternIdx = levelOrder.indexOf(pat.escalateTo ?? 'medium');
      if (patternIdx > currentIdx) {
        maxLevel = pat.escalateTo ?? 'medium';
      }
    }

    // Escalate for privilege escalation
    if (/\b(sudo|doas|run0)\b/.test(command)) {
      categories.add('privilege_escalation');
      const levelOrder: RiskLevel[] = ['safe', 'low', 'medium', 'high', 'critical'];
      if (levelOrder.indexOf(maxLevel) < levelOrder.indexOf('high')) {
        maxLevel = 'high';
      }
    }

    // Escalate for command substitution
    if (/\$\(/.test(command) || /`[^`]+`/.test(command)) {
      categories.add('code_execution');
    }

    // Determine if blocked/requires approval
    const thresholdOrder: RiskLevel[] = ['safe', 'low', 'medium', 'high', 'critical'];
    const blocked = thresholdOrder.indexOf(maxLevel) >= thresholdOrder.indexOf(this.config.riskThresholds.blocked);
    const requiresApproval = thresholdOrder.indexOf(maxLevel) >= thresholdOrder.indexOf(this.config.riskThresholds.approvalRequired);

    // Generate explanation
    const explanation = this.generateExplanation(command, maxLevel, categories, patterns);

    // Generate suggestions
    const suggestions = this.generateSuggestions(command, maxLevel, patterns);

    // Calculate confidence
    const confidence = this.calculateConfidence(command, ast);

    return {
      level: maxLevel,
      categories: Array.from(categories),
      explanation,
      blocked,
      requiresApproval,
      confidence,
      patterns,
      suggestions,
    };
  }

  /**
   * Walk the AST and collect risk assessments from each node.
   */
  private walkAST(node: BashASTNode): Array<{
    riskLevel: RiskLevel;
    categories: RiskCategory[];
    patterns: RiskPattern[];
    modifiesFilesystem: boolean;
    accessesNetwork: boolean;
  }> {
    const results: Array<{
      riskLevel: RiskLevel;
      categories: RiskCategory[];
      patterns: RiskPattern[];
      modifiesFilesystem: boolean;
      accessesNetwork: boolean;
    }> = [];

    switch (node.type) {
      case 'command': {
        const cmd = node as CommandNode;
        // For privileged commands (sudo, doas, etc.), the actual command is the first arg
        const effectiveCommand = cmd.isPrivileged && cmd.args.length > 0
          ? cmd.args[0]
          : cmd.command;
        const cmdRisk = COMMAND_RISK_MAP[effectiveCommand] ?? COMMAND_RISK_MAP[cmd.command];
        if (cmdRisk) {
          results.push({
            riskLevel: cmdRisk.level,
            categories: cmdRisk.categories,
            patterns: [],
            modifiesFilesystem: cmdRisk.modifiesFilesystem,
            accessesNetwork: cmdRisk.accessesNetwork,
          });
        } else {
          // Unknown command — medium risk
          results.push({
            riskLevel: 'medium',
            categories: ['code_execution'],
            patterns: [{ pattern: effectiveCommand, category: 'code_execution', description: `Unknown command: ${effectiveCommand}`, matched: effectiveCommand }],
            modifiesFilesystem: false,
            accessesNetwork: false,
          });
        }
        // If privileged, also add privilege escalation
        if (cmd.isPrivileged) {
          results.push({
            riskLevel: 'high',
            categories: ['privilege_escalation'],
            patterns: [{ pattern: cmd.command, category: 'privilege_escalation', description: `Privilege escalation via ${cmd.command}`, matched: cmd.command }],
            modifiesFilesystem: false,
            accessesNetwork: false,
          });
        }
        break;
      }
      case 'pipeline': {
        const pipe = node as PipelineNode;
        for (const child of pipe.commands) {
          results.push(...this.walkAST(child));
        }
        break;
      }
      case 'and_list':
      case 'or_list': {
        const list = node as AndListNode | OrListNode;
        results.push(...this.walkAST(list.left));
        results.push(...this.walkAST(list.right));
        break;
      }
      case 'sequence': {
        const seq = node as SequenceNode;
        for (const child of seq.commands) {
          results.push(...this.walkAST(child));
        }
        break;
      }
      case 'subshell': {
        const sub = node as SubshellNode;
        if (sub.body) results.push(...this.walkAST(sub.body));
        break;
      }
      case 'background': {
        const bg = node as BackgroundNode;
        if (bg.command) results.push(...this.walkAST(bg.command));
        break;
      }
      default:
        // For unknown or other node types, assess the raw command
        break;
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // Helper Methods
  // ---------------------------------------------------------------------------

  /**
   * Check blocked patterns against a command.
   */
  private checkBlockedPatterns(command: string): RiskPattern[] {
    const patterns: RiskPattern[] = [];
    for (const bp of BLOCKED_PATTERNS) {
      if (bp.pattern.test(command)) {
        patterns.push({
          pattern: bp.pattern.source,
          category: bp.category,
          description: bp.description,
          matched: command.slice(0, 100),
        });
      }
    }

    // Check config-defined blocked patterns
    for (const pattern of this.config.alwaysBlockedPatterns) {
      try {
        const regex = new RegExp(pattern);
        if (regex.test(command)) {
          patterns.push({
            pattern,
            category: 'code_execution',
            description: `Blocked pattern: ${pattern}`,
            matched: command.slice(0, 100),
          });
        }
      } catch {
        // Invalid regex — skip
      }
    }

    return patterns;
  }

  /**
   * Check dangerous flags for known commands.
   */
  private checkDangerousFlags(command: string): RiskPattern[] {
    const patterns: RiskPattern[] = [];

    // Extract command name
    const tokens = this.tokenize(command);
    if (tokens.length === 0) return patterns;

    const cmdName = tokens[0];
    const flagRules = DANGEROUS_FLAGS[cmdName];
    if (!flagRules) return patterns;

    for (const rule of flagRules) {
      for (const flag of rule.flags) {
        if (command.includes(flag)) {
          patterns.push({
            pattern: `${cmdName} ${flag}`,
            category: rule.category,
            description: rule.description,
            matched: `${cmdName} ${flag}`,
            alternative: undefined,
          });
        }
      }
    }

    return patterns;
  }

  /**
   * Determine if a command is read-only.
   */
  private isReadOnlyCommand(command: string, ast: BashASTNode): boolean {
    // Walk the AST and check if ALL commands are read-only
    const walkReadOnly = (node: BashASTNode): boolean => {
      switch (node.type) {
        case 'command': {
          const cmd = node as CommandNode;
          // Check if command writes to files via redirections
          const hasWriteRedirect = cmd.redirects.some(
            (r) => ['write', 'append', 'dup_write'].includes(r.redirectType),
          );
          if (hasWriteRedirect) return false;

          // For privileged commands, check the effective command (first arg)
          const effectiveCommand = cmd.isPrivileged && cmd.args.length > 0
            ? cmd.args[0]
            : cmd.command;

          // Check against known command risk map
          const cmdRisk = COMMAND_RISK_MAP[effectiveCommand] ?? COMMAND_RISK_MAP[cmd.command];
          if (cmdRisk) return cmdRisk.readOnly;

          // Privileged commands are never read-only
          if (cmd.isPrivileged) return false;

          // Unknown commands are not read-only
          return false;
        }
        case 'pipeline': {
          const pipe = node as PipelineNode;
          // A pipeline is read-only only if ALL stages are read-only
          return pipe.commands.every(walkReadOnly);
        }
        case 'and_list':
        case 'or_list': {
          const list = node as AndListNode | OrListNode;
          return walkReadOnly(list.left) && walkReadOnly(list.right);
        }
        case 'sequence': {
          const seq = node as SequenceNode;
          return seq.commands.every(walkReadOnly);
        }
        case 'background': {
          const bg = node as BackgroundNode;
          return bg.command ? walkReadOnly(bg.command) : false;
        }
        default:
          return false;
      }
    };

    return walkReadOnly(ast);
  }

  /**
   * Analyze filesystem and network effects of a command.
   */
  private analyzeEffects(
    command: string,
    ast: BashASTNode,
  ): { modifiesFilesystem: boolean; accessesNetwork: boolean } {
    let modifiesFilesystem = false;
    let accessesNetwork = false;

    const walkEffects = (node: BashASTNode): void => {
      switch (node.type) {
        case 'command': {
          const cmd = node as CommandNode;
          // Check write redirects
          const hasWriteRedirect = cmd.redirects.some(
            (r) => ['write', 'append', 'dup_write'].includes(r.redirectType),
          );
          if (hasWriteRedirect) modifiesFilesystem = true;

          // For privileged commands, check the effective command (first arg)
          const effectiveCommand = cmd.isPrivileged && cmd.args.length > 0
            ? cmd.args[0]
            : cmd.command;
          const cmdRisk = COMMAND_RISK_MAP[effectiveCommand] ?? COMMAND_RISK_MAP[cmd.command];
          if (cmdRisk) {
            if (cmdRisk.modifiesFilesystem) modifiesFilesystem = true;
            if (cmdRisk.accessesNetwork) accessesNetwork = true;
          }
          break;
        }
        case 'pipeline': {
          const pipe = node as PipelineNode;
          for (const child of pipe.commands) walkEffects(child);
          break;
        }
        case 'and_list':
        case 'or_list': {
          const list = node as AndListNode | OrListNode;
          walkEffects(list.left);
          walkEffects(list.right);
          break;
        }
        case 'sequence': {
          const seq = node as SequenceNode;
          for (const child of seq.commands) walkEffects(child);
          break;
        }
      }
    };

    walkEffects(ast);

    // Also check the raw command for write redirections
    if (/>>?\s*\S/.test(command)) modifiesFilesystem = true;

    return { modifiesFilesystem, accessesNetwork };
  }

  /**
   * Estimate execution time based on command characteristics.
   */
  private estimateExecutionTime(command: string): 'instant' | 'fast' | 'moderate' | 'slow' | 'unknown' {
    // Long pipelines or complex commands are slower
    if (command.includes('|') && command.includes('|')) return 'moderate';
    if (command.includes('&&') && command.includes('&&')) return 'fast';

    // Network commands are typically slower
    if (/\b(curl|wget|scp|rsync|ssh|ftp)\b/.test(command)) return 'moderate';
    if (/\b(docker|podman)\b/.test(command)) return 'moderate';

    // Package managers are slow
    if (/\b(apt|apt-get|yum|dnf|npm|pnpm|yarn|cargo|pip)\b/.test(command)) return 'slow';

    // Find over large directories is slow
    if (/\bfind\b/.test(command) && /\b-exec\b/.test(command)) return 'slow';

    // Simple read-only commands are instant
    if (/\b(ls|cat|head|tail|grep|wc|pwd|echo|date|whoami)\b/.test(command)) return 'instant';

    // Default
    return 'fast';
  }

  /**
   * Generate a human-readable explanation for a risk assessment.
   */
  private generateExplanation(
    command: string,
    level: RiskLevel,
    categories: Set<RiskCategory>,
    patterns: RiskPattern[],
  ): string {
    const catList = Array.from(categories).filter((c) => c !== 'none');
    if (catList.length === 0 && level === 'safe') {
      return 'Command appears safe — standard read-only operation.';
    }

    const levelDescriptions: Record<RiskLevel, string> = {
      safe: 'Safe command',
      low: 'Low-risk command',
      medium: 'Moderate-risk command',
      high: 'High-risk command',
      critical: 'Critical-risk command — potentially destructive',
    };

    const parts = [levelDescriptions[level]];

    if (catList.length > 0) {
      parts.push(`categories: ${catList.join(', ')}`);
    }

    if (patterns.length > 0) {
      parts.push(`patterns: ${patterns.map((p) => p.description).join('; ')}`);
    }

    return parts.join(' — ');
  }

  /**
   * Generate safer alternative suggestions.
   */
  private generateSuggestions(
    command: string,
    level: RiskLevel,
    patterns: RiskPattern[],
  ): string[] {
    const suggestions: string[] = [];

    if (/\brm\s+-/.test(command) && /\brf\b/.test(command)) {
      suggestions.push('Use rm without -f to be prompted before each deletion');
      suggestions.push('Consider using trash-cli instead of rm for recoverable deletion');
    }

    if (/\bsudo\b/.test(command)) {
      suggestions.push('Run without sudo if possible');
    }

    if (/\bcurl.*\|.*sh\b/.test(command) || /\bwget.*\|.*sh\b/.test(command)) {
      suggestions.push('Download the script first, review it, then execute');
      suggestions.push('Use curl --fail to handle HTTP errors');
    }

    if (/\bdd\s/.test(command)) {
      suggestions.push('Double-check dd arguments — typos can destroy data');
      suggestions.push('Consider using a safer alternative like cp for file copying');
    }

    if (/>\s*\//.test(command)) {
      suggestions.push('Writing to absolute paths is risky — verify the target');
    }

    if (level === 'critical') {
      suggestions.push('This command is classified as critical risk — manual review recommended');
    }

    return suggestions;
  }

  /**
   * Calculate confidence in the risk assessment.
   */
  private calculateConfidence(command: string, ast: BashASTNode): number {
    // High confidence for known commands
    if (ast.type === 'command') {
      const cmd = ast as CommandNode;
      if (COMMAND_RISK_MAP[cmd.command]) return 0.95;
    }

    // Medium confidence for pipelines and lists
    if (ast.type === 'pipeline' || ast.type === 'sequence' || ast.type === 'and_list' || ast.type === 'or_list') {
      return 0.85;
    }

    // Lower confidence for complex structures
    if (ast.type === 'unknown') return 0.4;

    // Default
    return 0.7;
  }

  // ---------------------------------------------------------------------------
  // Tokenizer
  // ---------------------------------------------------------------------------

  /**
   * Tokenize a command string, respecting quotes and escapes.
   */
  private tokenize(command: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let escaped = false;

    for (let i = 0; i < command.length; i++) {
      const ch = command[i];

      if (escaped) {
        current += ch;
        escaped = false;
        continue;
      }

      if (ch === '\\' && !inSingleQuote) {
        escaped = true;
        continue;
      }

      if (ch === "'" && !inDoubleQuote) {
        inSingleQuote = !inSingleQuote;
        current += ch;
        continue;
      }

      if (ch === '"' && !inSingleQuote) {
        inDoubleQuote = !inDoubleQuote;
        current += ch;
        continue;
      }

      if (ch === ' ' && !inSingleQuote && !inDoubleQuote) {
        if (current) {
          tokens.push(current);
          current = '';
        }
        continue;
      }

      current += ch;
    }

    if (current) {
      tokens.push(current);
    }

    return tokens;
  }

  /**
   * Split a string by a delimiter, respecting quotes.
   */
  private splitRespectingQuotes(str: string, delimiter: string): string[] {
    const parts: string[] = [];
    let current = '';
    let inSingleQuote = false;
    let inDoubleQuote = false;

    for (let i = 0; i < str.length; i++) {
      const ch = str[i];

      if (ch === "'" && !inDoubleQuote) {
        inSingleQuote = !inSingleQuote;
        current += ch;
        continue;
      }

      if (ch === '"' && !inSingleQuote) {
        inDoubleQuote = !inDoubleQuote;
        current += ch;
        continue;
      }

      if (!inSingleQuote && !inDoubleQuote && str.slice(i).startsWith(delimiter)) {
        parts.push(current);
        current = '';
        i += delimiter.length - 1;
        continue;
      }

      current += ch;
    }

    if (current) parts.push(current);

    return parts;
  }

  /**
   * Extract redirections from command arguments.
   */
  private extractRedirects(args: string[]): RedirectNode[] {
    const redirects: RedirectNode[] = [];

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];

      // > file (write stdout)
      if (arg === '>' && i + 1 < args.length) {
        redirects.push({ redirectType: 'write', target: args[i + 1], isCommandSubstitution: false });
        i++;
        continue;
      }

      // >> file (append stdout)
      if (arg === '>>' && i + 1 < args.length) {
        redirects.push({ redirectType: 'append', target: args[i + 1], isCommandSubstitution: false });
        i++;
        continue;
      }

      // 2> file (write stderr)
      if (/^\d?>$/.test(arg) && i + 1 < args.length) {
        const fd = arg.length > 1 ? parseInt(arg[0]) : 1;
        redirects.push({ fd, redirectType: 'write', target: args[i + 1], isCommandSubstitution: false });
        i++;
        continue;
      }

      // < file (read stdin)
      if (arg === '<' && i + 1 < args.length) {
        redirects.push({ redirectType: 'read', target: args[i + 1], isCommandSubstitution: false });
        i++;
        continue;
      }

      // &> file (redirect both stdout and stderr)
      if (arg === '&>' && i + 1 < args.length) {
        redirects.push({ redirectType: 'dup_write', target: args[i + 1], isCommandSubstitution: false });
        i++;
        continue;
      }

      // << EOF (heredoc)
      if (arg === '<<' && i + 1 < args.length) {
        redirects.push({ redirectType: 'heredoc', target: args[i + 1], isCommandSubstitution: false });
        i++;
        continue;
      }

      // <<< word (here string)
      if (arg === '<<<' && i + 1 < args.length) {
        redirects.push({ redirectType: 'here_string', target: args[i + 1], isCommandSubstitution: false });
        i++;
        continue;
      }

      // <(cmd) (process substitution)
      if (arg.startsWith('<(') && arg.endsWith(')')) {
        redirects.push({
          redirectType: 'pipe_read',
          target: arg.slice(2, -1),
          isCommandSubstitution: true,
        });
        continue;
      }

      // >(cmd) (process substitution)
      if (arg.startsWith('>(') && arg.endsWith(')')) {
        redirects.push({
          redirectType: 'pipe_write',
          target: arg.slice(2, -1),
          isCommandSubstitution: true,
        });
        continue;
      }
    }

    return redirects;
  }
}

// ---------------------------------------------------------------------------
// Singleton Export
// ---------------------------------------------------------------------------

/**
 * Default parser instance with standard configuration.
 */
export const bashASTParser = new BashASTParser();