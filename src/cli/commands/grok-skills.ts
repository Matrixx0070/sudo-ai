/**
 * @file grok-skills.ts
 * @description `sudo-ai grok skills` — list/inspect the seat's installed grok
 * skills (e.g. browser-use) and the published marketplace, FREE on the $30
 * subscription seat (cookie lane, statsig-free). `--enable`/`--disable`
 * toggle an installed skill with read-back verification.
 *
 * NOTE: registered into the `grok` command group via one registerGrokSkills()
 * call in src/cli/index.ts. No provider URL literal lives here (choke-point guard).
 *
 * SIDE-EFFECT: --enable/--disable change what the seat's own grok can do —
 * owner-CLI only, never an agent tool; a notice is printed before the call.
 * Install/uninstall are deliberately NOT wired (no safe round-trip provable;
 * see src/llm/grok-skills.ts header).
 *
 * QUARANTINE: skill text is external model-store data — display only.
 */
import type { Command } from 'commander';

export interface GrokSkillsCliOptions {
  search?: string;
  get?: string;
  verified?: boolean;
  enable?: string;
  disable?: string;
}

/** Run `sudo-ai grok skills`. Returns a process exit code. */
export async function runGrokSkills(opts: GrokSkillsCliOptions): Promise<number> {
  const modes = [opts.search, opts.get, opts.verified === true || undefined, opts.enable, opts.disable]
    .filter((m) => m !== undefined);
  if (modes.length > 1) {
    console.error('Use only one of --search, --get, --verified, --enable, --disable.');
    return 2;
  }
  const lib = await import('../../llm/grok-skills.js');
  try {
    const toggle = opts.enable ?? opts.disable;
    if (toggle !== undefined) {
      const enabled = opts.enable !== undefined;
      console.error(
        `NOTICE: this changes your seat's skills — grok will ${enabled ? 'START' : 'STOP'} using "${toggle}" in your own chats.`,
      );
      const r = await lib.setGrokUserSkillEnabled(toggle, enabled);
      if (!r.persisted) {
        console.error(
          `Toggle ACCEPTED (HTTP 200) but NOT persisted — read-back still shows enabled=${r.enabled}.`,
        );
        return 1;
      }
      console.log(`Skill "${r.name}" is now ${r.enabled ? 'ENABLED' : 'DISABLED'} (read-back verified).`);
      return 0;
    }
    if (opts.get !== undefined) {
      const s = await lib.getGrokUserSkill(opts.get);
      console.log(`${s.name} — ${s.enabled ? 'enabled' : 'disabled'} (${s.fileCount} file(s), ${s.totalBytes} bytes, updated ${s.updatedAt})`);
      console.log(s.description);
      if (s.skillMdContent) console.log(`\n${s.skillMdContent}`);
      return 0;
    }
    if (opts.verified === true) {
      const r = await lib.listGrokVerifiedSkills();
      if (r.skills.length === 0) {
        console.log('(no published verified skills visible to this seat)');
        return 0;
      }
      for (const s of r.skills) console.log(`${s.name} — ${s.description}`);
      return 0;
    }
    const skills = await lib.listGrokUserSkills({ query: opts.search });
    if (skills.length === 0) {
      console.log(opts.search ? '(no skills match)' : '(no skills installed on this seat)');
      return 0;
    }
    for (const s of skills) {
      console.log(`${s.enabled ? '[on] ' : '[off]'} ${s.name} — ${s.description.slice(0, 120)}`);
    }
    return 0;
  } catch (err) {
    console.error(`grok skills failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/** Register `grok skills` on the grok command group (one call from src/cli/index.ts). */
export function registerGrokSkills(grokCmd: Command): void {
  grokCmd
    .command('skills')
    .description("List/inspect your grok seat's installed skills, FREE on your subscription (cookie lane). --enable/--disable toggle a skill (read-back verified; changes your seat's behavior); --verified shows the published marketplace. Needs SUDO_GROK_WEBSESSION=1")
    .option('--search <query>', 'Filter installed skills by search query')
    .option('--get <name>', 'Show one skill in full (metadata + SKILL.md)')
    .option('--verified', 'List published verified skills (marketplace)')
    .option('--enable <name>', "Enable an installed skill (changes your seat's skills)")
    .option('--disable <name>', "Disable an installed skill (changes your seat's skills)")
    .action(async (opts: GrokSkillsCliOptions) => process.exit(await runGrokSkills(opts)));
}
