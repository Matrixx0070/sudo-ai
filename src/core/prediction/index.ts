/**
 * Predictive Intelligence module — public surface.
 *
 * Re-exports the Predictor class and its associated types so consumers
 * can import from 'src/core/prediction' without knowing the internal layout.
 */

export { Predictor } from './predictor.js';
export type { Prediction, Anomaly } from './predictor-schema.js';
