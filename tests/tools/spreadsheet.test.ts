/**
 * @file spreadsheet.test.ts
 * @description Test suite for spreadsheet.* tools (Wave 9B2).
 * Tests: create, read, pivot, chart, validate — 20 tests total.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../src/core/shared/logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

import type { ToolContext } from '../../src/core/tools/types.js';

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 'test-session',
    workingDir: os.tmpdir(),
    config: null,
    logger: console,
    ...overrides,
  };
}

const TMP = os.tmpdir();

// ---------------------------------------------------------------------------
// spreadsheet.create
// ---------------------------------------------------------------------------

describe('spreadsheet.create', () => {
  it('1. rejects missing outputPath', async () => {
    const { spreadsheetCreateTool } = await import('../../src/core/tools/builtin/spreadsheet/tools/create.js');
    const result = await spreadsheetCreateTool.execute({ sheets: [] }, makeCtx());
    expect(result.success).toBe(false);
    expect(result.output).toContain('outputPath');
  });

  it('2. rejects outputPath outside allowed dirs', async () => {
    const { spreadsheetCreateTool } = await import('../../src/core/tools/builtin/spreadsheet/tools/create.js');
    const result = await spreadsheetCreateTool.execute(
      { outputPath: '/etc/bad.xlsx', sheets: [{ name: 'S', columns: [{ header: 'A', key: 'a' }], rows: [] }] },
      makeCtx(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain('outputPath must be');
  });

  it('3. rejects empty sheets array', async () => {
    const { spreadsheetCreateTool } = await import('../../src/core/tools/builtin/spreadsheet/tools/create.js');
    const result = await spreadsheetCreateTool.execute(
      { outputPath: path.join(TMP, 'test.xlsx'), sheets: [] },
      makeCtx(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain('sheets');
  });

  it('4. rejects sheet with no columns', async () => {
    const { spreadsheetCreateTool } = await import('../../src/core/tools/builtin/spreadsheet/tools/create.js');
    const result = await spreadsheetCreateTool.execute(
      {
        outputPath: path.join(TMP, 'test.xlsx'),
        sheets: [{ name: 'S', columns: [], rows: [] }],
      },
      makeCtx(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain('column');
  });

  it('5. creates workbook and returns metadata', async () => {
    const { spreadsheetCreateTool } = await import('../../src/core/tools/builtin/spreadsheet/tools/create.js');
    const outPath = path.join(TMP, `ss-create-${Date.now()}.xlsx`);
    const result = await spreadsheetCreateTool.execute(
      {
        outputPath: outPath,
        sheets: [
          {
            name: 'Sales',
            columns: [
              { header: 'Region', key: 'region', width: 20 },
              { header: 'Revenue', key: 'revenue' },
            ],
            rows: [
              { region: 'North', revenue: 50000 },
              { region: 'South', revenue: 38000 },
            ],
          },
        ],
      },
      makeCtx(),
    );
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data['path']).toBe(outPath);
    expect(data['sheetCount']).toBe(1);
    expect(data['totalRows']).toBe(2);
    expect(typeof data['sizeBytes']).toBe('number');
    expect((data['sizeBytes'] as number)).toBeGreaterThan(0);
  });

  it('6. creates multi-sheet workbook', async () => {
    const { spreadsheetCreateTool } = await import('../../src/core/tools/builtin/spreadsheet/tools/create.js');
    const outPath = path.join(TMP, `ss-multi-${Date.now()}.xlsx`);
    const result = await spreadsheetCreateTool.execute(
      {
        outputPath: outPath,
        sheets: [
          {
            name: 'Sheet1',
            columns: [{ header: 'X', key: 'x' }],
            rows: [{ x: 1 }, { x: 2 }],
          },
          {
            name: 'Sheet2',
            columns: [{ header: 'Y', key: 'y' }],
            rows: [{ y: 'hello' }],
          },
        ],
      },
      makeCtx(),
    );
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data['sheetCount']).toBe(2);
    expect(data['totalRows']).toBe(3);
  });

  it('7. produces artifacts array on success', async () => {
    const { spreadsheetCreateTool } = await import('../../src/core/tools/builtin/spreadsheet/tools/create.js');
    const outPath = path.join(TMP, `ss-artifact-${Date.now()}.xlsx`);
    const result = await spreadsheetCreateTool.execute(
      {
        outputPath: outPath,
        sheets: [{ name: 'S', columns: [{ header: 'A', key: 'a' }], rows: [{ a: 1 }] }],
      },
      makeCtx(),
    );
    expect(result.success).toBe(true);
    expect(Array.isArray(result.artifacts)).toBe(true);
    expect(result.artifacts![0]!.action).toBe('created');
  });
});

// ---------------------------------------------------------------------------
// spreadsheet.read
// ---------------------------------------------------------------------------

describe('spreadsheet.read', () => {
  it('8. rejects missing path', async () => {
    const { spreadsheetReadTool } = await import('../../src/core/tools/builtin/spreadsheet/tools/read.js');
    const result = await spreadsheetReadTool.execute({}, makeCtx());
    expect(result.success).toBe(false);
    expect(result.output).toContain('path is required');
  });

  it('9. returns error for non-existent file', async () => {
    const { spreadsheetReadTool } = await import('../../src/core/tools/builtin/spreadsheet/tools/read.js');
    const result = await spreadsheetReadTool.execute({ path: '/tmp/does-not-exist-99999.xlsx' }, makeCtx());
    expect(result.success).toBe(false);
    expect(result.output).toContain('error');
  });

  it('10. reads created workbook and returns row data', async () => {
    const { spreadsheetCreateTool } = await import('../../src/core/tools/builtin/spreadsheet/tools/create.js');
    const { spreadsheetReadTool } = await import('../../src/core/tools/builtin/spreadsheet/tools/read.js');

    const outPath = path.join(TMP, `ss-read-${Date.now()}.xlsx`);
    await spreadsheetCreateTool.execute(
      {
        outputPath: outPath,
        sheets: [
          {
            name: 'Data',
            columns: [{ header: 'Name', key: 'name' }, { header: 'Value', key: 'value' }],
            rows: [{ name: 'Alice', value: 100 }, { name: 'Bob', value: 200 }],
          },
        ],
      },
      makeCtx(),
    );

    const result = await spreadsheetReadTool.execute({ path: outPath, sheet: 'Data' }, makeCtx());
    expect(result.success).toBe(true);
    const data = result.data as { sheets: Record<string, unknown[]>; totalRows: number };
    expect(data.totalRows).toBe(2);
    expect(Array.isArray(data.sheets['Data'])).toBe(true);
  });

  it('11. returns error when named sheet not found', async () => {
    const { spreadsheetCreateTool } = await import('../../src/core/tools/builtin/spreadsheet/tools/create.js');
    const { spreadsheetReadTool } = await import('../../src/core/tools/builtin/spreadsheet/tools/read.js');

    const outPath = path.join(TMP, `ss-read-missing-${Date.now()}.xlsx`);
    await spreadsheetCreateTool.execute(
      {
        outputPath: outPath,
        sheets: [{ name: 'Real', columns: [{ header: 'A', key: 'a' }], rows: [{ a: 1 }] }],
      },
      makeCtx(),
    );

    const result = await spreadsheetReadTool.execute({ path: outPath, sheet: 'Fake' }, makeCtx());
    expect(result.success).toBe(false);
    expect(result.output).toContain('not found');
  });
});

// ---------------------------------------------------------------------------
// spreadsheet.pivot
// ---------------------------------------------------------------------------

describe('spreadsheet.pivot', () => {
  it('12. rejects missing inputPath', async () => {
    const { spreadsheetPivotTool } = await import('../../src/core/tools/builtin/spreadsheet/tools/pivot.js');
    const result = await spreadsheetPivotTool.execute({}, makeCtx());
    expect(result.success).toBe(false);
    expect(result.output).toContain('inputPath');
  });

  it('13. rejects outputPath outside allowed dirs', async () => {
    const { spreadsheetPivotTool } = await import('../../src/core/tools/builtin/spreadsheet/tools/pivot.js');
    const result = await spreadsheetPivotTool.execute(
      {
        inputPath: path.join(TMP, 'src.xlsx'),
        outputPath: '/etc/bad.xlsx',
        sourceSheet: 'S',
        rows: ['r'],
        columns: ['c'],
        values: [{ col: 'v', agg: 'sum' }],
      },
      makeCtx(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain('outputPath must be');
  });

  it('14. creates pivot table from source data', async () => {
    const { spreadsheetCreateTool } = await import('../../src/core/tools/builtin/spreadsheet/tools/create.js');
    const { spreadsheetPivotTool } = await import('../../src/core/tools/builtin/spreadsheet/tools/pivot.js');

    const srcPath = path.join(TMP, `ss-pivot-src-${Date.now()}.xlsx`);
    const pivotPath = path.join(TMP, `ss-pivot-out-${Date.now()}.xlsx`);

    await spreadsheetCreateTool.execute(
      {
        outputPath: srcPath,
        sheets: [
          {
            name: 'Sales',
            columns: [
              { header: 'region', key: 'region' },
              { header: 'product', key: 'product' },
              { header: 'revenue', key: 'revenue' },
            ],
            rows: [
              { region: 'North', product: 'Widget', revenue: 100 },
              { region: 'North', product: 'Gadget', revenue: 150 },
              { region: 'South', product: 'Widget', revenue: 200 },
            ],
          },
        ],
      },
      makeCtx(),
    );

    const result = await spreadsheetPivotTool.execute(
      {
        inputPath: srcPath,
        outputPath: pivotPath,
        sourceSheet: 'Sales',
        rows: ['region'],
        columns: ['product'],
        values: [{ col: 'revenue', agg: 'sum' }],
      },
      makeCtx(),
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data['pivotRows']).toBe(2); // North and South
    expect(typeof data['sizeBytes']).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// spreadsheet.chart
// ---------------------------------------------------------------------------

describe('spreadsheet.chart', () => {
  it('15. rejects missing path', async () => {
    const { spreadsheetChartTool } = await import('../../src/core/tools/builtin/spreadsheet/tools/chart.js');
    const result = await spreadsheetChartTool.execute({}, makeCtx());
    expect(result.success).toBe(false);
    expect(result.output).toContain('path is required');
  });

  it('16. rejects invalid chartType', async () => {
    const { spreadsheetChartTool } = await import('../../src/core/tools/builtin/spreadsheet/tools/chart.js');
    const result = await spreadsheetChartTool.execute(
      {
        path: '/tmp/x.xlsx',
        sheetName: 'Data',
        chartType: 'scatter',
        dataRange: { startRow: 1, endRow: 10, startCol: 1, endCol: 3 },
      },
      makeCtx(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain('chartType');
  });

  it('17. writes chart metadata to ChartConfig sheet', async () => {
    const { spreadsheetCreateTool } = await import('../../src/core/tools/builtin/spreadsheet/tools/create.js');
    const { spreadsheetChartTool } = await import('../../src/core/tools/builtin/spreadsheet/tools/chart.js');

    const workbookPath = path.join(TMP, `ss-chart-${Date.now()}.xlsx`);
    await spreadsheetCreateTool.execute(
      {
        outputPath: workbookPath,
        sheets: [
          {
            name: 'Data',
            columns: [{ header: 'Month', key: 'month' }, { header: 'Sales', key: 'sales' }],
            rows: [{ month: 'Jan', sales: 1000 }, { month: 'Feb', sales: 1200 }],
          },
        ],
      },
      makeCtx(),
    );

    const result = await spreadsheetChartTool.execute(
      {
        path: workbookPath,
        sheetName: 'Data',
        chartType: 'bar',
        dataRange: { startRow: 1, endRow: 3, startCol: 1, endCol: 2 },
        titleCell: 'Monthly Sales',
      },
      makeCtx(),
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(typeof data['chartId']).toBe('string');
    expect((data['chartId'] as string).startsWith('chart-')).toBe(true);
    expect(result.output).toContain('ChartConfig');
  });
});

// ---------------------------------------------------------------------------
// spreadsheet.validate
// ---------------------------------------------------------------------------

describe('spreadsheet.validate', () => {
  it('18. rejects missing path', async () => {
    const { spreadsheetValidateTool } = await import('../../src/core/tools/builtin/spreadsheet/tools/validate.js');
    const result = await spreadsheetValidateTool.execute({}, makeCtx());
    expect(result.success).toBe(false);
    expect(result.output).toContain('path is required');
  });

  it('19. returns error for non-existent file', async () => {
    const { spreadsheetValidateTool } = await import('../../src/core/tools/builtin/spreadsheet/tools/validate.js');
    const result = await spreadsheetValidateTool.execute({ path: '/tmp/no-such-file-xyz.xlsx' }, makeCtx());
    expect(result.success).toBe(false);
    expect(result.output).toContain('error');
  });

  it('20. validates a clean workbook as valid', async () => {
    const { spreadsheetCreateTool } = await import('../../src/core/tools/builtin/spreadsheet/tools/create.js');
    const { spreadsheetValidateTool } = await import('../../src/core/tools/builtin/spreadsheet/tools/validate.js');

    const cleanPath = path.join(TMP, `ss-valid-${Date.now()}.xlsx`);
    await spreadsheetCreateTool.execute(
      {
        outputPath: cleanPath,
        sheets: [
          {
            name: 'Clean',
            columns: [{ header: 'Name', key: 'name' }, { header: 'Score', key: 'score' }],
            rows: [{ name: 'Alice', score: 95 }, { name: 'Bob', score: 87 }],
          },
        ],
      },
      makeCtx(),
    );

    const result = await spreadsheetValidateTool.execute({ path: cleanPath }, makeCtx());
    expect(result.success).toBe(true);
    const data = result.data as { valid: boolean; errors: unknown[]; warnings: unknown[] };
    expect(data.valid).toBe(true);
    expect(Array.isArray(data.errors)).toBe(true);
    expect(data.errors.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe('spreadsheet tool registration', () => {
  it('21. registerSpreadsheetTools registers 5 tools', async () => {
    const { registerSpreadsheetTools } = await import('../../src/core/tools/builtin/spreadsheet/index.js');
    const registered: string[] = [];
    const mockRegistry = {
      register: (tool: { name: string }) => { registered.push(tool.name); },
    };
    registerSpreadsheetTools(mockRegistry as never);
    expect(registered).toContain('spreadsheet.create');
    expect(registered).toContain('spreadsheet.read');
    expect(registered).toContain('spreadsheet.pivot');
    expect(registered).toContain('spreadsheet.chart');
    expect(registered).toContain('spreadsheet.validate');
    expect(registered.length).toBe(5);
  });
});

describe('normalizeSheetsArg — LLM arg coercion (nested sheets stringified)', () => {
  it('passes a proper nested array through', async () => {
    const { normalizeSheetsArg } = await import('../../src/core/tools/builtin/spreadsheet/tools/create.js');
    const out = normalizeSheetsArg([{ name: 'S', columns: [{ header: 'A', key: 'a' }], rows: [{ a: 1 }] }]);
    expect(out).toEqual([{ name: 'S', columns: [{ header: 'A', key: 'a' }], rows: [{ a: 1 }] }]);
  });

  it('parses the whole sheets array passed as a JSON string', async () => {
    const { normalizeSheetsArg } = await import('../../src/core/tools/builtin/spreadsheet/tools/create.js');
    const out = normalizeSheetsArg('[{"name":"S","columns":[{"header":"A","key":"a"}],"rows":[{"a":1}]}]');
    expect(out[0]).toMatchObject({ name: 'S', columns: [{ header: 'A', key: 'a' }] });
  });

  it('parses per-sheet columns/rows passed as JSON strings, and defaults key to header', async () => {
    const { normalizeSheetsArg } = await import('../../src/core/tools/builtin/spreadsheet/tools/create.js');
    const out = normalizeSheetsArg([{ name: 'S', columns: '[{"header":"Total"}]', rows: '[{"Total":9}]' }]);
    expect(out[0]!.columns).toEqual([{ header: 'Total', key: 'Total' }]); // key defaulted to header
    expect(out[0]!.rows).toEqual([{ Total: 9 }]);
  });

  it('drops sheets without a name; non-array/garbage → []', async () => {
    const { normalizeSheetsArg } = await import('../../src/core/tools/builtin/spreadsheet/tools/create.js');
    expect(normalizeSheetsArg([{ columns: [] }, { name: 'Keep', columns: [{ header: 'A', key: 'a' }], rows: [] }])).toHaveLength(1);
    expect(normalizeSheetsArg('not json')).toEqual([]);
    expect(normalizeSheetsArg(99)).toEqual([]);
  });
});
