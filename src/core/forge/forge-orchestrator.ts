import { mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { XaiEnsemble, ChatMessage } from './xai-ensemble.js';
import { ParallelBuilder, ModuleSpec, BuildResult } from './parallel-builder.js';
import { CodeDNA } from './code-dna.js';
import { EvolutionEngine } from './evolution-engine.js';

/**
 * Input provided to the forge process. When modules are omitted the
 * architect model is invoked to design them. OutputDir defaults to
 * `src/generated` if not supplied. The evolve flag controls whether
 * failing modules undergo the evolution process.
 */
export interface ForgeTask {
  description: string;
  outputDir: string;
  modules?: ModuleSpec[];
  runTests?: boolean;
  evolve?: boolean;
}

/**
 * Output of the forge process. Contains the generated files with
 * their paths, timing information, token usage per model and the
 * number of patterns learned. Success is true only if all modules
 * build successfully.
 */
export interface ForgeResult {
  success: boolean;
  files: { path: string; code: string }[];
  totalDurationMs: number;
  modelsUsed: Record<string, number>;
  patternsLearned: number;
}

/**
 * Orchestrates the SUDO FORGE pipeline by coordinating the architect,
 * builder, reviewer, security and evolution stages. It accumulates
 * model usage statistics and stores extracted patterns for future
 * reuse.
 */
export class ForgeOrchestrator {
  private readonly xai: XaiEnsemble;
  private readonly dna: CodeDNA;
  private readonly builder: ParallelBuilder;
  private readonly evolution: EvolutionEngine;

  constructor(xai?: XaiEnsemble) {
    this.xai = xai ?? new XaiEnsemble();
    this.dna = new CodeDNA();
    this.dna.initialize();
    this.builder = new ParallelBuilder();
    this.evolution = new EvolutionEngine(this.xai);
  }

  /**
   * Runs the full forge pipeline for a given task. If modules are not
   * provided it first asks the architect model to design them. It
   * generates code in parallel, performs reviews and security scans,
   * evolves failing modules, writes successful files to disk and
   * persists learned patterns.
   *
   * @param task The forge task to perform.
   */
  public async forge(task: ForgeTask): Promise<ForgeResult> {
    const startTime = Date.now();
    let modules: ModuleSpec[] | undefined = task.modules;
    const buildResults: BuildResult[] = [];
    try {
      // Step 1: Determine module specifications
      if (!modules || modules.length === 0) {
        const system: ChatMessage = {
          role: 'system',
          content:
            'You are a software architect. Given a high level description, produce an array of module specifications in JSON. Each item should have filePath, description, interfaces (array of strings) and dependsOn (array of strings). Return only valid JSON.',
        };
        const user: ChatMessage = {
          role: 'user',
          content: task.description,
        };
        const json = await this.xai.callModel('architect', [system, user], {
          temperature: 0.3,
          maxTokens: 2048,
        });
        try {
          modules = JSON.parse(json) as ModuleSpec[];
        } catch {
          modules = [];
        }
      }
      if (!modules || modules.length === 0) {
        throw new Error('No module specifications could be derived');
      }
      // Step 2: Spawn builders
      const builds = await this.builder.spawnBuilders(modules);
      buildResults.push(...builds);
      // Step 3: Review code for each successful build
      for (const result of buildResults) {
        if (result.success && result.code) {
          const systemReview: ChatMessage = {
            role: 'system',
            content:
              'You are a senior TypeScript reviewer. Assess the provided code for quality, readability and maintainability. Suggest improvements or acknowledge that it looks good.',
          };
          const userReview: ChatMessage = {
            role: 'user',
            content: result.code,
          };
          await this.xai.callModel('reviewer', [systemReview, userReview], {
            temperature: 0.2,
            maxTokens: 1024,
          });
        }
      }
      // Step 4: Security scan of all code
      const concatenated = buildResults.map((br) => br.code).join('\n\n');
      if (concatenated.trim().length > 0) {
        const systemSec: ChatMessage = {
          role: 'system',
          content:
            'You are a security auditor. Identify any security vulnerabilities or unsafe patterns in the given TypeScript code. If nothing is found reply "No issues found".',
        };
        const userSec: ChatMessage = { role: 'user', content: concatenated };
        await this.xai.callModel('security', [systemSec, userSec], {
          temperature: 0.2,
          maxTokens: 1024,
        });
      }
      // Step 5: Evolve failing modules if requested
      if (task.evolve !== false) {
        for (const res of buildResults) {
          if (!res.success) {
            const evolved = await this.evolution.evolve(res.code || '', res.filePath);
            res.code = evolved.finalCode;
            res.success = evolved.testsPassing;
          }
        }
      }
      // Step 6: Write successful modules to the output directory
      const outputDir = task.outputDir || 'src/generated';
      mkdirSync(outputDir, { recursive: true });
      const files: { path: string; code: string }[] = [];
      for (const res of buildResults) {
        if (res.success && res.code) {
          const outPath = join(outputDir, res.filePath);
          mkdirSync(dirname(outPath), { recursive: true });
          writeFileSync(outPath, res.code);
          files.push({ path: outPath, code: res.code });
        }
      }
      // Step 7: Store patterns
      let patternsLearned = 0;
      for (const res of buildResults) {
        if (res.success && res.code) {
          const patterns = this.dna.extractPatterns(res.code, res.filePath);
          for (const pattern of patterns) {
            this.dna.storePattern(pattern);
            patternsLearned++;
          }
        }
      }
      // Compute usage statistics
      const usage: Record<string, number> = {};
      for (const [model, stats] of this.xai.usageByModel.entries()) {
        usage[model] = (usage[model] || 0) + stats.promptTokens + stats.completionTokens;
      }
      const totalDurationMs = Date.now() - startTime;
      const success = buildResults.every((r) => r.success);
      return { success, files, totalDurationMs, modelsUsed: usage, patternsLearned };
    } catch (err) {
      // On any failure return partial result with usage statistics
      const usage: Record<string, number> = {};
      for (const [model, stats] of this.xai.usageByModel.entries()) {
        usage[model] = (usage[model] || 0) + stats.promptTokens + stats.completionTokens;
      }
      const totalDurationMs = Date.now() - startTime;
      return { success: false, files: [], totalDurationMs, modelsUsed: usage, patternsLearned: 0 };
    }
  }
}