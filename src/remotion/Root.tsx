/**
 * Remotion Root — registers all video compositions for SUDO-AI v3.
 * Import this file as the Remotion entry point in remotion.config.ts.
 */

import React from 'react';
import { QuizComposition } from './quiz/QuizVideo';
import { RemotionAgentsRoot } from './characters/index';

import { AITutorialShortComposition } from './shorts/AITutorialShort';

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <QuizComposition />
      <RemotionAgentsRoot />
        <AITutorialShortComposition />
    </>
  );
};
