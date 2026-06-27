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
];

// Build all entry points for builtin tools
const builtinDir = path.join(projectRoot, 'src/core/tools/builtin');
const allTsFiles = findAllTsFiles(builtinDir, builtinDir);

// Filter to only entry points (index.ts files) and their dependencies
const entryPoints = allTsFiles.filter(f => f.endsWith('index.ts'));

Promise.all([
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
  // Builtin tools - transpile all files preserving structure
  esbuild.build({
    entryPoints: allTsFiles,
    bundle: false,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    outdir: 'dist/core/tools/builtin',
    define: {
      'process.env.NODE_ENV': production ? '"production"' : '"development"',
    },
    sourcemap: !production,
    keepNames: true,
  }),
]).then(() => {
  // Runtime asset, not transpiled: tool-synthesize resolves this next to its
  // own __dirname at runtime, so it must ship inside dist as well.
  fs.copyFileSync(
    path.join(builtinDir, 'meta/synth-bwrap-entry.cjs'),
    path.join(projectRoot, 'dist/core/tools/builtin/meta/synth-bwrap-entry.cjs'),
  );
  // Same pattern for the code-execution sandbox workers (gap #15 +
  // pre-existing js-exec). Both are loaded at __dirname/<name>.cjs by their
  // tool file's Worker() constructor and must ship next to the transpiled JS.
  // mkdirSync(recursive) is defensive — the esbuild step creates code/ when
  // it transpiles code/index.ts, but if entry-points filtering ever changes
  // we still want the copy to succeed.
  const codeDistDir = path.join(projectRoot, 'dist/core/tools/builtin/code');
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
  console.log('Build complete: server CLI + MCP CLI + ACP CLI + builtin tools');
}).catch((err) => {
  console.error('Build failed:', err.message);
  process.exit(1);
});
