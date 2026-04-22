/**
 * coder.notebook-edit — Edit or insert cells in Jupyter notebook files (.ipynb).
 *
 * Provides two operations via a single tool call:
 *   - edit   — Replace the source of an existing cell (by index). Code cells have
 *              their outputs cleared automatically.
 *   - insert — Insert a new cell (code or markdown) after a given index.
 *
 * The notebook is read, mutated in memory, and written back as pretty-printed
 * JSON (indent = 1) to preserve the standard .ipynb format without diff noise.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';

// ---------------------------------------------------------------------------
// Notebook types (minimal subset of the nbformat spec)
// ---------------------------------------------------------------------------

interface NotebookCell {
  cell_type: 'code' | 'markdown' | 'raw';
  source: string[];
  metadata?: Record<string, unknown>;
  outputs?: unknown[];
  execution_count?: number | null;
}

interface Notebook {
  cells: NotebookCell[];
  metadata: Record<string, unknown>;
  nbformat: number;
  nbformat_minor: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Split a source string into the line array format used in .ipynb files. */
function toSourceLines(src: string): string[] {
  const lines = src.split('\n');
  return lines.map((line, i) => (i < lines.length - 1 ? line + '\n' : line));
}

type Log = {
  info: (...a: unknown[]) => void;
  warn: (...a: unknown[]) => void;
  error: (...a: unknown[]) => void;
};

async function loadNotebook(filePath: string, log: Log): Promise<Notebook | string> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ file: filePath, err }, 'notebook-edit: read failed');
    return `ERROR: cannot read ${filePath} — ${msg}`;
  }

  try {
    return JSON.parse(raw) as Notebook;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ file: filePath }, 'notebook-edit: JSON parse failed');
    return `ERROR: ${filePath} is not valid JSON — ${msg}`;
  }
}

async function saveNotebook(filePath: string, nb: Notebook, log: Log): Promise<string | null> {
  try {
    await writeFile(filePath, JSON.stringify(nb, null, 1), 'utf-8');
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ file: filePath, err }, 'notebook-edit: write failed');
    return `ERROR: write failed — ${msg}`;
  }
}

// ---------------------------------------------------------------------------
// Operation handlers
// ---------------------------------------------------------------------------

async function handleEdit(
  filePath: string,
  cellIndex: number,
  newSource: string,
  cellType: 'code' | 'markdown' | undefined,
  log: Log,
): Promise<string> {
  const nb = await loadNotebook(filePath, log);
  if (typeof nb === 'string') return nb;

  if (cellIndex < 0 || cellIndex >= nb.cells.length) {
    return `ERROR: Cell index ${cellIndex} out of range (notebook has ${nb.cells.length} cells, valid: 0–${nb.cells.length - 1})`;
  }

  const cell = nb.cells[cellIndex];
  if (!cell) return `ERROR: Cell at index ${cellIndex} is undefined`;

  cell.source = toSourceLines(newSource);
  if (cellType) cell.cell_type = cellType;

  // Clear outputs and reset execution count for code cells to prevent stale state.
  if (cell.cell_type === 'code') {
    cell.outputs = [];
    cell.execution_count = null;
  }

  const writeErr = await saveNotebook(filePath, nb, log);
  if (writeErr) return writeErr;

  log.info({ file: filePath, cellIndex, cellType: cell.cell_type }, 'notebook-edit: cell edited');
  return `OK: Edited cell ${cellIndex} in ${filePath}`;
}

async function handleInsert(
  filePath: string,
  afterIndex: number,
  source: string,
  cellType: 'code' | 'markdown',
  log: Log,
): Promise<string> {
  const nb = await loadNotebook(filePath, log);
  if (typeof nb === 'string') return nb;

  // Allow afterIndex === -1 to insert at the beginning.
  const insertAt = afterIndex + 1;
  if (insertAt < 0 || insertAt > nb.cells.length) {
    return `ERROR: afterIndex ${afterIndex} is out of range (notebook has ${nb.cells.length} cells)`;
  }

  const newCell: NotebookCell = {
    cell_type: cellType,
    source: toSourceLines(source),
    metadata: {},
    ...(cellType === 'code' ? { outputs: [], execution_count: null } : {}),
  };

  nb.cells.splice(insertAt, 0, newCell);

  const writeErr = await saveNotebook(filePath, nb, log);
  if (writeErr) return writeErr;

  log.info({ file: filePath, insertAt, cellType }, 'notebook-edit: cell inserted');
  return `OK: Inserted ${cellType} cell at index ${insertAt} in ${filePath}`;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const notebookEditTool: ToolDefinition = {
  name: 'coder.notebook-edit',
  description:
    'Edit or insert cells in a Jupyter notebook (.ipynb) file. ' +
    'Use operation "edit" to replace the source of an existing cell by index — code cells ' +
    'have their outputs cleared automatically. Use operation "insert" to add a new cell ' +
    'after a given index (use afterIndex -1 to insert at the beginning). ' +
    'The notebook is saved back to disk after each operation.',
  category: 'coder',
  requiresConfirmation: false,
  timeout: 30_000,
  parameters: {
    file: {
      type: 'string',
      required: true,
      description: 'Path to the .ipynb notebook file (absolute or relative to working dir).',
    },
    operation: {
      type: 'string',
      required: true,
      enum: ['edit', 'insert'],
      description: '"edit" replaces an existing cell; "insert" adds a new cell after afterIndex.',
    },
    source: {
      type: 'string',
      required: true,
      description: 'New cell source content (multi-line string).',
    },
    cellIndex: {
      type: 'number',
      required: false,
      description: 'Zero-based index of the cell to edit. Required for operation "edit".',
    },
    afterIndex: {
      type: 'number',
      required: false,
      description:
        'Zero-based index after which to insert the new cell. Use -1 to insert at position 0. ' +
        'Required for operation "insert".',
    },
    cellType: {
      type: 'string',
      required: false,
      enum: ['code', 'markdown'],
      description:
        'Cell type for the new/edited cell. Defaults to "code" for insert; ' +
        'for edit, preserves existing type unless overridden.',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const log = ctx.logger as Log;

    // --- Validate file path ---
    if (typeof params['file'] !== 'string' || params['file'].trim() === '') {
      return { success: false, output: 'coder.notebook-edit: "file" must be a non-empty string.' };
    }

    const filePath = resolve(ctx.workingDir, params['file'] as string);

    // Path-traversal guard.
    if (!filePath.startsWith(ctx.workingDir)) {
      log.warn({ file: params['file'], resolved: filePath }, 'notebook-edit: path traversal blocked');
      return { success: false, output: `BLOCKED: path resolves outside working directory` };
    }

    // Loose extension check — warn but do not block non-.ipynb files.
    if (extname(filePath) !== '.ipynb') {
      log.warn({ file: filePath }, 'notebook-edit: file does not have .ipynb extension');
    }

    // --- Validate operation ---
    const operation = params['operation'];
    if (operation !== 'edit' && operation !== 'insert') {
      return { success: false, output: 'coder.notebook-edit: "operation" must be "edit" or "insert".' };
    }

    // --- Validate source ---
    if (typeof params['source'] !== 'string') {
      return { success: false, output: 'coder.notebook-edit: "source" must be a string.' };
    }
    const source = params['source'] as string;

    // --- Validate cellType ---
    const rawCellType = params['cellType'];
    if (rawCellType !== undefined && rawCellType !== 'code' && rawCellType !== 'markdown') {
      return { success: false, output: 'coder.notebook-edit: "cellType" must be "code" or "markdown".' };
    }
    const cellType = rawCellType as 'code' | 'markdown' | undefined;

    // --- Dispatch ---
    if (operation === 'edit') {
      const cellIndex = params['cellIndex'];
      if (typeof cellIndex !== 'number' || !Number.isInteger(cellIndex)) {
        return { success: false, output: 'coder.notebook-edit: "cellIndex" must be an integer for operation "edit".' };
      }
      const output = await handleEdit(filePath, cellIndex, source, cellType, log);
      return { success: output.startsWith('OK'), output };
    }

    // operation === 'insert'
    const afterIndex = params['afterIndex'];
    if (typeof afterIndex !== 'number' || !Number.isInteger(afterIndex)) {
      return { success: false, output: 'coder.notebook-edit: "afterIndex" must be an integer for operation "insert".' };
    }
    const effectiveCellType: 'code' | 'markdown' = cellType ?? 'code';
    const output = await handleInsert(filePath, afterIndex, source, effectiveCellType, log);
    return { success: output.startsWith('OK'), output };
  },
};

export default notebookEditTool;
