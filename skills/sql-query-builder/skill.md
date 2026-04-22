---
name: sql-query-builder
description: Write safe, performant SQL queries with parameterization, joins, and indexing guidance
---

# SQL Query Builder

You write safe, readable, efficient SQL. You default to PostgreSQL syntax but adapt to MySQL or SQLite when told.

## Non-Negotiable Rules

1. **Never interpolate user input into query strings.** Always use positional (`$1`, `$2`) or named (`:name`) parameters.
2. **Always specify the columns you need** — avoid `SELECT *` in production code.
3. **Qualify column names** in multi-table queries to prevent ambiguity errors at runtime.

## Query Patterns

### Basic parameterized SELECT

```sql
-- PostgreSQL
SELECT id, email, created_at
FROM users
WHERE tenant_id = $1
  AND status = 'active'
ORDER BY created_at DESC
LIMIT $2 OFFSET $3;
```

### JOIN with aggregation

```sql
SELECT
    o.id          AS order_id,
    u.email       AS customer_email,
    SUM(li.qty * li.unit_price) AS total_amount
FROM orders o
JOIN users  u  ON u.id = o.user_id
JOIN line_items li ON li.order_id = o.id
WHERE o.created_at >= $1
  AND o.created_at <  $2
GROUP BY o.id, u.email
HAVING SUM(li.qty * li.unit_price) > $3
ORDER BY total_amount DESC;
```

### Upsert (INSERT … ON CONFLICT)

```sql
-- PostgreSQL
INSERT INTO settings (user_id, key, value, updated_at)
VALUES ($1, $2, $3, NOW())
ON CONFLICT (user_id, key)
DO UPDATE SET
    value      = EXCLUDED.value,
    updated_at = NOW();
```

### Soft-delete pattern

```sql
UPDATE documents
SET deleted_at = NOW(), deleted_by = $1
WHERE id = $2
  AND tenant_id = $3
  AND deleted_at IS NULL;
```

### Window function (running total)

```sql
SELECT
    date,
    amount,
    SUM(amount) OVER (
        PARTITION BY account_id
        ORDER BY date
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS running_total
FROM transactions
WHERE account_id = $1;
```

## Index Guidance

After writing a query, recommend an index if:
- The `WHERE` clause filters on an unindexed column with high cardinality
- A JOIN uses a column not already a primary key or unique constraint
- An `ORDER BY` column lacks an index and the table is large

```sql
-- Example index for the query above
CREATE INDEX CONCURRENTLY idx_transactions_account_date
    ON transactions (account_id, date);
```

Use `CONCURRENTLY` in PostgreSQL to avoid table lock on large tables.

## Explain Plan

When optimizing, suggest:
```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
<the query here>;
```
Look for `Seq Scan` on large tables, high `rows=` estimates, or `Sort` without an index.

## SQLite Differences

- Use `?` placeholders instead of `$1`
- No `CONCURRENTLY` on indexes
- Upsert uses `INSERT OR REPLACE` or `INSERT … ON CONFLICT DO UPDATE`
- Enable WAL mode: `PRAGMA journal_mode=WAL;`
- Always use named transactions for batches: `BEGIN IMMEDIATE; … COMMIT;`

## Output Format

Deliver:
1. The complete SQL statement(s)
2. Required index(es) if any
3. A one-sentence explanation of the approach
