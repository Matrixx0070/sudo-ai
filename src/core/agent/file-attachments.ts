/**
 * @file file-attachments.ts
 * @description Extract deliverable file paths from a tool's text output so the
 * agent loop can attach them to its reply (image preview / audio note / document
 * download). Pure + exported so the contract is unit-tested directly instead of
 * via a hand-maintained pattern mirror.
 *
 * The loop only sees a tool's `output` STRING (its structured `artifacts` are
 * dropped before the tool-result event), so delivery depends on (a) the tool
 * being a known file-producer and (b) its output naming the path with a verb the
 * pattern recognises. File-producing tools converge on "<X> saved/created: <path>".
 */

/** Tools whose text output names a file the user should receive. */
export const FILE_ATTACHMENT_TOOLS = new Set<string>([
  'browser.screenshot',
  'media.image-generate',
  'media.image',
  'media.screenshot',
  'media.record',
  'browser.capture',
  'voice.tts', // synthesized speech → audio/voice note
  'document.markdown-to-pdf', // → PDF
  'document.pdf-from-html', // → PDF
  'document.webpage', // → interactive .html (+ .png preview)
  'document.slides', // → slide-deck PDF
  'docx.create', // → Word document
  'data.chart', // → rendered chart PNG
  'media.qr', // → rendered QR code PNG
  'media.diagram', // → rendered tree/hierarchy diagram PNG
  'media.code-image', // → syntax-highlighted code screenshot PNG
  'media.equation', // → rendered LaTeX equation PNG
  'media.animation', // → looping animated GIF
  'media.mermaid', // → rendered Mermaid diagram PNG
]);

/**
 * Capture a saved/created file path from tool output. Verbs cover the common
 * phrasings ("saved to", "created:", "generated", "wrote"); extensions cover
 * images, audio/video, and document/data deliverables.
 */
export const FILE_ATTACHMENT_PATTERN =
  /(?:saved?(?:\s+to)?|created|generated|wrote|written|path)[:\s]+([^\s\n"']+\.(?:png|jpg|jpeg|gif|webp|pdf|mp4|mov|avi|mp3|wav|ogg|docx|doc|xlsx|pptx|csv|odt|rtf|zip|html))/gi;

export type FileAttachmentType = 'image' | 'video' | 'audio' | 'document';

export interface ExtractedFile {
  type: FileAttachmentType;
  path: string;
  filename: string | undefined;
}

const VIDEO_EXTS = new Set(['mp4', 'mov', 'avi']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg']);
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
// Everything else the pattern can capture is a document/data deliverable.

function classify(ext: string): FileAttachmentType {
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (IMAGE_EXTS.has(ext)) return 'image';
  return 'document';
}

/**
 * Returns the (de-duplicated) files named in a file-producing tool's output.
 * Non-file tools and empty output yield []. A tool counts as a file producer if
 * it's in {@link FILE_ATTACHMENT_TOOLS} or its name implies media capture.
 */
export function extractFileAttachments(toolName: string, resultStr: string): ExtractedFile[] {
  const isFileTool =
    FILE_ATTACHMENT_TOOLS.has(toolName) ||
    toolName.includes('screenshot') ||
    toolName.includes('image') ||
    toolName.includes('record') ||
    toolName.includes('capture');
  if (!isFileTool || !resultStr) return [];

  const out: ExtractedFile[] = [];
  FILE_ATTACHMENT_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FILE_ATTACHMENT_PATTERN.exec(resultStr)) !== null) {
    const filePath = match[1];
    if (!filePath) continue;
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    if (out.some((a) => a.path === filePath)) continue;
    out.push({ type: classify(ext), path: filePath, filename: filePath.split('/').pop() });
  }
  return out;
}
