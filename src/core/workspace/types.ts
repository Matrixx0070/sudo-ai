/**
 * @file types.ts
 * @description Type definitions for the SUDO-AI workspace module.
 *
 * The workspace is a set of Markdown files stored under workspace/ that define
 * SUDO-AI's identity, knowledge, daily logs, and operational state. These files
 * are human-readable and can be edited directly by the owner.
 */

// ---------------------------------------------------------------------------
// Workspace file names
// ---------------------------------------------------------------------------

/**
 * Canonical set of workspace Markdown file names (without extension).
 * Each maps to workspace/{NAME}.md on disk.
 */
export type WorkspaceFileName =
  | 'SOUL'
  | 'AGENTS'
  | 'USER'
  | 'IDENTITY'
  | 'HEARTBEAT'
  | 'BOOTSTRAP'
  | 'TOOLS'
  | 'GROWTH_TRACKER'
  | 'LEARNING_JOURNAL';

// ---------------------------------------------------------------------------
// File representation
// ---------------------------------------------------------------------------

/** An in-memory snapshot of a workspace file. */
export interface WorkspaceFile {
  /** The canonical file name (without extension). */
  name: WorkspaceFileName;
  /** Full Markdown content of the file. */
  content: string;
  /** When the file was last modified on disk (mtime). */
  lastModified: Date;
}

// ---------------------------------------------------------------------------
// Bootstrap state
// ---------------------------------------------------------------------------

/**
 * Tracks progress through the first-run onboarding dialogue.
 * Stored transiently in memory during a bootstrap run; not persisted to disk
 * (the deletion of BOOTSTRAP.md is the persistent completion signal).
 */
export interface BootstrapState {
  /** Whether the bootstrap sequence has been fully completed. */
  completed: boolean;
  /** Current step index (0-based). */
  step: number;
  /** Collected data keyed by field name (e.g. { name: 'Mark', vibe: 'focused' }). */
  data: Record<string, string>;
}
