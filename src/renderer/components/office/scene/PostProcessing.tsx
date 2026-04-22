import React from 'react';
import { EffectComposer, Bloom, Vignette } from '@react-three/postprocessing';

/**
 * PostProcessing — attaches Bloom + Vignette effects to the scene.
 * Must be rendered inside a <Canvas> element.
 */
export default function PostProcessing(): React.ReactElement {
  return (
    <EffectComposer>
      <Bloom
        intensity={0.3}
        luminanceThreshold={0.8}
        luminanceSmoothing={0.9}
      />
      <Vignette
        eskil={false}
        offset={0.1}
        darkness={0.5}
      />
    </EffectComposer>
  );
}
