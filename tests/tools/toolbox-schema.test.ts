/**
 * Tests for the toolbox-schema builder.
 *
 * Validates schema constructors, converters to JSON Schema,
 * and converters to ToolParam format.
 */

import { describe, it, expect } from 'vitest';
import {
  TString,
  TNumber,
  TBoolean,
  TArray,
  TObject,
  TEnum,
  defineToolSchema,
  schemaToJsonSchema,
  schemaToParameterDef,
} from '../../src/core/tools/toolbox-schema.js';

describe('toolbox-schema', () => {
  describe('TString', () => {
    it('creates basic string schema', () => {
      const schema = TString({ description: 'A name' });
      expect(schema.kind).toBe('string');
      expect(schema.description).toBe('A name');
      expect(schema.required).toBe(false);
    });

    it('creates required string schema', () => {
      const schema = TString({ description: 'Required field', required: true });
      expect(schema.required).toBe(true);
    });

    it('creates string with minLength and maxLength', () => {
      const schema = TString({
        description: 'Username',
        minLength: 3,
        maxLength: 20,
      });
      expect(schema.minLength).toBe(3);
      expect(schema.maxLength).toBe(20);
    });

    it('creates string with pattern', () => {
      const schema = TString({
        description: 'Email',
        pattern: '^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$',
      });
      expect(schema.pattern).toBe('^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$');
    });

    it('creates string with default', () => {
      const schema = TString({
        description: 'Greeting',
        default: 'Hello',
      });
      expect(schema.default).toBe('Hello');
    });
  });

  describe('TNumber', () => {
    it('creates basic number schema', () => {
      const schema = TNumber({ description: 'Age' });
      expect(schema.kind).toBe('number');
      expect(schema.description).toBe('Age');
    });

    it('creates number with min and max', () => {
      const schema = TNumber({
        description: 'Percentage',
        minimum: 0,
        maximum: 100,
      });
      expect(schema.minimum).toBe(0);
      expect(schema.maximum).toBe(100);
    });

    it('creates number with default', () => {
      const schema = TNumber({
        description: 'Count',
        default: 10,
      });
      expect(schema.default).toBe(10);
    });
  });

  describe('TBoolean', () => {
    it('creates basic boolean schema', () => {
      const schema = TBoolean({ description: 'Enabled' });
      expect(schema.kind).toBe('boolean');
      expect(schema.description).toBe('Enabled');
    });

    it('creates required boolean', () => {
      const schema = TBoolean({ description: 'Required flag', required: true });
      expect(schema.required).toBe(true);
    });

    it('creates boolean with default', () => {
      const schema = TBoolean({ description: 'Verbose', default: true });
      expect(schema.default).toBe(true);
    });
  });

  describe('TArray', () => {
    it('creates array of strings', () => {
      const schema = TArray(TString({ description: 'Tag' }), {
        description: 'List of tags',
      });
      expect(schema.kind).toBe('array');
      expect(schema.items.kind).toBe('string');
    });

    it('creates array with minItems and maxItems', () => {
      const schema = TArray(TString(), {
        description: 'Tags',
        minItems: 1,
        maxItems: 10,
      });
      expect(schema.minItems).toBe(1);
      expect(schema.maxItems).toBe(10);
    });

    it('creates nested array', () => {
      const schema = TArray(
        TArray(TNumber({ description: 'Coordinate' })),
        { description: 'Matrix' }
      );
      expect(schema.kind).toBe('array');
      expect(schema.items.kind).toBe('array');
      expect((schema.items as any).items.kind).toBe('number');
    });
  });

  describe('TObject', () => {
    it('creates object with properties', () => {
      const schema = TObject({
        name: TString({ description: 'Name', required: true }),
        age: TNumber({ description: 'Age' }),
      });
      expect(schema.kind).toBe('object');
      expect(schema.properties.name).toBeDefined();
      expect(schema.properties.age).toBeDefined();
    });

    it('auto-collects required from property schemas', () => {
      const schema = TObject({
        name: TString({ description: 'Name', required: true }),
        email: TString({ description: 'Email', required: true }),
        age: TNumber({ description: 'Age' }),
      });
      expect(schema.required).toEqual(['name', 'email']);
    });

    it('merges explicit and auto-collected required', () => {
      const schema = TObject(
        {
          name: TString({ description: 'Name', required: true }),
          age: TNumber({ description: 'Age' }),
        },
        { required: ['age'] }
      );
      expect(schema.required).toEqual(['name', 'age']);
    });

    it('creates object with additionalProperties', () => {
      const schema = TObject(
        { name: TString() },
        { additionalProperties: true }
      );
      expect(schema.additionalProperties).toBe(true);
    });
  });

  describe('TEnum', () => {
    it('creates enum schema', () => {
      const schema = TEnum(['red', 'green', 'blue'], {
        description: 'Color choice',
      });
      expect(schema.kind).toBe('enum');
      expect(schema.values).toEqual(['red', 'green', 'blue']);
    });

    it('creates required enum', () => {
      const schema = TEnum(['yes', 'no'], {
        description: 'Choice',
        required: true,
      });
      expect(schema.required).toBe(true);
    });
  });

  describe('defineToolSchema', () => {
    it('creates tool schema definition', () => {
      const toolSchema = defineToolSchema(
        'coder.write-file',
        'Write content to a file',
        {
          path: TString({ description: 'File path', required: true }),
          content: TString({ description: 'File content', required: true }),
          overwrite: TBoolean({ description: 'Overwrite existing', default: false }),
        }
      );
      expect(toolSchema.name).toBe('coder.write-file');
      expect(toolSchema.description).toBe('Write content to a file');
      expect(Object.keys(toolSchema.parameters)).toHaveLength(3);
    });
  });

  describe('schemaToJsonSchema', () => {
    it('converts string parameters to JSON Schema', () => {
      const toolSchema = defineToolSchema('test.tool', 'Test', {
        name: TString({ description: 'Name', required: true, minLength: 1 }),
      });
      const jsonSchema = schemaToJsonSchema(toolSchema);

      expect(jsonSchema.type).toBe('object');
      expect(jsonSchema.properties).toBeDefined();
      expect((jsonSchema.properties as any).name.type).toBe('string');
      expect((jsonSchema.properties as any).name.minLength).toBe(1);
      expect(jsonSchema.required).toEqual(['name']);
    });

    it('converts number with constraints', () => {
      const toolSchema = defineToolSchema('test.tool', 'Test', {
        count: TNumber({ description: 'Count', minimum: 0, maximum: 100 }),
      });
      const jsonSchema = schemaToJsonSchema(toolSchema);

      expect((jsonSchema.properties as any).count.minimum).toBe(0);
      expect((jsonSchema.properties as any).count.maximum).toBe(100);
    });

    it('converts array with items', () => {
      const toolSchema = defineToolSchema('test.tool', 'Test', {
        tags: TArray(TString({ description: 'Tag' }), {
          description: 'Tags',
          minItems: 1,
        }),
      });
      const jsonSchema = schemaToJsonSchema(toolSchema);

      const tagsSchema = (jsonSchema.properties as any).tags;
      expect(tagsSchema.type).toBe('array');
      expect(tagsSchema.items.type).toBe('string');
      expect(tagsSchema.minItems).toBe(1);
    });

    it('converts object with nested properties', () => {
      const toolSchema = defineToolSchema('test.tool', 'Test', {
        config: TObject({
          debug: TBoolean({ description: 'Debug mode' }),
          retries: TNumber({ description: 'Retries', default: 3 }),
        }),
      });
      const jsonSchema = schemaToJsonSchema(toolSchema);

      const configSchema = (jsonSchema.properties as any).config;
      expect(configSchema.type).toBe('object');
      expect(configSchema.properties.debug.type).toBe('boolean');
      expect(configSchema.properties.retries.type).toBe('number');
    });

    it('converts enum to JSON Schema enum', () => {
      const toolSchema = defineToolSchema('test.tool', 'Test', {
        format: TEnum(['json', 'xml', 'yaml'], { description: 'Output format' }),
      });
      const jsonSchema = schemaToJsonSchema(toolSchema);

      expect((jsonSchema.properties as any).format.enum).toEqual(['json', 'xml', 'yaml']);
    });

    it('produces valid JSON Schema structure', () => {
      const toolSchema = defineToolSchema(
        'coder.read-file',
        'Read a file',
        {
          path: TString({ description: 'File path', required: true }),
          encoding: TEnum(['utf-8', 'base64'], { default: 'utf-8' }),
        }
      );
      const jsonSchema = schemaToJsonSchema(toolSchema);

      // Validate structure
      expect(jsonSchema.type).toBe('object');
      expect(jsonSchema.properties).toBeDefined();
      expect(Array.isArray(jsonSchema.required)).toBe(true);
      expect(jsonSchema.required).toContain('path');
    });
  });

  describe('schemaToParameterDef', () => {
    it('converts string to ToolParam format', () => {
      const toolSchema = defineToolSchema('test.tool', 'Test', {
        name: TString({ description: 'Name', required: true }),
      });
      const params = schemaToParameterDef(toolSchema);

      expect(params.name.type).toBe('string');
      expect(params.name.description).toBe('Name');
      expect(params.name.required).toBe(true);
    });

    it('converts number to ToolParam format', () => {
      const toolSchema = defineToolSchema('test.tool', 'Test', {
        count: TNumber({ description: 'Count', default: 10 }),
      });
      const params = schemaToParameterDef(toolSchema);

      expect(params.count.type).toBe('number');
      expect(params.count.default).toBe(10);
    });

    it('converts boolean to ToolParam format', () => {
      const toolSchema = defineToolSchema('test.tool', 'Test', {
        verbose: TBoolean({ description: 'Verbose output' }),
      });
      const params = schemaToParameterDef(toolSchema);

      expect(params.verbose.type).toBe('boolean');
    });

    it('converts array with items to ToolParam format', () => {
      const toolSchema = defineToolSchema('test.tool', 'Test', {
        tags: TArray(TString({ description: 'Tag' })),
      });
      const params = schemaToParameterDef(toolSchema);

      expect(params.tags.type).toBe('array');
      expect(params.tags.items).toBeDefined();
      expect(params.tags.items?.type).toBe('string');
    });

    it('converts object with properties to ToolParam format', () => {
      const toolSchema = defineToolSchema('test.tool', 'Test', {
        config: TObject({
          debug: TBoolean(),
          retries: TNumber(),
        }),
      });
      const params = schemaToParameterDef(toolSchema);

      expect(params.config.type).toBe('object');
      expect(params.config.properties).toBeDefined();
      expect(params.config.properties?.debug.type).toBe('boolean');
      expect(params.config.properties?.retries.type).toBe('number');
    });

    it('converts enum to ToolParam format', () => {
      const toolSchema = defineToolSchema('test.tool', 'Test', {
        format: TEnum(['json', 'xml'], { description: 'Format' }),
      });
      const params = schemaToParameterDef(toolSchema);

      expect(params.format.type).toBe('string');
      expect(params.format.enum).toEqual(['json', 'xml']);
    });

    it('matches existing ToolParam format exactly', () => {
      // This test validates the output matches the ToolParam interface
      const toolSchema = defineToolSchema(
        'coder.write-file',
        'Write content to a file',
        {
          path: TString({ description: 'File path', required: true }),
          content: TString({ description: 'Content', required: true }),
          overwrite: TBoolean({ description: 'Overwrite', default: false }),
        }
      );
      const params = schemaToParameterDef(toolSchema);

      // Validate each param has required ToolParam fields
      for (const [name, param] of Object.entries(params)) {
        expect(param).toHaveProperty('type');
        expect(param).toHaveProperty('description');
        expect(['string', 'number', 'boolean', 'array', 'object']).toContain(param.type);
      }

      // Specific validations
      expect(params.path.type).toBe('string');
      expect(params.path.required).toBe(true);
      expect(params.content.type).toBe('string');
      expect(params.overwrite.type).toBe('boolean');
      expect(params.overwrite.default).toBe(false);
    });
  });

  describe('integration: full tool definition', () => {
    it('builds complete tool schema end-to-end', () => {
      const toolSchema = defineToolSchema(
        'comms.send-email',
        'Send an email message',
        {
          to: TString({ description: 'Recipient email', required: true }),
          subject: TString({ description: 'Email subject', required: true, maxLength: 200 }),
          body: TString({ description: 'Email body', required: true }),
          cc: TArray(TString({ description: 'CC email' }), {
            description: 'CC recipients',
          }),
          priority: TEnum(['low', 'normal', 'high'], {
            description: 'Priority level',
            default: 'normal',
          }),
        }
      );

      const jsonSchema = schemaToJsonSchema(toolSchema);
      const paramDef = schemaToParameterDef(toolSchema);

      // Validate JSON Schema output
      expect(jsonSchema.type).toBe('object');
      expect(jsonSchema.required).toEqual(['to', 'subject', 'body']);
      expect((jsonSchema.properties as any).to.type).toBe('string');
      expect((jsonSchema.properties as any).priority.enum).toEqual(['low', 'normal', 'high']);

      // Validate ToolParam output
      expect(paramDef.to.type).toBe('string');
      expect(paramDef.to.required).toBe(true);
      expect(paramDef.cc.type).toBe('array');
      expect(paramDef.priority.default).toBe('normal');
    });
  });
});
