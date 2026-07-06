/**
 * @file changed-files.ts
 * @description Pure extraction of file paths mutated by a tool call, so the
 * post-run verifier receives the real change set for the turn instead of an
 * empty list (which makes it abstain).
 */

/** Builtin tools that write or edit files, with per-tool arg shapes below. */
export const FILE_MUTATING_TOOLS: ReadonlySet<string> = new Set([
  'coder.write-file',
  'coder.edit-file',
  'coder.apply-patch',
  'coder.multi-edit',
  'coder.notebook-edit',
]);

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

/** Pull `file` fields out of an operations/edits array argument. */
function filesFromArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const entry of v) {
    if (entry && typeof entry === 'object') {
      const f = asString((entry as Record<string, unknown>)['file']);
      if (f) out.push(f);
    }
  }
  return out;
}

/**
 * Paths a successful call to `toolName` with `args` mutated. Returns [] for
 * non-mutating tools or unrecognized argument shapes — never throws.
 */
export function extractChangedFiles(toolName: string, args: Record<string, unknown>): string[] {
  if (!FILE_MUTATING_TOOLS.has(toolName)) return [];
  switch (toolName) {
    case 'coder.write-file':
    case 'coder.edit-file': {
      const p = asString(args['path']);
      return p ? [p] : [];
    }
    case 'coder.notebook-edit': {
      const f = asString(args['file']);
      return f ? [f] : [];
    }
    case 'coder.apply-patch':
      return filesFromArray(args['operations']);
    case 'coder.multi-edit':
      return filesFromArray(args['edits']);
    default:
      return [];
  }
}
