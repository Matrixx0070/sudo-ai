#!/usr/bin/env node
/**
 * @file cli/index.ts
 * @description SUDO-AI CLI entry point.
 *
 * Registers all sub-commands via commander and dispatches to the appropriate
 * handler. This file is compiled to dist/cli/index.js and exposed as the
 * `sudo-ai` binary via package.json "bin".
 *
 * Commands:
 *   sudo-ai start [--daemon]   Boot the full SUDO-AI stack
 *   sudo-ai stop               Gracefully stop a running instance
 *   sudo-ai status             Show running status and health
 *   sudo-ai config             Validate or inspect configuration
 *   sudo-ai doctor             Run comprehensive environment checks
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { config as loadDotenv } from 'dotenv';
import { APP_VERSION } from '../core/shared/constants.js';
import { PROJECT_ROOT } from '../core/shared/paths.js';
import { registerGrokEmbeddings } from './commands/grok-embeddings.js';
import { registerGrokRag } from './commands/grok-rag.js';
import { registerGrokFiles } from './commands/grok-files.js';
import { registerGrokMemory } from './commands/grok-memory.js';
import { registerGrokSkills } from './commands/grok-skills.js';
import { registerGrokMediaExtras } from './commands/grok-media-extras.js';
import { registerGrokAutomations } from './commands/grok-automations.js';
import { registerGrokWorkspaces } from './commands/grok-workspaces.js';

// ---------------------------------------------------------------------------
// Bundler path overrides — ESM bundle __dirname fix
//
// esbuild inlines pino and thread-stream as __commonJS wrappers.  Those
// wrappers reference __dirname in their closures, but esbuild does NOT inject
// __dirname into __commonJS callbacks when outputting ESM.
//
// pino checks globalThis.__bundlerPathsOverrides BEFORE falling back to
// __dirname, so injecting it here — before any lazy __esm init (config/loader,
// brain, etc.) can fire pino.transport() — permanently prevents the
// ReferenceError: __dirname is not defined crash.
//
// The build:cli banner injects:
//   import { createRequire } from 'module'; const require = createRequire(import.meta.url);
// We must NOT re-import createRequire (duplicate ESM identifier error).
// Instead we declare the banner-injected `require` as ambient.
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const require: NodeRequire;  // provided by esbuild banner

(function injectPinoBundlerPaths() {
  if (typeof globalThis !== 'object' || '__bundlerPathsOverrides' in globalThis) return;
  try {
    // thread-stream is a nested dep of pino under pnpm and is NOT directly
    // resolvable from the bundle entry.  In pnpm's virtual store, all deps of
    // a package sit as siblings: <store>/pino@x/node_modules/{pino,thread-stream,...}
    // so we find thread-stream relative to pino's own directory.
    const pinoMain  = require.resolve('pino');
    const pinoDir   = path.dirname(pinoMain);                     // …/node_modules/pino
    const tsWorker  = path.resolve(pinoDir, '..', 'thread-stream', 'lib', 'worker.js');

    (globalThis as Record<string, unknown>)['__bundlerPathsOverrides'] = {
      'pino-worker':          require.resolve('pino/lib/worker.js'),
      'thread-stream-worker': tsWorker,
      'pino/file':            require.resolve('pino/file.js'),
      'pino-pretty':          require.resolve('pino-pretty'),
    };
  } catch {
    // Non-fatal — pino will fall back to __dirname at runtime; log dir issues
    // will surface naturally.
  }
}());
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Project root resolution
// ---------------------------------------------------------------------------

/**
 * Install root: where this checkout lives (../../ from src/ or dist/cli/).
 * Used only by commands operating on the installation itself (`start` spawns
 * src/cli.ts with the local tsx; `update` runs git against the checkout and
 * reads its package.json). All other commands (config, doctor, scan,
 * quickstart, init) use the SUDO_AI_HOME-aware PROJECT_ROOT from
 * core/shared/paths.ts, so a global install targets the user's project dir.
 */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const INSTALL_ROOT = path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// Program definition
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name('sudo-ai')
  .description('SUDO-AI — Autonomous AI Agent Platform')
  .version(APP_VERSION, '-v, --version', 'Print version number');

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

program
  .command('start')
  .description('Boot the full SUDO-AI stack')
  .option('-d, --daemon', 'Run as a background daemon (detached process)', false)
  .action(async (opts: { daemon: boolean }) => {
    if (opts.daemon) {
      const { runStartDaemon } = await import('./commands/start.js');
      await runStartDaemon(INSTALL_ROOT);
    } else {
      const { runStartForeground } = await import('./commands/start.js');
      await runStartForeground(INSTALL_ROOT);
    }
  });

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

program
  .command('stop')
  .description('Gracefully stop a running SUDO-AI instance')
  .action(async () => {
    const { runStop } = await import('./commands/stop.js');
    const code = await runStop();
    process.exit(code);
  });

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

program
  .command('status')
  .description('Show current SUDO-AI running status and API health')
  .action(async () => {
    const { runStatus } = await import('./commands/status.js');
    const code = await runStatus();
    process.exit(code);
  });

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

const configCmd = program
  .command('config')
  .description('Inspect or validate the SUDO-AI configuration');

configCmd
  .option('--validate', 'Load and validate config/sudo-ai.json5, exit 0/1')
  .option('--path', 'Print the resolved config file path')
  .action(async (opts: { validate?: boolean; path?: boolean }) => {
    const { runConfigValidate, runConfigPath } = await import('./commands/config.js');

    if (opts.validate) {
      const code = await runConfigValidate(PROJECT_ROOT);
      process.exit(code);
    } else if (opts.path) {
      runConfigPath(PROJECT_ROOT);
    } else {
      // Default: show both.
      runConfigPath(PROJECT_ROOT);
      const code = await runConfigValidate(PROJECT_ROOT);
      process.exit(code);
    }
  });

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

program
  .command('doctor')
  .description('Run comprehensive environment health checks')
  .option('--fix', 'Auto-remediate issues where possible', false)
  .action(async (opts: { fix?: boolean }) => {
    const { runDoctor } = await import('./commands/doctor.js');
    const code = await runDoctor(PROJECT_ROOT, { fix: opts.fix ?? false });
    process.exit(code);
  });

// ---------------------------------------------------------------------------
// bench
// ---------------------------------------------------------------------------

program
  .command('bench')
  .description('Run model × task benchmark sweep and print report')
  .option('--models <list>',     'Comma-separated model IDs to benchmark')
  .option('--tasks <list>',      'Comma-separated task IDs (default: all 5 built-in)')
  .option('--conditions <list>', 'Comma-separated conditions: no_skills,skills_on,skills_optimized')
  .option('--seeds <n>',         'Number of random seeds per cell (default: 1)')
  .option('--output <fmt>',      'Output format: markdown | json (default: markdown)', 'markdown')
  .action(async (opts: { models?: string; tasks?: string; conditions?: string; seeds?: string; output?: string }) => {
    const { runBench } = await import('./commands/bench.js');
    const code = await runBench(opts);
    process.exit(code);
  });

// ---------------------------------------------------------------------------
// flywheel-verify (implemented in commands/flywheel-verify.ts)
// ---------------------------------------------------------------------------

program
  .command('flywheel-verify')
  .description('Run the repair-flywheel LIVE A/B on captured failures (dry by default; --confirm spends tokens)')
  .option('--tool <name>', 'Tool cluster to verify', 'system.exec')
  .option('--max <n>',     'Max live rewrites to spend (cost ceiling)', '20')
  .option('--confirm',     'Actually spend tokens and run the live A/B', false)
  .option('--admit',       'On an adopt decision, enter the lesson into the canary lifecycle', false)
  .option('--json',        'Emit the result as JSON', false)
  .action(async (opts: { tool?: string; max?: string; confirm?: boolean; admit?: boolean; json?: boolean }) => {
    const { runFlywheelVerify } = await import('./commands/flywheel-verify.js');
    const code = await runFlywheelVerify(opts);
    process.exit(code);
  });

// ---------------------------------------------------------------------------
// scan (implemented in commands/scan.ts)
// ---------------------------------------------------------------------------

program
  .command('scan')
  .description('Security scan: token strength, env leaks, config permissions')
  .option('--json', 'Output results as JSON instead of table', false)
  .action(async (opts: { json?: boolean }) => {
    try {
      const { runScan } = await import('./commands/scan.js');
      const code = await runScan(PROJECT_ROOT, opts);
      process.exit(code);
    } catch (err) {
      console.error('[sudo-ai] scan failed:', err);
      console.error('[sudo-ai] scan command not yet available (Builder 3 pending)');
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// quickstart (implemented in commands/quickstart.ts)
// ---------------------------------------------------------------------------

program
  .command('quickstart')
  .description('Interactive 5-step setup wizard (non-interactive with --yes or when piped)')
  .option('--force', 'Overwrite existing config without prompting', false)
  .option('--yes', 'Non-interactive: accept all defaults (auto-on when stdin is not a TTY)', false)
  .action(async (opts: { force?: boolean; yes?: boolean }) => {
    try {
      const { runQuickstart } = await import('./commands/quickstart.js');
      await runQuickstart(PROJECT_ROOT, { force: opts.force ?? false, yes: opts.yes ?? false });
      process.exit(0);
    } catch (err) {
      console.error('[sudo-ai] quickstart failed:', err);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// init (implemented in commands/init.ts)
// ---------------------------------------------------------------------------

program
  .command('init')
  .description('Apply a preset recipe to the current workspace')
  .option('--preset <name>', 'Preset name: coding | research | chat')
  .option('--force', 'Overwrite existing config without prompting', false)
  .action(async (opts: { preset?: string; force?: boolean }) => {
    try {
      const { runInit } = await import('./commands/init.js');
      const code = await runInit(PROJECT_ROOT, opts);
      process.exit(code);
    } catch (err) {
      console.error('[sudo-ai] init failed:', err);
      if (opts.preset) {
        process.exit(1);
      } else {
        console.log('Available presets: coding, research, chat');
        process.exit(0);
      }
    }
  });

// ---------------------------------------------------------------------------
// chat — terminal TUI streaming conversation with Claude
// ---------------------------------------------------------------------------

program
  .command('chat')
  .description('Interactive streaming chat with Claude in the terminal')
  .action(async () => {
    const { runChat } = await import('./commands/chat.js');
    await runChat();
  });

// ---------------------------------------------------------------------------
// claude-oauth — Claude.ai subscription OAuth (PKCE) connector
// ---------------------------------------------------------------------------

const claudeOauthCmd = program
  .command('claude-oauth')
  .description('Manage Claude.ai subscription OAuth (PKCE) — login, status, refresh, disconnect');

claudeOauthCmd
  .command('login')
  .description('Run the PKCE OAuth flow — prints URL, accepts pasted code')
  .action(async () => {
    const { runClaudeOAuthLogin } = await import('./commands/claude-oauth.js');
    process.exit(await runClaudeOAuthLogin());
  });

claudeOauthCmd
  .command('status')
  .description('Show whether sudo-ai has a usable Claude OAuth token')
  .action(async () => {
    const { runClaudeOAuthStatus } = await import('./commands/claude-oauth.js');
    process.exit(await runClaudeOAuthStatus());
  });

claudeOauthCmd
  .command('refresh')
  .description('Force a Claude OAuth token refresh now')
  .action(async () => {
    const { runClaudeOAuthRefresh } = await import('./commands/claude-oauth.js');
    process.exit(await runClaudeOAuthRefresh());
  });

claudeOauthCmd
  .command('disconnect')
  .description('Wipe stored Claude OAuth credentials')
  .action(async () => {
    const { runClaudeOAuthDisconnect } = await import('./commands/claude-oauth.js');
    process.exit(await runClaudeOAuthDisconnect());
  });

claudeOauthCmd
  .command('models')
  .description('List Claude models available to the connected account')
  .option('--refresh', 'Force a live fetch instead of using the cached list', false)
  .action(async (opts: { refresh?: boolean }) => {
    const { runClaudeOAuthModels } = await import('./commands/claude-oauth.js');
    process.exit(await runClaudeOAuthModels(opts.refresh ?? false));
  });

claudeOauthCmd
  .command('set-model <id>')
  .description('Set the default Claude model used by the brain router')
  .action(async (id: string) => {
    const { runClaudeOAuthSetModel } = await import('./commands/claude-oauth.js');
    process.exit(await runClaudeOAuthSetModel(id));
  });

// ---------------------------------------------------------------------------
// xai-oauth — xAI subscription OAuth (device flow) connector
// ---------------------------------------------------------------------------

const xaiOauthCmd = program
  .command('xai-oauth')
  .description('Manage xAI subscription OAuth (device flow) — login, status');

xaiOauthCmd
  .command('login')
  .description('Run the device-code OAuth flow — prints URL + code, waits for approval')
  .action(async () => {
    const { runXaiOAuthLogin } = await import('./commands/xai-oauth.js');
    process.exit(await runXaiOAuthLogin());
  });

xaiOauthCmd
  .command('status')
  .description('Show whether sudo-ai has a usable xAI OAuth token')
  .action(async () => {
    const { runXaiOAuthStatus } = await import('./commands/xai-oauth.js');
    process.exit(await runXaiOAuthStatus());
  });

xaiOauthCmd
  .command('models')
  .description('List Grok models available to the connected OAuth seat (subscription-covered)')
  .option('--refresh', 'Force a live fetch instead of the cached list', false)
  .action(async (opts: { refresh?: boolean }) => {
    const { runXaiOAuthModels } = await import('./commands/xai-oauth.js');
    process.exit(await runXaiOAuthModels(opts.refresh ?? false));
  });

xaiOauthCmd
  .command('set-model <id>')
  .description('Set the default xai-oauth Grok model')
  .action(async (id: string) => {
    const { runXaiOAuthSetModel } = await import('./commands/xai-oauth.js');
    process.exit(await runXaiOAuthSetModel(id));
  });

// ---------------------------------------------------------------------------
// xai apikey — metered xAI API-key provider (independent of xai-oauth)
// ---------------------------------------------------------------------------

const xaiCmd = program
  .command('xai')
  .description('Manage the metered xAI API-key provider (metered Grok API)');

const xaiApikeyCmd = xaiCmd
  .command('apikey')
  .description('Set/list the xAI API key and pick a default metered Grok model');

xaiApikeyCmd
  .command('set')
  .description('Paste + store an xAI API key (validated by a live model list)')
  .action(async () => {
    const { runXaiApiKeySet } = await import('./commands/xai-apikey.js');
    process.exit(await runXaiApiKeySet());
  });

xaiApikeyCmd
  .command('status')
  .description('Show whether an xAI API key is set + the active default model')
  .action(async () => {
    const { runXaiApiKeyStatus } = await import('./commands/xai-apikey.js');
    process.exit(await runXaiApiKeyStatus());
  });

xaiApikeyCmd
  .command('models')
  .description('List Grok models for the metered API key (pay-per-token)')
  .option('--refresh', 'Force a live fetch instead of the cached list', false)
  .action(async (opts: { refresh?: boolean }) => {
    const { runXaiApiKeyModels } = await import('./commands/xai-apikey.js');
    process.exit(await runXaiApiKeyModels(opts.refresh ?? false));
  });

xaiApikeyCmd
  .command('set-model <id>')
  .description('Set the default metered xai Grok model')
  .action(async (id: string) => {
    const { runXaiApiKeySetModel } = await import('./commands/xai-apikey.js');
    process.exit(await runXaiApiKeySetModel(id));
  });

xaiApikeyCmd
  .command('disconnect')
  .description('Wipe the stored xAI API key (XAI_API_KEY env, if set, is kept)')
  .action(async () => {
    const { runXaiApiKeyDisconnect } = await import('./commands/xai-apikey.js');
    process.exit(await runXaiApiKeyDisconnect());
  });

// ---------------------------------------------------------------------------
// grok — unified provider-management view across both Grok methods (GP5)
// ---------------------------------------------------------------------------

const grokCmd = program
  .command('grok')
  .description('Show both Grok providers (xai-oauth + xai) — status, default model, billing');

// Hydrate config/.env so `grok` subcommands honor SUDO_GROK_* flags (media
// enablement, warm-browser config) exactly like the daemon does. dotenv does not
// override already-set vars, so an inline env still wins.
grokCmd.hook('preAction', () => {
  loadDotenv({ path: path.resolve(PROJECT_ROOT, 'config', '.env'), quiet: true });
});

grokCmd.command('status', { isDefault: true }).description('Provider-management view across both Grok methods')
  .action(async () => process.exit(await (await import('./commands/grok.js')).runGrokStatus()));

// GW5 — subscription-free media on the captured Grok web session (flag: SUDO_GROK_WEBSESSION)
grokCmd
  .command('image <prompt>')
  .description('Generate image(s) FREE on your Grok subscription (web session). Needs SUDO_GROK_WEBSESSION=1')
  .option('--aspect <ratio>', 'Aspect ratio, e.g. 1:1, 9:16, 16:9 (default 1:1)')
  .option('--num <n>', 'Number of images (default 1)', (v) => parseInt(v, 10))
  .option('--pro', 'Use the imagePro tier')
  .action(async (prompt: string, opts: { aspect?: string; num?: number; pro?: boolean }) => {
    const { runGrokImage } = await import('./commands/grok.js');
    const a: { aspect?: string; num?: number; pro?: boolean } = {};
    if (opts.aspect) a.aspect = opts.aspect;
    if (opts.num) a.num = opts.num;
    if (opts.pro) a.pro = true;
    process.exit(await runGrokImage(prompt, a));
  });

grokCmd
  .command('video <prompt>')
  .description('Generate a video FREE on your Grok subscription via the statsig oracle. Needs SUDO_GROK_WEBSESSION=1')
  .option('--image <url>', 'Source image public URL for image-to-video (default: text-to-video)')
  .option('--aspect <ratio>', 'Aspect ratio (default 9:16)')
  .option('--length <sec>', 'Video length seconds (default 6)', (v) => parseInt(v, 10))
  .option('--res <name>', 'Resolution, e.g. 720p (default 720p)')
  .action(async (prompt: string, opts: { aspect?: string; length?: number; res?: string; image?: string }) => {
    const { runGrokVideo } = await import('./commands/grok.js');
    const a: { aspect?: string; length?: number; res?: string; image?: string } = {};
    if (opts.image) a.image = opts.image;
    if (opts.aspect) a.aspect = opts.aspect;
    if (opts.length) a.length = opts.length;
    if (opts.res) a.res = opts.res;
    process.exit(await runGrokVideo(prompt, a));
  });

// Path A — realtime voice with grok's own voice agent over LiveKit (seat-covered)
grokCmd.command('voice <input>')
  .description('One realtime voice turn with grok\'s voice agent over LiveKit — FREE on your subscription. Speaks <input> audio, saves the spoken reply. Needs SUDO_GROK_WEBSESSION=1')
  .option('--seconds <n>', 'Seconds to capture the reply (default 12)', (v) => parseInt(v, 10)).option('--out <path>', 'Where to write the reply WAV (default /tmp/grok-voice-reply-*.wav)')
  .action(async (input: string, opts: { seconds?: number; out?: string }) => process.exit(await (await import('./commands/grok-voice.js')).runGrokVoice(input, opts)));

grokCmd.command('converse <inputs...>')
  .description('PERSISTENT multi-turn realtime conversation with grok\'s voice agent over one LiveKit connection (context persists). Speaks each input WAV; saves reply-<i>.wav. Needs SUDO_GROK_WEBSESSION=1')
  .option('--out <prefix>', 'Reply path prefix (default /tmp/grok-converse-reply)')
  .action(async (inputs: string[], opts: { out?: string }) => process.exit(await (await import('./commands/grok-voice.js')).runGrokConverse(inputs, opts)));

grokCmd.command('models').option('--limits <model>', 'Show rate limits for one model instead of the catalog')
  .description('Seat model catalog + tier defaults, FREE on your subscription (cookie lane). --limits <model> shows remaining/total query windows. Needs SUDO_GROK_WEBSESSION=1')
  .action(async (o: { limits?: string }) => process.exit(await (await import('./commands/grok-models.js')).runGrokModels(o)));
registerGrokEmbeddings(grokCmd); registerGrokRag(grokCmd); // FREE embedding RAG collections + grounded doc RAG
registerGrokFiles(grokCmd); // FREE persistent file upload/info/download (app-chat file lane)
registerGrokMemory(grokCmd); registerGrokMediaExtras(grokCmd); // FREE memory read + video upscale/caption on the seat
registerGrokAutomations(grokCmd); registerGrokSkills(grokCmd); registerGrokWorkspaces(grokCmd); // FREE automations + seat skills + READ-ONLY workspaces (owner-only)

grokCmd.command('run-code').description('Run code in grok\'s server-side interpreter, FREE on your seat. Prints executed stdout/stderr (exit 1 on runtime error). Needs the xai-oauth seat.')
  .option('--lang <lang>', 'Language: python only (sandbox is a Python REPL; others rejected)').option('--code <code>', 'Inline code to execute').option('--file <path>', 'Read code from a file (else stdin)')
  .action(async (opts: { lang?: string; code?: string; file?: string }) => process.exit(await (await import('./commands/grok-runcode.js')).runGrokRunCode(opts)));

grokCmd.command('websession').description('Grok web-session status (subscription-free media capture health)').action(async () => process.exit(await (await import('./commands/grok.js')).runGrokWebsessionStatus()));

// ---------------------------------------------------------------------------
// voice — turn-based voice conversation (audio → STT → agent → TTS → audio)
// ---------------------------------------------------------------------------

const voiceCmd = program
  .command('voice')
  .description('Turn-based voice conversation utilities');

// Hydrate config/.env so `--stt grok` / `--tts grok` honor SUDO_GROK_WEBSESSION
// exactly like the daemon does (dotenv does not override already-set vars).
voiceCmd.hook('preAction', () => {
  loadDotenv({ path: path.resolve(PROJECT_ROOT, 'config', '.env'), quiet: true });
});

voiceCmd
  .command('turn <audio>')
  .description('Run one voice turn: transcribe <audio>, get an agent reply, synthesise it back to audio')
  .option('--stt <provider>', 'STT provider: whisper-local (default), groq, elevenlabs, openai, grok')
  .option('--tts <provider>', 'TTS provider: kokoro (default), elevenlabs, xai, openai, grok')
  .option('--voice <name>', 'TTS voice override (provider-specific)')
  .option('--language <code>', 'STT language hint (BCP-47, e.g. en)')
  .option('--model <alias>', 'LLM alias for the reply (default sudo/cheap)')
  .option('--out <path>', 'Where to write the reply audio (default: /tmp/sudo-ai-voice-turn-*.wav)')
  .option('--echo', 'Skip the LLM — reply with the transcript itself (zero-spend pipeline check)')
  .action(async (audio: string, opts: { stt?: string; tts?: string; voice?: string; language?: string; model?: string; out?: string; echo?: boolean }) => {
    const { runVoiceTurnCli } = await import('./commands/voice.js');
    process.exit(await runVoiceTurnCli(audio, opts));
  });

voiceCmd
  .command('stream <audio>')
  .description('Stream an audio file through the VAD session: segment utterances, run a turn per utterance, support barge-in (a live mic is the same pipeline with the frame source swapped)')
  .option('--stt <provider>', 'STT provider (default whisper-local; grok for the free seat)')
  .option('--tts <provider>', 'TTS provider (default kokoro; grok for the free seat)')
  .option('--voice <name>', 'TTS voice override (provider-specific)')
  .option('--language <code>', 'STT language hint (BCP-47, e.g. en)')
  .option('--model <alias>', 'LLM alias for replies (default sudo/cheap)')
  .option('--threshold <n>', 'VAD energy threshold 0..1 (default 0.02)', (v) => parseFloat(v))
  .option('--out <path>', 'Output audio path prefix (default: /tmp/sudo-ai-voice-stream-*.wav)')
  .option('--echo', 'Skip the LLM — reply with the transcript itself (zero-spend pipeline check)')
  .action(async (audio: string, opts: { stt?: string; tts?: string; voice?: string; language?: string; model?: string; threshold?: number; out?: string; echo?: boolean }) => {
    const { runVoiceStreamCli } = await import('./commands/voice.js');
    process.exit(await runVoiceStreamCli(audio, opts));
  });

// ---------------------------------------------------------------------------
// secrets — audit / apply / configure SecretRef indirect secrets
// ---------------------------------------------------------------------------

const secretsCmd = program
  .command('secrets')
  .description('Audit, resolve, and configure SecretRef indirect secrets (never prints values)');

secretsCmd
  .command('audit')
  .description('Report credential posture + findings (I90 reuse, short token). Read-only; exit 2 on CRITICAL')
  .action(async () => {
    const { runSecretsAudit } = await import('./commands/secrets.js');
    process.exit(await runSecretsAudit(PROJECT_ROOT));
  });

secretsCmd
  .command('apply')
  .description('Resolve every declared <NAME>_REF in config/.env and report OK/FAIL (preview only)')
  .option('--dry-run', 'Preview only (default; activation requires a daemon restart)')
  .option('--allow-exec', 'Allow exec-source SecretRefs to run during the preview')
  .action(async (opts: { allowExec?: boolean }) => {
    const { runSecretsApply } = await import('./commands/secrets.js');
    process.exit(await runSecretsApply(PROJECT_ROOT, { allowExec: opts.allowExec }));
  });

secretsCmd
  .command('configure')
  .description('Build a <NAME>_REF SecretRef line; --write appends it to config/.env (with backup)')
  .requiredOption('--name <NAME>', 'Credential env var name (e.g. GATEWAY_TOKEN)')
  .requiredOption('--source <source>', 'SecretRef source: env | file | exec')
  .requiredOption('--id <id>', 'Source id (env var name, absolute file path[#selector], or command)')
  .option('--provider <provider>', 'Provider slug (^[a-z][a-z0-9_-]*$)', 'default')
  .option('--write', 'Append the line to config/.env (backup to config/.env.bak)')
  .option('--force', 'Overwrite an existing differing <NAME>_REF value')
  .action(async (opts: { name?: string; source?: string; id?: string; provider?: string; write?: boolean; force?: boolean }) => {
    const { runSecretsConfigure } = await import('./commands/secrets.js');
    process.exit(runSecretsConfigure(PROJECT_ROOT, opts));
  });

// ---------------------------------------------------------------------------
// gdrive — Drive memory-substrate operator commands (status/knew-at/bisect/resume)
// ---------------------------------------------------------------------------

const gdriveCmd = program
  .command('gdrive')
  .description('Google Drive memory substrate: status, knew-at (F31), bisect (F9), resume (F35)');

gdriveCmd
  .command('status')
  .description('Live health snapshot: auth mode, tree, brain counter, heartbeat age, canaries, pause')
  .action(async () => {
    const { runGdriveStatus } = await import('./commands/gdrive.js');
    process.exit(await runGdriveStatus());
  });

gdriveCmd
  .command('knew-at <timestamp>')
  .description('Reconstruct what the brain knew at an ISO-8601 moment (F31 bitemporal chronicle)')
  .option('--path <logicalPath>', 'Report only whether this memory was known at that time')
  .action(async (timestamp: string, opts: { path?: string }) => {
    const { runGdriveKnewAt } = await import('./commands/gdrive.js');
    process.exit(await runGdriveKnewAt(timestamp, opts));
  });

gdriveCmd
  .command('bisect')
  .description('Find the manifest revision where a memory first changed (F9 memory bisection)')
  .requiredOption('--path <logicalPath>', 'The memory (logical path) to trace')
  .action(async (opts: { path?: string }) => {
    const { runGdriveBisect } = await import('./commands/gdrive.js');
    process.exit(await runGdriveBisect(opts));
  });

gdriveCmd
  .command('resume <taskId>')
  .description('Load + claim a hibernated task from tasks/active/ (F35 task hibernation)')
  .action(async (taskId: string) => {
    const { runGdriveResume } = await import('./commands/gdrive.js');
    process.exit(await runGdriveResume(taskId));
  });

// ---------------------------------------------------------------------------
// notebooklm — NotebookLM annex (status / export-incident / export-studypack)
// ---------------------------------------------------------------------------

const nlmCmd = program
  .command('notebooklm')
  .description('NotebookLM annex: status, export-incident (F43), export-studypack (F45)');

nlmCmd
  .command('status')
  .description('Annex health: folders, registered shapes, ritual budget')
  .action(async () => {
    const { runNlmStatus } = await import('./commands/notebooklm.js');
    process.exit(await runNlmStatus());
  });

nlmCmd
  .command('export-incident <bundleId>')
  .description('Export a redacted incident pack from a flight-recorder bundle (F43)')
  .action(async (bundleId: string) => {
    const { runNlmExportIncident } = await import('./commands/notebooklm.js');
    process.exit(await runNlmExportIncident(bundleId));
  });

nlmCmd
  .command('export-studypack <topic>')
  .description('Export a study pack (question + zone-2 context) for a topic (F45)')
  .action(async (topic: string) => {
    const { runNlmExportStudypack } = await import('./commands/notebooklm.js');
    process.exit(await runNlmExportStudypack(topic));
  });

// ---------------------------------------------------------------------------
// update — check for and apply SUDO-AI updates
// ---------------------------------------------------------------------------

program
  .command('update')
  .description('Check for and apply SUDO-AI updates')
  .option('--check', 'Only check for available updates (do not apply)')
  .option('--channel <channel>', 'Update channel: latest or stable', 'latest')
  .option('--rollback', 'Rollback to the previous version')
  .option('--status', 'Show current version and update history')
  .action(async (opts: { check?: boolean; channel?: string; rollback?: boolean; status?: boolean }) => {
    const { runUpdate } = await import('./commands/update.js');
    const code = await runUpdate(INSTALL_ROOT, opts);
    // Close the pino worker transport before exiting — otherwise its process
    // 'exit' flush hook throws "_flushSync took too long (10s)" (see
    // core/shared/logger.ts closeLogger).
    try {
      const { closeLogger } = await import('../core/shared/logger.js');
      await closeLogger();
    } catch { /* logger unavailable — nothing to tear down */ }
    process.exit(code);
  });

// ---------------------------------------------------------------------------
// Parse args
// ---------------------------------------------------------------------------

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[sudo-ai] Fatal error: ${msg}`);
  process.exit(1);
});
