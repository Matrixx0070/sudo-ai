/**
 * @file index.ts
 * @description DOCX toolkit — registers all docx tools into the ToolRegistry.
 *
 * Tools registered:
 *   docx.create       — Create a .docx Word document with title and sections
 *   docx.inspect      — Read structure/text/theme/media of an existing .docx
 *   docx.replace_text — Find-and-replace text in an existing .docx (unpack→edit→pack)
 *   docx.patch        — Apply a batch JSON patch to an existing .docx
 *   docx.convert      — .doc/.dotx→.docx, .docx→pdf/images (LibreOffice)
 *   docx.render       — Labeled page-grid JPEG for visual inspection (LibreOffice)
 *   docx.accept_changes — Flatten all tracked changes into a clean document (LibreOffice)
 */

import type { ToolRegistry } from '../../registry.js';
import { docxCreateTool } from './tools/create.js';
import { docxInspectTool } from './tools/inspect.js';
import { docxReplaceTextTool, docxPatchTool } from './tools/edit.js';
import { docxConvertTool, docxRenderTool, docxAcceptChangesTool } from './tools/convert.js';

export const DOCX_TOOLS = [
  docxCreateTool,
  docxInspectTool,
  docxReplaceTextTool,
  docxPatchTool,
  docxConvertTool,
  docxRenderTool,
  docxAcceptChangesTool,
] as const;

/**
 * Register all docx tools with the given registry.
 * Called automatically by the built-in tool loader.
 *
 * @param registry - The application's central {@link ToolRegistry}.
 */
export function registerDocxTools(registry: ToolRegistry): void {
  for (const tool of DOCX_TOOLS) {
    registry.register(tool);
  }
}
