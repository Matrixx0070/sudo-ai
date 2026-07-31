/**
 * @file resource-sampler.ts
 * @description Per-run resource metering (ADR-0007 Phase 2). While the eval
 * child runs, samples the child's whole process TREE from /proc every
 * intervalMs: summed RSS (VmRSS from /proc/<pid>/status) and cumulative CPU
 * (utime+stime from /proc/<pid>/stat). Each sample is journalled as a
 * `resource.sample` event; stop() returns run totals for scores.efficiency.
 *
 * Docker containers spawned by the sandbox backend are anonymous — the docker
 * backend runs `docker run --rm` with no `--name` (see docker-backend.ts
 * buildDockerArgs) — so there is no stable container name to feed
 * `docker stats`. We therefore sample only the process tree, which includes
 * the `docker` CLI client but not container-internal processes; the container
 * side stays bounded by its own --memory/--pids-limit cgroup caps.
 *
 * Sampling is telemetry: every read failure (racing PID exit, non-Linux /proc)
 * is swallowed and never fails the run.
 */

import { readFileSync, readdirSync } from 'node:fs';
import type { RunJournal } from './run-journal.js';

/** Linux USER_HZ — /proc stat cpu times are in ticks of 1/100 s on every
 * supported kernel (sysconf(_SC_CLK_TCK); Node exposes no direct API). */
const CLK_TCK = 100;

export interface ResourceTotals {
  peakRssMb: number;
  cpuSecs: number;
  samples: number;
}

export interface ResourceSamplerHandle {
  stop(): ResourceTotals;
}

/** All live PIDs whose ancestry chain reaches rootPid (rootPid included). */
export function listProcessTree(rootPid: number): number[] {
  const children = new Map<number, number[]>();
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return [rootPid];
  }
  for (const entry of entries) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const ppid = readPpid(pid);
    if (ppid === undefined) continue;
    const list = children.get(ppid);
    if (list) list.push(pid);
    else children.set(ppid, [pid]);
  }
  const tree: number[] = [];
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    tree.push(pid);
    for (const child of children.get(pid) ?? []) queue.push(child);
  }
  return tree;
}

/** Fields after the comm's closing ')' — comm itself may contain spaces/parens. */
function statFields(pid: number): string[] | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
    const close = stat.lastIndexOf(')');
    if (close < 0) return undefined;
    return stat.slice(close + 2).split(' ');
  } catch {
    return undefined;
  }
}

function readPpid(pid: number): number | undefined {
  const fields = statFields(pid);
  const ppid = Number(fields?.[1]);
  return Number.isInteger(ppid) ? ppid : undefined;
}

/** Cumulative utime+stime in clock ticks. */
function readCpuTicks(pid: number): number | undefined {
  const fields = statFields(pid);
  if (!fields) return undefined;
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return undefined;
  return utime + stime;
}

function readRssKb(pid: number): number {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf-8');
    const m = /^VmRSS:\s+(\d+)\s+kB/m.exec(status);
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

export function startResourceSampler(opts: {
  pid: number;
  journal?: RunJournal;
  intervalMs?: number;
}): ResourceSamplerHandle {
  let peakRssKb = 0;
  let samples = 0;
  // CPU time is cumulative per PID; keep the max seen per PID so short-lived
  // descendants still contribute their last observed total after they exit.
  const cpuTicksByPid = new Map<number, number>();

  const cpuSecs = (): number => {
    let ticks = 0;
    for (const t of cpuTicksByPid.values()) ticks += t;
    return Math.round((ticks / CLK_TCK) * 100) / 100;
  };

  const sample = (): void => {
    try {
      let rssKb = 0;
      const pids = listProcessTree(opts.pid);
      for (const pid of pids) {
        rssKb += readRssKb(pid);
        const ticks = readCpuTicks(pid);
        if (ticks !== undefined) {
          cpuTicksByPid.set(pid, Math.max(cpuTicksByPid.get(pid) ?? 0, ticks));
        }
      }
      if (rssKb > peakRssKb) peakRssKb = rssKb;
      samples += 1;
      opts.journal?.append({
        type: 'resource.sample',
        pids: pids.length,
        rssMb: Math.round((rssKb / 1024) * 10) / 10,
        cpuSecs: cpuSecs(),
      });
    } catch {
      /* telemetry only */
    }
  };

  const timer = setInterval(sample, opts.intervalMs ?? 2000);
  timer.unref();
  sample();

  return {
    stop(): ResourceTotals {
      clearInterval(timer);
      sample();
      return {
        peakRssMb: Math.round((peakRssKb / 1024) * 10) / 10,
        cpuSecs: cpuSecs(),
        samples,
      };
    },
  };
}
