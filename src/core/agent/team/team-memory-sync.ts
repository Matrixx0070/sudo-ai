/**
 * TeamMemorySync manages shared memory files for a multi-agent team.
 *
 * Each team gets a directory at `data/teams/<teamName>/memory/` where
 * agents can store and retrieve shared knowledge. The sync module:
 *
 * - Writes memory files to the team's shared directory.
 * - Detects secrets (API keys, tokens, passwords) and refuses to sync
 *   files that contain them.
 * - Lists all shared memory files available in the team's directory.
 *
 * Secret detection uses a set of common patterns for API keys, tokens,
 * passwords, and private keys. Any file whose content matches one of
 * these patterns is rejected during sync to prevent credential leakage
 * across team boundaries.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { createLogger } from '../../shared/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of a sync attempt. */
export interface SyncResult {
  /** The filename that was synced. */
  filename: string;
  /** Whether the sync succeeded. */
  success: boolean;
  /** Reason for failure (if success is false). */
  reason?: string;
}

/** Metadata about a shared memory file. */
export interface MemoryFileInfo {
  /** Filename (relative to the team memory directory). */
  filename: string;
  /** Absolute path on disk. */
  path: string;
  /** File size in bytes. */
  sizeBytes: number;
  /** ISO timestamp of the last modification. */
  modifiedAt: string;
}

// ---------------------------------------------------------------------------
// Secret detection
// ---------------------------------------------------------------------------

/**
 * Patterns that commonly indicate leaked secrets. Each entry is a
 * regular expression that matches a typical secret format.
 */
const SECRET_PATTERNS: RegExp[] = [
  // Generic API key patterns (common providers)
  /['"](?:sk|pk|ak|rk)_[a-zA-Z0-9]{20,}['"]/g,
  // AWS-style keys
  /['"]AKIA[0-9A-Z]{16}['"]/g,
  // Generic token patterns
  /['"]ghp_[a-zA-Z0-9]{36}['"]/g,              // GitHub PAT
  /['"]gho_[a-zA-Z0-9]{36}['"]/g,              // GitHub OAuth
  /['"]glpat-[a-zA-Z0-9\-]{20,}['"]/g,          // GitLab PAT
  /['"]xox[bpas]-[a-zA-Z0-9\-]{10,}['"]/g,      // Slack tokens
  // Private key blocks
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
  // Generic password/key assignments in config files
  /(?:password|passwd|secret|api[_-]?key|access[_-]?key|auth[_-]?token)\s*[:=]\s*['"][^'"]{8,}['"]/gi,
];

/**
 * Scan content for known secret patterns.
 *
 * @returns `true` if a secret pattern is detected.
 */
export function detectSecrets(content: string): boolean {
  for (const pattern of SECRET_PATTERNS) {
    // Reset lastIndex for global regexes.
    pattern.lastIndex = 0;
    if (pattern.test(content)) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// TeamMemorySync
// ---------------------------------------------------------------------------

const log = createLogger('team-memory-sync');

export class TeamMemorySync {
  private readonly dataRoot: string;

  constructor(dataRoot: string = 'data') {
    this.dataRoot = dataRoot;
  }

  /**
   * Return the absolute path to a team's shared memory directory.
   */
  teamMemoryDir(teamName: string): string {
    return path.join(this.dataRoot, 'teams', teamName, 'memory');
  }

  /**
   * Write a memory file to the team's shared directory. The content is
   * first scanned for secrets; if any are found the write is refused.
   *
   * @returns A SyncResult indicating success or failure.
   */
  syncMemoryFile(teamName: string, filename: string, content: string): SyncResult {
    // Validate filename — prevent path traversal.
    const sanitized = path.basename(filename);
    if (sanitized !== filename || filename.includes('..')) {
      const reason = `Invalid filename: "${filename}" (path traversal rejected)`;
      log.warn({ teamName, filename, reason }, 'Memory sync rejected');
      return { filename, success: false, reason };
    }

    // Secret detection.
    if (detectSecrets(content)) {
      const reason = 'Secret detected in content — refusing to sync';
      log.warn({ teamName, filename, reason }, 'Memory sync rejected');
      return { filename, success: false, reason };
    }

    const dir = this.teamMemoryDir(teamName);
    mkdirSync(dir, { recursive: true });

    const filePath = path.join(dir, filename);
    writeFileSync(filePath, content, 'utf-8');

    log.info({ teamName, filename, sizeBytes: content.length }, 'Memory file synced');
    return { filename, success: true };
  }

  /**
   * Read a memory file from the team's shared directory.
   *
   * @returns The file content as a string, or `undefined` if the file
   *          does not exist.
   */
  readMemoryFile(teamName: string, filename: string): string | undefined {
    const sanitized = path.basename(filename);
    if (sanitized !== filename) {
      return undefined;
    }

    const filePath = path.join(this.teamMemoryDir(teamName), filename);
    if (!existsSync(filePath)) {
      return undefined;
    }

    return readFileSync(filePath, 'utf-8');
  }

  /**
   * List all shared memory files in the team's directory.
   *
   * @returns Array of MemoryFileInfo objects for each file.
   */
  getSharedMemoryFiles(teamName: string): MemoryFileInfo[] {
    const dir = this.teamMemoryDir(teamName);
    if (!existsSync(dir)) {
      return [];
    }

    const entries: MemoryFileInfo[] = [];

    for (const entry of readdirSync(dir)) {
      const fullPath = path.join(dir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isFile()) {
          entries.push({
            filename: entry,
            path: fullPath,
            sizeBytes: stat.size,
            modifiedAt: stat.mtime.toISOString(),
          });
        }
      } catch {
        // Skip unreadable entries.
      }
    }

    return entries;
  }

  /**
   * Delete a memory file from the team's shared directory.
   *
   * @returns `true` if the file was deleted, `false` if not found.
   */
  deleteMemoryFile(teamName: string, filename: string): boolean {
    const sanitized = path.basename(filename);
    if (sanitized !== filename) {
      return false;
    }

    const filePath = path.join(this.teamMemoryDir(teamName), filename);
    if (!existsSync(filePath)) {
      return false;
    }

    const { unlinkSync } = require('fs');
    unlinkSync(filePath);
    log.info({ teamName, filename }, 'Memory file deleted');
    return true;
  }
}