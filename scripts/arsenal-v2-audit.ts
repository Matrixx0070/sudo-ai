/**
 * @file scripts/arsenal-v2-audit.ts
 * @description One-shot harness: invokes `coder.arsenal-v2` in read-only
 * `review` mode against the arsenal-v2 source itself. No disk mutation.
 *
 * Provider creds are loaded from config/.env BEFORE the tool module is
 * imported, since the brain/providers layer reads env at import time.
 *
 * Run: npx tsx scripts/arsenal-v2-audit.ts
 */

import { config as loadEnv } from 'dotenv';
import path from 'node:path';

loadEnv({ path: path.join(process.cwd(), 'config', '.env') });

const TASK = `Review the patch-driven coder module for correctness, edge
cases, and operational robustness. Focus areas:

1. patch-applier — atomic write semantics, drift detection, path
   normalization and project-root confinement, per-file isolation
   guarantees.
2. patch-parser — JSON parsing strictness, behavior on malformed input.
3. recon — file discovery caps, payload byte budgeting.
4. retry-prompt + index.ts loop — behavior on partial parse failure
   mid-retry, off-by-one risks on attemptIdx, what happens when
   applied=0.
5. telemetry + size cap — concurrent-write invariants around truncate,
   line-alignment guarantees, never-throws contract.
6. stats — Pearson/Spearman edge cases (zero variance, ties, NaN
   inputs), Fisher CI math at n=4, mode similarity blend.
7. critic — verdict parser precision and recall.

Be concrete: cite file:line where possible. Prioritize HIGH/MEDIUM/LOW.
Skip style nitpicks; focus on correctness and operational robustness.`;

async function main(): Promise<void> {
  // Dynamic import AFTER dotenv has populated the env — ESM hoists static
  // imports above all top-level code, which would otherwise mean the
  // provider module reads env before dotenv runs.
  const { arsenalV2Tool } = await import('../src/core/tools/builtin/coder/arsenal-v2/index.js');
  const { createLogger } = await import('../src/core/shared/logger.js');
  const { initProviders } = await import('../src/core/brain/providers.js');

  // Populates the provider cache by checking env keys. Without this,
  // buildProvider() returns null and getProvider() throws.
  await initProviders();

  const model = process.env['SUDO_ARSENAL_V2_AUDIT_MODEL'] || 'claude-oauth/claude-sonnet-4-6';
  console.log(`[harness] using model: ${model}`);
  console.log(`[harness] XAI_API_KEY present: ${Boolean(process.env['XAI_API_KEY'])}`);

  const result = await arsenalV2Tool.execute(
    {
      task: TASK,
      mode: 'review',
      files: ['src/core/tools/builtin/coder/arsenal.ts'],
      model,
    },
    {
      sessionId: 'arsenal-audit-verification',
      workingDir: process.cwd(),
      config: {} as unknown,
      logger: createLogger('arsenal-audit-verification') as unknown,
    },
  );

  console.log('===== success =====');
  console.log(result.success);
  console.log('===== output =====');
  console.log(result.output);
  console.log('===== data =====');
  console.log(JSON.stringify(result.data, null, 2));
}

main().catch((err) => {
  console.error('audit failed:', err);
  process.exit(1);
});
