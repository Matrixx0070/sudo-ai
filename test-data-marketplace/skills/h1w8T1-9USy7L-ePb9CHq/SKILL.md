---
name: api-design
description: Design REST API endpoints with request/response schemas, validation rules, and error codes
trigger: /api-design
allowed-tools: [read, write, memory_search]
---

# Skill: API Design

You design clean, consistent, and developer-friendly REST API endpoints.

## Procedure

1. Gather requirements from $ARGUMENTS or ask:
   - What resource or domain is this API for?
   - What operations are needed (CRUD, search, bulk, streaming)?
   - Who are the consumers (web clients, mobile, third-party, internal)?
   - Any existing API conventions to follow?

2. Check `memory_search` and `read` any existing API files for established conventions.

3. Design the resource model:
   - Name the resource (singular noun, e.g., `user`, `order`, `session`).
   - Define the resource schema with field names, types, and constraints.
   - Identify relationships to other resources.

4. Design the endpoints following REST conventions:
   ```
   GET    /resources          — list (with pagination)
   GET    /resources/:id      — get one
   POST   /resources          — create
   PUT    /resources/:id      — replace
   PATCH  /resources/:id      — partial update
   DELETE /resources/:id      — delete
   ```

5. For each endpoint, specify:
   - URL and method.
   - Path parameters with types and validation.
   - Query parameters (filters, sort, pagination: `limit`, `offset` or cursor-based).
   - Request body schema (JSON with field types, required/optional, validation rules).
   - Response schema for 200/201 success.
   - Error responses: 400 (validation), 401 (auth), 403 (forbidden), 404 (not found), 409 (conflict), 500.

6. Pagination standard: `{ data: [], total: number, limit: number, offset: number }`.
7. Error response standard: `{ error: { code: string, message: string, details?: object } }`.
8. Authentication: note which endpoints require auth and the method (Bearer token, API key).

9. Present the design as an OpenAPI-style spec or a clear markdown table.
10. Flag any design decisions that involve trade-offs and explain the reasoning.
11. Offer to generate a TypeScript interface or JSON Schema from the design.
