/** @file Panel.tsx — Ctrl+\ info panel showing model, provider, alignment, turn, tokens. */

import React from 'react';
import { Box, Text } from 'ink';
import type { AlignmentStatus } from './Header.js';

interface Props {
  model: string;
  provider: string;
  alignment: AlignmentStatus;
  turn: number;
  tokens: number;
}

const ALIGNMENT_COLORS: Record<AlignmentStatus, string> = {
  green: '#7acc7a',
  amber: '#e8b860',
  red:   '#dd6666',
};

export const Panel: React.FC<Props> = ({ model, provider, alignment, turn, tokens }) => {
  const alignColor = ALIGNMENT_COLORS[alignment];

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
      <Text bold>info</Text>
      <Text> </Text>
      <Box>
        <Box width={14}><Text dimColor>model</Text></Box>
        <Text>{model}</Text>
      </Box>
      <Box>
        <Box width={14}><Text dimColor>provider</Text></Box>
        <Text>{provider}</Text>
      </Box>
      <Box>
        <Box width={14}><Text dimColor>alignment</Text></Box>
        <Text color={alignColor}>{alignment}</Text>
      </Box>
      <Box>
        <Box width={14}><Text dimColor>turn</Text></Box>
        <Text>{turn}</Text>
      </Box>
      <Box>
        <Box width={14}><Text dimColor>tokens</Text></Box>
        <Text>{tokens}</Text>
      </Box>
      <Text> </Text>
      <Text dimColor>Ctrl+\ to close</Text>
    </Box>
  );
};
