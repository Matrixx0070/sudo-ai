/**
 * Tests for runtime skill activation — the matcher the agent loop and
 * skill.trigger-eval both use. Whole-word phrase matching, deterministic
 * selection with caps, injection formatting, kill-switch.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  normalize,
  effectiveTriggers,
  matchTriggers,
  selectSkills,
  formatSkillInjection,
  activateSkillsForMessage,
  isSkillActivationEnabled,
  MAX_INJECTED_BODY_CHARS,
  type ActivatableSkill,
} from '../../src/core/skills/skill-activator.js';

const eli5: ActivatableSkill = {
  name: 'eli5',
  content: '# ELI5\nUse one analogy.',
  triggers: ['eli5', 'explain like i am five', 'explain this simply'],
};
const tldr: ActivatableSkill = {
  name: 'tldr',
  content: '# TLDR\nOne-line takeaway first.',
  triggers: ['tldr', 'tl;dr', 'summarize this'],
};

describe('matchTriggers', () => {
  it('matches whole-word phrases, case/punctuation-insensitive', () => {
    expect(matchTriggers('TLDR this thread please', tldr)?.phrase).toBe('tldr');
    expect(matchTriggers('give me the tl;dr!', tldr)).not.toBeNull();
    expect(matchTriggers('Explain like I am FIVE: what is DNS?', eli5)?.phrase).toBe('explain like i am five');
  });

  it('does not match inside other words', () => {
    expect(matchTriggers('the xtldrx format', tldr)).toBeNull();
    expect(matchTriggers('tldring is not a word', tldr)).toBeNull();
  });

  it('prefers the more specific (longer) phrase', () => {
    const skill: ActivatableSkill = { name: 's', content: '', triggers: ['explain', 'explain this simply'] };
    expect(matchTriggers('please explain this simply', skill)?.phrase).toBe('explain this simply');
  });

  it('merges legacy singular trigger', () => {
    const skill: ActivatableSkill = { name: 's', content: '', trigger: 'old style trigger' };
    expect(effectiveTriggers(skill)).toEqual(['old style trigger']);
    expect(matchTriggers('use the old style trigger here', skill)).not.toBeNull();
  });

  it('returns null with no triggers or no match', () => {
    expect(matchTriggers('anything', { name: 'x', content: '' })).toBeNull();
    expect(matchTriggers('unrelated request', eli5)).toBeNull();
  });
});

describe('selectSkills', () => {
  it('caps selections and orders deterministically by score then name', () => {
    const picked = selectSkills('tldr and eli5 both mentioned', [tldr, eli5], { max: 1 });
    expect(picked).toHaveLength(1);
    // Equal single-word scores: alphabetical tiebreak → eli5.
    expect(picked[0]!.skill.name).toBe('eli5');
  });

  it('selects nothing when nothing matches', () => {
    expect(selectSkills('write me a poem', [tldr, eli5])).toHaveLength(0);
  });
});

describe('formatSkillInjection', () => {
  it('includes header, skill name, matched phrase, and body', () => {
    const out = formatSkillInjection([{ skill: eli5, phrase: 'eli5', score: 104 }]);
    expect(out).toContain('# ACTIVE SKILLS');
    expect(out).toContain('## Skill: eli5 (matched trigger: "eli5")');
    expect(out).toContain('Use one analogy.');
  });

  it('caps oversized bodies', () => {
    const big: ActivatableSkill = { name: 'big', content: 'x'.repeat(MAX_INJECTED_BODY_CHARS + 500), triggers: ['big'] };
    const out = formatSkillInjection([{ skill: big, phrase: 'big', score: 1 }]);
    expect(out).toContain('…(truncated)');
    expect(out.length).toBeLessThan(MAX_INJECTED_BODY_CHARS + 1000);
  });
});

describe('activateSkillsForMessage + kill-switch', () => {
  const saved = process.env['SUDO_SKILL_ACTIVATION'];
  const savedAssist = process.env['SUDO_SKILL_SEMANTIC_ASSIST'];
  beforeEach(() => {
    delete process.env['SUDO_SKILL_ACTIVATION'];
    // These tests must never load the real ONNX embedder; the semantic path
    // has its own suite with an injected fake (semantic-assist.test.ts).
    process.env['SUDO_SKILL_SEMANTIC_ASSIST'] = '0';
  });
  afterEach(() => {
    if (saved === undefined) delete process.env['SUDO_SKILL_ACTIVATION'];
    else process.env['SUDO_SKILL_ACTIVATION'] = saved;
    if (savedAssist === undefined) delete process.env['SUDO_SKILL_SEMANTIC_ASSIST'];
    else process.env['SUDO_SKILL_SEMANTIC_ASSIST'] = savedAssist;
  });

  it('activates and formats on match', async () => {
    const r = await activateSkillsForMessage('tldr this article for me', [tldr, eli5], 's1');
    expect(r).not.toBeNull();
    expect(r!.names).toEqual(['tldr']);
    expect(r!.content).toContain('# ACTIVE SKILLS');
  });

  it('returns null on no match / empty skills / disabled', async () => {
    expect(await activateSkillsForMessage('hello there', [tldr], 's1')).toBeNull();
    expect(await activateSkillsForMessage('tldr this', [], 's1')).toBeNull();
    process.env['SUDO_SKILL_ACTIVATION'] = '0';
    expect(isSkillActivationEnabled()).toBe(false);
    expect(await activateSkillsForMessage('tldr this', [tldr], 's1')).toBeNull();
  });

  it('normalize wraps with spaces for boundary-safe matching', () => {
    expect(normalize('TL;DR!')).toBe(' tl dr ');
  });
});

// ---------------------------------------------------------------------------
// Trigger semantics measured on real traffic (2026-07-10): slash commands are
// anchored dispatch, comma-joined legacy trigger strings are phrase lists.
// ---------------------------------------------------------------------------

describe('slash-command triggers are anchored at message start', () => {
  const summarize: ActivatableSkill = { name: 'summarize', content: '# S', trigger: '/summarize' };

  it('fires on real dispatch', () => {
    expect(matchTriggers('/summarize docs/report.md', summarize)?.phrase).toBe('/summarize');
    expect(matchTriggers('  /summarize the thread', summarize)).not.toBeNull();
    expect(matchTriggers('/SUMMARIZE this', summarize)).not.toBeNull();
    expect(matchTriggers('/summarize', summarize)).not.toBeNull();
  });

  it('does NOT fire on incidental mentions (the 65%-of-cron-traffic defect)', () => {
    expect(matchTriggers('After any remediation, summarize what was changed', summarize)).toBeNull();
    expect(matchTriggers('Summarize what was changed', summarize)).toBeNull(); // bare word, prose not dispatch
    expect(matchTriggers('please run /summarize later', summarize)).toBeNull(); // not at start
    expect(matchTriggers('/summarizer test', summarize)).toBeNull(); // boundary respected
  });
});

describe('comma-joined legacy trigger strings are phrase lists', () => {
  const gmail: ActivatableSkill = {
    name: 'gmail', content: '# G',
    trigger: '/gmail, send email, read email, check inbox',
  };

  it('splits into working phrases (was dead wiring — the whole string never matched)', () => {
    expect(effectiveTriggers(gmail)).toEqual(['/gmail', 'send email', 'read email', 'check inbox']);
    expect(matchTriggers('can you send email to bob about the invoice', gmail)?.phrase).toBe('send email');
    expect(matchTriggers('/gmail unread', gmail)?.phrase).toBe('/gmail');
    expect(matchTriggers('completely unrelated message', gmail)).toBeNull();
  });
});
