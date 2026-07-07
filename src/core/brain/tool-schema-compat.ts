/**
 * @file tool-schema-compat.ts
 * @description Per-provider tool-schema normalization applied at the AI SDK
 * boundary, so a tool JSON schema that one provider accepts and another
 * rejects is reshaped for the target model before the request goes out.
 *
 * Motivating case: xAI's function-calling validator rejects several JSON
 * Schema validation keywords (minLength, maxItems, …) that Anthropic tolerates.
 * SUDO's Zod-derived tool schemas emit those keywords, so a real agent turn to
 * an xai/* model returns HTTP 400 "format" while the same catalog works on
 * claude-oauth. This strips the unsupported keywords for xai only; every other
 * provider is a pass-through (byte-identical to prior behavior).
 */

/**
 * JSON Schema validation keywords the xAI function-calling API rejects.
 * Constraint keywords only — never structural keys (type/properties/items).
 */
export const XAI_UNSUPPORTED_SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'minContains',
  'maxContains',
]);

/**
 * Recursively remove `unsupported` keywords from a JSON schema, descending
 * only through the known sub-schema containers (properties, items, $defs/
 * definitions, anyOf/oneOf/allOf) so validation keywords are stripped while
 * unrelated data — descriptions, enums, a property literally named "minItems"
 * — is preserved verbatim. Pure; returns a new object, never mutates input.
 */
export function stripUnsupportedSchemaKeywords(schema: unknown, unsupported: ReadonlySet<string>): unknown {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) {
    return schema.map((entry) => stripUnsupportedSchemaKeywords(entry, unsupported));
  }
  const obj = schema as Record<string, unknown>;
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (unsupported.has(key)) continue;

    if ((key === 'properties' || key === '$defs' || key === 'definitions') && value && typeof value === 'object' && !Array.isArray(value)) {
      cleaned[key] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [
          childKey,
          stripUnsupportedSchemaKeywords(childValue, unsupported),
        ]),
      );
      continue;
    }
    if (key === 'items' && value && typeof value === 'object') {
      cleaned[key] = Array.isArray(value)
        ? value.map((entry) => stripUnsupportedSchemaKeywords(entry, unsupported))
        : stripUnsupportedSchemaKeywords(value, unsupported);
      continue;
    }
    if ((key === 'anyOf' || key === 'oneOf' || key === 'allOf') && Array.isArray(value)) {
      cleaned[key] = value.map((entry) => stripUnsupportedSchemaKeywords(entry, unsupported));
      continue;
    }
    cleaned[key] = value;
  }
  return cleaned;
}

/** Provider prefix of a `provider/model-id` ref, lowercased. */
function providerOf(modelId: string): string {
  const slash = modelId.indexOf('/');
  return (slash === -1 ? modelId : modelId.slice(0, slash)).trim().toLowerCase();
}

/**
 * Normalize a tool's JSON-schema `parameters` for the target model. Only xai
 * is transformed today (strips the keywords its validator rejects); every
 * other provider returns the input unchanged. Kill-switch
 * SUDO_TOOL_SCHEMA_COMPAT=0 disables all normalization.
 */
export function sanitizeToolSchemaForProvider<T>(parameters: T, modelId: string): T {
  if (process.env['SUDO_TOOL_SCHEMA_COMPAT'] === '0') return parameters;
  if (providerOf(modelId) === 'xai') {
    // Structural transform: strips only constraint keywords, so the cleaned
    // schema is the same shape as the input (safe to preserve T).
    return stripUnsupportedSchemaKeywords(parameters, XAI_UNSUPPORTED_SCHEMA_KEYWORDS) as T;
  }
  return parameters;
}
