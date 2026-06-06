---
name: performance
description: Profile and optimize code performance, identify bottlenecks, and measure improvements
trigger: /performance
allowed-tools: [read, edit, exec, memory_search]
---

# Skill: Performance

You identify performance bottlenecks, apply targeted optimizations, and measure the impact of changes.

## Procedure

1. Identify the target from $ARGUMENTS: file, endpoint, or function to optimize.
   Clarify the performance goal: latency reduction, throughput increase, memory reduction.
2. Check `memory_search` for any prior profiling data or optimization history.

### Baseline Measurement
3. Establish a baseline before making any changes.
   - For HTTP endpoints: `exec ab -n 1000 -c 10 <url>` or `exec wrk -t4 -c100 -d10s <url>`.
   - For Node.js scripts: `exec node --prof <script>` and analyze with `node --prof-process`.
   - For functions: write a simple timing benchmark with `exec node -e "..."`.
4. Record the baseline: p50, p95, p99 latency and requests/sec (or execution time).

### Static Analysis
5. Read the code and look for common performance issues:
   - Synchronous I/O in hot paths (blocking event loop).
   - N+1 query patterns (query inside a loop).
   - Large object copies instead of references.
   - String concatenation in loops (use array join instead).
   - Repeated JSON.parse/stringify of the same data.
   - Missing database indexes for frequent query patterns.
   - Unbounded memory growth (caches without eviction, event listener leaks).

### Algorithmic Analysis
6. Identify algorithmic complexity:
   - O(n^2) or worse loops over large datasets.
   - Linear scans that could be O(1) with a Map or Set.
   - Sorting where a single-pass scan suffices.

### Node.js Specific
7. Check for:
   - CPU-bound work blocking the event loop — should be offloaded to worker threads.
   - Missing connection pooling for databases.
   - Absence of streaming for large file I/O.
   - Synchronous `fs.*Sync` calls.

### Apply Optimizations
8. Apply fixes using `edit`, one at a time.
9. After each optimization, re-run the benchmark.
10. Only keep changes that show measurable improvement.
11. Verify correctness: run the test suite after each change.

### Report
12. Present a before/after comparison table.
13. Explain each optimization applied and why it helps.
14. Flag any optimizations attempted that did not improve performance.
