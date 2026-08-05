/**
 * @file magika.ts
 * @description Deep-learning file-type detection — a faithful TypeScript port of
 * Google's Magika (`standard_v3_3` model, Apache-2.0), running the vendored ONNX
 * model on `onnxruntime-node` (the same runtime stack Whisper/Kokoro/local
 * embeddings use). Where `detectMime` (../types.ts) matches 4 magic-byte
 * signatures, Magika classifies 200+ content types — including text/code formats
 * (python vs js vs json vs csv vs markdown …) that magic bytes cannot tell apart.
 *
 * Model + config + content-types KB are vendored under `./assets/` (≈3 MB total),
 * so detection is offline and deterministic — no runtime download (unlike the
 * large STT/TTS models). Inference is async and lazy: the session loads on first
 * call and is cached. Off-box or if onnxruntime-node is missing, the loader
 * throws a clear error; callers should treat Magika as an enrichment over the
 * always-available sync `detectMime`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('files:magika');

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), 'assets');

interface MagikaModelConfig {
  beg_size: number;
  mid_size: number;
  end_size: number;
  block_size: number;
  padding_token: number;
  min_file_size_for_dl: number;
  medium_confidence_threshold: number;
  target_labels_space: string[];
  thresholds: Record<string, number>;
  overwrite_map: Record<string, string>;
}

interface ContentTypeInfo {
  mime_type: string;
  group: string;
  description: string;
  extensions: string[];
  is_text: boolean;
}

const CONFIG: MagikaModelConfig = JSON.parse(readFileSync(join(ASSETS, 'model_config.json'), 'utf8'));
const KB: Record<string, ContentTypeInfo> = JSON.parse(readFileSync(join(ASSETS, 'content_types_kb.json'), 'utf8'));

/** ASCII whitespace bytes stripped by Python `bytes.strip()`. */
const WS = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20]);

export interface MagikaResult {
  /** Magika content-type label, e.g. `python`, `json`, `pdf`, `txt`, `unknown`, `empty`. */
  label: string;
  mimeType: string;
  /** Coarse group, e.g. `code`, `text`, `document`, `image`, `archive`. */
  group: string;
  description: string;
  isText: boolean;
  /** Model probability of the predicted (pre-threshold) label, 0–1. */
  score: number;
}

function ctInfo(label: string): ContentTypeInfo {
  return (
    KB[label] ?? { mime_type: 'application/octet-stream', group: 'unknown', description: label, extensions: [], is_text: false }
  );
}

// -- feature extraction (port of Magika._extract_features_from_seekable) -------

function lstripWs(buf: Buffer): Buffer {
  let i = 0;
  while (i < buf.length && WS.has(buf[i]!)) i++;
  return buf.subarray(i);
}
function rstripWs(buf: Buffer): Buffer {
  let j = buf.length;
  while (j > 0 && WS.has(buf[j - 1]!)) j--;
  return buf.subarray(0, j);
}

/** Build the 2048-int feature vector: beg (padded at end) ++ end (padded at start). */
function extractFeatures(content: Buffer): Int32Array {
  const { beg_size, end_size, block_size, padding_token } = CONFIG;
  const feat = new Int32Array(beg_size + end_size).fill(padding_token);
  const toRead = Math.min(block_size, content.length);

  // beg: first `toRead` bytes, lstripped, first `beg_size` of them; pad at END.
  const beg = lstripWs(content.subarray(0, toRead));
  for (let i = 0; i < beg_size && i < beg.length; i++) feat[i] = beg[i]!;

  // end: last `toRead` bytes, rstripped, last `end_size` of them; pad at START.
  const end = rstripWs(content.subarray(content.length - toRead, content.length));
  const take = Math.min(end_size, end.length);
  for (let i = 0; i < take; i++) feat[beg_size + (end_size - take) + i] = end[end.length - take + i]!;

  return feat;
}

// -- ONNX session (lazy singleton) --------------------------------------------

interface OrtLike {
  InferenceSession: { create(path: string): Promise<OrtSession> };
  Tensor: new (type: string, data: Int32Array, dims: number[]) => unknown;
}
interface OrtSession {
  inputNames: string[];
  outputNames: string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: ArrayLike<number> }>>;
}

let sessionPromise: Promise<{ ort: OrtLike; session: OrtSession }> | null = null;

async function getSession(): Promise<{ ort: OrtLike; session: OrtSession }> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      let ort: OrtLike;
      try {
        ort = (await import('onnxruntime-node')) as unknown as OrtLike;
      } catch (e) {
        throw new Error(
          'onnxruntime-node is required for Magika file-type detection — run `pnpm add onnxruntime-node`. ' +
            `(${(e as Error).message})`,
        );
      }
      const session = await ort.InferenceSession.create(join(ASSETS, 'model.onnx'));
      log.info({ labels: CONFIG.target_labels_space.length }, 'magika model loaded');
      return { ort, session };
    })().catch((e) => {
      sessionPromise = null; // allow retry after a transient load failure
      throw e;
    });
  }
  return sessionPromise;
}

// -- public API ----------------------------------------------------------------

/**
 * Classify a buffer's content type with Magika. Async (loads the ONNX model on
 * first call). Empty input returns `empty`; otherwise runs the model and applies
 * Magika's HIGH_CONFIDENCE thresholding (per-label threshold, falling back to
 * `txt`/`unknown` by text-vs-binary when the model is not confident enough).
 */
export async function detectContentType(content: Buffer): Promise<MagikaResult> {
  if (content.length === 0) {
    const info = ctInfo('empty');
    return { label: 'empty', mimeType: info.mime_type, group: info.group, description: info.description, isText: info.is_text, score: 1 };
  }

  const { ort, session } = await getSession();
  const feat = extractFeatures(content);
  const input = new ort.Tensor('int32', feat, [1, feat.length]);
  const out = await session.run({ [session.inputNames[0]!]: input });
  const probs = out[session.outputNames[0]!]!.data;

  // argmax over the 214-way softmax.
  let bestIdx = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < probs.length; i++) {
    const v = Number(probs[i]);
    if (v > bestScore) {
      bestScore = v;
      bestIdx = i;
    }
  }
  const dlLabel = CONFIG.target_labels_space[bestIdx] ?? 'unknown';

  // overwrite_map, then HIGH_CONFIDENCE thresholding.
  let outputLabel = CONFIG.overwrite_map[dlLabel] ?? dlLabel;
  const threshold = CONFIG.thresholds[dlLabel] ?? CONFIG.medium_confidence_threshold;
  if (bestScore < threshold) {
    outputLabel = ctInfo(outputLabel).is_text ? 'txt' : 'unknown';
  }

  const info = ctInfo(outputLabel);
  return {
    label: outputLabel,
    mimeType: info.mime_type,
    group: info.group,
    description: info.description,
    isText: info.is_text,
    score: bestScore,
  };
}

/** The set of content-type labels the model can emit (214). */
export function magikaLabels(): readonly string[] {
  return CONFIG.target_labels_space;
}
