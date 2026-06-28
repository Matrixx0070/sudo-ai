/**
 * @file cognition/injection-detector.ts
 * @description InjectionDetector — stateless pure detector that scans arbitrary text
 * (user messages, tool args, tool outputs) for prompt-injection markers and returns
 * severity + matched markers.
 *
 * Pure module — no DB, no persistence, no side effects. 6O will wire into loop.ts + REST.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type InjectionSeverity = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface DetectionResult {
  severity: InjectionSeverity;
  matchedMarkers: string[];  // unique list of category names (not raw match strings)
  snippetCount: number;      // total number of regex matches across all categories
  scannedChars: number;      // chars actually scanned (after truncation)
}

export interface InjectionDetectorOptions {
  strictMode?: boolean;  // if true, LOW becomes MEDIUM; CRITICAL stays CRITICAL
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_SCAN_CHARS = 100_000;

// Severity ordering for comparison
const SEVERITY_ORDER: Record<InjectionSeverity, number> = {
  NONE: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
};

// ---------------------------------------------------------------------------
// Marker rules — module-level constant
// ---------------------------------------------------------------------------

interface MarkerRule {
  category: string;
  regex: RegExp;
  severity: InjectionSeverity;
}

const MARKER_RULES: MarkerRule[] = [
  {
    category: 'ROLE_MARKER',
    regex: /\[SYSTEM\]|\[ADMIN\]|\[DEV\]|\[INST\]|\[\/INST\]/gi,
    severity: 'HIGH',
  },
  {
    category: 'CHATML',
    regex: /<\|im_start\|>|<\|im_end\|>|<\|system\|>|<\|user\|>|<\|assistant\|>/gi,
    severity: 'HIGH',
  },
  {
    category: 'IGNORE_INSTRUCTION',
    regex: /\b(ignore|disregard|forget|override|bypass)\b[\s\S]{0,30}\b(instructions?|rules?|directives?|constraints?|prompts?)\b/gi,
    severity: 'CRITICAL',
  },
  {
    category: 'REVEAL_PROMPT',
    regex: /(reveal|show|print|display|leak|disclose)\s+(the\s+|your\s+)?(system\s+prompt|instructions|rules|hidden\s+instructions)/gi,
    severity: 'CRITICAL',
  },
  {
    category: 'JAILBREAK',
    regex: /DAN\s+mode|developer\s+mode|jailbreak|evil\s+mode|uncensored\s+(mode|prompt)/gi,
    severity: 'HIGH',
  },
  {
    category: 'AUTHORITY_CLAIM',
    regex: /(I\s+am|as)\s+(your\s+)?(owner|admin|creator|developer|Anthropic|OpenAI)|(pre-?authori[sz]ed|user\s+has\s+authori[sz]ed)/gi,
    severity: 'MEDIUM',
  },
  {
    category: 'URGENCY',
    regex: /(emergency|urgent|immediately|right\s+now).*(override|bypass|skip)/gi,
    severity: 'MEDIUM',
  },
  {
    category: 'HIDDEN_ENCODING',
    regex: /base64:|\bencoded:|\bcipher:/gi,
    severity: 'LOW',
  },
  {
    category: 'XML_TAG_INJECTION',
    regex: /<\/?(system|instructions|user_input|tool_use|assistant)>/gi,
    severity: 'MEDIUM',
  },
  {
    category: 'DELIMITER_ESCAPE',
    regex: /`{3,}\s*(SYSTEM|IGNORE|OVERRIDE):/gi,
    severity: 'LOW',
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Count all matches of a regex in text. Regex must have the `g` flag.
 * Returns 0 on any unexpected error (fail-open).
 *
 * Guard: advances lastIndex on zero-width matches to prevent an infinite loop,
 * and caps iterations at text.length+2 so a pathological regex can't spin forever.
 */
function countMatches(regex: RegExp, text: string): number {
  try {
    regex.lastIndex = 0;
    let count = 0;
    const cap = text.length + 2;
    let prevLastIndex = -1;
    while (count < cap) {
      const m = regex.exec(text);
      if (m === null) break;
      count++;
      if (regex.lastIndex === prevLastIndex) {
        regex.lastIndex++;
      }
      prevLastIndex = regex.lastIndex;
    }
    return count;
  } catch {
    return 0;
  }
}

/**
 * Resolve the effective severity for a result, applying strictMode promotion.
 * strictMode: LOW → MEDIUM (but CRITICAL stays CRITICAL, NONE stays NONE).
 */
function resolveEffectiveSeverity(
  baseSeverity: InjectionSeverity,
  strictMode: boolean,
): InjectionSeverity {
  if (strictMode && baseSeverity === 'LOW') {
    return 'MEDIUM';
  }
  return baseSeverity;
}

/**
 * Return the higher of two severities by their ordering.
 */
function maxSeverity(a: InjectionSeverity, b: InjectionSeverity): InjectionSeverity {
  return SEVERITY_ORDER[a] >= SEVERITY_ORDER[b] ? a : b;
}

/**
 * Compute severity from a set of matched category names.
 * Returns 'NONE' if empty.
 */
function severityFromCategories(categories: string[]): InjectionSeverity {
  let result: InjectionSeverity = 'NONE';
  for (const cat of categories) {
    const rule = MARKER_RULES.find(r => r.category === cat);
    if (rule) {
      result = maxSeverity(result, rule.severity);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// InjectionDetector
// ---------------------------------------------------------------------------

export class InjectionDetector {
  private readonly _strictMode: boolean;

  constructor(opts?: InjectionDetectorOptions) {
    this._strictMode = opts?.strictMode === true;
  }

  /**
   * Scan a single text for injection markers.
   * - Empty/whitespace → NONE, empty arrays, zero counts
   * - Text > 100,000 chars → truncated before scan (scannedChars = 100,000)
   * - Fail-open: any unexpected error returns NONE result
   */
  scan(text: string): DetectionResult {
    try {
      if (typeof text !== 'string' || text.trim().length === 0) {
        return { severity: 'NONE', matchedMarkers: [], snippetCount: 0, scannedChars: 0 };
      }

      const truncated = text.length > MAX_SCAN_CHARS ? text.slice(0, MAX_SCAN_CHARS) : text;
      const scannedChars = truncated.length;

      const matchedMarkers: string[] = [];
      let snippetCount = 0;

      for (const rule of MARKER_RULES) {
        const count = countMatches(rule.regex, truncated);
        if (count > 0) {
          matchedMarkers.push(rule.category);
          snippetCount += count;
        }
      }

      const baseSeverity = severityFromCategories(matchedMarkers);
      const severity = resolveEffectiveSeverity(baseSeverity, this._strictMode);

      return { severity, matchedMarkers, snippetCount, scannedChars };
    } catch {
      return { severity: 'NONE', matchedMarkers: [], snippetCount: 0, scannedChars: 0 };
    }
  }

  /**
   * Scan multiple texts and union the results.
   * - matchedMarkers: unique union across all scans
   * - snippetCount: sum across all scans
   * - scannedChars: sum across all scans
   * - severity: derived from the final unioned marker set (strictMode applied once)
   */
  scanBatch(texts: string[]): DetectionResult {
    try {
      const allMarkers = new Set<string>();
      let totalSnippets = 0;
      let totalChars = 0;

      for (const text of texts) {
        if (typeof text !== 'string' || text.trim().length === 0) {
          continue;
        }
        const truncated = text.length > MAX_SCAN_CHARS ? text.slice(0, MAX_SCAN_CHARS) : text;
        totalChars += truncated.length;

        for (const rule of MARKER_RULES) {
          const count = countMatches(rule.regex, truncated);
          if (count > 0) {
            allMarkers.add(rule.category);
            totalSnippets += count;
          }
        }
      }

      const matchedMarkers = Array.from(allMarkers);
      const baseSeverity = severityFromCategories(matchedMarkers);
      const severity = resolveEffectiveSeverity(baseSeverity, this._strictMode);

      return {
        severity,
        matchedMarkers,
        snippetCount: totalSnippets,
        scannedChars: totalChars,
      };
    } catch {
      return { severity: 'NONE', matchedMarkers: [], snippetCount: 0, scannedChars: 0 };
    }
  }
}
