import { createLogger } from '../shared/logger.js';
const log = createLogger('brain:frustration');

export type FrustrationLevel = 'none' | 'mild' | 'moderate' | 'high' | 'extreme';

export interface FrustrationSignal {
  level: FrustrationLevel;
  score: number;
  triggers: string[];
  recommendation: string;
}

// Pre-compiled regex patterns (module-level for performance — no API cost)
const PATTERNS = {
  extreme: [
    /\b(wtf|what the f+u+c+k|useless|piece of sh+it|nothing works|i give up|this is broken|absolute garbage)\b/i,
    /[!?]{4,}/,
    /^[A-Z\s!?.,]{20,}$/m,  // ALL CAPS long messages
  ],
  high: [
    /\b(still not working|why won'?t|i already told you|for the (third|second|\d+) time|you'?re not listening|failed again|doesn'?t work|not working)\b/i,
    /\b(that'?s wrong|incorrect|wrong again|still wrong)\b/i,
  ],
  moderate: [
    /\b(not what i asked|that'?s not right|try again|no no+|ugh+|come on|seriously)\b/i,
    /\?\?+/,
  ],
  mild: [
    /\bhmm+\b/i,
    /\.{3,}/,
    /\bhow come\b/i,
  ],
};

const RECOMMENDATIONS: Record<FrustrationLevel, string> = {
  extreme: 'Acknowledge the frustration directly. Simplify your response. Ask what specifically went wrong.',
  high: 'Be more concise. Double-check your understanding of the request. Offer to start fresh.',
  moderate: 'Clarify what was missed. Ask one confirming question.',
  mild: 'Provide a slightly more thorough explanation.',
  none: 'Proceed normally.',
};

export function detectFrustration(message: string): FrustrationSignal {
  const triggers: string[] = [];
  let score = 0;

  for (const pattern of PATTERNS.extreme) {
    if (pattern.test(message)) { triggers.push('extreme:' + pattern.source.slice(0, 30)); score = Math.max(score, 85); }
  }
  for (const pattern of PATTERNS.high) {
    if (pattern.test(message)) { triggers.push('high:' + pattern.source.slice(0, 30)); score = Math.max(score, 65); }
  }
  for (const pattern of PATTERNS.moderate) {
    if (pattern.test(message)) { triggers.push('moderate:' + pattern.source.slice(0, 30)); score = Math.max(score, 45); }
  }
  for (const pattern of PATTERNS.mild) {
    if (pattern.test(message)) { triggers.push('mild:' + pattern.source.slice(0, 30)); score = Math.max(score, 25); }
  }

  const level: FrustrationLevel =
    score >= 80 ? 'extreme' :
    score >= 60 ? 'high' :
    score >= 40 ? 'moderate' :
    score >= 20 ? 'mild' : 'none';

  if (level !== 'none') log.debug({ level, score, triggers }, 'Frustration detected');

  return { level, score, triggers, recommendation: RECOMMENDATIONS[level] };
}

export function isFrustrated(message: string): boolean {
  return detectFrustration(message).score >= 40;
}

export function frustrationTrend(messages: string[]): FrustrationLevel {
  if (messages.length === 0) return 'none';
  const scores = messages.map(m => detectFrustration(m).score);
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  return avg >= 80 ? 'extreme' : avg >= 60 ? 'high' : avg >= 40 ? 'moderate' : avg >= 20 ? 'mild' : 'none';
}
