import { isMainThread, parentPort, workerData, Worker } from 'worker_threads';
import { performance } from 'perf_hooks';
import { resolve } from 'path';
import type { ChatMessage } from './xai-ensemble.js';
import { XaiEnsemble } from './xai-ensemble.js';

/**
 * Specification for a module to be generated. A module lives at
 * filePath, contains code fulfilling the description, exports the
 * interfaces listed in `interfaces` and may depend on other modules.
 */
export interface ModuleSpec {
  filePath: string;
  description: string;
  interfaces: string[];
  dependsOn: string[];
}

/**
 * Result of attempting to build a module. On success `code` will hold
 * the generated file contents, and `success` will be true. On error
 * `error` conveys the failure reason.
 */
export interface BuildResult {
  filePath: string;
  code: string;
  success: boolean;
  error?: string;
  durationMs: number;
}

/**
 * Executes code generation tasks in parallel using worker threads. When
 * used on the main thread, spawnBuilders starts a worker for each
 * module specification and waits for all to complete. When run as a
 * worker, it receives a single spec via workerData and produces a
 * BuildResult via postMessage.
 */
export class ParallelBuilder {
  /**
   * Spawns a worker thread for each provided ModuleSpec. Workers run
   * concurrently and return BuildResult objects when finished. Any
   * failure in one worker does not prevent others from completing.
   *
   * @param specs The module specifications to build.
   * @returns Promise resolved with an array of BuildResults.
   */
  public async spawnBuilders(specs: ModuleSpec[]): Promise<BuildResult[]> {
    if (!isMainThread) {
      throw new Error('spawnBuilders must be called from the main thread');
    }
    const tasks = specs.map((spec) => {
      return new Promise<BuildResult>((resolve, reject) => {
        try {
          const worker = new Worker(new URL(import.meta.url, import.meta.url), {
            workerData: spec,
          });
          worker.once('message', (result: BuildResult) => {
            resolve(result);
          });
          worker.once('error', (err) => {
            resolve({
              filePath: spec.filePath,
              code: '',
              success: false,
              error: String(err),
              durationMs: 0,
            });
          });
        } catch (err) {
          resolve({
            filePath: spec.filePath,
            code: '',
            success: false,
            error: String(err),
            durationMs: 0,
          });
        }
      });
    });
    return Promise.all(tasks);
  }
}

// Worker code. When not running on the main thread this block
// executes immediately and generates a module based on workerData.
if (!isMainThread && parentPort) {
  (async () => {
    const spec = workerData as ModuleSpec;
    const start = performance.now();
    let result: BuildResult;
    try {
      const xai = new XaiEnsemble();
      // Craft a prompt instructing the model to generate complete
      // TypeScript code for the module. Be explicit about expected
      // exports and dependencies to give the model enough context.
      const systemMsg: ChatMessage = {
        role: 'system',
        content:
          'You are a TypeScript code generator. Given a module specification, produce the complete code for that module. Do not include any explanations. Ensure the code compiles and matches the interfaces described.',
      };
      const userMsg: ChatMessage = {
        role: 'user',
        content: `Module file path: ${spec.filePath}\nDescription: ${spec.description}\nInterfaces: ${spec.interfaces.join(', ')}\nDepends on: ${spec.dependsOn.join(', ')}`,
      };
      const code = await xai.callModel('code-specialist', [systemMsg, userMsg], {
        temperature: 0.2,
        maxTokens: 2048,
      });
      const durationMs = performance.now() - start;
      result = {
        filePath: spec.filePath,
        code,
        success: true,
        durationMs,
      };
    } catch (err: any) {
      const durationMs = performance.now() - start;
      result = {
        filePath: spec?.filePath ?? 'unknown',
        code: '',
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs,
      };
    }
    parentPort.postMessage(result);
  })().catch((err) => {
    // Unexpected failure: communicate error
    parentPort?.postMessage({
      filePath: workerData?.filePath ?? 'unknown',
      code: '',
      success: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: 0,
    } as BuildResult);
  });
}