/** @file GerundSpinner.tsx — Animated spinner with gerund label and elapsed time. */

import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';

export interface GerundSpinnerProps {
  gerund: string;
  elapsedMs: number;
}

export const GerundSpinner: React.FC<GerundSpinnerProps> = ({ gerund, elapsedMs }) => {
  const secs = (elapsedMs / 1000).toFixed(1);

  return (
    <Box paddingLeft={2}>
      <Text color="#e8b860">
        <Spinner type="dots" />
      </Text>
      <Text> {gerund} </Text>
      <Text color="#e8b860">{secs}s</Text>
    </Box>
  );
};

/**
 * Map tool name to gerund label.
 */
export function toolNameToGerund(toolName: string): string {
  const n = toolName.toLowerCase();
  if (n.includes('search') || n.includes('grep') || n.includes('find')) return 'Searching…';
  if (n === 'bash' || n.includes('exec') || n.includes('run')) return 'Running…';
  if (n.includes('read') || n.includes('cat') || n.includes('view')) return 'Reading…';
  if (n.includes('write') || n.includes('edit') || n.includes('create')) return 'Writing…';
  return 'Working…';
}
