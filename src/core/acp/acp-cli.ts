/**
 * @file acp/acp-cli.ts
 * @description ACP (Agent Client Protocol) stdio agent entrypoint — preloader.
 *
 * stdout is the JSON-RPC protocol channel and MUST stay clean. This thin
 * preloader sets the env that routes human logs to stderr (SUDO_LOG_STDERR) and
 * silences dotenv's stdout banner (DOTENV_CONFIG_QUIET) BEFORE the logger /
 * config modules are imported, then hands off to ./acp-main.js via a dynamic
 * import so those env vars are honored at the modules' load time.
 *
 * Editors launch `node dist/core/acp/acp-cli.js` directly, so this must run
 * in-process — it can't rely on the `pnpm acp` script's environment. This file
 * has NO static imports so the env assignments below execute first.
 */

process.env['SUDO_LOG_STDERR'] = process.env['SUDO_LOG_STDERR'] ?? '1';
process.env['DOTENV_CONFIG_QUIET'] = process.env['DOTENV_CONFIG_QUIET'] ?? 'true';

import('./acp-main.js')
  .then((m) => m.runAcpServer())
  .catch((err: unknown) => {
    process.stderr.write(`[acp] Fatal error: ${String(err)}\n`);
    process.exit(1);
  });
