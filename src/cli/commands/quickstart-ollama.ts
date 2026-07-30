/**
 * @file quickstart-ollama.ts
 * @description Quickstart step for the local embedding lane (2026-07-30).
 * sudo-ai's default embeddings run on a local Ollama daemon (nomic-embed-text,
 * 768-dim, zero cost, no API key). Ollama is OPTIONAL — without it retrieval
 * degrades to the built-in MiniLM embedder and BM25 — but the quickstart
 * offers a one-click install so new users land on the best lane.
 *
 * The install itself only ever runs after an explicit interactive "yes"
 * (never in --yes / piped mode): it executes the official installer
 * (https://ollama.com/install.sh) on Linux, or prints the download URL on
 * macOS/Windows where the installer is a GUI app.
 */

import { spawnSync } from 'node:child_process';
import type * as readline from 'node:readline';

/** The embedding model the default config expects (see EmbeddingService). */
export const OLLAMA_EMBED_MODEL = 'nomic-embed-text';

const OLLAMA_TAGS_URL = `${process.env['OLLAMA_BASE_URL'] ?? 'http://127.0.0.1:11434'}/api/tags`;

export interface OllamaStatus {
  running: boolean;
  hasEmbedModel: boolean;
}

/** Probe the local Ollama daemon (short timeout — quickstart must never hang). */
export async function detectOllama(timeoutMs = 1500): Promise<OllamaStatus> {
  try {
    const res = await fetch(OLLAMA_TAGS_URL, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { running: false, hasEmbedModel: false };
    const json = (await res.json()) as { models?: Array<{ name?: string }> };
    const hasEmbedModel = (json.models ?? []).some(
      (m) => typeof m.name === 'string' && m.name.startsWith(OLLAMA_EMBED_MODEL),
    );
    return { running: true, hasEmbedModel };
  } catch {
    return { running: false, hasEmbedModel: false };
  }
}

/** One-line status for non-interactive runs — hint only, never installs. */
export async function printOllamaHint(): Promise<void> {
  const st = await detectOllama();
  if (st.running && st.hasEmbedModel) {
    console.log('  Local embeddings: Ollama + nomic-embed-text detected — best retrieval enabled.');
  } else if (st.running) {
    console.log(`  Local embeddings: Ollama running but ${OLLAMA_EMBED_MODEL} missing — run: ollama pull ${OLLAMA_EMBED_MODEL}`);
  } else {
    console.log('  Local embeddings: Ollama not detected — retrieval uses built-in MiniLM/BM25.');
    console.log(`  For best retrieval: install https://ollama.com/download then run: ollama pull ${OLLAMA_EMBED_MODEL}`);
  }
}

/**
 * Interactive quickstart step: detect → offer install (Linux one-click via the
 * official installer; URL instructions elsewhere) → offer model pull. Every
 * action is behind its own explicit yes/no.
 */
export async function offerOllamaSetup(
  rl: readline.Interface,
  promptYesNo: (rl: readline.Interface, question: string, defaultValue: boolean) => Promise<boolean>,
): Promise<void> {
  let st = await detectOllama();

  if (!st.running) {
    console.log('  Ollama not detected. It powers sudo-ai\'s free local embeddings (no API key,');
    console.log('  nothing leaves your machine); without it retrieval falls back to MiniLM/BM25.');
    if (process.platform === 'linux') {
      const go = await promptYesNo(rl, '  Install Ollama now (runs the official ollama.com installer)?', true);
      if (go) {
        const r = spawnSync('sh', ['-c', 'curl -fsSL https://ollama.com/install.sh | sh'], { stdio: 'inherit' });
        if (r.status === 0) st = await detectOllama(4000);
        else console.log('  Installer exited non-zero — install manually from https://ollama.com/download');
      }
    } else {
      console.log('  Install it from https://ollama.com/download, then re-run `sudo-ai quickstart`.');
    }
  }

  if (st.running && !st.hasEmbedModel) {
    const pull = await promptYesNo(rl, `  Download the embedding model (${OLLAMA_EMBED_MODEL}, ~274MB)?`, true);
    if (pull) {
      const r = spawnSync('ollama', ['pull', OLLAMA_EMBED_MODEL], { stdio: 'inherit' });
      if (r.status === 0) st = { running: true, hasEmbedModel: true };
      else console.log(`  Pull failed — run manually later: ollama pull ${OLLAMA_EMBED_MODEL}`);
    }
  }

  if (st.running && st.hasEmbedModel) {
    console.log('  Local embeddings ready — best retrieval enabled, zero cost.');
  } else {
    console.log('  Continuing without Ollama — retrieval uses built-in MiniLM/BM25 (works, weaker).');
  }
}
