/**
 * ToolRouter — the dedicated `github` category must surface github.* tools for
 * PR/merge/github prompts, and must NOT flood unrelated prompts with them.
 */
import { describe, it, expect } from 'vitest';
import { ToolRouter } from '../../src/core/agent/tool-router.js';

function fakeRegistry(tools: Array<{ name: string; category: string }>) {
  const schemas = tools.map((t) => ({ type: 'function' as const, function: { name: t.name, description: t.name, parameters: {} } }));
  return {
    getSchemaForLLM: () => schemas,
    listEnabled: () => tools.map((t) => ({ name: t.name, description: t.name, category: t.category, parameters: {} })),
  };
}

const TOOLS = [
  // BASE_TOOLS (must exist so they are added)
  { name: 'meta.self-modify', category: 'meta' },
  { name: 'system.exec', category: 'system' },
  { name: 'browser.search', category: 'browser' },
  { name: 'meta.health-check', category: 'meta' },
  { name: 'coder.read-file', category: 'coder' },
  { name: 'coder.smart-edit', category: 'coder' },
  { name: 'meta.service-control', category: 'meta' },
  { name: 'meta.task-manager', category: 'meta' },
  { name: 'coder.multi-read', category: 'coder' },
  { name: 'meta.self-update', category: 'meta' },
  // github category
  { name: 'github.commit', category: 'github' },
  { name: 'github.open_pr', category: 'github' },
  { name: 'github.merge_pr', category: 'github' },
  { name: 'github.pr_diff', category: 'github' },
  // document category (PDF generation/parsing)
  { name: 'document.markdown-to-pdf', category: 'document' },
  { name: 'document.pdf-from-html', category: 'document' },
  // unrelated
  { name: 'content.write-article', category: 'content' },
];

describe('ToolRouter — github category routing', () => {
  const router = new ToolRouter(fakeRegistry(TOOLS) as never);
  const names = (msg: string): string[] => router.route(msg).map((s) => s.function.name);

  it('surfaces github tools for a PR/merge prompt', () => {
    const n = names('merge pull request #5 on github');
    expect(n).toContain('github.merge_pr');
    expect(n).toContain('github.open_pr');
  });

  it('does NOT surface github tools for an unrelated prompt', () => {
    const n = names('write an article about cats');
    expect(n).not.toContain('github.merge_pr');
    expect(n).not.toContain('github.open_pr');
  });
});

describe('ToolRouter — document category routing', () => {
  const router = new ToolRouter(fakeRegistry(TOOLS) as never);
  const names = (msg: string): string[] => router.route(msg).map((s) => s.function.name);

  it('surfaces document tools for a "make a PDF" prompt', () => {
    const n = names('generate a PDF report titled Cat Facts');
    expect(n).toContain('document.markdown-to-pdf');
  });

  it('does NOT surface document tools for an unrelated prompt', () => {
    const n = names('what time is it in Tokyo');
    expect(n).not.toContain('document.markdown-to-pdf');
  });
});
