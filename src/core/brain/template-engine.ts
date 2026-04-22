/**
 * Template engine for system prompt variable substitution.
 *
 * Supports {{ variable }} placeholders matching the Codex GPT-5.4 template format.
 * Unknown variables are left as-is (the placeholder is preserved).
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('brain:template');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Map of variable names to their substitution values.
 * Unknown keys are silently ignored — the placeholder is kept in the output.
 */
export interface TemplateVars {
  personality?: string;
  user_name?: string;
  workspace?: string;
  model?: string;
  date?: string;
  tools_count?: number;
  [key: string]: string | number | boolean | undefined;
}

// ---------------------------------------------------------------------------
// renderTemplate
// ---------------------------------------------------------------------------

/**
 * Replace {{ variable }} placeholders in a template string with values from vars.
 *
 * - Whitespace inside the braces is trimmed: "{{ name }}" and "{{name}}" both match.
 * - If a variable is not present in vars, the original placeholder is preserved.
 * - Values of type number or boolean are coerced to strings.
 *
 * @param template - Raw template string containing {{ placeholders }}.
 * @param vars     - Key/value substitution map.
 * @returns Rendered string with all known placeholders replaced.
 */
export function renderTemplate(template: string, vars: TemplateVars): string {
  if (!template || typeof template !== 'string') {
    log.warn({ template }, 'renderTemplate: received empty or non-string template');
    return template ?? '';
  }

  const rendered = template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) => {
    const val = vars[key];
    return val !== undefined ? String(val) : match;
  });

  const replacedCount = (template.match(/\{\{\s*\w+\s*\}\}/g) ?? []).length;
  const remainingCount = (rendered.match(/\{\{\s*\w+\s*\}\}/g) ?? []).length;

  log.debug(
    {
      totalPlaceholders: replacedCount,
      resolved: replacedCount - remainingCount,
      unresolved: remainingCount,
    },
    'Template rendered',
  );

  return rendered;
}

log.debug('template-engine module loaded');
