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
    external: [
      'better-sqlite3',
      'sqlite-vec',
      'canvas',
      'sharp',
      'playwright',
      'puppeteer',
      'chromium-bidi',
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
  console.log('Build complete: server CLI + builtin tools');
}).catch((err) => {
  console.error('Build failed:', err.message);
  process.exit(1);
});
