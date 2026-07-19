/**
 * @file workspace/guidance-registry.ts
 * @description BO10 / scorecard-S10 — the PURE catalog + frozen-set resolver for
 * the agent's guidance files (SOUL / IDENTITY / USER / AGENTS / TOOLS / MEMORY /
 * HEARTBEAT etc.), consumed by the admin guidance viewer + gated audited writer.
 *
 * This module contains NO filesystem side effects. It only maps a UI-facing file
 * name to a project-root-relative path, classifies each entry, and answers the
 * one question invariant 4 hinges on: is this file FROZEN?
 *
 * INVARIANT 4 (non-negotiable): files in PROTECTED_PATHS and the identity /
 * constitution surfaces (core-identity.md, values.json, hard-prohibitions.yaml)
 * are READ-ONLY in the UI, ALWAYS. `isFrozenGuidance*` is the single source of
 * truth the write path defends on (defense in depth: the handler rejects a frozen
 * write even if the UI is bypassed). It fails CLOSED — anything it cannot resolve
 * is treated as frozen.
 */

import { isProtectedPath } from '../self-build/protected-paths.js';

/** Category of a guidance file. `constitution` files are always frozen. */
export type GuidanceCategory = 'workspace' | 'constitution';

/** A single guidance file the UI can list (and, if not frozen, edit). */
export interface GuidanceFileSpec {
  /** Canonical UI id (no path separators), e.g. "SOUL", "core-identity". */
  readonly name: string;
  /** Project-root-relative POSIX path, e.g. "workspace/SOUL.md". */
  readonly relPath: string;
  /** Display label, e.g. "SOUL.md". */
  readonly label: string;
  /** Classification — drives ordering + the always-frozen constitution rule. */
  readonly category: GuidanceCategory;
}

/**
 * Identity / constitution surfaces. These are the frozen signed-manifest files
 * the identity loader reads (never writes) — the UI shows them but exposes no
 * write path. Project-root-relative, lower-cased for comparison.
 */
export const CONSTITUTION_PATHS: readonly string[] = [
  'config/core-identity.md',
  'config/values.json',
  'config/hard-prohibitions.yaml',
];

/**
 * The guidance-file catalog. Workspace files are editable (none fall under
 * PROTECTED_PATHS); constitution files are always frozen and read-only.
 */
export const GUIDANCE_CATALOG: readonly GuidanceFileSpec[] = [
  { name: 'SOUL', relPath: 'workspace/SOUL.md', label: 'SOUL.md', category: 'workspace' },
  { name: 'IDENTITY', relPath: 'workspace/IDENTITY.md', label: 'IDENTITY.md', category: 'workspace' },
  { name: 'USER', relPath: 'workspace/USER.md', label: 'USER.md', category: 'workspace' },
  { name: 'AGENTS', relPath: 'workspace/AGENTS.md', label: 'AGENTS.md', category: 'workspace' },
  { name: 'TOOLS', relPath: 'workspace/TOOLS.md', label: 'TOOLS.md', category: 'workspace' },
  { name: 'MEMORY', relPath: 'workspace/MEMORY.md', label: 'MEMORY.md', category: 'workspace' },
  { name: 'HEARTBEAT', relPath: 'workspace/HEARTBEAT.md', label: 'HEARTBEAT.md', category: 'workspace' },
  { name: 'GROWTH_TRACKER', relPath: 'workspace/GROWTH_TRACKER.md', label: 'GROWTH_TRACKER.md', category: 'workspace' },
  { name: 'LEARNING_JOURNAL', relPath: 'workspace/LEARNING_JOURNAL.md', label: 'LEARNING_JOURNAL.md', category: 'workspace' },
  { name: 'BOOTSTRAP', relPath: 'workspace/BOOTSTRAP.md', label: 'BOOTSTRAP.md', category: 'workspace' },
  // Frozen identity / constitution surfaces — READ-ONLY in the UI, ALWAYS.
  { name: 'core-identity', relPath: 'config/core-identity.md', label: 'core-identity.md', category: 'constitution' },
  { name: 'values', relPath: 'config/values.json', label: 'values.json', category: 'constitution' },
  { name: 'hard-prohibitions', relPath: 'config/hard-prohibitions.yaml', label: 'hard-prohibitions.yaml', category: 'constitution' },
];

/** Normalise a path to POSIX separators for stable comparison. */
function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * True if the given project-root-relative path is FROZEN — a PROTECTED_PATHS
 * entry or a constitution / identity surface. Fails CLOSED: a missing / non-string
 * path is treated as frozen so a resolution gap can never open a write path.
 */
export function isFrozenGuidancePath(relPath: string): boolean {
  if (!relPath || typeof relPath !== 'string') return true; // fail-closed
  const posix = toPosix(relPath);
  if (isProtectedPath(posix)) return true;
  const lower = posix.toLowerCase();
  return CONSTITUTION_PATHS.some((c) => c.toLowerCase() === lower);
}

/** True if the spec is frozen (constitution category OR a frozen path). */
export function isFrozenGuidanceSpec(spec: GuidanceFileSpec): boolean {
  return spec.category === 'constitution' || isFrozenGuidancePath(spec.relPath);
}

/**
 * Resolve a caller-supplied name to a catalog spec, or null. This is the
 * traversal guard: only exact catalog names (case-insensitive) resolve; anything
 * containing a path separator, `..`, a NUL byte, or not in the allow-list is
 * rejected — so a bypassed UI cannot smuggle `../../etc/passwd` through as a name.
 */
export function resolveGuidanceSpec(name: unknown): GuidanceFileSpec | null {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return null;
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..') || trimmed.includes('\x00')) {
    return null;
  }
  const lower = trimmed.toLowerCase();
  return GUIDANCE_CATALOG.find((s) => s.name.toLowerCase() === lower) ?? null;
}

/** Catalog entry decorated with its frozen flag — the list-view shape. */
export interface GuidanceListEntry extends GuidanceFileSpec {
  readonly frozen: boolean;
}

/** The full catalog with each entry's frozen flag resolved (pure). */
export function listGuidanceSpecs(): GuidanceListEntry[] {
  return GUIDANCE_CATALOG.map((s) => ({ ...s, frozen: isFrozenGuidanceSpec(s) }));
}
