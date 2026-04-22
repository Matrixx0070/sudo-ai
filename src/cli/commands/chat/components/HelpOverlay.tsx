/** @file HelpOverlay.tsx — Ctrl+K command palette with new slash commands. */

import React from 'react';
import { Box, Text } from 'ink';

interface Props {
  onClose: () => void;
}

const COMMANDS = [
  { cmd: '/help',          desc: 'Show this help' },
  { cmd: '/clear',         desc: 'Clear conversation history' },
  { cmd: '/model <name>',  desc: 'Switch model (e.g. claude-opus-4-5)' },
  { cmd: '/system <text>', desc: 'Set system prompt' },
  { cmd: '/history',       desc: 'Show message count + token estimate' },
  { cmd: '/panel',         desc: 'Toggle info panel' },
  { cmd: '/skills',        desc: 'Open skill picker' },
  { cmd: '/alignment',     desc: 'Open alignment digest' },
  { cmd: '/federation',    desc: 'Open federation peers' },
  { cmd: '/exit',          desc: 'Exit chat' },
  { cmd: 'Ctrl+C',         desc: 'Cancel stream (1st) / Exit (2nd)' },
  { cmd: 'Ctrl+K',         desc: 'Toggle this palette' },
  { cmd: 'Ctrl+\\',        desc: 'Toggle info panel' },
  { cmd: 'Ctrl+D',         desc: 'Exit on empty input' },
  { cmd: 'Ctrl+A',         desc: 'Open alignment digest' },
  { cmd: 'Ctrl+F',         desc: 'Open federation peers' },
  { cmd: 'Ctrl+S',         desc: 'Open skill picker' },
  { cmd: 'Ctrl+O',         desc: 'Toggle last tool card expand' },
  { cmd: '\u2191 / \u2193', desc: 'Navigate input history' },
];

export const HelpOverlay: React.FC<Props> = ({ onClose: _onClose }) => {
  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor="white"
      marginLeft={2}
      marginRight={2}
      marginBottom={1}
      paddingX={2}
      paddingY={1}
    >
      <Text bold>commands</Text>
      <Text> </Text>
      {COMMANDS.map(({ cmd, desc }) => (
        <Box key={cmd}>
          <Box width={22}>
            <Text>{cmd}</Text>
          </Box>
          <Text dimColor>{desc}</Text>
        </Box>
      ))}
      <Text> </Text>
      <Text dimColor>Ctrl+K to close</Text>
    </Box>
  );
};
