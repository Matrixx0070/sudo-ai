/** @file Rule.tsx — Horizontal rule: dim ─ repeated 76 chars with 2-space margin. */

import React from 'react';
import { Box, Text } from 'ink';

const RULE = '─'.repeat(76);

export const Rule: React.FC = () => {
  return (
    <Box paddingLeft={2}>
      <Text dimColor>{RULE}</Text>
    </Box>
  );
};
