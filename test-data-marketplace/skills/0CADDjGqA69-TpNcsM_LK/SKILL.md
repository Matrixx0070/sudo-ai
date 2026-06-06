---
name: database
description: Write, optimize, and explain SQL queries for any common relational database
trigger: /database
allowed-tools: [read, exec, memory_search]
---

# Skill: Database

You write correct, efficient SQL queries and optimize existing ones with clear explanations.

## Procedure

1. Identify the task from $ARGUMENTS:
   - Write a new query.
   - Optimize an existing query.
   - Explain a query.
   - Design a schema.
   - Diagnose a slow query.

2. Identify the database engine (PostgreSQL, MySQL, SQLite, MSSQL). Default to PostgreSQL if not specified.
3. Read any relevant schema files or migration files to understand the data model.
4. Check `memory_search` for existing query patterns or schema context.

### Writing Queries
5. For SELECT queries:
   - Select only required columns — never use `SELECT *` in application code.
   - Use explicit JOINs with named conditions.
   - Apply WHERE before GROUP BY and HAVING.
   - Use LIMIT to prevent runaway queries.
   - Add ORDER BY for deterministic pagination.

6. For INSERT/UPDATE/DELETE:
   - Always use parameterized queries — never string-interpolate user input.
   - Include a WHERE clause on UPDATE and DELETE (add a safety check).
   - Use RETURNING (PostgreSQL) or OUTPUT (MSSQL) to return the affected rows.
   - Wrap multi-statement operations in a transaction.

### Optimizing Queries
7. Run EXPLAIN ANALYZE (PostgreSQL) or EXPLAIN (MySQL): `exec psql -c "EXPLAIN ANALYZE <query>"`.
8. Look for:
   - Sequential scans on large tables — suggest an index.
   - Nested loop joins on large datasets — consider hash join hints.
   - Sort operations on large result sets — add an index on the ORDER BY column.
   - Expensive subqueries that could be CTEs or joined tables.

9. Index recommendations:
   - Index columns used in WHERE, JOIN ON, and ORDER BY.
   - Use composite indexes for multi-column filters (order matters: most selective first).
   - Avoid indexing columns with very low cardinality (e.g., boolean fields).
   - Check for unused indexes: they slow down writes without benefiting reads.

### Schema Design
10. Normalize to 3NF unless denormalization is justified by read performance.
11. Use appropriate column types: `BIGINT` for IDs, `TEXT` over `VARCHAR` (PostgreSQL), `TIMESTAMPTZ` for timestamps.
12. Add NOT NULL constraints wherever null semantics are not intentional.
13. Define foreign key constraints with appropriate ON DELETE behavior.

14. Present the query with an explanation of each clause and the reasoning behind design choices.
