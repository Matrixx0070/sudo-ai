/**
 * @file security/bash-ast-types.ts
 * @description Type definitions for Bash AST structural analysis.
 *
 * Defines the abstract syntax tree node types for bash command parsing,
 * risk classification, and structural validation.
 *
 * Competitive context: Claude Code has 102KB of bash security (bashSecurity.ts),
 * 98KB of bash permissions (bashPermissions.ts), 68KB of read-only validation,
 * and 43KB of path validation. This module provides the type foundation for
 * SUDO-AI's structural bash analysis.
 */

// ---------------------------------------------------------------------------
// AST Node Types
// ---------------------------------------------------------------------------

/** Base type for all AST nodes. */
export interface BashASTNode {
  /** Node type discriminator. */
  type: BashASTNodeType;
  /** Original source text for this node. */
  raw: string;
  /** Start position in the original command (0-based). */
  start: number;
  /** End position in the original command (exclusive). */
  end: number;
}

/** All possible AST node types. */
export type BashASTNodeType =
  | 'command'           // Simple command: `ls -la`
  | 'pipeline'          // Pipeline: `cmd1 | cmd2`
  | 'and_list'          // AND list: `cmd1 && cmd2`
  | 'or_list'           // OR list: `cmd1 || cmd2`
  | 'sequence'          // Sequential: `cmd1; cmd2`
  | 'subshell'          // Subshell: `(cmd1; cmd2)`
  | 'group'             // Brace group: `{ cmd1; cmd2; }`
  | 'conditional'       // Conditional: `[[ expr ]]` or `test expr`
  | 'for_loop'          // For loop: `for x in ...; do ...; done`
  | 'while_loop'        // While loop: `while cmd; do ...; done`
  | 'until_loop'        // Until loop: `until cmd; do ...; done`
  | 'case_statement'    // Case: `case $x in ...) ... ;; esac`
  | 'function_def'      // Function definition: `foo() { ... }`
  | 'variable_assign'   // Variable assignment: `X=1`
  | 'export_statement'   // Export: `export X=1`
  | 'redirect'          // Redirection: `cmd > file`
  | 'heredoc'           // Heredoc: `cmd << EOF ... EOF`
  | 'command_substitution' // Command substitution: `$(cmd)` or `` `cmd` ``
  | 'process_substitution' // Process substitution: `<(cmd)` or `>(cmd)`
  | 'background'        // Background job: `cmd &`
  | 'coprocess'         // Coprocess: `coproc cmd`
  | 'comment'           // Comment: `# text`
  | 'empty'             // Empty line or whitespace
  | 'unknown';          // Unparseable node

// ---------------------------------------------------------------------------
// Command Node
// ---------------------------------------------------------------------------

/** A simple command with its components. */
export interface CommandNode extends BashASTNode {
  type: 'command';
  /** Command name (e.g., 'ls', 'rm', 'sudo'). */
  command: string;
  /** Arguments to the command. */
  args: string[];
  /** Prefix assignments (e.g., `VAR=value cmd`). */
  prefixAssignments: Array<{ key: string; value: string }>;
  /** Redirections attached to this command. */
  redirects: RedirectNode[];
  /** Whether this command is run with sudo/doas/run0. */
  isPrivileged: boolean;
  /** Whether this command is run in the background. */
  isBackground: boolean;
}

// ---------------------------------------------------------------------------
// Pipeline Node
// ---------------------------------------------------------------------------

/** A pipeline of commands connected by |. */
export interface PipelineNode extends BashASTNode {
  type: 'pipeline';
  /** Commands in the pipeline (left to right). */
  commands: BashASTNode[];
  /** Whether the pipeline is negated with !. */
  negated: boolean;
}

// ---------------------------------------------------------------------------
// List Nodes (AND/OR/Sequence)
// ---------------------------------------------------------------------------

/** AND list: cmd1 && cmd2. */
export interface AndListNode extends BashASTNode {
  type: 'and_list';
  left: BashASTNode;
  right: BashASTNode;
}

/** OR list: cmd1 || cmd2. */
export interface OrListNode extends BashASTNode {
  type: 'or_list';
  left: BashASTNode;
  right: BashASTNode;
}

/** Sequential list: cmd1; cmd2. */
export interface SequenceNode extends BashASTNode {
  type: 'sequence';
  /** Commands in the sequence. */
  commands: BashASTNode[];
}

// ---------------------------------------------------------------------------
// Compound Command Nodes
// ---------------------------------------------------------------------------

/** Subshell: (cmd1; cmd2). */
export interface SubshellNode extends BashASTNode {
  type: 'subshell';
  body: BashASTNode;
}

/** Brace group: { cmd1; cmd2; }. */
export interface GroupNode extends BashASTNode {
  type: 'group';
  body: BashASTNode;
}

/** Conditional: [[ expr ]] or test expr. */
export interface ConditionalNode extends BashASTNode {
  type: 'conditional';
  expression: string;
  negated: boolean;
}

/** For loop. */
export interface ForLoopNode extends BashASTNode {
  type: 'for_loop';
  variable: string;
  words: string[];
  body: BashASTNode;
}

/** While loop. */
export interface WhileLoopNode extends BashASTNode {
  type: 'while_loop';
  condition: BashASTNode;
  body: BashASTNode;
}

/** Until loop. */
export interface UntilLoopNode extends BashASTNode {
  type: 'until_loop';
  condition: BashASTNode;
  body: BashASTNode;
}

/** Case statement. */
export interface CaseNode extends BashASTNode {
  type: 'case_statement';
  word: string;
  patterns: Array<{ pattern: string; body: BashASTNode }>;
}

/** Function definition. */
export interface FunctionDefNode extends BashASTNode {
  type: 'function_def';
  name: string;
  body: BashASTNode;
}

/** Variable assignment. */
export interface VariableAssignNode extends BashASTNode {
  type: 'variable_assign';
  name: string;
  value: string;
  isExport: boolean;
}

// ---------------------------------------------------------------------------
// Redirection Nodes
// ---------------------------------------------------------------------------

/** Redirection type. */
export type RedirectType =
  | 'write'      // >
  | 'append'     // >>
  | 'read'       // <
  | 'readwrite'  // <>
  | 'dup_write'  // &> or n>&m
  | 'dup_read'   // n<&m
  | 'heredoc'    // <<
  | 'heredoc_strip' // <<-
  | 'here_string' // <<<
  | 'pipe_write' // >(
  | 'pipe_read'; // <(

/** A single redirection. */
export interface RedirectNode {
  /** File descriptor being redirected (default varies by type). */
  fd?: number;
  /** Type of redirection. */
  redirectType: RedirectType;
  /** Target file or file descriptor. */
  target: string;
  /** Whether the target is a command substitution. */
  isCommandSubstitution: boolean;
}

// ---------------------------------------------------------------------------
// Command Substitution
// ---------------------------------------------------------------------------

/** Command substitution: $(cmd) or `cmd`. */
export interface CommandSubstitutionNode extends BashASTNode {
  type: 'command_substitution';
  /** The inner command string. */
  innerCommand: string;
  /** Parsed inner AST (if parseable). */
  innerAST?: BashASTNode;
}

/** Process substitution: <(cmd) or >(cmd). */
export interface ProcessSubstitutionNode extends BashASTNode {
  type: 'process_substitution';
  direction: 'read' | 'write';
  innerCommand: string;
}

// ---------------------------------------------------------------------------
// Background/Coprocess
// ---------------------------------------------------------------------------

/** Background job: cmd &. */
export interface BackgroundNode extends BashASTNode {
  type: 'background';
  command: BashASTNode;
}

/** Coprocess: coproc cmd. */
export interface CoprocessNode extends BashASTNode {
  type: 'coprocess';
  command: BashASTNode;
}

// ---------------------------------------------------------------------------
// Risk Analysis
// ---------------------------------------------------------------------------

/** Risk level for a command or operation. */
export type RiskLevel = 'safe' | 'low' | 'medium' | 'high' | 'critical';

/** Risk category. */
export type RiskCategory =
  | 'file_destruction'    // rm, shred, truncate
  | 'file_modification'   // chmod, chown, mv
  | 'privilege_escalation' // sudo, doas, run0, su
  | 'network_access'       // curl, wget, nc, ssh
  | 'code_execution'       // eval, bash, sh, python, node
  | 'data_exfiltration'    // curl upload, scp, rsync
  | 'resource_abuse'       // fork bomb, dd, /dev/zero
  | 'system_modification'  // systemctl, service, sysctl
  | 'environment_tampering' // export PATH, LD_PRELOAD
  | 'container_escape'     // docker escape, nsenter
  | 'information_disclosure' // cat /etc/shadow, env
  | 'persistence'           // crontab, systemd unit, rc.local
  | 'none';                // No risk identified

/** Risk assessment for a command or AST node. */
export interface RiskAssessment {
  /** Overall risk level. */
  level: RiskLevel;
  /** Risk categories identified. */
  categories: RiskCategory[];
  /** Human-readable explanation. */
  explanation: string;
  /** Whether this command should be blocked. */
  blocked: boolean;
  /** Whether this command requires explicit approval. */
  requiresApproval: boolean;
  /** Confidence of the assessment (0-1). */
  confidence: number;
  /** Specific dangerous patterns found. */
  patterns: RiskPattern[];
  /** Suggestions for safer alternatives. */
  suggestions: string[];
}

/** A specific risk pattern found in a command. */
export interface RiskPattern {
  /** The pattern that was matched. */
  pattern: string;
  /** The category of the risk. */
  category: RiskCategory;
  /** Human-readable description. */
  description: string;
  /** The part of the command that matched. */
  matched: string;
  /** Suggested safer alternative. */
  alternative?: string;
}

// ---------------------------------------------------------------------------
// Validation Result
// ---------------------------------------------------------------------------

/** Result of validating a bash command. */
export interface BashValidationResult {
  /** Whether the command passed validation. */
  valid: boolean;
  /** Risk assessment. */
  risk: RiskAssessment;
  /** Parsed AST (if parsing succeeded). */
  ast?: BashASTNode;
  /** Warnings (non-blocking issues). */
  warnings: string[];
  /** Errors (blocking issues). */
  errors: string[];
  /** Whether this was classified as a read-only command. */
  isReadOnly: boolean;
  /** Estimated execution time category. */
  estimatedTime: 'instant' | 'fast' | 'moderate' | 'slow' | 'unknown';
  /** Whether the command uses pipes. */
  hasPipes: boolean;
  /** Whether the command uses redirections. */
  hasRedirects: boolean;
  /** Whether the command uses command substitution. */
  hasSubstitution: boolean;
  /** Whether the command is privileged (sudo/doas). */
  isPrivileged: boolean;
  /** Whether the command modifies the filesystem. */
  modifiesFilesystem: boolean;
  /** Whether the command accesses the network. */
  accessesNetwork: boolean;
}

// ---------------------------------------------------------------------------
// Parser Configuration
// ---------------------------------------------------------------------------

/** Configuration for the Bash AST parser. */
export interface BashParserConfig {
  /** Maximum command length to parse (default: 10000). */
  maxCommandLength: number;
  /** Maximum nesting depth for AST (default: 10). */
  maxNestingDepth: number;
  /** Whether to parse command substitutions recursively (default: true). */
  parseSubstitutions: boolean;
  /** Whether to include raw source text in nodes (default: true). */
  includeRaw: boolean;
  /** Risk thresholds for validation. */
  riskThresholds: {
    /** Minimum risk level to require approval (default: 'medium'). */
    approvalRequired: RiskLevel;
    /** Minimum risk level to block execution (default: 'critical'). */
    blocked: RiskLevel;
  };
  /** Commands that are always considered safe (read-only). */
  alwaysSafeCommands: string[];
  /** Commands that always require approval. */
  alwaysRequireApproval: string[];
  /** Commands that are always blocked. */
  alwaysBlockedCommands: string[];
  /** Patterns that are always blocked (regex strings). */
  alwaysBlockedPatterns: string[];
  /** Path patterns that are protected (regex strings). */
  protectedPaths: string[];
}

/** Default parser configuration. */
export const DEFAULT_BASH_PARSER_CONFIG: BashParserConfig = {
  maxCommandLength: 10_000,
  maxNestingDepth: 10,
  parseSubstitutions: true,
  includeRaw: true,
  riskThresholds: {
    approvalRequired: 'medium',
    blocked: 'critical',
  },
  alwaysSafeCommands: [
    'ls', 'dir', 'cat', 'head', 'tail', 'less', 'more', 'wc',
    'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack',
    'find', 'locate', 'which', 'whereis', 'type',
    'echo', 'printf', 'date', 'whoami', 'hostname', 'uname',
    'pwd', 'realpath', 'readlink', 'basename', 'dirname',
    'git', 'git-log', 'git-diff', 'git-status', 'git-branch', 'git-show',
    'env', 'printenv', 'set', 'export', 'declare',
    'file', 'stat', 'du', 'df', 'free', 'top', 'ps',
    'curl', 'wget', // Network but not destructive
    'node', 'python3', 'python', // Execution but common
    'npm', 'pnpm', 'yarn', // Package managers (read-only operations)
    'cargo', 'rustc', 'make', 'cmake',
    'docker', 'podman', // Container runtimes (info commands)
    'jq', 'yq', 'xargs', 'sort', 'uniq', 'cut', 'tr', 'sed', 'awk',
  ],
  alwaysRequireApproval: [
    'sudo', 'doas', 'run0', 'su', 'pkexec',
    'systemctl', 'service', 'journalctl',
    'apt', 'apt-get', 'yum', 'dnf', 'pacman', 'brew', 'nix',
    'pip', 'pip3', 'gem', 'cargo', // Install commands
    'crontab', 'at', 'batch',
    'iptables', 'nft', 'ufw',
    'mount', 'umount', 'fdisk', 'parted',
    'dd', 'shred', 'mkfs',
  ],
  alwaysBlockedCommands: [
    // Nothing blocked by default — policy decides
  ],
  alwaysBlockedPatterns: [
    // Fork bombs
    ':(){ :|:& };:',
    'fork bomb',
    // Wipe commands
    'rm -rf /',
    'rm -rf /*',
    'rm -rf ~',
    // Overwrite disk
    'dd if=/dev/zero',
    'dd if=/dev/urandom',
    // Execute from network
    'curl.*\\|.*sh',
    'wget.*\\|.*sh',
    'curl.*\\|.*bash',
    'wget.*\\|.*bash',
    // LD_PRELOAD injection
    'LD_PRELOAD',
    // Write to /etc/passwd or /etc/shadow
    '/etc/passwd',
    '/etc/shadow',
    // Device access
    '/dev/sd',
    '/dev/nvme',
    '/dev/mem',
    '/dev/kmem',
  ],
  protectedPaths: [
    '^/etc/passwd$',
    '^/etc/shadow$',
    '^/etc/sudoers',
    '^/etc/ssh/',
    '^/root/\\.ssh/',
    '^/boot/',
    '^/proc/sys/',
    '^/sys/',
  ],
};