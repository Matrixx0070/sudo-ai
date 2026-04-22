/**
 * @file validation.ts
 * @description Input validation helpers for the agent config REST resource.
 *
 * Enforces:
 *  - Required / optional field types
 *  - Max string lengths
 *  - Max array sizes (tools <= 50, skills <= 20)
 *  - No unknown keys (strict allow-list)
 *
 * All helpers return null on success or an error message string on failure.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_NAME_LEN        = 256;
const MAX_MODEL_LEN       = 128;
const MAX_SYSTEM_LEN      = 32_768;  // 32 KB
const MAX_TOOLS_COUNT     = 50;
const MAX_SKILLS_COUNT    = 20;
const MAX_MCP_COUNT       = 50;

// Allowed keys for create and update bodies
const CREATE_ALLOWED_KEYS = new Set([
  'name', 'model', 'system', 'tools', 'skills', 'mcp_servers',
]);

const UPDATE_ALLOWED_KEYS = new Set([
  'version', 'name', 'model', 'system', 'tools', 'skills', 'mcp_servers',
]);

// ---------------------------------------------------------------------------
// Primitive validators
// ---------------------------------------------------------------------------

function checkStringField(
  obj: Record<string, unknown>,
  key: string,
  required: boolean,
  maxLen: number,
): string | null {
  const val = obj[key];
  if (val === undefined || val === null) {
    if (required) return `"${key}" is required`;
    return null;
  }
  if (typeof val !== 'string') return `"${key}" must be a string`;
  if (val.length > maxLen) return `"${key}" exceeds maximum length of ${maxLen}`;
  return null;
}

function checkArrayField(
  obj: Record<string, unknown>,
  key: string,
  maxCount: number,
): string | null {
  const val = obj[key];
  if (val === undefined) return null; // optional
  if (!Array.isArray(val)) return `"${key}" must be an array`;
  if (val.length > maxCount) return `"${key}" exceeds maximum of ${maxCount} items`;
  for (let i = 0; i < val.length; i++) {
    if (typeof val[i] !== 'object' || val[i] === null || Array.isArray(val[i])) {
      return `"${key}[${i}]" must be a non-null object`;
    }
  }
  return null;
}

function checkUnknownKeys(
  obj: Record<string, unknown>,
  allowed: Set<string>,
): string | null {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) return `Unknown field: "${key}"`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public validators
// ---------------------------------------------------------------------------

/**
 * Validate a create agent request body.
 * Returns null on success, or a human-readable error string on failure.
 */
export function validateCreate(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return 'Request body must be a JSON object';
  }
  const obj = body as Record<string, unknown>;

  const unknownErr = checkUnknownKeys(obj, CREATE_ALLOWED_KEYS);
  if (unknownErr) return unknownErr;

  const nameErr = checkStringField(obj, 'name', true, MAX_NAME_LEN);
  if (nameErr) return nameErr;

  const modelErr = checkStringField(obj, 'model', true, MAX_MODEL_LEN);
  if (modelErr) return modelErr;

  if (obj['name'] !== undefined && (obj['name'] as string).trim().length === 0) {
    return '"name" must not be blank';
  }
  if (obj['model'] !== undefined && (obj['model'] as string).trim().length === 0) {
    return '"model" must not be blank';
  }

  const systemErr = checkStringField(obj, 'system', false, MAX_SYSTEM_LEN);
  if (systemErr) return systemErr;

  const toolsErr = checkArrayField(obj, 'tools', MAX_TOOLS_COUNT);
  if (toolsErr) return toolsErr;

  const skillsErr = checkArrayField(obj, 'skills', MAX_SKILLS_COUNT);
  if (skillsErr) return skillsErr;

  const mcpErr = checkArrayField(obj, 'mcp_servers', MAX_MCP_COUNT);
  if (mcpErr) return mcpErr;

  return null;
}

/**
 * Validate an update agent request body.
 * `version` is required for optimistic locking.
 * Returns null on success, or a human-readable error string on failure.
 */
export function validateUpdate(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return 'Request body must be a JSON object';
  }
  const obj = body as Record<string, unknown>;

  const unknownErr = checkUnknownKeys(obj, UPDATE_ALLOWED_KEYS);
  if (unknownErr) return unknownErr;

  if (obj['version'] === undefined) return '"version" is required for optimistic locking';
  if (typeof obj['version'] !== 'number' || !Number.isInteger(obj['version']) || obj['version'] < 1) {
    return '"version" must be a positive integer';
  }

  const nameErr = checkStringField(obj, 'name', false, MAX_NAME_LEN);
  if (nameErr) return nameErr;
  if (obj['name'] !== undefined && (obj['name'] as string).trim().length === 0) {
    return '"name" must not be blank';
  }

  const modelErr = checkStringField(obj, 'model', false, MAX_MODEL_LEN);
  if (modelErr) return modelErr;
  if (obj['model'] !== undefined && (obj['model'] as string).trim().length === 0) {
    return '"model" must not be blank';
  }

  const systemErr = checkStringField(obj, 'system', false, MAX_SYSTEM_LEN);
  if (systemErr) return systemErr;

  const toolsErr = checkArrayField(obj, 'tools', MAX_TOOLS_COUNT);
  if (toolsErr) return toolsErr;

  const skillsErr = checkArrayField(obj, 'skills', MAX_SKILLS_COUNT);
  if (skillsErr) return skillsErr;

  const mcpErr = checkArrayField(obj, 'mcp_servers', MAX_MCP_COUNT);
  if (mcpErr) return mcpErr;

  return null;
}
