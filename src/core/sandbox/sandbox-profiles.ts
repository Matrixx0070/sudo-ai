/**
 * @file sandbox-profiles.ts
 * @description Sandbox Profiles — Landlock/bwrap/seccomp profile system.
 * Grok Build CLI parity.
 *
 * Grok Build CLI uses:
 *   - nono-0.53.0 sandbox engine
 *   - Landlock (Linux ABI V1-V6) for filesystem access control
 *   - bwrap (bubblewrap) as fallback
 *   - seccomp for network blocking and syscall filtering
 *   - Seatbelt (macOS) for Apple platforms
 *
 * Profiles:
 *   - off:       No sandboxing (dangerous, development only)
 *   - workspace: Read/write access to workspace dir only
 *   - read-only: Read-only filesystem access
 *   - strict:    Full isolation — no network, restricted filesystem, seccomp
 *
 * SUDO-AI implementation adds profile support on top of existing bwrap sandbox.
 */

import { createLogger } from '../shared/logger.js';
import type { SandboxPolicy } from './sandbox-types.js';

const log = createLogger('sandbox:profiles');

// ---------------------------------------------------------------------------
// Profile types
// ---------------------------------------------------------------------------

export type SandboxProfileName = 'off' | 'workspace' | 'read-only' | 'strict';

export interface SandboxProfile extends SandboxPolicy {
  /** Profile name. */
  profile: SandboxProfileName;
  /** Description of what this profile allows. */
  description: string;
  /** Whether Landlock is used (Linux only). */
  useLandlock: boolean;
  /** Landlock ABI version to target (1-6). 0 = auto-detect. */
  landlockAbiVersion: number;
  /** Whether seccomp is used for syscall filtering. */
  useSeccomp: boolean;
  /** Whether Seatbelt is used (macOS only). */
  useSeatbelt: boolean;
}

// ---------------------------------------------------------------------------
// Profile definitions
// ---------------------------------------------------------------------------

const PROFILES: Record<SandboxProfileName, SandboxProfile> = {
  off: {
    profile: 'off',
    description: 'No sandboxing — all filesystem and network access allowed. DANGEROUS: development only.',
    enabled: false,
    network: 'host',
    useLandlock: false,
    landlockAbiVersion: 0,
    useSeccomp: false,
    useSeatbelt: false,
  },

  workspace: {
    profile: 'workspace',
    description: 'Read/write access to workspace directory only. Network allowed for built-in tools.',
    enabled: true,
    network: 'host',
    cpuSeconds: 60,
    memoryMB: 1024,
    maxFileMB: 200,
    useLandlock: true,
    landlockAbiVersion: 0, // auto-detect
    useSeccomp: false,
    useSeatbelt: true,
  },

  'read-only': {
    profile: 'read-only',
    description: 'Read-only filesystem access. No write operations allowed. Network blocked for child processes.',
    enabled: true,
    network: 'none',
    cpuSeconds: 30,
    memoryMB: 512,
    maxFileMB: 100,
    useLandlock: true,
    landlockAbiVersion: 0,
    useSeccomp: true,
    useSeatbelt: true,
  },

  strict: {
    profile: 'strict',
    description: 'Full isolation — no network, restricted filesystem (workspace read-only), seccomp syscall filter, minimal environment.',
    enabled: true,
    network: 'none',
    cpuSeconds: 15,
    memoryMB: 256,
    maxFileMB: 50,
    useLandlock: true,
    landlockAbiVersion: 0,
    useSeccomp: true,
    useSeatbelt: true,
  },
};

// ---------------------------------------------------------------------------
// ProfileManager
// ---------------------------------------------------------------------------

/**
 * Manages sandbox profiles and resolves the effective policy for a given context.
 *
 * Usage:
 * ```ts
 * const pm = new ProfileManager();
 * const policy = pm.resolve('workspace', '/home/user/project');
 * // policy contains merged SandboxPolicy + Landlock/bwrap/seccomp settings
 * ```
 */
export class ProfileManager {
  private currentProfile: SandboxProfileName = 'workspace'; // sensible default
  private readonly platform: 'linux' | 'mac' | 'win';

  constructor() {
    this.platform = this._detectPlatform();
    log.info({ platform: this.platform, defaultProfile: this.currentProfile }, 'ProfileManager initialised');
  }

  /**
   * Resolve the effective sandbox policy for a given profile.
   *
   * @param profileName  - Profile to use.
   * @param workspaceDir  - Workspace directory (for bind mount calculation).
   * @returns Resolved SandboxProfile.
   */
  resolve(profileName: SandboxProfileName, workspaceDir?: string): SandboxProfile {
    const base = PROFILES[profileName];
    if (!base) {
      log.warn({ profileName }, 'Unknown profile — falling back to workspace');
      return PROFILES['workspace'];
    }

    // Clone the profile
    const resolved: SandboxProfile = { ...base };

    // Platform adjustments
    if (this.platform === 'mac') {
      resolved.useLandlock = false; // Landlock is Linux-only
      resolved.useSeatbelt = base.useSeatbelt;
    } else if (this.platform === 'win') {
      resolved.useLandlock = false;
      resolved.useSeatbelt = false;
      resolved.useSeccomp = false; // seccomp is Linux-only
    } else {
      // Linux — check Landlock ABI support
      if (resolved.useLandlock) {
        resolved.landlockAbiVersion = this._detectLandlockAbi();
        if (resolved.landlockAbiVersion === 0) {
          log.warn('Landlock not available — falling back to bwrap');
          resolved.useLandlock = false;
        }
      }
    }

    // Set workspace binds
    if (workspaceDir && profileName !== 'off') {
      if (profileName === 'strict' || profileName === 'read-only') {
        resolved.extraReadOnlyBinds = [workspaceDir];
      } else {
        resolved.extraWritableBinds = [workspaceDir];
      }
    }

    log.info(
      {
        profile: profileName,
        landlock: resolved.useLandlock,
        landlockAbi: resolved.landlockAbiVersion,
        seccomp: resolved.useSeccomp,
        seatbelt: resolved.useSeatbelt,
        network: resolved.network,
      },
      'Sandbox profile resolved',
    );

    return resolved;
  }

  /** Set the current profile. */
  setProfile(name: SandboxProfileName): void {
    if (!PROFILES[name]) {
      throw new Error(`Unknown sandbox profile: ${name}. Available: ${Object.keys(PROFILES).join(', ')}`);
    }
    this.currentProfile = name;
    log.info({ profile: name }, 'Sandbox profile changed');
  }

  /** Get the current profile name. */
  getCurrentProfile(): SandboxProfileName {
    return this.currentProfile;
  }

  /** Get all available profile names. */
  getAvailableProfiles(): SandboxProfileName[] {
    return Object.keys(PROFILES) as SandboxProfileName[];
  }

  /** Get a profile definition by name. */
  getProfile(name: SandboxProfileName): SandboxProfile | undefined {
    return PROFILES[name];
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _detectPlatform(): 'linux' | 'mac' | 'win' {
    const platform = process.platform;
    if (platform === 'darwin') return 'mac';
    if (platform === 'win32') return 'win';
    return 'linux';
  }

  /**
   * Detect the highest supported Landlock ABI version.
   * Returns 0 if Landlock is not available.
   */
  private _detectLandlockAbi(): number {
    try {
      const { execSync } = require('node:child_process') as { execSync: (cmd: string, opts: unknown) => string };
      // Check kernel version — Landlock requires Linux 5.13+
      const kernelVersion = execSync('uname -r', { encoding: 'utf8' }).trim();
      const match = kernelVersion.match(/^(\d+)\.(\d+)/);
      if (!match) return 0;

      const major = parseInt(match[1], 10);
      const minor = parseInt(match[2], 10);

      // Landlock ABI versions correspond to kernel versions:
      // ABI 1: 5.13, ABI 2: 5.19, ABI 3: 6.2, ABI 4: 6.6, ABI 5: 6.9, ABI 6: 6.10+
      if (major < 5 || (major === 5 && minor < 13)) return 0;
      if (major === 5 && minor < 19) return 1;
      if (major === 5) return 2;
      if (major === 6 && minor < 2) return 2;
      if (major === 6 && minor < 6) return 3;
      if (major === 6 && minor < 9) return 4;
      if (major === 6 && minor < 10) return 5;
      return 6; // 6.10+
    } catch {
      return 0;
    }
  }
}