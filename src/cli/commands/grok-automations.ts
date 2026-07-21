/**
 * @file grok-automations.ts
 * @description `sudo-ai grok automations` — list grok-side automations and
 * scheduled tasks, FREE on the $30 subscription seat (cookie lane,
 * statsig-free). `--catalog` shows connector triggers, `--tools` the connector
 * tool catalog, `--tasks` scheduled tasks + quotas. `--create` / `--delete`
 * are EXPLICIT owner actions on persistent grok-side agents.
 *
 * SAFETY: automations are persistent grok-side scheduled agents. A created
 * automation goes LIVE immediately (the server ignores disabled-at-create,
 * probed live 2026-07-21); create here is ONE-TIME only, never recurring.
 *
 * NOTE: registered into the `grok` command group via one
 * registerGrokAutomations() call in src/cli/index.ts. No provider URL literal
 * lives here (choke-point guard).
 */
import type { Command } from 'commander';

export interface GrokAutomationsCliOptions {
  catalog?: boolean;
  tools?: boolean;
  tasks?: boolean;
  create?: boolean;
  name?: string;
  prompt?: string;
  at?: string;
  time?: string;
  tz?: string;
  delete?: string;
}

/** Run `sudo-ai grok automations`. Returns a process exit code. */
export async function runGrokAutomations(opts: GrokAutomationsCliOptions): Promise<number> {
  const modes = [opts.catalog, opts.tools, opts.tasks, opts.create, opts.delete !== undefined]
    .filter(Boolean);
  if (modes.length > 1) {
    console.error('Use only one of --catalog, --tools, --tasks, --create, --delete.');
    return 2;
  }
  const auto = await import('../../llm/grok-automations.js');
  try {
    if (opts.catalog === true) {
      const groups = await auto.getGrokAutomationCatalog();
      for (const g of groups) {
        const triggers = (g.triggers ?? [])
          .map((t) => `${t.triggerType ?? '?'} (${t.displayName ?? ''})`)
          .join(', ');
        console.log(`${g.displayName ?? g.provider}: ${triggers || '(no triggers)'}`);
      }
      if (groups.length === 0) console.log('(no trigger providers available)');
      return 0;
    }
    if (opts.tools === true) {
      const tools = await auto.getGrokTaskTools();
      for (const t of tools) {
        console.log(`${t.id ?? '?'} — ${t.label ?? ''} [connectors: ${(t.connectorIds ?? []).join(',') || 'none'}]`);
      }
      if (tools.length === 0) console.log('(no connector tools available)');
      return 0;
    }
    if (opts.tasks === true) {
      const { tasks, usage } = await auto.listGrokTasks();
      console.log(`Tasks: ${tasks.length}`);
      console.log(JSON.stringify(tasks, null, 2));
      console.log(
        `Usage: frequent ${usage.frequentUsage}/${usage.frequentLimit}, occasional ${usage.occasionalUsage}/${usage.occasionalLimit}`,
      );
      return 0;
    }
    if (opts.create === true) {
      if (!opts.name || !opts.prompt || !opts.at) {
        console.error('--create requires --name <name> --prompt <text> --at <YYYY-MM-DD> (optional --time HH:MM, --tz <zone>).');
        return 2;
      }
      console.error(
        'NOTICE: this creates a PERSISTENT grok-side automation that goes LIVE immediately ' +
          '(grok will execute the prompt at the scheduled time). One-time schedule only.',
      );
      const a = await auto.createGrokAutomation({
        name: opts.name,
        prompt: opts.prompt,
        dayOfYear: opts.at,
        ...(opts.time !== undefined ? { timeOfDay: opts.time } : {}),
        ...(opts.tz !== undefined ? { timezone: opts.tz } : {}),
      });
      const s = a.schedules?.[0];
      console.log(`Created automation ${a.taskId} — next run ${s?.nextRun ?? 'unknown'} (${s?.timezone ?? ''}).`);
      console.log('Delete it with: grok automations --delete ' + a.taskId);
      return 0;
    }
    if (opts.delete !== undefined) {
      console.error('NOTICE: this deletes a persistent grok-side automation.');
      const r = await auto.deleteGrokAutomation(opts.delete);
      console.log(r.deleted ? 'Automation deleted.' : 'Delete returned deleted:false — verify with a list.');
      return r.deleted ? 0 : 1;
    }
    const list = await auto.listGrokAutomations();
    if (list.length === 0) {
      console.log('(no grok-side automations)');
      return 0;
    }
    for (const a of list) {
      const s = a.schedules?.[0];
      console.log(
        `${a.taskId}  ${a.content?.name ?? '(unnamed)'}  active=${a.isActive === true}  next=${s?.nextRun ?? '-'}`,
      );
    }
    return 0;
  } catch (err) {
    console.error(`grok automations failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/** Register `grok automations` on the grok command group (one call from src/cli/index.ts). */
export function registerGrokAutomations(grokCmd: Command): void {
  grokCmd
    .command('automations')
    .description("List grok-side automations/scheduled tasks, FREE on your subscription (cookie lane). --catalog triggers, --tools connectors, --tasks quotas; --create/--delete manage a PERSISTENT grok-side agent (create = one-time, goes live immediately). Needs SUDO_GROK_WEBSESSION=1")
    .option('--catalog', 'Show the connector trigger catalog (e.g. gmail new_email)')
    .option('--tools', 'Show the connector tool catalog available to automations')
    .option('--tasks', 'Show scheduled tasks + usage quotas')
    .option('--create', 'Create a ONE-TIME automation (needs --name, --prompt, --at; LIVE immediately)')
    .option('--name <name>', 'Automation name (with --create)')
    .option('--prompt <text>', 'What grok should do when it runs (with --create)')
    .option('--at <date>', 'Run date YYYY-MM-DD, max 1 year out (with --create)')
    .option('--time <hhmm>', 'Run time HH:MM, default 09:00 (with --create)')
    .option('--tz <zone>', 'IANA timezone, default UTC (with --create)')
    .option('--delete <taskId>', 'Delete a grok-side automation by id')
    .action(async (opts: GrokAutomationsCliOptions) => process.exit(await runGrokAutomations(opts)));
}
