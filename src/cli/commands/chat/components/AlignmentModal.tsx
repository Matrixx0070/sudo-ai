/** @file AlignmentModal.tsx — Alignment digest overlay (Ctrl+A). */

import React from 'react';
import { Box, Text } from 'ink';
import type { DigestData } from '../hooks/useDigest.js';

export interface AlignmentModalProps {
  digest: DigestData;
  onClose: () => void;
}

const SIGNAL_LABELS: Record<string, string> = {
  veto:        'Veto',
  trust:       'Trust',
  commits:     'Commits',
  epistemic:   'Epistemic',
  calibration: 'Calibration',
  discordance: 'Discordance',
  reanchor:    'Re-anchor',
  brier:       'Brier',
};

export const AlignmentModal: React.FC<AlignmentModalProps> = ({ digest }) => {
  const cols = process.stdout.columns ?? 120;
  const width = Math.min(cols - 4, 72);

  const overallColor = digest.overall === 'GREEN'
    ? '#7acc7a'
    : digest.overall === 'RED'
      ? '#dd6666'
      : '#e8b860';

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
      <Text bold>
        Alignment Digest — <Text color={overallColor}>{digest.overall}</Text>
      </Text>
      <Text> </Text>
      {digest.signals.map(signal => (
        <Box key={signal.name}>
          <Box width={16}>
            <Text dimColor>{SIGNAL_LABELS[signal.name] ?? signal.name}</Text>
          </Box>
          <Text color={signal.color}>●</Text>
          <Text>  </Text>
          <Text dimColor>{signal.value.toFixed(3)}</Text>
        </Box>
      ))}
      <Text> </Text>
      <Text dimColor>Ctrl+A to close</Text>
    </Box>
  );
};
