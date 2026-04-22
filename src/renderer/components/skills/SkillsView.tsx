import React, { useEffect, useState } from 'react';
import { useIpcInvoke } from '@renderer/hooks/useIpc';
import { Badge } from '@renderer/components/common/Badge';
import { Spinner } from '@renderer/components/common/Spinner';

interface Skill {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  lastRun: string | null;
  runCount: number;
}

export function SkillsView() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const listSkills = useIpcInvoke<Skill[]>('skills:list');

  useEffect(() => {
    listSkills().then((data) => {
      setSkills(data ?? []);
      setLoading(false);
    });
  }, []);

  return (
    <div className="h-full overflow-y-auto p-5">
      <div className="flex items-center justify-between mb-5">
        <h1 className="text-lg font-semibold text-[var(--text-primary)]">Skills</h1>
        <span className="text-xs text-[var(--text-secondary)]">
          {skills.filter((s) => s.enabled).length} / {skills.length} enabled
        </span>
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <Spinner size="lg" />
        </div>
      ) : skills.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
          <p className="text-sm text-[var(--text-secondary)]">No skills registered yet.</p>
          <p className="text-xs text-[var(--text-secondary)]">
            Skills are autonomous capabilities registered by the backend agent.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {skills.map((skill) => (
            <article
              key={skill.id}
              className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-4 flex flex-col gap-2"
              aria-label={`Skill: ${skill.name}`}
            >
              <div className="flex items-start justify-between gap-2">
                <h2 className="text-sm font-semibold text-[var(--text-primary)]">{skill.name}</h2>
                <Badge
                  status={skill.enabled ? 'online' : 'neutral'}
                  label={skill.enabled ? 'Enabled' : 'Disabled'}
                  dot
                />
              </div>
              <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
                {skill.description}
              </p>
              <div className="flex items-center gap-3 text-[10px] text-[var(--text-secondary)] pt-1">
                <span>Runs: <strong className="text-[var(--text-primary)]">{skill.runCount}</strong></span>
                {skill.lastRun && (
                  <span>
                    Last:{' '}
                    <strong className="text-[var(--text-primary)]">
                      {new Date(skill.lastRun).toLocaleDateString()}
                    </strong>
                  </span>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
