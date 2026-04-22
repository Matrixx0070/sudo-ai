/**
 * @file identity/types.ts
 * @description Type definitions for the operator identity anchor subsystem.
 *
 * The identity loader is pure transport — it reads operator-config files and
 * makes their content available. It never editorialises, enforces, or
 * semantically validates file content.
 */

// ---------------------------------------------------------------------------
// Core shape types
// ---------------------------------------------------------------------------

/** Arbitrary key-value map parsed from values.json. */
export interface ValuesShape {
  [key: string]: unknown;
}

/** List of tool names from hard-prohibitions.yaml (advisory only). */
export type ProhibitionsShape = string[];

// ---------------------------------------------------------------------------
// Identity anchor
// ---------------------------------------------------------------------------

/**
 * Resolved operator identity anchor.
 * Each field is null when the corresponding config file is absent or invalid.
 */
export interface IdentityAnchor {
  /** Raw text content of core-identity.md. */
  identity: string | null;
  /** Parsed object from values.json. */
  values: ValuesShape | null;
  /** Parsed string array from hard-prohibitions.yaml. */
  prohibitions: ProhibitionsShape | null;
}

// ---------------------------------------------------------------------------
// Hook types
// ---------------------------------------------------------------------------

/** Result returned by the advisory pre-tool hook. Always ok:true. */
export interface HookResult {
  ok: boolean;
  /** Optional advisory note — never causes blocking. */
  advisory?: string;
}

/** Minimal descriptor of a tool call passed to verify(). */
export interface ToolCallDescriptor {
  name: string;
  arguments?: Record<string, unknown>;
}

/** Contextual metadata supplied by the agent loop when calling verify(). */
export interface HookContext {
  sessionId: string;
  actor?: string;
}
