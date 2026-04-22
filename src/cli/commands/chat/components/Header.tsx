/**
 * @file Header.tsx — Single-line header with alignment dots, federation indicator.
 * Truncates gracefully at narrow terminals (<100 / 100-119 / >=120).
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { DigestData } from '../hooks/useDigest.js';
import type { FederationData } from '../hooks/useFederation.js';

export type AlignmentStatus = 'green' | 'amber' | 'red';

export interface HeaderProps {
  model: string;
  alignment: AlignmentStatus;
  tokens: number;
  digest: DigestData;
  federation: FederationData;
  onAlignmentOpen: () => void;
  onFederationOpen: () => void;
}

const OVERALL_COLORS: Record<string, string> = {
  GREEN: '#7acc7a',
  AMBER: '#e8b860',
  RED:   '#dd6666',
};

export const Header: React.FC<HeaderProps> = ({
  model,
  tokens,
  digest,
  federation,
}) => {
  const cols = process.stdout.columns ?? 120;

  // Truncate model name for narrow terminals
  const displayModel = cols < 100
    ? (model.includes('/') ? model.split('/').pop() ?? model : model.split('.')[0] ?? model)
    : model;

  const overallColor = OVERALL_COLORS[digest.overall] ?? '#e8b860';

  return (
    <Box paddingLeft={2}>
      <Text color="#e8b860" bold>sudo</Text>
      <Text dimColor> · </Text>
      <Text dimColor>{displayModel}</Text>
      <Text> </Text>

      {/* 8 alignment dots */}
      {digest.signals.map(signal => (
        <Text key={signal.name} color={signal.color}>●</Text>
      ))}
      <Text> </Text>
      <Text color={overallColor}>{digest.overall}</Text>

      {/* Federation peers */}
      {cols >= 100 && (
        <>
          <Text dimColor>  </Text>
          {cols >= 120 ? (
            <Text dimColor>peers · {federation.count}</Text>
          ) : (
            <Text dimColor>·{federation.count}</Text>
          )}
        </>
      )}

      {/* Token count */}
      <Text dimColor>  {tokens}t</Text>
    </Box>
  );
};
