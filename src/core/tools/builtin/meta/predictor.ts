/**
 * meta.predictor — SUDO-AI Predictive Intelligence tool.
 *
 * Exposes the Predictor engine to the agent loop so SUDO-AI can anticipate
 * the owner's needs, forecast viral topics, simulate decisions, and surface anomalies.
 *
 * Actions:
 *   anticipate        — predict what the owner likely needs right now (time/day patterns)
 *   predict-viral     — predict the next viral content topic from video history
 *   simulate          — model outcomes of different strategic options
 *   detect-anomalies  — scan metrics for unusual deviations
 *   accuracy          — get prediction accuracy statistics
 *   recent            — list recent predictions
 */

import path from 'node:path';
import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { Predictor, type Prediction, type Anomaly } from '../../../prediction/predictor.js';
import { createLogger } from '../../../shared/logger.js';

const logger = createLogger('meta-predictor');

const DB_PATH = path.resolve('/root/sudo-ai-v4/data/mind.db');

// ---------------------------------------------------------------------------
// Lazy singleton
// ---------------------------------------------------------------------------

let _predictor: Predictor | null = null;

function getPredictor(): Predictor {
  if (!_predictor) {
    _predictor = new Predictor(DB_PATH);
  }
  return _predictor;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatPrediction(p: Prediction): string {
  const confidence = `${Math.round(p.confidence * 100)}%`;
  const expires = p.expiresAt ? ` | expires: ${p.expiresAt.slice(0, 16)}` : '';
  const action = p.suggestedAction ? `\n  Action: ${p.suggestedAction}` : '';
  const outcome = p.outcome !== 'pending' ? ` [${p.outcome?.toUpperCase()}]` : '';
  return (
    `[${p.id.slice(0, 8)}] ${p.type.toUpperCase()}${outcome} — ${confidence} confidence${expires}\n` +
    `  Prediction: ${p.prediction}\n` +
    `  Reasoning: ${p.reasoning}${action}`
  );
}

function formatAnomaly(a: Anomaly): string {
  const sign = a.deviation >= 0 ? '+' : '';
  return (
    `[${a.severity.toUpperCase()}] ${a.metric}\n` +
    `  Expected: ${a.expected} | Actual: ${a.actual} | Deviation: ${sign}${a.deviation.toFixed(1)}%\n` +
    `  ${a.description}`
  );
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const predictorTool: ToolDefinition = {
  name: 'meta.predictor',
  description:
    'Predictive Intelligence engine. Anticipates what the owner needs before they ask, '
    + 'forecasts viral content topics from historical data, simulates decision outcomes, '
    + 'and detects metric anomalies early. '
    + 'Actions: anticipate (time/pattern-based needs), predict-viral (next hot topic), '
    + 'simulate (model strategy options), detect-anomalies (metric deviation scan), '
    + 'accuracy (prediction track record), recent (latest predictions).',
  category: 'meta',
  timeout: 30_000,

  parameters: {
    action: {
      type: 'string',
      required: true,
      description: 'Operation to perform.',
      enum: ['anticipate', 'predict-viral', 'simulate', 'detect-anomalies', 'accuracy', 'recent'],
    },
    scenario: {
      type: 'string',
      description: '[simulate] Scenario description, e.g. "choosing upload frequency strategy".',
    },
    options: {
      type: 'array',
      description: '[simulate] Array of strategy options to compare (2-10 items).',
      items: { type: 'string', description: 'A strategy option description.' },
    },
    predictionId: {
      type: 'string',
      description: '[record-outcome] Prediction ID to mark as correct or incorrect.',
    },
    outcome: {
      type: 'string',
      description: '[record-outcome] Outcome for the prediction.',
      enum: ['correct', 'incorrect'],
    },
    limit: {
      type: 'number',
      description: '[recent] Number of predictions to return (default 10, max 100).',
      default: 10,
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = params['action'] as string | undefined;
    logger.info({ session: ctx.sessionId, action }, 'meta.predictor invoked');

    if (!action?.trim()) {
      return {
        success: false,
        output: 'action is required. Choose one of: anticipate, predict-viral, simulate, detect-anomalies, accuracy, recent.',
      };
    }

    try {
      const predictor = getPredictor();

      switch (action) {

        // -------------------------------------------------------------------
        case 'anticipate': {
          const predictions = await predictor.anticipate();

          if (predictions.length === 0) {
            return {
              success: true,
              output: 'No anticipatory predictions generated for the current time/context. All patterns are nominal.',
              data: { predictions: [] },
            };
          }

          const lines = predictions.map(p => formatPrediction(p));
          logger.info({ count: predictions.length }, 'Anticipatory predictions returned');
          return {
            success: true,
            output: `${predictions.length} anticipatory prediction(s):\n\n${lines.join('\n\n')}`,
            data: { predictions },
          };
        }

        // -------------------------------------------------------------------
        case 'predict-viral': {
          const prediction = await predictor.predictViralTopic();
          logger.info({ id: prediction.id, confidence: prediction.confidence }, 'Viral topic prediction returned');
          return {
            success: true,
            output: `Viral Topic Prediction:\n\n${formatPrediction(prediction)}`,
            data: { prediction },
          };
        }

        // -------------------------------------------------------------------
        case 'simulate': {
          const scenario = (params['scenario'] as string | undefined)?.trim();
          if (!scenario) {
            return { success: false, output: 'scenario is required for simulate.' };
          }

          const rawOptions = params['options'];
          if (!Array.isArray(rawOptions) || rawOptions.length === 0) {
            return { success: false, output: 'options array is required for simulate (provide 2-10 strategy options).' };
          }

          const options = (rawOptions as unknown[])
            .filter(o => typeof o === 'string' && (o as string).trim().length > 0)
            .map(o => (o as string).trim());

          if (options.length < 2) {
            return { success: false, output: 'simulate requires at least 2 valid option strings.' };
          }

          const results = await predictor.simulate(scenario, options);

          const lines = results.map((r, i) => {
            const medal = i === 0 ? 'RECOMMENDED' : `Option ${i + 1}`;
            return (
              `[${medal}] "${r.option}"\n` +
              `  Confidence: ${Math.round(r.confidence * 100)}%\n` +
              `  ${r.projectedOutcome}`
            );
          });

          logger.info({ scenario, topOption: results[0]?.option }, 'Simulation results returned');
          return {
            success: true,
            output: `Decision Simulation: "${scenario}"\n\n${lines.join('\n\n')}`,
            data: { scenario, results },
          };
        }

        // -------------------------------------------------------------------
        case 'detect-anomalies': {
          const anomalies = await predictor.detectAnomalies();

          if (anomalies.length === 0) {
            return {
              success: true,
              output: 'No anomalies detected. All monitored metrics are within normal ranges.',
              data: { anomalies: [] },
            };
          }

          const lines = anomalies.map(a => formatAnomaly(a));
          const criticalCount = anomalies.filter(a => a.severity === 'critical').length;
          const warningCount = anomalies.filter(a => a.severity === 'warning').length;

          logger.warn({ total: anomalies.length, critical: criticalCount }, 'Anomalies detected and returned');
          return {
            success: true,
            output: (
              `${anomalies.length} anomaly/anomalies detected `
              + `(${criticalCount} critical, ${warningCount} warning):\n\n`
              + lines.join('\n\n')
            ),
            data: { anomalies, counts: { total: anomalies.length, critical: criticalCount, warning: warningCount } },
          };
        }

        // -------------------------------------------------------------------
        case 'accuracy': {
          const stats = predictor.getAccuracy();
          const output = [
            'Prediction Accuracy Statistics',
            `  Total resolved:  ${stats.total}`,
            `  Correct:         ${stats.correct}`,
            `  Accuracy rate:   ${stats.rate}%`,
            stats.total === 0 ? '\n  No resolved predictions yet — outcomes have not been recorded.' : '',
          ].join('\n').trimEnd();

          logger.info({ stats }, 'Prediction accuracy returned');
          return { success: true, output, data: stats };
        }

        // -------------------------------------------------------------------
        case 'recent': {
          const rawLimit = params['limit'];
          const limit = typeof rawLimit === 'number'
            ? Math.min(Math.max(1, Math.floor(rawLimit)), 100)
            : 10;

          const predictions = predictor.getRecentPredictions(limit);

          if (predictions.length === 0) {
            return {
              success: true,
              output: 'No predictions stored yet.',
              data: { predictions: [] },
            };
          }

          const lines = predictions.map(p => formatPrediction(p));
          logger.info({ count: predictions.length }, 'Recent predictions returned');
          return {
            success: true,
            output: `${predictions.length} recent prediction(s):\n\n${lines.join('\n\n')}`,
            data: { predictions },
          };
        }

        // -------------------------------------------------------------------
        default:
          return {
            success: false,
            output: `Unknown action: "${action}". Valid: anticipate, predict-viral, simulate, detect-anomalies, accuracy, recent.`,
          };
      }

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ action, err: msg, session: ctx.sessionId }, 'meta.predictor error');
      return { success: false, output: `Predictor error: ${msg}` };
    }
  },
};
