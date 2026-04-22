/**
 * @file security/patterns.ts
 * @description Compiled RegExp patterns for injection detection and command blocking.
 * Extracted from security/index.ts to keep files under 300 lines.
 */

// ---------------------------------------------------------------------------
// Prompt injection detection patterns
// ---------------------------------------------------------------------------

export interface InjectionPatternEntry {
  pattern: RegExp;
  weight: number;
  label: string;
}

export const INJECTION_PATTERNS: InjectionPatternEntry[] = [
  // Instruction override attempts (high weight)
  { pattern: /ignore\s+(all\s+|previous\s+|prior\s+|above\s+)?(instructions|rules|guidelines)/i, weight: 0.7, label: 'instruction_override' },
  { pattern: /forget\s+(everything|all|your)\s+(you|instructions)/i, weight: 0.7, label: 'forget_instructions' },
  { pattern: /you\s+are\s+now\b/i, weight: 0.5, label: 'identity_reassign' },
  { pattern: /new\s+(instructions|rules|persona|identity)/i, weight: 0.55, label: 'new_instructions' },
  { pattern: /override\s+(your|the|all)\s+(instructions|rules|system)/i, weight: 0.7, label: 'override_system' },
  { pattern: /disregard\s+(your|the|all|previous)/i, weight: 0.65, label: 'disregard_instructions' },

  // Role manipulation (medium weight)
  { pattern: /pretend\s+(you\s+are|to\s+be|you're)/i, weight: 0.45, label: 'role_pretend' },
  { pattern: /act\s+as\s+(if|a|an|the)\b/i, weight: 0.35, label: 'act_as' },
  { pattern: /you('re|\s+are)\s+(actually|really|secretly)/i, weight: 0.5, label: 'secret_identity' },
  { pattern: /your\s+(real|true|actual)\s+(purpose|goal|instruction)/i, weight: 0.55, label: 'true_purpose' },

  // System prompt extraction (high weight)
  { pattern: /show\s+me\s+(your|the)\s+(system|initial)\s+(prompt|instructions|message)/i, weight: 0.75, label: 'extract_prompt' },
  { pattern: /what\s+(are|is)\s+your\s+(system|initial)\s+(prompt|instructions)/i, weight: 0.7, label: 'query_prompt' },
  { pattern: /repeat\s+(your|the)\s+(system|initial|first)\s+(prompt|message|instruction)/i, weight: 0.75, label: 'repeat_prompt' },
  { pattern: /output\s+(your|the)\s+(system|initial)\s+(prompt|instructions)/i, weight: 0.8, label: 'output_prompt' },

  // Encoding tricks (medium weight)
  { pattern: /base64|rot13|hex\s+encode|decode.*instruction/i, weight: 0.4, label: 'encoding_trick' },
  { pattern: /\[system\]|\[admin\]|\[override\]/i, weight: 0.65, label: 'fake_system_tag' },

  // Data exfiltration via social engineering (high weight)
  { pattern: /send\s+(the|my|all|your)\s+(data|files|keys|tokens|passwords|credentials)\s+to/i, weight: 0.85, label: 'exfiltrate_request' },
  { pattern: /upload\s+(the|my|all)\s+(data|files|keys)\s+to/i, weight: 0.8, label: 'upload_request' },
  { pattern: /curl.*\|\s*(sh|bash)/i, weight: 0.9, label: 'piped_shell' },
  { pattern: /wget.*-O.*\|/i, weight: 0.85, label: 'wget_pipe' },
];

// ---------------------------------------------------------------------------
// Blocked exec patterns for validateToolCall
// ---------------------------------------------------------------------------

export interface BlockedPatternEntry {
  pattern: RegExp;
  label: string;
}

export const BLOCKED_EXEC_PATTERNS: BlockedPatternEntry[] = [
  // Destructive file ops
  { pattern: /rm\s+(-rf?|--recursive).*\//i, label: 'rm_rf' },
  { pattern: /mkfs\b/i, label: 'mkfs' },
  { pattern: /dd\s+if=/i, label: 'dd_overwrite' },
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:&\s*\}\s*;/i, label: 'fork_bomb' },
  { pattern: />\s*\/dev\/sd/i, label: 'overwrite_block_device' },

  // Exfiltration via shell
  { pattern: /curl.*\|\s*(sh|bash)/i, label: 'curl_pipe_shell' },
  { pattern: /wget.*\|\s*bash/i, label: 'wget_pipe_bash' },
  { pattern: /nc\s+-l/i, label: 'netcat_listener' },
  { pattern: /\bncat\b/i, label: 'ncat' },

  // Credential theft via exec
  { pattern: /cat\s+.*\.env\b/i, label: 'cat_env' },
  { pattern: /cat\s+.*credentials/i, label: 'cat_credentials' },
  { pattern: /cat\s+.*\/etc\/shadow/i, label: 'cat_shadow' },
  { pattern: /cat\s+.*id_rsa/i, label: 'cat_rsa_key' },

  // Network scanning / credential attacks
  { pattern: /\bnmap\b/i, label: 'nmap' },
  { pattern: /\bmasscan\b/i, label: 'masscan' },
  { pattern: /\bhydra\b/i, label: 'hydra' },
];

// Internal IP ranges that browser.navigate should not reach.
export const BLOCKED_IP_PATTERN = /^https?:\/\/(169\.254\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i;

// AWS/GCP/Azure cloud metadata endpoint.
export const CLOUD_METADATA_PATTERN = /169\.254\.169\.254/i;
