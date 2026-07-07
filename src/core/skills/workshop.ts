/**
 * @file workshop.ts
 * @description Closed, safe loop for the agent to author and revise its OWN
 * skills: stage a candidate SKILL.md → scan-gate + capability-gate + path-gate
 * (fail-closed) → apply with a versioned prior kept for rollback. This is the
 * SAFE-autonomy path: self-authored skills are pinned to the `workspace` trust
 * tier (never shell.exec / skill.load), every candidate is injection-scanned,
 * and writes are confined to the skills/ tree with protected-path guards.
 */

import path from 'node:path';
import { existsSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { createLogger } from '../shared/logger.js';
import { PROJECT_ROOT, MIND_DB } from '../shared/paths.js';
import { SkillVersioning } from './versioning.js';
import { validateSkillName } from './versioning-io.js';
import { checkCapabilities } from './trust-policy.js';
import { scanMemoryContent } from '../memory/injection-scanner.js';
import { isProtectedPath } from '../self-build/protected-paths.js';
import { blockIfProtected } from '../self-build/path-guard.js';

const log = createLogger('skills:workshop');

/** Trust tier assigned to ALL self-authored skills — deliberately not
 * caller-controllable, so a candidate cannot escalate itself past workspace. */
const WORKSHOP_TIER = 'workspace' as const;

export interface WorkshopProposal {
  skillName: string;
  version: string;
  markdown: string;
  changelog?: string;
}

export interface GateResult {
  ok: boolean;
  reasons: string[];
}

export interface ApplyResult {
  applied: boolean;
  versionId?: number;
  skillPath?: string;
  blockedReasons?: string[];
}

/** Extract declared capability strings from a SKILL.md YAML frontmatter block
 * (inline `caps: [a, b]` or a block list). Defensive: returns [] when absent. */
export function extractDeclaredCaps(markdown: string): string[] {
  const fm = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return [];
  const block = fm[1];
  const inline = block.match(/^caps:\s*\[([^\]]*)\]/m);
  if (inline) {
    return inline[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  }
  const listHeader = block.match(/^caps:\s*$/m);
  if (listHeader) {
    const after = block.slice(block.indexOf(listHeader[0]) + listHeader[0].length);
    const items: string[] = [];
    for (const line of after.split('\n')) {
      const m = line.match(/^\s*-\s*(.+?)\s*$/);
      if (m) items.push(m[1].replace(/^["']|["']$/g, ''));
      else if (line.trim() !== '' && !/^\s/.test(line)) break; // next top-level key
    }
    return items;
  }
  return [];
}

export class SkillWorkshop {
  private readonly mindDbPath: string;
  private readonly skillsRoot: string;
  private readonly stagingDir: string;

  constructor(opts: { mindDbPath?: string; skillsRoot?: string; stagingDir?: string } = {}) {
    this.mindDbPath = opts.mindDbPath ?? MIND_DB;
    this.skillsRoot = opts.skillsRoot ?? path.join(PROJECT_ROOT, 'skills');
    this.stagingDir = opts.stagingDir ?? path.join(PROJECT_ROOT, 'data', 'skills-staging');
  }

  isEnabled(): boolean {
    return process.env['SUDO_SKILL_WORKSHOP'] === '1';
  }

  /** Absolute target path for a skill's SKILL.md, or null if the name is unsafe. */
  private targetPath(skillName: string): string | null {
    try {
      validateSkillName(skillName);
    } catch {
      return null;
    }
    if (skillName.includes('/') || skillName.includes('..') || path.isAbsolute(skillName)) return null;
    const target = path.join(this.skillsRoot, skillName, 'SKILL.md');
    if (!target.startsWith(this.skillsRoot + path.sep)) return null;
    return target;
  }

  /** Write the candidate to a staging file (never the live skills tree). */
  stage(p: WorkshopProposal): string {
    const dir = path.join(this.stagingDir, p.skillName.replace(/[^\w.-]/g, '_'));
    mkdirSync(dir, { recursive: true });
    const staged = path.join(dir, 'SKILL.md');
    writeFileSync(staged, p.markdown, 'utf-8');
    return staged;
  }

  /** Fail-closed gate: injection scan + capability policy + path safety. */
  gate(p: WorkshopProposal): GateResult {
    const reasons: string[] = [];

    // 1. Injection scan — treat authored skill content as untrusted (role undefined).
    const scan = scanMemoryContent(p.markdown, undefined, 'skill-workshop');
    if (!scan.clean) reasons.push(`injection-scan: ${scan.reasons.join(', ')}`);

    // 2. Capability policy — self-authored skills are pinned to the workspace tier;
    // a candidate declaring caps beyond it (e.g. shell.exec) is rejected.
    const declared = extractDeclaredCaps(p.markdown);
    const caps = checkCapabilities(declared, WORKSHOP_TIER);
    if (!caps.granted) reasons.push(`capabilities beyond workspace tier: ${caps.missing.join(', ')}`);

    // 3. Path safety — confined to skills/, name validated, not a protected path.
    const target = this.targetPath(p.skillName);
    if (!target) {
      reasons.push(`unsafe skill name: "${p.skillName}"`);
    } else {
      const rel = path.relative(PROJECT_ROOT, target);
      if (isProtectedPath(rel)) reasons.push(`target is a protected path: ${rel}`);
      const guard = blockIfProtected(target, PROJECT_ROOT);
      if (guard.blocked) reasons.push(guard.error ?? 'blocked by path-guard');
    }

    return { ok: reasons.length === 0, reasons };
  }

  /** stage → gate → version → apply. Fail-closed: no write unless the gate passes. */
  apply(p: WorkshopProposal): ApplyResult {
    this.stage(p);
    const g = this.gate(p);
    if (!g.ok) {
      log.warn({ skill: p.skillName, reasons: g.reasons }, 'Workshop: apply blocked by gate');
      return { applied: false, blockedReasons: g.reasons };
    }
    const target = this.targetPath(p.skillName)!;

    const versioning = new SkillVersioning(this.mindDbPath);
    let versionId: number;
    try {
      // saveVersion retains the prior row as inactive — that IS the rollback record.
      versionId = versioning.saveVersion(p.skillName, p.version, p.markdown, p.changelog ?? 'workshop apply');
    } finally {
      versioning.close();
    }

    mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, p.markdown, 'utf-8');
    renameSync(tmp, target);
    log.info({ skill: p.skillName, version: p.version, versionId, target }, 'Workshop: skill applied');
    return { applied: true, versionId, skillPath: target };
  }

  /** Restore a prior version (explicit id, else the newest inactive one). */
  rollback(skillName: string, versionId?: number): { restored: boolean; version?: string; reason?: string } {
    const target = this.targetPath(skillName);
    if (!target) return { restored: false, reason: `unsafe skill name: "${skillName}"` };

    const versioning = new SkillVersioning(this.mindDbPath);
    try {
      const versions = versioning.getVersions(skillName);
      if (versions.length === 0) return { restored: false, reason: 'no version history' };
      const active = versioning.getActive(skillName);
      const priors = versions.filter((v) => v.id !== active?.id);
      if (versionId === undefined && priors.length === 0) {
        // Only one version — undo it entirely.
        if (existsSync(target)) rmSync(target);
        return { restored: true, version: '(removed — no prior version)' };
      }
      const pick = versionId !== undefined
        ? versions.find((v) => v.id === versionId)
        : priors.sort((a, b) => b.id - a.id)[0];
      if (!pick) return { restored: false, reason: `version ${versionId} not found` };

      versioning.rollback(skillName, pick.id);
      const tmp = `${target}.tmp`;
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(tmp, pick.sourceCode, 'utf-8');
      renameSync(tmp, target);
      log.info({ skill: skillName, versionId: pick.id, version: pick.version }, 'Workshop: skill rolled back');
      return { restored: true, version: pick.version };
    } finally {
      versioning.close();
    }
  }
}
