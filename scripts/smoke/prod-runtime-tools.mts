/**
 * @file prod-runtime-tools.mts
 * @description Prod-runtime smoke test for file-producing tools — run under tsx
 * (the SAME ESM loader as the daemon's `node --import tsx`), NOT vitest.
 *
 * WHY: the ESM/CJS dynamic-import interop bug class (see the
 * project-esm-require-securityguard memory) is invisible to `pnpm test` —
 * vitest/esbuild shim the module system, so `const X = await import('cjs-pkg')`
 * resolves `.Member` fine in vitest while it's `undefined` under the real runtime.
 * That landmine shipped the entire spreadsheet subsystem broken (exceljs,
 * "Workbook is not a constructor") and earlier turned SecurityGuard off 323×.
 *
 * This smoke actually CALLS the lightweight, pure-JS file producers and asserts
 * each writes a non-empty file. It runs in CI as a separate step after Test, so a
 * regression in the interop contract fails the build instead of reaching prod.
 *
 * Scope: pure-JS deliverable tools only (exceljs / docx). The chromium- and
 * ffmpeg-backed tools (media.*, document.webpage/slides) need heavy external
 * binaries and are intentionally out of scope here — their dynamic imports use
 * named exports / `.default` and are covered by the one-time audit recorded in
 * the memory.
 */

import { existsSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spreadsheetCreateTool } from '../../src/core/tools/builtin/spreadsheet/tools/create.js';
import { docxCreateTool } from '../../src/core/tools/builtin/docx/tools/create.js';

// Minimal ToolContext — the tools only read sessionId + an optional logger here.
const ctx = { sessionId: 'smoke', logger: { info() {}, warn() {}, error() {}, debug() {} } } as never;

const cases = [
  {
    name: 'spreadsheet.create (exceljs)',
    tool: spreadsheetCreateTool,
    out: join(tmpdir(), 'sudo-smoke.xlsx'),
    args: { sheets: [{ name: 'S', columns: [{ header: 'A', key: 'a' }], rows: [{ a: 1 }] }] },
  },
  {
    name: 'docx.create (docx)',
    tool: docxCreateTool,
    out: join(tmpdir(), 'sudo-smoke.docx'),
    args: { title: 'Smoke', sections: [{ heading: 'S', paragraphs: ['hello'] }] },
  },
];

let failed = 0;
for (const c of cases) {
  try {
    rmSync(c.out, { force: true });
    const r = await c.tool.execute({ outputPath: c.out, ...c.args }, ctx);
    const wrote = existsSync(c.out) && statSync(c.out).size > 0;
    if (r.success && wrote) {
      console.log(`✓ ${c.name} → ${statSync(c.out).size} bytes`);
    } else {
      failed++;
      console.error(`✗ ${c.name} — success=${r.success} wroteFile=${wrote} output=${String(r.output).slice(0, 160)}`);
    }
    rmSync(c.out, { force: true });
  } catch (err) {
    failed++;
    console.error(`✗ ${c.name} — THREW ${err instanceof Error ? err.message : String(err)}`);
  }
}

if (failed > 0) {
  console.error(
    `\nprod-runtime smoke FAILED: ${failed}/${cases.length}. ` +
    `A tool that passes vitest but fails here is almost certainly an ESM/CJS dynamic-import ` +
    `interop bug — dynamic-importing a CJS dep needs \`(await import('pkg')).default ?? mod\`. ` +
    `See the project-esm-require-securityguard memory.`,
  );
  process.exit(1);
}
console.log(`\nprod-runtime smoke OK: ${cases.length}/${cases.length} file-producing tools work under the tsx runtime.`);
