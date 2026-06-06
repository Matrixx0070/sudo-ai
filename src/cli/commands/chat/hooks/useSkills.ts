/**
 * @file useSkills.ts — Polls /v1/skills every 30s.
 * Returns skills list + local setActive mutator.
 * On error: { skills: [], active: null }.
 */

import { useState, useEffect } from 'react';

export interface Skill {
  name: string;
  description: string;
  trust_tier?: string;
}

export interface SkillsData {
  skills: Skill[];
  active: Skill | null;
}

export interface SkillsResult extends SkillsData {
  setActive: (s: Skill | null) => void;
}

function parseSkills(data: unknown): Skill[] {
  if (typeof data !== 'object' || data === null) return [];

  // API may return { data: [...] } or { skills: [...] } or an array
  const d = data as Record<string, unknown>;
  const raw = Array.isArray(d['data'])
    ? d['data']
    : Array.isArray(d['skills'])
      ? d['skills']
      : Array.isArray(data) ? data : [];

  return (raw as unknown[])
    .filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null)
    .map(s => ({
      name: String(s['name'] ?? ''),
      description: String(s['description'] ?? ''),
      trust_tier: s['trust_tier'] ? String(s['trust_tier']) : undefined,
    }))
    .filter(s => s.name.length > 0);
}

export function useSkills(baseUrl: string): SkillsResult {
  const [skills, setSkillsList] = useState<Skill[]>([]);
  const [active, setActive] = useState<Skill | null>(null);

  useEffect(() => {
    const key = process.env['GATEWAY_TOKEN'] ?? '';
    const url = `${baseUrl}/v1/skills`;

    const fetchSkills = (): void => {
      fetch(url, {
        headers: { Authorization: `Bearer ${key}` },
      })
        .then(res => {
          if (!res.ok) return;
          return res.json();
        })
        .then((data: unknown) => {
          if (data == null) return;
          setSkillsList(parseSkills(data));
        })
        .catch(() => {
          setSkillsList([]);
        });
    };

    fetchSkills();
    const id = setInterval(fetchSkills, 30_000);
    return () => { clearInterval(id); };
  }, [baseUrl]);

  return { skills, active, setActive };
}
