/** @file SkillPicker.tsx — Skill selection overlay (Ctrl+S). */

import React from 'react';
import { Box, Text } from 'ink';
import type { Skill } from '../hooks/useSkills.js';

export interface SkillPickerProps {
  skills: Skill[];
  activeSkill: Skill | null;
  onSelect: (skill: Skill | null) => void;
  onClose: () => void;
}

export const SkillPicker: React.FC<SkillPickerProps> = ({ skills, activeSkill }) => {
  const cols = process.stdout.columns ?? 120;
  const width = Math.min(cols - 4, 72);

  const entries: Array<{ label: string; skill: Skill | null }> = [
    { label: 'none', skill: null },
    ...skills.map(s => ({ label: s.name, skill: s })),
  ];

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor="#e8b860"
      marginLeft={2}
      marginRight={2}
      marginBottom={1}
      paddingX={2}
      paddingY={1}
      width={width}
    >
      <Text bold>Skill Picker</Text>
      <Text> </Text>
      {entries.map((entry, i) => {
        const isActive = entry.skill === null
          ? activeSkill === null
          : activeSkill?.name === entry.skill.name;
        return (
          <Box key={i}>
            <Box width={28}>
              <Text color={isActive ? '#e8b860' : undefined} bold={isActive}>
                {entry.label}
              </Text>
            </Box>
            {entry.skill && (
              <Text dimColor>{entry.skill.description}</Text>
            )}
            {isActive && <Text dimColor>  ← active</Text>}
          </Box>
        );
      })}
      <Text> </Text>
      <Text dimColor>Ctrl+S or Escape to close</Text>
    </Box>
  );
};
