/** @file MentionMenu.tsx — @filename autocomplete overlay above Input. */

import React from 'react';
import { Box, Text } from 'ink';

export interface MentionMenuProps {
  filter: string;
  entries: string[];
  selectedIndex: number;
  onSelect: (path: string) => void;
  onClose: () => void;
}

export const MentionMenu: React.FC<MentionMenuProps> = ({ entries, selectedIndex }) => {
  const cols = process.stdout.columns ?? 120;
  const width = Math.min(cols - 4, 80);

  if (entries.length === 0) return null;

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor="#e8b860"
      marginLeft={2}
      marginRight={2}
      paddingX={1}
      width={width}
    >
      <Text dimColor bold>files</Text>
      {entries.map((entry, i) => {
        const isSelected = i === selectedIndex % entries.length;
        return (
          <Box key={entry}>
            <Text color={isSelected ? '#e8b860' : undefined} bold={isSelected}>
              {entry}
            </Text>
            {isSelected && <Text dimColor>  ← selected</Text>}
          </Box>
        );
      })}
    </Box>
  );
};
