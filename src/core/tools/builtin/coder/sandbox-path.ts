/**
 * @file sandbox-path.ts
 * @description Shared path-resolver for coder.* tools that run inside the
 * bwrap sandbox but need to reach host source files.
 *
 * Pattern: tools resolve user-supplied relative paths against
 * `ctx.workingDir`, which is a per-session sandbox dir under
 * `<host-project>/workspace/sessions/<sid>/`. The host source tree is
 * NOT bind-mounted into that namespace, so a relative path like
 * "src/cli.ts" resolves to a missing path inside the sandbox. Each tool
 * had been reimplementing the fallback ad hoc (#223 read-file,
 * #236 grep). This module is the single source of truth.
 *
 * Used by: coder.grep, coder.glob, coder.debugger (#237). coder.read-file
 * still has its own bespoke fallback for legacy reasons but matches the
 * same semantics.
 */

import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * Resolve `inputPath` against `workingDir` first. If the result doesn't
 * exist AND `workingDir` is a workspace-session sandbox, retry against
 * the host project root (derived by stripping the
 * `/workspace/sessions/...` tail). On both misses, return the original
 * resolved path so the caller's downstream stat() throws the same error
 * users would have seen before — no behaviour change for genuinely-
 * missing paths.
 */
export async function resolveSandboxOrHostPath(
  workingDir: string,
  inputPath: string,
): Promise<string> {
  const primary = resolve(workingDir, inputPath);
  try {
    await stat(primary);
    return primary;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') return primary;
    if (!/\/workspace\/sessions\//.test(workingDir)) return primary;
    const projectRoot = workingDir.replace(/\/workspace\/sessions\/.*/, '');
    const fallback = resolve(projectRoot, inputPath);
    try {
      await stat(fallback);
      return fallback;
    } catch {
      return primary;
    }
  }
}
