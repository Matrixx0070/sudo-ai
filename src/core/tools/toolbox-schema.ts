/**
 * Lightweight schema builder for SUDO-AI v4 tools.
 *
 * Provides type-safe constructors for building tool parameter schemas that
 * are compatible with the existing ToolParam format and can be converted to
 * JSON Schema for LLM function definitions.
 */

// ---------------------------------------------------------------------------
// Schema Type Builders
// ---------------------------------------------------------------------------

/** Base options for any schema type */
export interface SchemaOptions {
  description?: string;
  required?: boolean;
  default?: unknown;
}

/** String schema with optional constraints */
export interface TStringSchema extends SchemaOptions {
  kind: 'string';
  enum?: string[];
  minLength?: number;
  maxLength?: number;
  pattern?: string;
}

/** Number schema with optional constraints */
export interface TNumberSchema extends SchemaOptions {
  kind: 'number';
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: boolean;
  exclusiveMaximum?: boolean;
}

/** Boolean schema */
export interface TBooleanSchema extends SchemaOptions {
  kind: 'boolean';
}

/** Array schema with item type */
export interface TArraySchema extends SchemaOptions {
  kind: 'array';
  items: SchemaType;
  minItems?: number;
  maxItems?: number;
}

/** Object schema with properties */
export interface TObjectSchema extends Omit<SchemaOptions, 'required'> {
  kind: 'object';
  properties: Record<string, SchemaType>;
  required?: string[];
  additionalProperties?: boolean;
}

/** Enum schema for string literals */
export interface TEnumSchema extends SchemaOptions {
  kind: 'enum';
  values: string[];
}

/** Union of all schema types */
export type SchemaType =
  | TStringSchema
  | TNumberSchema
  | TBooleanSchema
  | TArraySchema
  | TObjectSchema
  | TEnumSchema;

// ---------------------------------------------------------------------------
// Schema Constructors
// ---------------------------------------------------------------------------

/**
 * Creates a string schema with optional constraints.
 */
export function TString(opts?: SchemaOptions & { minLength?: number; maxLength?: number; pattern?: string }): TStringSchema {
  return {
    kind: 'string',
    description: opts?.description,
    required: opts?.required ?? false,
    default: opts?.default,
    minLength: opts?.minLength,
    maxLength: opts?.maxLength,
    pattern: opts?.pattern,
  };
}

/**
 * Creates a number schema with optional min/max constraints.
 */
export function TNumber(opts?: SchemaOptions & { minimum?: number; maximum?: number }): TNumberSchema {
  return {
    kind: 'number',
    description: opts?.description,
    required: opts?.required ?? false,
    default: opts?.default,
    minimum: opts?.minimum,
    maximum: opts?.maximum,
  };
}

/**
 * Creates a boolean schema.
 */
export function TBoolean(opts?: SchemaOptions): TBooleanSchema {
  return {
    kind: 'boolean',
    description: opts?.description,
    required: opts?.required ?? false,
    default: opts?.default,
  };
}

/**
 * Creates an array schema with item type.
 */
export function TArray(items: SchemaType, opts?: SchemaOptions & { minItems?: number; maxItems?: number }): TArraySchema {
  return {
    kind: 'array',
    description: opts?.description,
    required: opts?.required ?? false,
    default: opts?.default,
    items,
    minItems: opts?.minItems,
    maxItems: opts?.maxItems,
  };
}

/**
 * Creates an object schema with properties.
 * If opts.required is an array, those keys are marked required.
 * If individual property schemas have required: true, they are auto-collected.
 */
export function TObject(
  properties: Record<string, SchemaType>,
  opts?: Omit<SchemaOptions, 'required'> & { required?: string[]; additionalProperties?: boolean }
): TObjectSchema {
  const autoRequired = Object.entries(properties)
    .filter(([, schema]) => schema.required === true)
    .map(([key]) => key);

  const explicitRequired = opts?.required ?? [];
  const combinedRequired = [...new Set([...autoRequired, ...explicitRequired])];

  return {
    kind: 'object',
    description: opts?.description,
    default: opts?.default,
    properties,
    required: combinedRequired.length > 0 ? combinedRequired : undefined,
    additionalProperties: opts?.additionalProperties ?? false,
  };
}

/**
 * Creates an enum schema for string literals.
 */
export function TEnum(values: string[], opts?: SchemaOptions): TEnumSchema {
  return {
    kind: 'enum',
    values,
    description: opts?.description,
    required: opts?.required ?? false,
    default: opts?.default,
  };
}

// ---------------------------------------------------------------------------
// Tool Schema Definition
// ---------------------------------------------------------------------------

/**
 * High-level tool schema definition.
 */
export interface ToolSchemaDefinition {
  name: string;
  description: string;
  parameters: Record<string, SchemaType>;
}

/**
 * Creates a tool schema definition.
 */
export function defineToolSchema(
  name: string,
  description: string,
  parameters: Record<string, SchemaType>
): ToolSchemaDefinition {
  return { name, description, parameters };
}

// ---------------------------------------------------------------------------
// Converters
// ---------------------------------------------------------------------------

/**
 * Converts a SchemaType to the existing ToolParam format.
 */
function schemaToParam(schema: SchemaType): import('./types.js').ToolParam {
  const base = {
    description: schema.description ?? '',
    required: schema.kind === 'object' ? (schema as TObjectSchema).required !== undefined : (schema.required ?? false),
    default: schema.default,
  };

  switch (schema.kind) {
    case 'string': {
      const result: import('./types.js').ToolParam = {
        type: 'string',
        description: base.description,
        required: base.required as boolean | undefined,
      };
      if (base.default !== undefined) result.default = base.default;
      if (schema.enum !== undefined) result.enum = schema.enum;
      return result;
    }
    case 'number': {
      const result: import('./types.js').ToolParam = {
        type: 'number',
        description: base.description,
        required: base.required as boolean | undefined,
      };
      if (base.default !== undefined) result.default = base.default;
      return result;
    }
    case 'boolean': {
      const result: import('./types.js').ToolParam = {
        type: 'boolean',
        description: base.description,
        required: base.required as boolean | undefined,
      };
      if (base.default !== undefined) result.default = base.default;
      return result;
    }
    case 'array': {
      const result: import('./types.js').ToolParam = {
        type: 'array',
        description: base.description,
        required: base.required as boolean | undefined,
        items: schemaToParam(schema.items),
      };
      if (base.default !== undefined) result.default = base.default;
      return result;
    }
    case 'object': {
      const objSchema = schema as TObjectSchema;
      const result: import('./types.js').ToolParam = {
        type: 'object',
        description: base.description,
        required: objSchema.required !== undefined,
        properties: Object.entries(objSchema.properties).reduce(
          (acc, [key, value]) => {
            acc[key] = schemaToParam(value);
            return acc;
          },
          {} as Record<string, import('./types.js').ToolParam>
        ),
      };
      if (base.default !== undefined) result.default = base.default;
      return result;
    }
    case 'enum': {
      const result: import('./types.js').ToolParam = {
        type: 'string',
        description: base.description,
        required: base.required as boolean | undefined,
        enum: schema.values,
      };
      if (base.default !== undefined) result.default = base.default;
      return result;
    }
    default:
      const _exhaustive: never = schema;
      throw new Error(`Unknown schema kind: ${(_exhaustive as SchemaType).kind}`);
  }
}

/**
 * Converts a ToolSchemaDefinition to the existing ToolParam format.
 * Returns { parameterName: ToolParam } matching the ToolDefinition.parameters type.
 */
export function schemaToParameterDef(
  toolSchema: ToolSchemaDefinition
): Record<string, import('./types.js').ToolParam> {
  const result: Record<string, import('./types.js').ToolParam> = {};
  for (const [name, schema] of Object.entries(toolSchema.parameters)) {
    result[name] = schemaToParam(schema);
  }
  return result;
}

/**
 * Converts a SchemaType to JSON Schema format.
 */
function schemaToJsonType(schema: SchemaType): Record<string, unknown> {
  const base: Record<string, unknown> = {
    description: schema.description,
  };

  switch (schema.kind) {
    case 'string': {
      const jsonSchema: Record<string, unknown> = {
        type: 'string',
        ...base,
      };
      if (schema.minLength !== undefined) jsonSchema.minLength = schema.minLength;
      if (schema.maxLength !== undefined) jsonSchema.maxLength = schema.maxLength;
      if (schema.pattern !== undefined) jsonSchema.pattern = schema.pattern;
      if (schema.enum !== undefined) jsonSchema.enum = schema.enum;
      return jsonSchema;
    }
    case 'number': {
      const jsonSchema: Record<string, unknown> = {
        type: 'number',
        ...base,
      };
      if (schema.minimum !== undefined) jsonSchema.minimum = schema.minimum;
      if (schema.maximum !== undefined) jsonSchema.maximum = schema.maximum;
      return jsonSchema;
    }
    case 'boolean':
      return {
        type: 'boolean',
        ...base,
      };
    case 'array':
      return {
        type: 'array',
        ...base,
        items: schemaToJsonType(schema.items),
        minItems: schema.minItems,
        maxItems: schema.maxItems,
      };
    case 'object': {
      const properties: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(schema.properties)) {
        properties[key] = schemaToJsonType(value);
      }
      const jsonSchema: Record<string, unknown> = {
        type: 'object',
        ...base,
        properties,
        additionalProperties: schema.additionalProperties ?? false,
      };
      if (schema.required && Array.isArray(schema.required) && schema.required.length > 0) {
        jsonSchema.required = schema.required;
      }
      return jsonSchema;
    }
    case 'enum':
      return {
        type: 'string',
        ...base,
        enum: schema.values,
      };
    default:
      const _exhaustive: never = schema;
      throw new Error(`Unknown schema kind: ${(_exhaustive as SchemaType).kind}`);
  }
}

/**
 * Converts a ToolSchemaDefinition to standard JSON Schema format.
 * Returns a complete JSON Schema object suitable for LLM function definitions.
 */
export function schemaToJsonSchema(toolSchema: ToolSchemaDefinition): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [name, schema] of Object.entries(toolSchema.parameters)) {
    properties[name] = schemaToJsonType(schema);
    if (schema.required === true) {
      required.push(name);
    }
  }

  const result: Record<string, unknown> = {
    type: 'object',
    properties,
  };

  if (required.length > 0) {
    result.required = required;
  }

  return result;
}
