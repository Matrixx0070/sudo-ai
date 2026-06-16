/**
 * @file capability-manifest.ts
 * @description Short, terse statement of which tools see what at runtime.
 *
 * Problem this solves (bot's architectural audit, fix #4):
 *   "Sandbox/host split causes silent dead-ends. `system.exec` can't see host
 *   FS, but `meta.self-modify` can. The agent doesn't know this and wastes
 *   turns hitting walls."
 *
 * Approach:
 *   Inject a single static section into the system prompt that maps the
 *   common access mismatches to the right tool. No clever runtime detection
 *   — that's been observed in the wild to produce the same dead-end loops.
 *   The list mirrors the real names from approval-matrix.ts and is kept
 *   short on purpose: a 50-line manifest is just more noise.
 *
 * Toggle:
 *   Set SUDO_CAPABILITY_MANIFEST=0 to skip injection (parity tests, etc).
 *   Default: on.
 */

const MANIFEST_BODY = `These tool boundaries are real — don't burn turns retrying the wrong one:

- **\`system.exec\`** runs inside a hardened sandbox. It has no access to the host filesystem, the sudo-ai-v4 repo, host secrets, or host processes. Use it for shell-style work that operates on its own sandboxed view only.
- **\`meta.self-modify\`** edits files inside the sudo-ai-v4 codebase (the host repo). Use it to read or change any \`src/\`, \`tests/\`, \`config/\`, \`scripts/\` file. Despite the name, this tool is for *writing* source — it is NOT for inspecting current runtime config, enabled channels, model selection, or capabilities; those questions are answered from the system prompt directly.
- **\`meta.self-update\`** triggers a controlled self-update (build + restart) — not for routine code reads or edits.
- **\`coder.*\`** (read / write / edit / glob / grep) targets the user's project workspace, not the sudo-ai-v4 repo. If the goal is to inspect or change SUDO-AI itself, reach for \`meta.self-modify\` instead.

Introspective questions about your own state — "what channels are enabled", "which model are you running", "what tools do you have", "what is your version / config" — are answered from the system prompt and this manifest, NOT by calling tools. Do not invoke \`meta.self-modify\` or any other tool *solely* to discover SUDO-AI's enabled channels, loaded config, model selection, or capability list; if the answer is not in the prompt, say so honestly instead of looping on tool calls. (Legitimate \`system.exec\` use for host-level introspection — "what is the current CPU load", "what shell is active" — is unaffected.)

Heuristic when a path lookup or read silently returns nothing:
- If the path is inside this repo (\`/root/sudo-ai-v4/...\` or \`src/core/...\`), the right tool is \`meta.self-modify\`, not \`system.exec\` and not \`coder.*\`.
- If the path is inside the workspace project, use \`coder.*\`.
- A \`system.exec\` "no such file" on a host repo path is the sandbox refusing — switch tools, don't retry.`;

/** Returns the manifest body with no surrounding header. */
export function getCapabilityManifestBody(): string {
  return MANIFEST_BODY;
}

/**
 * Returns true when the manifest should be included in the system prompt.
 * Defaults to enabled; only disabled when SUDO_CAPABILITY_MANIFEST is the
 * literal string '0'.
 */
export function isCapabilityManifestEnabled(): boolean {
  return process.env['SUDO_CAPABILITY_MANIFEST'] !== '0';
}
