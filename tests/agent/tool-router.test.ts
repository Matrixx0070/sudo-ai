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

describe('ToolRouter — skill category routing', () => {
  // Regression: category:'skill' tools (skill.apply/rollback/...) had no entry in
  // CATEGORY_MAP, so they never grouped into a routed category and were reachable
  // only via tool.search — the agent kept failing to find skill.apply when asked
  // to author a skill.
  const SKILL_TOOLS = [
    ...TOOLS,
    // Full 7-tool skill category — the write path (apply/rollback) must always
    // surface even though it is registered alongside 5 read/compose siblings.
    { name: 'skill.apply', category: 'skill' },
    { name: 'skill.rollback', category: 'skill' },
    { name: 'skill.refine', category: 'skill' },
    { name: 'skill.compose', category: 'skill' },
    { name: 'skill.explain', category: 'skill' },
    { name: 'skill.federate', category: 'skill' },
    { name: 'skill.usage-stats', category: 'skill' },
  ];
  const router = new ToolRouter(fakeRegistry(SKILL_TOOLS) as never);
  const names = (msg: string): string[] => router.route(msg).map((s) => s.function.name);

  it('surfaces skill.apply for an "author a skill" prompt', () => {
    const n = names('author a new skill that greets the operator warmly');
    expect(n).toContain('skill.apply');
  });

  it('surfaces skill.rollback for a "roll back a skill" prompt', () => {
    expect(names('roll back the greeting skill to the previous version')).toContain('skill.rollback');
  });

  it('surfaces BOTH write-path tools (apply+rollback) despite 5 sibling skill tools', () => {
    // Regression: maxFromCategory=5 dropped apply/rollback for the full 7-tool
    // category. The write path must always travel on a skill turn.
    const n = names('roll back the greeting-flair skill using skill.rollback');
    expect(n).toContain('skill.rollback');
    expect(n).toContain('skill.apply');
  });

  it('does NOT surface skill tools for an unrelated prompt', () => {
    const n = names('what time is it in Tokyo');
    expect(n).not.toContain('skill.apply');
    expect(n).not.toContain('skill.rollback');
  });
});

describe('ToolRouter — superpowers category routing', () => {
  // Regression: category:'superpowers' tools (the 12 registered super.* tools)
  // had no entry in CATEGORY_MAP, so they never grouped into a routed category
  // and were reachable only via tool.search — same invisibility bug that hid
  // the skill toolset.
  const SUPER_TOOLS = [
    ...TOOLS,
    { name: 'super.build-api', category: 'superpowers' },
    { name: 'super.deploy', category: 'superpowers' },
    { name: 'super.generate-pdf', category: 'superpowers' },
    { name: 'super.translate', category: 'superpowers' },
    { name: 'super.archive', category: 'superpowers' },
    { name: 'super.auto-fix', category: 'superpowers' },
    { name: 'super.analyze-data', category: 'superpowers' },
    { name: 'super.ffmpeg', category: 'superpowers' },
    { name: 'super.edit-image', category: 'superpowers' },
    { name: 'super.profile', category: 'superpowers' },
    { name: 'super.security-scan', category: 'superpowers' },
    { name: 'super.build-scraper', category: 'superpowers' },
  ];
  const router = new ToolRouter(fakeRegistry(SUPER_TOOLS) as never);
  const names = (msg: string): string[] => router.route(msg).map((s) => s.function.name);

  it('surfaces super.translate for a translation prompt', () => {
    expect(names('translate this text to spanish for me')).toContain('super.translate');
  });

  it('surfaces super.archive for an unzip/archive prompt', () => {
    expect(names('unzip the release archive and list what is inside')).toContain('super.archive');
  });

  it('surfaces super.security-scan for a vulnerability-scan prompt', () => {
    expect(names('run a security scan for vulnerabilities in the npm dependencies')).toContain('super.security-scan');
  });

  it('surfaces super.ffmpeg for a video-manipulation prompt', () => {
    expect(names('use ffmpeg to trim the intro off this video')).toContain('super.ffmpeg');
  });

  it('surfaces super.profile for a load-test prompt', () => {
    expect(names('profile the memory usage of this command and benchmark it')).toContain('super.profile');
  });

  it('does NOT surface superpowers tools for an unrelated prompt', () => {
    const n = names('what time is it in Tokyo');
    expect(n).not.toContain('super.translate');
    expect(n).not.toContain('super.archive');
    expect(n).not.toContain('super.security-scan');
  });
});

describe('ToolRouter — multi-word tool surfacing (name-word ranking)', () => {
  // media.code-image is registered LAST of many media tools; with maxFromCategory
  // it only surfaces if name-word overlap ranks it above its siblings for a
  // "code image"/"code screenshot" prompt (the hyphenated action never matches a
  // spaced phrase). Earlier siblings whose action segment also won't match.
  const MEDIA_TOOLS = [
    ...TOOLS,
    { name: 'media.image-generate', category: 'media' },
    { name: 'media.image-edit-advanced', category: 'media' },
    { name: 'media.thumbnail-generate', category: 'media' },
    { name: 'media.video-edit', category: 'media' },
    { name: 'media.video-generate', category: 'media' },
    { name: 'media.qr', category: 'media' },
    { name: 'media.diagram', category: 'media' },
    { name: 'media.code-image', category: 'media' }, // last → must be ranked up to surface
  ];
  const router = new ToolRouter(fakeRegistry(MEDIA_TOOLS) as never);
  const names = (msg: string): string[] => router.route(msg).map((s) => s.function.name);

  it('surfaces media.code-image for "code screenshot" despite being registered last', () => {
    expect(names('make a code screenshot of this python function')).toContain('media.code-image');
  });

  it('surfaces media.code-image for "code image"', () => {
    expect(names('turn this code into a shareable image')).toContain('media.code-image');
  });

  it('does NOT surface media.code-image for an unrelated prompt', () => {
    expect(names('what time is it in Tokyo')).not.toContain('media.code-image');
  });
});

describe('ToolRouter — distinctive-word relevance (description-aware ranking)', () => {
  // Two sibling media tools that both produce an image: the ranker must pick the
  // one the user actually describes, not the one matching the generic word "image".
  function registryWithDesc(tools: Array<{ name: string; category: string; description: string }>) {
    const schemas = tools.map((t) => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: {} } }));
    return {
      getSchemaForLLM: () => schemas,
      listEnabled: () => tools.map((t) => ({ name: t.name, description: t.description, category: t.category, parameters: {} })),
    };
  }
  const MEDIA = [
    ...TOOLS.map((t) => ({ ...t, description: t.name })),
    { name: 'media.image-generate', category: 'media', description: 'Generate an image from a text prompt via DALL-E / Stable Diffusion' },
    { name: 'media.code-image', category: 'media', description: 'Render a source-code snippet as a syntax-highlighted code screenshot PNG' },
    { name: 'media.equation', category: 'media', description: 'Render a mathematical equation or formula written in LaTeX as a PNG — fractions, integrals, Greek math notation' },
    { name: 'media.animation', category: 'media', description: 'Create a looping animated GIF from an ordered sequence of caption frames' },
    { name: 'media.diagram', category: 'media', description: 'Render a tree or hierarchy as a PNG — org charts, mind maps, hierarchies, file trees, from a flat node list' },
    { name: 'media.mermaid', category: 'media', description: 'Render a Mermaid diagram — flowchart, sequence diagram, class diagram, state diagram, entity-relationship ER diagram of a database schema, gantt chart, pie, mindmap, timeline' },
  ];
  const router = new ToolRouter(registryWithDesc(MEDIA) as never);
  const names = (msg: string): string[] => router.route(msg).map((s) => s.function.name);

  // With a small fixture every media tool fits the slots, so what matters is
  // RANK: the described tool must come before its image-making sibling.
  it('ranks media.equation ahead of code-image for an equation request', () => {
    const n = names('render this equation as an image');
    expect(n).toContain('media.equation');
    expect(n.indexOf('media.equation')).toBeLessThan(n.indexOf('media.code-image'));
  });

  it('ranks media.equation ahead of code-image for "image of this math" (via description)', () => {
    const n = names('make an image of this math expression');
    expect(n.indexOf('media.equation')).toBeLessThan(n.indexOf('media.code-image'));
  });

  it('ranks media.code-image ahead of equation for a code screenshot', () => {
    const n = names('make a code screenshot of this function');
    expect(n).toContain('media.code-image');
    expect(n.indexOf('media.code-image')).toBeLessThan(n.indexOf('media.equation'));
  });

  it('ranks media.animation first for an animated-gif request', () => {
    const n = names('make an animated gif counting down');
    expect(n).toContain('media.animation');
    expect(n.indexOf('media.animation')).toBeLessThan(n.indexOf('media.code-image'));
    expect(n.indexOf('media.animation')).toBeLessThan(n.indexOf('media.image-generate'));
  });

  it('ranks media.mermaid first among media tools for mermaid-type diagrams', () => {
    for (const q of [
      'draw a sequence diagram of the login flow',
      'make a gantt chart for the project plan',
      'render an ER diagram of the database schema',
      'draw a state diagram for the order lifecycle',
    ]) {
      const n = names(q);
      expect(n).toContain('media.mermaid');
      const firstMedia = n.findIndex((x) => x.startsWith('media.'));
      expect(n.indexOf('media.mermaid')).toBe(firstMedia); // the top media pick
    }
  });

  it('prefers media.diagram when the user gives a flat node list', () => {
    // both can draw hierarchies; the "flat node list" phrasing is media.diagram's niche
    const n = names('make an org chart from a flat node list of people and managers');
    expect(n).toContain('media.diagram');
    expect(n.indexOf('media.diagram')).toBeLessThan(n.indexOf('media.mermaid'));
  });
});

describe('ToolRouter — comms discovery (send a Telegram message)', () => {
  // Regression: the live agent asked to "Send a Telegram message to chat <id>"
  // got ZERO comms tools (only base tools) and fell back to system.exec+curl,
  // which the sandbox rightly blocks. 'telegram' was not a comms keyword,
  // 'send message' missed the "send a telegram message" shape, and
  // message.send was hidden under category 'meta'.
  const COMMS_TOOLS = [
    ...TOOLS,
    { name: 'message.send', category: 'comms' },
    { name: 'comms.notify', category: 'comms' },
    { name: 'comms.schedule-message', category: 'comms' },
    { name: 'comms.email', category: 'comms' },
  ];
  const router = new ToolRouter(fakeRegistry(COMMS_TOOLS) as never);
  const names = (msg: string): string[] => router.route(msg).map((s) => s.function.name);

  it('surfaces message.send for the live-incident prompt', () => {
    const n = names('Send a Telegram message to chat 8087386717 right now saying: "deploy verified." Then confirm delivery.');
    expect(n).toContain('message.send');
    expect(n).toContain('comms.notify');
  });

  it('surfaces comms tools for other channel-name phrasings', () => {
    for (const q of ['message me on whatsapp when done', 'send my discord a summary', 'notify me on telegram']) {
      expect(names(q)).toContain('comms.notify');
    }
  });

  it('does NOT surface comms tools for an unrelated prompt', () => {
    const n = names('refactor the parser and run the tests');
    expect(n).not.toContain('comms.notify');
    expect(n).not.toContain('message.send');
  });
});
