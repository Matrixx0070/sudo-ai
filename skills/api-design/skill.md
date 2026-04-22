---
name: api-design
description: Design REST or RPC API endpoints with auth, versioning, error codes, and OpenAPI examples
---

# API Design

You design clean, consistent, and secure REST APIs. You produce endpoint specs with request/response shapes, status codes, and auth requirements.

## Design Principles

1. **Resource-oriented URLs** — nouns, not verbs. `/v1/invoices` not `/getInvoices`
2. **Plural collection names** — `/users`, `/orders`, `/documents`
3. **Version in the path** — `/v1/...` from day one; never force clients to pin headers
4. **HTTP methods carry semantics** — GET (safe+idempotent), POST (create), PUT (replace), PATCH (partial update), DELETE
5. **Consistent error shape** — every error returns the same structure so clients parse once
6. **No sensitive data in URLs** — tokens, passwords, and PII go in headers or body, never query params

## Standard Error Body

```json
{
  "error": {
    "code": "RESOURCE_NOT_FOUND",
    "message": "Invoice inv_abc123 not found",
    "request_id": "req_xyz789"
  }
}
```

Always include `request_id` for traceability.

## Auth Patterns

- **Bearer token** (JWT or opaque): `Authorization: Bearer <token>` header
- **API key**: `X-API-Key: <key>` header — never in query params (appears in server logs)
- **OAuth 2.0 scopes**: document required scopes per endpoint

## Endpoint Template

```
POST /v1/invoices
Authorization: Bearer <token>
Content-Type: application/json

Request body:
{
  "customer_id": "cus_abc",
  "line_items": [
    { "description": "Consulting", "qty": 10, "unit_price": 150.00 }
  ],
  "due_date": "2026-05-01"
}

Response 201 Created:
{
  "id": "inv_xyz",
  "status": "draft",
  "total_amount": 1500.00,
  "created_at": "2026-04-12T10:00:00Z"
}

Errors:
  400 VALIDATION_ERROR  — missing required field or invalid value
  401 UNAUTHORIZED      — token missing or expired
  403 FORBIDDEN         — token lacks billing:write scope
  422 UNPROCESSABLE     — customer_id does not exist
```

## Pagination

Use cursor-based pagination for large collections:

```
GET /v1/invoices?limit=50&cursor=inv_xyz

Response:
{
  "data": [...],
  "pagination": {
    "next_cursor": "inv_abc",
    "has_more": true
  }
}
```

Avoid offset pagination for large datasets — it's inconsistent when rows are inserted during traversal.

## Idempotency

For POST endpoints that create or charge, support `Idempotency-Key`:

```
POST /v1/charges
Idempotency-Key: client-generated-uuid
```

Store the key + response for 24h. Return the cached response on replay.

## Rate Limiting Headers

Return on every response:
```
X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 843
X-RateLimit-Reset: 1713520800
Retry-After: 30   (only on 429)
```

## OpenAPI Snippet

```yaml
/v1/invoices/{id}:
  get:
    summary: Retrieve an invoice
    security:
      - bearerAuth: []
    parameters:
      - name: id
        in: path
        required: true
        schema:
          type: string
    responses:
      '200':
        description: Invoice object
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/Invoice'
      '404':
        $ref: '#/components/responses/NotFound'
```

## Output Format

For each endpoint deliver:
- Method + path
- Required auth / scopes
- Request body schema (fields, types, required/optional)
- Success response shape + status code
- All possible error codes and their meaning
