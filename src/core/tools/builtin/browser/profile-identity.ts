/**
 * @file profile-identity.ts
 * @description Make the profile a browser tool ACTUALLY used visible in its
 * result, on every entry point.
 *
 * Why this exists: when the requested profile dir is held by another live
 * process, `BrowserManager.launch` runs on a per-process fork of it — a
 * different userDataDir, therefore a different cookie jar. `browser.launch`
 * said so in its output; the other twenty-five browser tools did not. A tool
 * that reports "clicked Sign in" while holding an empty session, with no way
 * for the model to tell, is worse than a failure.
 *
 * Rather than editing every leaf tool (and having the next new tool silently
 * miss it), the annotation happens at ONE chokepoint: `withProfileIdentity`
 * wraps a ToolDefinition, and `BROWSER_TOOLS` in index.ts is built from wrapped
 * definitions, so every consumer of that array — the registry, tests, anything
 * else — gets the annotated version.
 *
 * The tool→parameter mapping is an EXPLICIT table, not a heuristic over
 * parameter names: `browser.launch` calls it `profile`/`name`, most leaf tools
 * call it `browser`, and `browser.profiles` / `browser.profile-status` use
 * `name` for something else entirely. A test asserts the table covers every
 * registered browser tool, so a new tool cannot join without a decision.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { BrowserManager, type BrowserInstance } from './browser-manager.js';
import { baseProfileName, isDerivedProfileName } from './profile-registry.js';

/**
 * Which parameter names carry the browser-instance name, in priority order, per
 * tool. An EMPTY list means the tool does not act on a single browser instance
 * (it manages profile dirs, reports on all of them, or does not touch a browser
 * at all) — those get no annotation, deliberately.
 */
export const PROFILE_PARAM_BY_TOOL: Readonly<Record<string, readonly string[]>> = {
  // Instance-scoped tools. Default instance name is 'default' in every one.
  'browser.launch': ['profile', 'name'],
  'browser.navigate': ['browser'],
  'browser.interact': ['browser'],
  'browser.scrape': ['browser'],
  'browser.screenshot': ['browser'],
  'browser.auth': ['browser'],
  'browser.fill-form': ['browser'],
  'browser.captcha': ['browser'],
  'browser.download': ['browser'],
  'browser.tabs': ['browser'],
  'browser.snapshot': ['browser'],
  'browser.click': ['browser'],
  'browser.type': ['browser'],
  'browser.file_upload': ['browser'],
  'browser.wait': ['browser'],
  'browser.mouse': ['browser'],
  'browser.network': ['browser'],
  'browser.console': ['browser'],
  'browser.history': ['browser'],
  'browser.watch': ['profile'],
  'browser.login': ['profile'],
  // Not instance-scoped:
  'browser.profiles': [],       // creates/lists/deletes profile DIRS
  'browser.profile-status': [], // reports every profile itself
  'browser.vision': [],         // analyses an image file
  'browser.search': [],         // HTTP search, no browser instance
  'browser.fetch': [],          // HTTP fetch, no browser instance
};

/** Structured identity attached to every instance-scoped browser tool result. */
export interface ProfileIdentity {
  /** Instance name the caller asked for. */
  requested: string;
  /** Logical profile behind it (a fork resolves to its base). */
  profile: string;
  /** userDataDir actually in use, or `(cdp:…)` for an attached browser. */
  profileDir: string;
  /** True when running on a per-process fork: FRESH cookies, no saved logins. */
  forked: boolean;
  trust?: string;
  ownerOnly?: boolean;
  cdp: boolean;
}

/** The loud, model-readable warning appended when the profile was forked. */
export const FORKED_PROFILE_NOTE =
  'NOTE: the requested browser profile was locked by another live process, so this ran on a ' +
  'PER-PROCESS FORK with a FRESH cookie jar — saved logins for that profile are NOT available ' +
  'here, and anything that looks signed-in is not.';

/** Resolve the instance name a given tool invocation targets. Null = not instance-scoped. */
export function resolveToolProfileName(
  toolName: string,
  params: Record<string, unknown>,
): string | null {
  const keys = PROFILE_PARAM_BY_TOOL[toolName];
  if (!keys || keys.length === 0) return null;
  for (const k of keys) {
    const v = params[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return 'default';
}

/** Build the identity record for a live instance. */
export function describeInstance(requested: string, inst: BrowserInstance): ProfileIdentity {
  const dirName = inst.profileDir.split('/').pop() ?? inst.profileDir;
  const logical = isDerivedProfileName(dirName) ? baseProfileName(dirName) : baseProfileName(requested);
  return {
    requested,
    profile: logical,
    profileDir: inst.profileDir,
    forked: inst.forked === true,
    ...(inst.trust === undefined ? {} : { trust: inst.trust }),
    ...(inst.ownerOnly === undefined ? {} : { ownerOnly: inst.ownerOnly }),
    cdp: inst.cdp === true,
  };
}

/** Merge the identity into a ToolResult without disturbing its existing shape. */
export function annotateResult(result: ToolResult, identity: ProfileIdentity): ToolResult {
  const data = result.data;
  const mergedData =
    data === undefined
      ? { profileIdentity: identity }
      : (data !== null && typeof data === 'object' && !Array.isArray(data))
        ? { ...(data as Record<string, unknown>), profileIdentity: identity }
        // Array/primitive payloads keep their shape; the output note still carries it.
        : data;
  const output = identity.forked && !result.output.includes(FORKED_PROFILE_NOTE)
    ? `${result.output}\n\n${FORKED_PROFILE_NOTE}`
    : result.output;
  return { ...result, output, data: mergedData };
}

/**
 * Wrap a browser ToolDefinition so its result reports the profile it actually
 * used. Non-instance-scoped tools are returned untouched.
 */
export function withProfileIdentity(tool: ToolDefinition): ToolDefinition {
  const keys = PROFILE_PARAM_BY_TOOL[tool.name];
  if (!keys || keys.length === 0) return tool;
  const inner = tool.execute.bind(tool);
  return {
    ...tool,
    async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const result = await inner(params, ctx);
      try {
        const name = resolveToolProfileName(tool.name, params);
        if (!name) return result;
        const inst = BrowserManager.getInstance().get(name);
        if (!inst) return result;
        return annotateResult(result, describeInstance(name, inst));
      } catch {
        // Annotation must never turn a working tool call into a failure.
        return result;
      }
    },
  };
}
