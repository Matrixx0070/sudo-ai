import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execSync } from 'child_process';
import { XaiEnsemble } from './xai-ensemble.js';
import type { ChatMessage } from './xai-ensemble.js';

/**
 * Structure returned by the evolution process. It captures the final
 * code, the number of generations attempted, whether tests passed and
 * a log of improvements attempted at each generation.
 */
export interface EvolvedCode {
  finalCode: string;
  generations: number;
  testsPassing: boolean;
  improvements: string[];
}

/**
 * Attempts to iteratively refine a piece of TypeScript code until it
 * runs without throwing an exception. When an error occurs the
 * EvolutionEngine asks the complex‑builder model to repair the code
 * using the error message as context. Up to three generations are
 * attempted.
 */
export class EvolutionEngine {
  private readonly xai: XaiEnsemble;
  constructor(xai: XaiEnsemble) {
    this.xai = xai;
  }

  /**
   * Evolves the supplied code by running it and attempting to fix
   * errors using the xAI complex‑builder model. The process repeats
   * until the code runs successfully or the maximum number of
   * generations is reached.
   *
   * @param code The initial TypeScript source code to evolve.
   * @param filePath Path of the code file (used only for messaging).
   * @param context Additional context to include in the prompt.
   * @returns A promise resolving with information about the evolved code.
   */
  public async evolve(code: string, filePath: string, context?: string): Promise<EvolvedCode> {
    let currentCode = code;
    const improvements: string[] = [];
    let testsPassing = false;
    let generations = 0;
    const MAX_GENERATIONS = 3;
    for (let i = 0; i < MAX_GENERATIONS; i++) {
      generations = i + 1;
      // Write the current code to a temporary file
      const tempFile = join(
        tmpdir(),
        `evolve-${Date.now()}-${Math.random().toString(36).substring(2)}.ts`
      );
      try {
        writeFileSync(tempFile, currentCode);
        // Attempt to run the code with tsx. Using stdio 'pipe' to catch output.
        execSync(`npx tsx ${tempFile}`, { stdio: 'pipe', timeout: 30000 });
        testsPassing = true;
        unlinkSync(tempFile);
        break;
      } catch (err: any) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        improvements.push(`Generation ${i + 1} failed: ${errorMsg}`);
        // Ask the complex‑builder model to fix the code based on error
        const system: ChatMessage = {
          role: 'system',
          content:
            'You are an expert TypeScript developer. Given code and an error, return corrected code only, without explanations.',
        };
        const user: ChatMessage = {
          role: 'user',
          content: `File: ${filePath}\n\nContext: ${context ?? ''}\n\nCurrent code:\n${currentCode}\n\nError:\n${errorMsg}\n\nProvide only the corrected TypeScript file contents.`,
        };
        try {
          const response = await this.xai.callModel('complex-builder', [system, user], {
            temperature: 0.2,
            maxTokens: 2048,
          });
          currentCode = response.trim();
        } catch (fixErr) {
          improvements.push(`Failed to obtain fix: ${fixErr}`);
          break;
        } finally {
          try {
            unlinkSync(tempFile);
          } catch {
            /* ignore */
          }
        }
      }
    }
    return { finalCode: currentCode, generations, testsPassing, improvements };
  }
}