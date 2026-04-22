import React from 'react';
import {
  AbsoluteFill,
  Composition,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
  Easing,
  spring,
  Series,
} from 'remotion';

const bgStyle = {
  background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
} as const;

const textStyle = {
  fontSize: 80,
  fontWeight: 900,
  color: 'white',
  textAlign: 'center' as const,
  textShadow: '0 0 30px rgba(0,0,0,0.5)',
} as const;

const HookScene: React.FC<{hookText: string}> = ({hookText}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const scale = spring({
    frame,
    fps,
    from: 0,
    to: 1.2,
    config: {damping: 20, stiffness: 200},
  });
  const opacity = interpolate(frame, [0, 30], [0, 1], {extrapolateRight: 'clamp'});
  return (
    <AbsoluteFill style={bgStyle}>
      <div style={{...textStyle, fontSize: 100, transform: `scale(${scale})`, opacity}}>
        {hookText}
      </div>
    </AbsoluteFill>
  );
};

const StepScene: React.FC<{step: {title: string; desc: string}, num: number}> = ({step, num}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const badgeScale = spring({frame, fps, from: 0, to: 1, delay: 10, config: {damping: 15, stiffness: 150}});
  const titleY = interpolate(frame, [0, 20], [100, 0], {easing: Easing.out(Easing.cubic)});
  const descOpacity = interpolate(frame, [20, 40], [0, 1], {extrapolateRight: 'clamp'});
  return (
    <AbsoluteFill style={{...bgStyle, justifyContent: 'center', alignItems: 'center'}}>
      <div style={{position: 'absolute', top: 200, left: '50%', transform: 'translateX(-50%)'}}>
        <div style={{fontSize: 120, color: '#FFD700', transform: `scale(${badgeScale})`, fontWeight: 900}}>
          Step {num}
        </div>
      </div>
      <div style={{position: 'absolute', top: 350, left: '50%', width: '80%', transform: `translate(-50%, ${titleY}px)`}}>
        <div style={{...textStyle, fontSize: 70}}>{step.title}</div>
      </div>
      <div style={{position: 'absolute', bottom: 400, left: '50%', width: '80%', transform: 'translateX(-50%)', opacity: descOpacity}}>
        <div style={{...textStyle, fontSize: 50}}>{step.desc}</div>
      </div>
    </AbsoluteFill>
  );
};

const CTAScene: React.FC<{ctaText: string}> = ({ctaText}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const pulse = spring({frame, fps, from: 1, to: 1.05, config: {damping: 10, stiffness: 200}});
  const opacity = interpolate(frame, [0, 20], [0, 1], {extrapolateRight: 'clamp'});
  return (
    <AbsoluteFill style={bgStyle}>
      <div style={{...textStyle, fontSize: 90, opacity, transform: `scale(${pulse})`}}>
        {ctaText}
      </div>
      <div style={{position: 'absolute', bottom: 300, left: '50%', transform: 'translateX(-50%)', fontSize: 60, color: '#FFD700', textAlign: 'center' as const}}>
        Subscribe SUDO AI!
      </div>
    </AbsoluteFill>
  );
};

const AITutorialShortVideo: React.FC<unknown> = (props: unknown) => {
  const {hookText, steps, ctaText} = props as {hookText: string; steps: {title: string; desc: string}[]; ctaText: string};
  return (
    <Series>
      <Series.Sequence durationInFrames={90}>
        <HookScene hookText={hookText} />
      </Series.Sequence>
      {steps.map((step: {title: string; desc: string}, i: number) => (
        <Series.Sequence key={i} durationInFrames={220}>
          <StepScene step={step} num={i+1} />
        </Series.Sequence>
      ))}
      <Series.Sequence durationInFrames={150}>
        <CTAScene ctaText={ctaText} />
      </Series.Sequence>
    </Series>
  );
};

export const AITutorialShortComposition = () => (
  <Composition
    id="AITutorialShort"
    component={AITutorialShortVideo}
    durationInFrames={2000}
    fps={30}
    width={1080}
    height={1920}
    defaultProps={{
      hookText: 'Hook Text',
      steps: [{title: 'Step 1', desc: 'Description'}],
      ctaText: 'Try now!',
    }}
  />
);