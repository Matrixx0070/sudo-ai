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

/**
 * Sanitise a tool name for Anthropic's OAuth (Claude Code) inference endpoint.
 *
 * Two constraints, both enforced server-side:
 *  1. Names must match ^[a-zA-Z0-9_-]{1,128}$ — sudo-ai's dotted names
 *     (`meta.self-modify`) are rejected outright, so every disallowed char
 *     collapses to `_`.
 *  2. The lowercase single-underscore `mcp_` prefix is RESERVED for the
 *     endpoint's own managed MCP tools. A client tool named `mcp_*` is refused
 *     with a MISLEADING `400 "You're out of extra usage"` billing message (not
 *     a validation error). Verified by replay: `mcp__`, `MCP_`, `mcpconnect`,
 *     `x_mcp_` all pass; only `^mcp_` (one underscore) fails. sudo-ai's
 *     `mcp.connect`/`mcp.list`/`mcp.disconnect` sanitise straight onto that
 *     prefix, so a reserved leading `mcp_` is lifted to `mcp__`.
 *
 * Returns the possibly-rewritten name; identical to the input when no change
 * was needed. Callers that need to reverse the mapping (to resolve the model's
 * tool_use back to the original dotted name) should compare the result to the
 * input and record `sanitized -> original` when they differ.
 */
export function sanitizeOAuthToolName(name: string): string {
  let sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  // `mcp_connect` -> `mcp__connect`; leave an already-doubled `mcp__` alone.
  sanitized = sanitized.replace(/^mcp_(?!_)/, 'mcp__');
  return sanitized.slice(0, 128);
}
