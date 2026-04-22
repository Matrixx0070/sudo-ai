/** @file SlashMenu.tsx — Filterable slash command overlay above Input. */

import React from 'react';
import { Box, Text } from 'ink';

export const SLASH_COMMANDS = [
  { cmd: '/help',       desc: 'Show help' },
  { cmd: '/clear',      desc: 'Clear conversation history' },
  { cmd: '/model',      desc: 'Switch model' },
  { cmd: '/panel',      desc: 'Toggle info panel' },
  { cmd: '/skills',     desc: 'Open skill picker' },
  { cmd: '/alignment',  desc: 'Open alignment digest' },
  { cmd: '/federation', desc: 'Open federation peers' },
  { cmd: '/exit',       desc: 'Exit chat' },
] as const;

export interface SlashMenuProps {
  filter: string;
  selectedIndex: number;
  onSelect: (cmd: string) => void;
  onClose: () => void;
}

export const SlashMenu: React.FC<SlashMenuProps> = ({ filter, selectedIndex }) => {
  const cols = process.stdout.columns ?? 120;
  const width = Math.min(cols - 4, 80);

  const filtered = SLASH_COMMANDS.filter(c =>
    c.cmd.toLowerCase().includes(filter.toLowerCase())
  );

  if (filtered.length === 0) return null;

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
      <Text dimColor bold>commands</Text>
      {filtered.map((item, i) => {
        const isSelected = i === selectedIndex % filtered.length;
        return (
          <Box key={item.cmd}>
            <Box width={16}>
              <Text color={isSelected ? '#e8b860' : undefined} bold={isSelected}>
                {item.cmd}
              </Text>
            </Box>
            <Text dimColor>{item.desc}</Text>
            {isSelected && <Text dimColor>  ← selected</Text>}
          </Box>
        );
      })}
    </Box>
  );
};
