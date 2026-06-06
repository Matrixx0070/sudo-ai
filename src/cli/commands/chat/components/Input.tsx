/** @file Input.tsx — Footer input bar with skills bar right side. */

import React from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import type { Skill } from '../hooks/useSkills.js';

export interface InputProps {
  value: string;
  onChange: (val: string) => void;
  onSubmit: (val: string) => void;
  disabled: boolean;
  activeSkill: Skill | null;
  onSlashOpen: () => void;
  onMentionOpen: () => void;
}

export const Input: React.FC<InputProps> = ({
  value,
  onChange,
  onSubmit,
  disabled,
  activeSkill,
  onSlashOpen,
  onMentionOpen,
}) => {
  const HINTS = '\u2303K cmds  \u2303\\ panel  \u2303D exit';

  const handleChange = (val: string): void => {
    if (disabled) return;

    // Detect '/' as first character (was empty before)
    if (val === '/' && value === '') {
      onSlashOpen();
    }

    // Detect a newly typed '@' (count increased), so subsequent mentions reopen the menu
    if (val.split('@').length > value.split('@').length) {
      onMentionOpen();
    }

    onChange(val);
  };

  return (
    <Box justifyContent="space-between">
      <Box paddingLeft={2}>
        <Text dimColor bold>{'\u203a'}{'  '}</Text>
        <TextInput
          value={value}
          onChange={handleChange}
          onSubmit={disabled ? () => undefined : onSubmit}
          placeholder={''}
          focus={!disabled}
        />
      </Box>
      <Box paddingRight={2}>
        <Text dimColor>{HINTS}</Text>
        {activeSkill && (
          <>
            <Text dimColor> · </Text>
            <Text color="#e8b860">{activeSkill.name}</Text>
          </>
        )}
      </Box>
    </Box>
  );
};
