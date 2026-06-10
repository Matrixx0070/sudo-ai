/**
 * synth-bwrap-entry.cjs — CommonJS bwrap sandbox entry for synthesized tool evaluation.
 *
 * This file MUST be .cjs because:
 *   - The project uses "type": "module" (ESM)
 *   - Child process scripts inherit ESM mode unless explicitly .cjs
 *
 * Communication:
 *   Input:  process.argv[2] = quarantine path (inside sandbox: /sandbox/quarantine.ts)
 *   Output: single line of JSON written to stdout + newline, then process exits
 *
 *   Output shape:
 *     | { ok: true; toolNames: string[] }
 *     | { ok: false; errorCode: string; errorName: string; phase: 'import' | 'exec' }
 *
 * The entry script attempts to dynamically import the quarantine .ts file (tsx loader
 * pre-registered via --import flag), extract registered tool names, and run a test
 * execution. All results are communicated via a single JSON line to stdout.
 *
 * Security:
 *   - process.env is scrubbed before synthesized code runs (Fix A: closes H1/H2/H3).
 *     Even if code does process.env.SECRET / process['env'] / globalThis.process.env,
 *     it gets undefined because the env map is empty.
 *   - Error strings are NOT emitted to stdout (Fix B: closes H1 exfil channel).
 *     Only generic errorCode + errorName are sent; the raw String(err) never leaves
 *     the sandbox, so a throw-based exfil attempt carries no information.
 */

'use strict';

function clampErrorName(n) {
  const raw = (n != null && typeof n === 'string') ? n
              : (n != null ? String(n) : 'Error');
  return raw.replace(/[^A-Za-z0-9_]/g, '').slice(0, 32) || 'Error';
}

const { pathToFileURL } = require('url');
const fs = require('fs');
const path = require('path');

const quarantinePath = process.argv[2];

/**
 * Pre-compile: read and esbuild-transform the quarantine TypeScript AS ROOT,
 * before setuid(65534). Writes compiled JS to /workspace/quarantine.mjs.
 *
 * Root cause fixed: /root is drwx------ (0700). After setuid(65534), UID 65534
 * cannot traverse /root, so the esbuild Go binary at
 * node_modules/.pnpm/@esbuild+linux-x64@.../bin/esbuild is inaccessible.
 * tsx calls esbuild for .ts extensions → esbuild hangs → 8000ms test timeout.
 *
 * Solution: transform the .ts source to plain ESM while still running as root
 * (esbuild reachable), write result to writable /workspace/quarantine.mjs
 * (chmod 0644), then import the .mjs file after setuid — no esbuild needed.
 */
function precompileQuarantine() {
  const src = fs.readFileSync(quarantinePath, 'utf8');
  let compiled = src;
  try {
    // Resolve via the node_modules embedded in the sandbox via --ro-bind.
    // buildSynthBwrapArgs binds the host node_modules at its host-resolved
    // path, and this entry file is bound at its own host path, so the same
    // 5-levels-up resolution tool-synthesize.ts uses for the bind source
    // also works here inside the sandbox.
    // We use require.resolve so pnpm symlinks are followed correctly.
    const esbuildMainPath = require.resolve('esbuild', {
      paths: [path.resolve(__dirname, '../../../../../node_modules')],
    });
    const { transformSync } = require(esbuildMainPath);
    compiled = transformSync(src, { loader: 'ts', format: 'esm' }).code;
  } catch (_e) {
    // esbuild unavailable or source is already plain JS — use as-is.
  }
  const mjsPath = '/workspace/quarantine.mjs';
  fs.writeFileSync(mjsPath, compiled, { mode: 0o644 });
  return mjsPath;
}

// Pre-compile as root before any privilege drop.
const compiledMjsPath = precompileQuarantine();

function emitResult(result) {
  process.stdout.write(JSON.stringify(result) + '\n');
}

/**
 * Build a minimal mock registry to capture registered tool names.
 * Mirrors the proxy pattern in loader.ts:259-281.
 */
function buildMockRegistry() {
  const toolNames = [];
  return {
    toolNames,
    registry: {
      register: function(toolDef) {
        if (toolDef && toolDef.name) {
          toolNames.push(toolDef.name);
        }
      },
      get: function() { return undefined; },
      size: 0,
    },
  };
}

async function run() {
  // Wave 2.2c: drop to nobody:nogroup (65534:65534) before synthesized code runs.
  // setgid MUST precede setuid — CAP_SETGID is lost once UID drops from 0 to 65534.
  // try/catch: graceful no-op when bwrap not setuid-root (e.g. nested test context).
  try { process.setgid(65534); } catch (_e) { /* non-root or no privilege */ }
  try { process.setuid(65534); } catch (_e) { /* non-root or no privilege */ }

  // Fix A (Wave 2.2a): Scrub process.env BEFORE importing synthesized code.
  // Closes H1/H2/H3: process.env.SECRET / process['env'] / globalThis.process.env
  // all return undefined because the env map is empty when synthesized code runs.
  for (const k of Object.keys(process.env)) {
    delete process.env[k];
  }

  // Phase 1: Import the pre-compiled quarantine module (.mjs, already transformed).
  // We import compiledMjsPath (written as root before setuid) instead of quarantinePath
  // (.ts) to avoid tsx triggering esbuild after setuid — esbuild's Go binary is at
  // node_modules/.pnpm/.../@esbuild+linux-x64/.../bin/esbuild which lives under /root
  // (0700), inaccessible to UID 65534 after privilege drop.
  let moduleExports;
  try {
    const fileUrl = pathToFileURL(compiledMjsPath).href;
    moduleExports = await import(fileUrl);
  } catch (importErr) {
    // Fix B: emit errorCode/errorName only — raw error string never crosses boundary.
    emitResult({
      ok: false,
      errorCode: 'IMPORT_FAILED',
      errorName: clampErrorName(importErr && importErr.name),
      phase: 'import',
    });
    return;
  }

  // Phase 2: Locate and call register*Tools exports to capture tool names
  const { toolNames, registry: mockRegistry } = buildMockRegistry();

  const registerFns = Object.entries(moduleExports).filter(
    ([key, val]) => /^register.+Tools$/.test(key) && typeof val === 'function'
  );

  if (registerFns.length > 0) {
    for (const [, registerFn] of registerFns) {
      try {
        await Promise.resolve(registerFn(mockRegistry));
      } catch (regErr) {
        // Non-fatal: continue to find other registrars
      }
    }
  }

  // Phase 3: Attempt test execution via execute export
  // If the module exports an execute function directly, call it with empty args
  if (typeof moduleExports.execute === 'function') {
    try {
      await Promise.resolve(moduleExports.execute({}));
    } catch (execErr) {
      // Fix B: emit errorCode/errorName only — raw error string never crosses boundary.
      emitResult({
        ok: false,
        errorCode: 'EXEC_FAILED',
        errorName: clampErrorName(execErr && execErr.name),
        phase: 'exec',
      });
      return;
    }
  }

  // Success — report tool names captured during registration
  emitResult({
    ok: true,
    toolNames: toolNames,
  });
}

run().catch(function(unexpectedErr) {
  // Fix B: emit errorCode/errorName only — raw error string never crosses boundary.
  emitResult({
    ok: false,
    errorCode: 'IMPORT_FAILED',
    errorName: clampErrorName(unexpectedErr && unexpectedErr.name),
    phase: 'import',
  });
  process.exit(1);
});
