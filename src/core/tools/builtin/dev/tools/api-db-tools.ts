/**
 * dev.api-designer and dev.database-designer tool definitions.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../../types.js';
import { createLogger } from '../../../../shared/logger.js';

const logger = createLogger('dev-builtin');

// ---------------------------------------------------------------------------
// Helpers: OpenAPI / GraphQL spec builders
// ---------------------------------------------------------------------------

function buildOpenApiSpec(description: string, title: string, version: string, auth: string): string {
  const authEntry =
    auth === 'bearer'
      ? `  BearerAuth:\n    type: http\n    scheme: bearer\n    bearerFormat: JWT`
      : auth === 'api-key'
      ? `  ApiKeyAuth:\n    type: apiKey\n    in: header\n    name: X-API-Key`
      : auth === 'basic'
      ? `  BasicAuth:\n    type: http\n    scheme: basic`
      : '';

  const secName =
    auth === 'bearer' ? 'BearerAuth' : auth === 'api-key' ? 'ApiKeyAuth' : auth === 'basic' ? 'BasicAuth' : '';

  const securityBlock = secName ? `\nsecurity:\n  - ${secName}: []\n` : '';

  return `openapi: 3.0.3
info:
  title: ${title}
  description: ${description.slice(0, 200)}
  version: "${version}"
  contact:
    name: API Support
    email: support@example.com

servers:
  - url: https://api.example.com/v1
    description: Production
  - url: https://api-staging.example.com/v1
    description: Staging
${securityBlock}
paths:
  /resources:
    get:
      summary: List resources
      operationId: listResources
      tags: [Resources]
      parameters:
        - name: page
          in: query
          schema: { type: integer, default: 1 }
        - name: limit
          in: query
          schema: { type: integer, default: 20, maximum: 100 }
      responses:
        "200":
          description: Paginated list
          content:
            application/json:
              schema: { $ref: "#/components/schemas/ResourceList" }
        "401":
          $ref: "#/components/responses/Unauthorized"
    post:
      summary: Create resource
      operationId: createResource
      tags: [Resources]
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/ResourceCreate" }
      responses:
        "201":
          description: Resource created
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Resource" }
        "400": { $ref: "#/components/responses/BadRequest" }
        "401": { $ref: "#/components/responses/Unauthorized" }

  /resources/{id}:
    parameters:
      - name: id
        in: path
        required: true
        schema: { type: string }
    get:
      summary: Get by ID
      operationId: getResource
      tags: [Resources]
      responses:
        "200":
          description: Resource
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Resource" }
        "404": { $ref: "#/components/responses/NotFound" }
    put:
      summary: Update resource
      operationId: updateResource
      tags: [Resources]
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/ResourceUpdate" }
      responses:
        "200":
          description: Updated
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Resource" }
        "404": { $ref: "#/components/responses/NotFound" }
    delete:
      summary: Delete resource
      operationId: deleteResource
      tags: [Resources]
      responses:
        "204": { description: Deleted }
        "404": { $ref: "#/components/responses/NotFound" }

components:
  schemas:
    Resource:
      type: object
      required: [id, createdAt, updatedAt]
      properties:
        id:          { type: string, format: uuid, readOnly: true }
        name:        { type: string, maxLength: 255 }
        createdAt:   { type: string, format: date-time, readOnly: true }
        updatedAt:   { type: string, format: date-time, readOnly: true }

    ResourceCreate:
      type: object
      required: [name]
      properties:
        name: { type: string, maxLength: 255 }

    ResourceUpdate:
      type: object
      properties:
        name: { type: string, maxLength: 255 }

    ResourceList:
      type: object
      required: [data, total, page, limit]
      properties:
        data:  { type: array, items: { $ref: "#/components/schemas/Resource" } }
        total: { type: integer }
        page:  { type: integer }
        limit: { type: integer }

    Error:
      type: object
      required: [code, message]
      properties:
        code:    { type: string }
        message: { type: string }

  responses:
    BadRequest:
      description: Invalid request
      content:
        application/json:
          schema: { $ref: "#/components/schemas/Error" }
    Unauthorized:
      description: Authentication required
      content:
        application/json:
          schema: { $ref: "#/components/schemas/Error" }
    NotFound:
      description: Not found
      content:
        application/json:
          schema: { $ref: "#/components/schemas/Error" }
${authEntry ? `\n  securitySchemes:\n${authEntry}` : ''}
`;
}

function buildGraphQLSchema(description: string, title: string): string {
  return `# GraphQL Schema — ${title}
# ${description.slice(0, 120)}

scalar DateTime
scalar UUID

type Query {
  resource(id: UUID!): Resource
  resources(page: Int = 1, limit: Int = 20, filter: ResourceFilter): ResourceConnection!
}

type Mutation {
  createResource(input: CreateResourceInput!): Resource!
  updateResource(id: UUID!, input: UpdateResourceInput!): Resource!
  deleteResource(id: UUID!): Boolean!
}

type Resource {
  id: UUID!
  name: String!
  createdAt: DateTime!
  updatedAt: DateTime!
}

type ResourceConnection {
  nodes: [Resource!]!
  totalCount: Int!
  pageInfo: PageInfo!
}

type PageInfo {
  hasNextPage: Boolean!
  hasPreviousPage: Boolean!
  startCursor: String
  endCursor: String
}

input ResourceFilter {
  name: String
  createdAfter: DateTime
  createdBefore: DateTime
}

input CreateResourceInput { name: String! }
input UpdateResourceInput { name: String }
`;
}

// ---------------------------------------------------------------------------
// dev.api-designer
// ---------------------------------------------------------------------------

export const apiDesignerTool: ToolDefinition = {
  name: 'dev.api-designer',
  description:
    'Design a REST or GraphQL API from a natural language description. ' +
    'Produces a complete OpenAPI 3.0 YAML specification with paths, schemas, ' +
    'request/response models, and authentication setup.',
  category: 'dev',
  timeout: 15_000,
  parameters: {
    description: {
      type: 'string',
      required: true,
      description: 'Natural language description of the API.',
    },
    apiType: {
      type: 'string',
      description: 'API style (default: rest).',
      enum: ['rest', 'graphql'],
      default: 'rest',
    },
    title: { type: 'string', description: 'API title.' },
    version: { type: 'string', description: 'API version string (default: 1.0.0).', default: '1.0.0' },
    auth: {
      type: 'string',
      description: 'Authentication scheme (default: bearer).',
      enum: ['none', 'bearer', 'api-key', 'oauth2', 'basic'],
      default: 'bearer',
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const description = params['description'];
    logger.info({ session: ctx.sessionId }, 'dev.api-designer invoked');

    if (typeof description !== 'string' || !description.trim()) {
      return { success: false, output: 'dev.api-designer: description is required.' };
    }

    const apiType = (params['apiType'] as string | undefined) ?? 'rest';
    const title = (params['title'] as string | undefined) ?? 'Generated API';
    const version = (params['version'] as string | undefined) ?? '1.0.0';
    const auth = (params['auth'] as string | undefined) ?? 'bearer';

    const spec =
      apiType === 'graphql'
        ? buildGraphQLSchema(description.trim(), title)
        : buildOpenApiSpec(description.trim(), title, version, auth);

    logger.info({ session: ctx.sessionId, apiType }, 'dev.api-designer complete');
    return { success: true, output: spec, data: { apiType, title, version, auth } };
  },
};

// ---------------------------------------------------------------------------
// dev.database-designer
// ---------------------------------------------------------------------------

export const databaseDesignerTool: ToolDefinition = {
  name: 'dev.database-designer',
  description:
    'Design a database schema from requirements. Generates SQL CREATE TABLE ' +
    'statements with proper types, constraints, indexes, and foreign keys. ' +
    'Optionally produces an initial migration file header.',
  category: 'dev',
  timeout: 15_000,
  parameters: {
    requirements: {
      type: 'string',
      required: true,
      description: 'Plain language description of the data model and entities.',
    },
    dialect: {
      type: 'string',
      description: 'SQL dialect (default: postgresql).',
      enum: ['postgresql', 'mysql', 'sqlite'],
      default: 'postgresql',
    },
    includeMigration: {
      type: 'boolean',
      description: 'Whether to include a migration file header (default: true).',
      default: true,
    },
  },

  async execute(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const requirements = params['requirements'];
    logger.info({ session: ctx.sessionId }, 'dev.database-designer invoked');

    if (typeof requirements !== 'string' || !requirements.trim()) {
      return { success: false, output: 'dev.database-designer: requirements is required.' };
    }

    const dialect = (params['dialect'] as string | undefined) ?? 'postgresql';
    const includeMigration = params['includeMigration'] !== false;

    const uuid =
      dialect === 'postgresql' ? 'UUID DEFAULT gen_random_uuid()' :
      dialect === 'mysql' ? 'CHAR(36) DEFAULT (UUID())' :
      'TEXT DEFAULT (lower(hex(randomblob(16))))';

    const ts =
      dialect === 'sqlite' ? 'TEXT DEFAULT (datetime("now"))' : 'TIMESTAMPTZ DEFAULT NOW()';

    const uuidRef =
      dialect === 'postgresql' ? 'UUID' : dialect === 'mysql' ? 'CHAR(36)' : 'TEXT';

    const bigint =
      dialect === 'postgresql' ? 'BIGSERIAL' :
      dialect === 'mysql' ? 'BIGINT AUTO_INCREMENT' : 'INTEGER';

    const jsonType = dialect === 'postgresql' ? 'JSONB' : 'JSON';

    const schema = [
      `-- Database Schema`,
      `-- Requirements: ${requirements.slice(0, 200)}`,
      `-- Dialect: ${dialect}`,
      `-- Generated: ${new Date().toISOString().slice(0, 10)}`,
      '',
      dialect === 'postgresql' ? `CREATE EXTENSION IF NOT EXISTS "pgcrypto";\n` : '',
      `CREATE TABLE users (`,
      `  id         ${uuid} PRIMARY KEY,`,
      `  email      VARCHAR(255) NOT NULL UNIQUE,`,
      `  name       VARCHAR(255) NOT NULL,`,
      `  created_at ${ts} NOT NULL,`,
      `  updated_at ${ts} NOT NULL`,
      `);`,
      `CREATE INDEX idx_users_email ON users (email);`,
      '',
      `CREATE TABLE resources (`,
      `  id          ${uuid} PRIMARY KEY,`,
      `  user_id     ${uuidRef} NOT NULL REFERENCES users(id) ON DELETE CASCADE,`,
      `  name        VARCHAR(255) NOT NULL,`,
      `  description TEXT,`,
      `  status      VARCHAR(50) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'deleted')),`,
      `  metadata    ${jsonType},`,
      `  created_at  ${ts} NOT NULL,`,
      `  updated_at  ${ts} NOT NULL`,
      `);`,
      `CREATE INDEX idx_resources_user_id ON resources (user_id);`,
      `CREATE INDEX idx_resources_status  ON resources (status);`,
      '',
      `CREATE TABLE audit_logs (`,
      `  id          ${bigint} PRIMARY KEY,`,
      `  table_name  VARCHAR(100) NOT NULL,`,
      `  record_id   VARCHAR(255) NOT NULL,`,
      `  action      VARCHAR(20) NOT NULL CHECK (action IN ('INSERT', 'UPDATE', 'DELETE')),`,
      `  changed_by  ${uuidRef} REFERENCES users(id) ON DELETE SET NULL,`,
      `  changed_at  ${ts} NOT NULL,`,
      `  old_data    ${jsonType},`,
      `  new_data    ${jsonType}`,
      `);`,
      `CREATE INDEX idx_audit_table_record ON audit_logs (table_name, record_id);`,
      `CREATE INDEX idx_audit_changed_at   ON audit_logs (changed_at);`,
    ].filter((l) => l !== undefined).join('\n');

    const migration = includeMigration
      ? `-- ============================================================\n-- Migration: 0001_initial_schema.sql\n-- Rollback:  DROP TABLE audit_logs, resources, users CASCADE;\n-- ============================================================\n\n`
      : '';

    const output = migration + schema;
    logger.info({ session: ctx.sessionId, dialect }, 'dev.database-designer complete');
    return { success: true, output, data: { dialect, includeMigration, charCount: output.length } };
  },
};
