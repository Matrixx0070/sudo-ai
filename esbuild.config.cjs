const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

const production = process.env['NODE_ENV'] === 'production';
const projectRoot = __dirname;

// Recursively find all .ts files in a directory
function findAllTsFiles(dir, baseDir) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findAllTsFiles(fullPath, baseDir));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      results.push(fullPath);
    }
  }
  return results;
}

// Native/runtime modules that must load from node_modules, not the bundle.
const sharedExternals = [
  'better-sqlite3',
  'sqlite-vec',
  'canvas',
  'sharp',
  'playwright',
  'puppeteer',
  'chromium-bidi',
  // ONNX stack: transformers lazily loads onnxruntime-node's native .node
  // binding, which esbuild cannot bundle. Reached by the bundled CLIs via
  // skill-activator → semantic-assist → local-embeddings.
  '@huggingface/transformers',
  'onnxruntime-node',
];

// Build all entry points for builtin tools
const builtinDir = path.join(projectRoot, 'src/core/tools/builtin');
const allTsFiles = findAllTsFiles(builtinDir, builtinDir);

// Filter to only entry points (index.ts files) and their dependencies
const entryPoints = allTsFiles.filter(f => f.endsWith('index.ts'));

// Daemon runtime graph — transpiled (NOT bundled) so an installed npm package
// runs the exact same module graph as the tsx dev path (`node dist/cli.js` ==
// `tsx src/cli.ts`). Bundling the daemon was tried and rejected: the bundle
// duplicates core singletons (channel-outbox, approval manager, config) that
// the runtime-scanned dist/core/tools/builtin modules import from the
// transpiled tree, split-braining shared state. Transpile-preserve-structure
// keeps one graph, resolves every npm dep from node_modules (no __dirname/
// createRequire bundling hazards), and lets `new URL(...)`-relative asset
// reads keep working. Tests are excluded; non-TS runtime assets (sql
// migrations, SKILL.md, workers, json/yaml) are copied after the build.
// The graph is emitted under dist/src/** and dist/shared-types/** (outbase '.')
// so the source imports of '../../../shared-types/*.js' from src/core/ide/*
// keep the same relative depth after transpilation. The daemon entry is
// therefore dist/src/cli.js (see src/cli/commands/start.ts resolveDaemonEntry).
const daemonSrcDirs = ['src/core', 'src/gateway', 'src/cli', 'shared-types'];
const isTestFile = (f) =>
  f.endsWith('.test.ts') || f.endsWith('.spec.ts') ||
  f.includes(`${path.sep}__tests__${path.sep}`) || f.includes(`${path.sep}test-fixtures${path.sep}`);
const daemonEntryPoints = [
  path.join(projectRoot, 'src/cli.ts'),
  ...daemonSrcDirs.flatMap((d) => {
    const abs = path.join(projectRoot, d);
    return fs.existsSync(abs) ? findAllTsFiles(abs, abs) : [];
  }),
].filter((f) => !isTestFile(f));

// Copy non-TS runtime assets from <dir> into dist/<dir>, preserving paths.
function copyRuntimeAssets() {
  for (const d of daemonSrcDirs) {
    const absSrc = path.join(projectRoot, d);
    if (!fs.existsSync(absSrc)) continue;
    fs.cpSync(absSrc, path.join(projectRoot, 'dist', d), {
      recursive: true,
      filter: (srcPath) => {
        if (fs.statSync(srcPath).isDirectory()) return !srcPath.includes('__tests__');
        return !srcPath.endsWith('.ts') && !srcPath.endsWith('.tsx') && !isTestFile(srcPath);
      },
    });
  }
}

Promise.all([
  // Daemon graph transpile (usage: node dist/cli.js — what `sudo-ai start`
  // launches from an installed npm package, where src/ and tsx don't ship).
  esbuild.build({
    entryPoints: daemonEntryPoints,
    bundle: false,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    outdir: 'dist',
    outbase: '.',
    define: {
      'process.env.NODE_ENV': production ? '"production"' : '"development"',
    },
    sourcemap: !production,
    keepNames: true,
  }),
  // Server CLI bundle
  esbuild.build({
    entryPoints: ['src/cli/index.ts'],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    outfile: 'dist/server/cli.js',
    external: [...sharedExternals],
    define: {
      'process.env.NODE_ENV': production ? '"production"' : '"development"',
    },
    banner: {
      js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
    },
    sourcemap: !production,
    minify: production,
    keepNames: true,
  }),
  // MCP loopback server CLI bundle (usage: node dist/core/gateway/mcp-cli.js)
  esbuild.build({
    entryPoints: ['src/core/gateway/mcp-cli.ts'],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    outfile: 'dist/core/gateway/mcp-cli.js',
    external: [
      ...sharedExternals,
      // pino resolves its transport worker via __dirname at runtime, which
      // breaks when bundled into an ESM file — load it from node_modules.
      'pino',
      'pino-pretty',
    ],
    define: {
      'process.env.NODE_ENV': production ? '"production"' : '"development"',
    },
    banner: {
      js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
    },
    sourcemap: !production,
    minify: production,
    keepNames: true,
  }),
  // ACP (Agent Client Protocol) stdio agent CLI bundle
  // (usage: node dist/core/acp/acp-cli.js — launched by an ACP editor)
  esbuild.build({
    entryPoints: ['src/core/acp/acp-cli.ts'],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    outfile: 'dist/core/acp/acp-cli.js',
    external: [
      ...sharedExternals,
      // pino resolves its transport worker via __dirname at runtime, which
      // breaks when bundled into an ESM file — load it from node_modules.
      'pino',
      'pino-pretty',
    ],
    define: {
      'process.env.NODE_ENV': production ? '"production"' : '"development"',
    },
    banner: {
      // The env assignments run at the very TOP of the bundle, before any
      // bundled module (logger / dotenv) initializes — so stdout stays a clean
      // JSON-RPC channel: human logs go to stderr, dotenv's banner is silenced.
      js:
        "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" +
        " process.env.SUDO_LOG_STDERR ??= '1'; process.env.DOTENV_CONFIG_QUIET ??= 'true';",
    },
    sourcemap: !production,
    minify: production,
    keepNames: true,
  }),
  // NOTE: the former builtin-tools-only transpile step is subsumed by the
  // daemon graph transpile above (src/core includes src/core/tools/builtin).
]).then(() => {
  // Ship non-TS runtime assets next to the transpiled daemon graph.
  copyRuntimeAssets();
  // Runtime asset, not transpiled: tool-synthesize resolves this next to its
  // own __dirname at runtime, so it must ship inside dist as well.
  fs.copyFileSync(
    path.join(builtinDir, 'meta/synth-bwrap-entry.cjs'),
    path.join(projectRoot, 'dist/src/core/tools/builtin/meta/synth-bwrap-entry.cjs'),
  );
  // Same pattern for the code-execution sandbox workers (gap #15 +
  // pre-existing js-exec). Both are loaded at __dirname/<name>.cjs by their
  // tool file's Worker() constructor and must ship next to the transpiled JS.
  // mkdirSync(recursive) is defensive — the esbuild step creates code/ when
  // it transpiles code/index.ts, but if entry-points filtering ever changes
  // we still want the copy to succeed.
  const codeDistDir = path.join(projectRoot, 'dist/src/core/tools/builtin/code');
  fs.mkdirSync(codeDistDir, { recursive: true });
  fs.copyFileSync(
    path.join(builtinDir, 'code/js-worker.cjs'),
    path.join(codeDistDir, 'js-worker.cjs'),
  );
  fs.copyFileSync(
    path.join(builtinDir, 'code/ptc-worker.cjs'),
    path.join(codeDistDir, 'ptc-worker.cjs'),
  );
  // Python PTC harness (gap #15, python variant) — loaded by meta/ptc-python.ts
  // at __dirname/../code/ptc-python-harness.py via its python3 subprocess.
  fs.copyFileSync(
    path.join(builtinDir, 'code/ptc-python-harness.py'),
    path.join(codeDistDir, 'ptc-python-harness.py'),
  );
  console.log('Build complete: daemon entry + server CLI + MCP CLI + ACP CLI + builtin tools');
}).catch((err) => {
  console.error('Build failed:', err.message);
  process.exit(1);
});
