/**
 * @file index.ts
 * @description PPTX toolkit — registers pptx tools into the ToolRegistry.
 *
 * Tools registered:
 *   pptx.create    — Create a real .pptx PowerPoint deck (pptxgenjs, local/offline)
 *   pptx.inspect   — Read structure/text/notes/media of an existing .pptx
 *   pptx.unpack    — Unpack a .pptx to an editable OOXML directory
 *   pptx.add_slide — Duplicate a slide or instantiate a layout in an unpacked dir
 *   pptx.clean     — Remove orphaned slides/media/rels from an unpacked dir
 *   pptx.pack      — Validate and repack an unpacked dir into a .pptx
 *   pptx.thumbnail — Labeled slide-grid JPEG(s) for template analysis / visual QA
 *   pptx.delete_slide   — Delete slides (or keep-list) with sldIdLst upkeep
 *   pptx.set_text       — Set placeholder text preserving template formatting
 *   pptx.inspect_slides — Placeholders/text/media of an unpacked dir
 *   pptx.check_overlaps — Geometric overlap/overflow QA (optional --fix)
 *   pptx.render_slides  — Per-slide images + contact sheet (LibreOffice)
 */

import type { ToolRegistry } from '../../registry.js';
import { pptxCreateTool } from './tools/create.js';
import { pptxInspectTool } from './tools/inspect.js';
import { pptxUnpackTool, pptxAddSlideTool, pptxCleanTool, pptxPackTool } from './tools/edit.js';
import { pptxThumbnailTool } from './tools/thumbnail.js';
import {
  pptxDeleteSlideTool,
  pptxSetTextTool,
  pptxInspectSlidesTool,
  pptxCheckOverlapsTool,
  pptxRenderSlidesTool,
} from './tools/slide-edit.js';

export const PPTX_TOOLS = [
  pptxCreateTool,
  pptxInspectTool,
  pptxUnpackTool,
  pptxAddSlideTool,
  pptxCleanTool,
  pptxPackTool,
  pptxThumbnailTool,
  pptxDeleteSlideTool,
  pptxSetTextTool,
  pptxInspectSlidesTool,
  pptxCheckOverlapsTool,
  pptxRenderSlidesTool,
] as const;

/**
 * Register all pptx tools with the given registry.
 * Called automatically by the built-in tool loader.
 *
 * @param registry - The application's central {@link ToolRegistry}.
 */
export function registerPptxTools(registry: ToolRegistry): void {
  for (const tool of PPTX_TOOLS) {
    registry.register(tool);
  }
}
