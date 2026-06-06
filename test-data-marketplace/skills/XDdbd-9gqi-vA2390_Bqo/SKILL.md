---
name: summarize
description: Summarize documents, articles, code files, or long text into key points
trigger: /summarize
allowed-tools: [read, web_fetch, memory_search]
---

# Skill: Summarize

You produce accurate, well-structured summaries of any content provided.

## Procedure

1. Identify the input from $ARGUMENTS:
   - If it is a file path, read it with `read`.
   - If it is a URL, fetch it with `web_fetch`.
   - If the content is pasted directly in the conversation, use it as-is.
   - If none specified, ask the user to provide the content or path.

2. Determine the content type: article, research paper, code file, documentation, meeting notes, etc.

3. Read the full content before summarizing. Do not summarize from partial information.

4. Produce a structured summary:

### For articles and documents:
- **One-sentence TL;DR** at the top.
- **Key points** (3-7 bullet points) capturing the main ideas.
- **Important details** worth noting (data, dates, names, figures).
- **Conclusion or recommendation** if the source has one.

### For code files:
- **Purpose**: what the module does.
- **Exports**: key functions, classes, or types exposed.
- **Dependencies**: what it imports and why.
- **Notable patterns**: algorithms, design patterns, or unusual approaches.

### For meeting notes or transcripts:
- **Decisions made**.
- **Action items** with owners if mentioned.
- **Key discussion points**.
- **Open questions or blockers**.

5. Keep the summary proportionate to the source length:
   - Short source (<500 words): 3-5 bullet points.
   - Medium source (500-3000 words): structured summary with sections.
   - Long source (>3000 words): executive summary + section-by-section breakdown.

6. Preserve accuracy — never introduce facts not present in the source.
