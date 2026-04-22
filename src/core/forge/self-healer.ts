import { watchFile, unwatchFile, readFileSync, writeFileSync } from 'fs';
import { spawn } from 'child_process';
import { XaiEnsemble } from './xai-ensemble.js';
import type { ChatMessage } from './xai-ensemble.js';

/**
 * Represents an error captured from a monitored process. Contains
 * sufficient information to attempt automatic healing of the source
 * code that caused the error.
 */
export interface ProcessError {
  processName: string;
  errorMessage: string;
  stackTrace: string;
  timestamp: Date;
}

/**
 * Result returned by the healer after attempting to patch a file. If
 * patched is true the file was updated and the process restarted.
 */
export interface HealResult {
  patched: boolean;
  filePath?: string;
  description: string;
  appliedPatch?: string;
}

/**
 * Watches process log files for errors and, when found, leverages the
 * complex‑builder model to generate patches for the offending code.
 */
export class SelfHealer {
  private xai: XaiEnsemble;
  private watchers: Map<string, { logFile: string; callback: (curr: any, prev: any) => void }> =
    new Map();

  constructor(xai: XaiEnsemble) {
    this.xai = xai;
  }

  /**
   * Begins monitoring a log file for errors. When an error line is
   * detected, onError is invoked to attempt a fix. Monitoring runs
   * until stopMonitoring is called for the same processName.
   *
   * @param processName Arbitrary identifier for the process.
   * @param logFile Path to the log file to watch.
   */
  public startMonitoring(processName: string, logFile: string): void {
    const callback = (curr: any, prev: any) => {
      if (curr.mtime <= prev.mtime) return;
      try {
        const content = readFileSync(logFile, 'utf-8');
        const lines = content.split(/\r?\n/);
        // Check the most recent lines for error patterns
        for (let i = Math.max(0, lines.length - 20); i < lines.length; i++) {
          const line = lines[i];
          if (/error|exception/i.test(line)) {
            const stack = lines.slice(Math.max(0, i - 10), i + 10).join('\n');
            const error: ProcessError = {
              processName,
              errorMessage: line,
              stackTrace: stack,
              timestamp: new Date(),
            };
            // Fire and forget the healing to avoid blocking
            this.onError(error).catch(() => {
              /* ignore healing errors */
            });
            break;
          }
        }
      } catch {
        /* ignore read errors */
      }
    };
    watchFile(logFile, { persistent: true, interval: 5000 }, callback);
    this.watchers.set(processName, { logFile, callback });
  }

  /**
   * Stops monitoring a previously watched log file. If no such
   * monitoring session exists nothing happens.
   *
   * @param processName Identifier provided at startMonitoring time.
   */
  public stopMonitoring(processName: string): void {
    const entry = this.watchers.get(processName);
    if (!entry) return;
    unwatchFile(entry.logFile, entry.callback);
    this.watchers.delete(processName);
  }

  /**
   * Invoked when an error is detected. Attempts to locate the
   * offending TypeScript file from the stack trace, ask the xAI
   * complex‑builder model for a fix and restart the process. Returns
   * details about the attempted heal.
   *
   * @param error Details of the error encountered.
   */
  public async onError(error: ProcessError): Promise<HealResult> {
    try {
      // Extract a file path from the stack trace (look for .ts entries)
      const match = error.stackTrace.match(/([^\s\(]+\.ts):\d+:\d+/);
      const filePath = match ? match[1] : undefined;
      if (!filePath) {
        return { patched: false, description: 'No TypeScript file found in stack trace' };
      }
      const originalCode = readFileSync(filePath, 'utf-8');
      const system: ChatMessage = {
        role: 'system',
        content:
          'You are a senior TypeScript engineer. Given faulty code and an error, return corrected code only, with no explanations.',
      };
      const user: ChatMessage = {
        role: 'user',
        content: `File: ${filePath}\n\nOriginal code:\n${originalCode}\n\nError:\n${error.errorMessage}\n\nStack Trace:\n${error.stackTrace}\n\nReturn the full corrected code for this file.`,
      };
      const newCode = await this.xai.callModel('complex-builder', [system, user], {
        temperature: 0.2,
        maxTokens: 2048,
      });
      writeFileSync(filePath, newCode);
      // Restart the process by spawning it anew. Use detached to
      // disassociate the child. The processName is used as a
      // command here; in real scenarios this might map to a script path.
      spawn('node', [error.processName], { detached: true, stdio: 'ignore' }).unref();
      return {
        patched: true,
        filePath,
        description: 'Patched file and restarted process',
        appliedPatch: newCode,
      };
    } catch (err: any) {
      return { patched: false, description: `Healing failed: ${err}` };
    }
  }
}