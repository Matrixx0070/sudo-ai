/**
 * @file setup/components/SetupSelect.tsx
 * @description Reusable arrow-select list for Wave2 Ink TUI wizard (setup* component, no Wave3/chat overlap).
 * Matches chat patterns (SlashMenu style: selected bold amber, ←, useInput in parent).
 * No new deps.
 */

import React from 'react';
import { Box, Text } from 'ink';

export interface SetupSelectItem {
  value: string;
  label: string;
  desc?: string;
}

export interface SetupSelectProps {
  items: SetupSelectItem[];
  selectedIndex: number;
  title?: string;
}

export const SetupSelect: React.FC<SetupSelectProps> = ({ items, selectedIndex, title }) => {
  const cols = process.stdout.columns ?? 120;
  const width = Math.min(cols - 4, 78);
  const safeIndex = ((selectedIndex % items.length) + items.length) % items.length;

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
      {title && <Text dimColor bold>{title}</Text>}
      {items.map((item, i) => {
        const isSelected = i === safeIndex;
        return (
          <Box key={item.value}>
            <Box width={Math.max(20, item.label.length + 2)}>
              <Text color={isSelected ? '#e8b860' : undefined} bold={isSelected}>
                {item.label}
              </Text>
            </Box>
            {item.desc && <Text dimColor>{item.desc}</Text>}
            {isSelected && <Text dimColor>  ← selected (enter to choose)</Text>}
          </Box>
        );
      })}
    </Box>
  );
};
