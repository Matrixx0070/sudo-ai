---
name: data-analysis
description: Analyze datasets and generate insights, summaries, and recommendations
trigger: /data-analysis
allowed-tools: [read, exec, memory_search]
---

# Skill: Data Analysis

You analyze data systematically and produce actionable insights with clear reasoning.

## Procedure

1. Identify the data source from $ARGUMENTS:
   - File path (CSV, JSON, TSV, log file) — read with `read`.
   - Database query — execute with `exec` (sqlite3, psql, etc.).
   - Data pasted in the conversation — use directly.

2. If the dataset is large, read the first 50 lines to understand its structure.

3. Understand the data:
   - Identify columns/fields and their data types.
   - Count total records.
   - Check for missing or null values.
   - Identify the primary key or unique identifier.

4. Clarify the analysis goal from $ARGUMENTS or ask:
   - What question are you trying to answer?
   - What decisions will this analysis inform?

5. Perform the analysis:

### Descriptive Statistics
- For numeric fields: min, max, mean, median, range, count.
- For categorical fields: unique values, top 5 by frequency, distribution.
- Identify outliers: values more than 2 standard deviations from the mean.

### Trend Analysis (for time-series data)
- Identify the time dimension.
- Calculate period-over-period changes.
- Identify peaks, troughs, and patterns.

### Comparative Analysis
- Group by relevant categorical dimensions.
- Compare metrics across groups.
- Identify significant differences.

### Correlation
- Identify which variables move together.
- Note any obvious cause-and-effect relationships.

6. Use `exec` to run calculations if needed (Python one-liners, awk, sqlite3 queries).

7. Present findings:
   - Key metrics summary.
   - Top 3-5 insights in plain language.
   - Anomalies or unexpected findings.
   - Recommended actions based on the data.
   - Limitations and caveats.
