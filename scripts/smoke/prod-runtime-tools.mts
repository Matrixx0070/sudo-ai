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
 * each succeeds (and, for writers, leaves a non-empty file). It runs in CI as a
 * separate step after Test, so a regression in the interop contract — or in the
 * spreadsheet round-trip logic — fails the build instead of reaching prod.
 *
 * Scope: pure-JS tools only (exceljs round-trip + docx). The chromium- and
 * ffmpeg-backed tools (media.*, document.webpage/slides) need heavy external
 * binaries and are intentionally out of scope here; their dynamic imports use
 * named exports / `.default` and are covered by the one-time audit in the memory.
 * When you add a new pure-JS file-producing tool, add a step() below.
 */

import { existsSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spreadsheetCreateTool } from '../../src/core/tools/builtin/spreadsheet/tools/create.js';
import { spreadsheetReadTool } from '../../src/core/tools/builtin/spreadsheet/tools/read.js';
import { spreadsheetValidateTool } from '../../src/core/tools/builtin/spreadsheet/tools/validate.js';
import { spreadsheetPivotTool } from '../../src/core/tools/builtin/spreadsheet/tools/pivot.js';
import { spreadsheetChartTool } from '../../src/core/tools/builtin/spreadsheet/tools/chart.js';
import { docxCreateTool } from '../../src/core/tools/builtin/docx/tools/create.js';
import { imageEditAdvancedTool } from '../../src/core/tools/builtin/media/image-tools.js';

// Minimal ToolContext — these tools only read sessionId + an optional logger here.
const ctx = { sessionId: 'smoke', logger: { info() {}, warn() {}, error() {}, debug() {} } } as never;

const xlsx = join(tmpdir(), 'sudo-smoke.xlsx');
const pivotOut = join(tmpdir(), 'sudo-smoke-pivot.xlsx');
const docx = join(tmpdir(), 'sudo-smoke.docx');
const srcPng = join(tmpdir(), 'sudo-smoke-src.png');
const outJpg = join(tmpdir(), 'sudo-smoke-out.jpg');
const tmpFiles = [xlsx, pivotOut, docx, srcPng, outJpg];
for (const f of tmpFiles) rmSync(f, { force: true });

let failed = 0;
async function step(label: string, fn: () => Promise<{ success: boolean; output?: string }>, outFile?: string): Promise<void> {
  try {
    const r = await fn();
    const wrote = outFile ? existsSync(outFile) && statSync(outFile).size > 0 : true;
    if (r?.success && wrote) {
      console.log(`✓ ${label}${outFile ? ` → ${statSync(outFile).size} bytes` : ''}`);
    } else {
      failed++;
      console.error(`✗ ${label} — success=${r?.success} wroteFile=${wrote} output=${String(r?.output).slice(0, 160)}`);
    }
  } catch (err) {
    failed++;
    console.error(`✗ ${label} — THREW ${err instanceof Error ? err.message : String(err)}`);
  }
}

// exceljs subsystem — a full round-trip (create → read → validate → pivot → chart);
// every one of these dynamic-imports exceljs, so this guards the interop fix end-to-end.
await step('spreadsheet.create (exceljs)', () => spreadsheetCreateTool.execute({
  outputPath: xlsx,
  sheets: [{
    name: 'Data',
    columns: [{ header: 'Region', key: 'region' }, { header: 'Product', key: 'product' }, { header: 'Amount', key: 'amount' }],
    rows: [{ region: 'N', product: 'A', amount: 10 }, { region: 'N', product: 'B', amount: 20 }, { region: 'S', product: 'A', amount: 5 }],
  }],
}, ctx), xlsx);
await step('spreadsheet.read', () => spreadsheetReadTool.execute({ path: xlsx }, ctx));
await step('spreadsheet.validate', () => spreadsheetValidateTool.execute({ path: xlsx }, ctx));
await step('spreadsheet.pivot', () => spreadsheetPivotTool.execute({
  inputPath: xlsx, outputPath: pivotOut, sourceSheet: 'Data',
  rows: ['region'], columns: ['product'], values: [{ field: 'amount', aggregation: 'sum' }],
}, ctx), pivotOut);
await step('spreadsheet.chart', () => spreadsheetChartTool.execute({
  path: xlsx, sheetName: 'Data', chartType: 'bar', dataRange: { startRow: 1, endRow: 4, startCol: 1, endCol: 3 },
}, ctx));

// docx (the docx package)
await step('docx.create (docx)', () => docxCreateTool.execute({
  outputPath: docx, title: 'Smoke', sections: [{ heading: 'S', paragraphs: ['hello'] }],
}, ctx), docx);

// sharp — media.image-edit-advanced was silently broken in prod (sharp was a
// transitive-only dep so `await import('sharp')` couldn't resolve; the tool masked
// it as "sharp is not installed"). Make a source PNG via sharp (also directly
// proves it resolves + the native binding works), then resize+convert it.
const sharpNs = await import('sharp');
const sharp = (sharpNs as { default?: typeof sharpNs }).default ?? sharpNs;
await sharp({ create: { width: 120, height: 90, channels: 3, background: '#2563eb' } }).png().toFile(srcPng);
await step('media.image-edit-advanced (sharp resize+convert)', () => imageEditAdvancedTool.execute({
  input: srcPng, output: outJpg, operations: [{ type: 'resize', width: 60 }, { type: 'convert', format: 'jpeg' }],
}, ctx), outJpg);

for (const f of tmpFiles) rmSync(f, { force: true });

if (failed > 0) {
  console.error(
    `\nprod-runtime smoke FAILED: ${failed} step(s). A tool that passes vitest but fails ` +
    `here is almost certainly an ESM/CJS dynamic-import interop bug — dynamic-importing a CJS ` +
    `dep needs \`(await import('pkg')).default ?? mod\`. See the project-esm-require-securityguard memory.`,
  );
  process.exit(1);
}
console.log(`\nprod-runtime smoke OK: spreadsheet (×5) + docx + image-edit (sharp) tools work under the tsx runtime.`);
