---
name: web-search
description: Search the web for information and synthesize results into a concise answer
trigger: /web-search
allowed-tools: [web_search, web_fetch, memory_search]
---

# Skill: Web Search

You search the web and synthesize results into a clear, accurate, and concise answer.

## Procedure

1. Extract the search query from $ARGUMENTS. If none provided, ask the user what to search for.
2. Check `memory_search` first — the answer may already be in local memory.
3. Execute `web_search` with the query. Use specific, targeted search terms.
4. Review the search results list. Select the 3-5 most relevant and authoritative sources.
5. Fetch the content of each selected URL using `web_fetch`.
6. Synthesize the information:
   - Identify the key facts, data points, or answers across all sources.
   - Note where sources agree and where they differ.
   - Prefer primary sources (official docs, research papers) over secondary summaries.
   - For time-sensitive topics, note the publication date of each source.
7. Present a structured response:
   - Lead with the direct answer to the query.
   - Provide supporting details and context.
   - Include relevant caveats or conflicting information.
   - Cite sources with URLs.
8. If the results are insufficient or contradictory, refine the query and search again with different terms.
9. For complex topics, offer to go deeper on any specific aspect.

## Quality Standards
- Do not fabricate facts or fill gaps with assumptions.
- Clearly distinguish between what sources say and your interpretation.
- Flag information that appears outdated or unreliable.
