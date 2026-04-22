/**
 * QuizVideo Remotion composition — ported from /root/my-remotion-test/src/quiz/QuizVideo.tsx
 * Registered as 'QuizVideo' at 1920x1080, 30fps.
 */

import React from 'react';
import {
  AbsoluteFill,
  Audio,
  Composition,
  Sequence,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
} from 'remotion';

// ---------------------------------------------------------------------------
// Types (inlined to avoid cross-project import issues)
// ---------------------------------------------------------------------------

export interface QuizQuestion {
  question: string;
  displayContent: string;
  contentType: 'emoji' | 'image' | 'text';
  answer: string;
  options?: string[];
  difficulty: 'easy' | 'medium' | 'hard' | 'impossible';
  funFact?: string;
}

export interface QuizConfig {
  title: string;
  category: string;
  timerSeconds: number;
  questions: QuizQuestion[];
  channelName: string;
  backgroundMusic: string;
}

const COLORS = {
  bgPurple: '#1A0A2E',
  bgNavy: '#0D1B2A',
  cyan: '#00BCD4',
  purple: '#7B2FBE',
  orange: '#FF6B35',
  correct: '#4CAF50',
  wrong: '#F44336',
  timerGold: '#FFD700',
  white: '#FFFFFF',
} as const;

const DIFFICULTY_COLORS: Record<QuizQuestion['difficulty'], string> = {
  easy: '#4CAF50',
  medium: '#FFD700',
  hard: '#FF6B35',
  impossible: '#F44336',
};

const FRAMES = {
  INTRO: 90,
  PER_QUESTION: 170,
  DIFFICULTY_BADGE: 60,
  OUTRO: 150,
  QUESTION_ENTER: 15,
  TIMER_DURATION: 90,
  ANSWER_REVEAL: 30,
} as const;

// ---------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------

export const SAMPLE_QUIZ_CONFIG: QuizConfig = {
  title: 'Guess 5 Animals in 3s',
  category: 'Animals',
  timerSeconds: 3,
  channelName: 'SUDO-AI Quiz',
  backgroundMusic: 'audio/bgmusic.mp3',
  questions: [
    { question: 'What animal is this?', displayContent: '🐘', contentType: 'emoji', answer: 'Elephant', difficulty: 'easy', funFact: 'Elephants are the largest land animals on Earth!' },
    { question: 'Which big cat has spots?', displayContent: '🐆', contentType: 'emoji', answer: 'Leopard', options: ['Lion', 'Tiger', 'Leopard', 'Cheetah'], difficulty: 'medium', funFact: 'Leopards drag prey up trees to keep it safe.' },
    { question: 'Fastest bird in a dive?', displayContent: '🦅', contentType: 'emoji', answer: 'Peregrine Falcon', difficulty: 'hard', funFact: 'Peregrine falcons can reach 240 mph in a dive.' },
    { question: 'Only mammal that can fly?', displayContent: '🦇', contentType: 'emoji', answer: 'Bat', difficulty: 'hard', funFact: 'Bats use echolocation to navigate in darkness.' },
    { question: 'Sleeps 22 hours a day?', displayContent: '🐨', contentType: 'emoji', answer: 'Koala', difficulty: 'impossible', funFact: 'Koalas need sleep because eucalyptus is toxic.' },
  ],
};

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function calcDuration(questions: QuizQuestion[]): number {
  return FRAMES.INTRO + questions.length * FRAMES.PER_QUESTION + FRAMES.OUTRO;
}

function getDifficultyAtIndex(index: number, total: number): QuizQuestion['difficulty'] {
  const pct = index / total;
  if (pct < 0.25) return 'easy';
  if (pct < 0.5) return 'medium';
  if (pct < 0.75) return 'hard';
  return 'impossible';
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const Background: React.FC<{ difficultyProgress: number }> = ({ difficultyProgress }) => {
  const color = `hsl(${260 + difficultyProgress * 40}, 70%, ${8 + difficultyProgress * 5}%)`;
  return (
    <AbsoluteFill style={{ background: `linear-gradient(135deg, ${COLORS.bgPurple} 0%, ${color} 100%)` }} />
  );
};

const Intro: React.FC<{ config: QuizConfig }> = ({ config }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 15], [0, 1], { extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{ opacity, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ color: COLORS.cyan, fontSize: 48, fontWeight: 900, textAlign: 'center', padding: '0 40px' }}>{config.title}</div>
      <div style={{ color: COLORS.white, fontSize: 28, marginTop: 16, opacity: 0.8 }}>{config.category}</div>
    </AbsoluteFill>
  );
};

const QuestionCard: React.FC<{ question: QuizQuestion; questionNumber: number; totalQuestions: number }> = ({ question, questionNumber, totalQuestions }) => {
  const color = DIFFICULTY_COLORS[question.difficulty];
  return (
    <AbsoluteFill style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '0 60px' }}>
      <div style={{ color, fontSize: 20, fontWeight: 700, marginBottom: 12 }}>{`Q${questionNumber}/${totalQuestions}`}</div>
      <div style={{ fontSize: 120, marginBottom: 20 }}>{question.displayContent}</div>
      <div style={{ color: COLORS.white, fontSize: 36, fontWeight: 700, textAlign: 'center', lineHeight: 1.3 }}>{question.question}</div>
    </AbsoluteFill>
  );
};

const TimerBar: React.FC<{ durationFrames: number; startFrame: number }> = ({ durationFrames, startFrame }) => {
  const frame = useCurrentFrame();
  const { width } = useVideoConfig();
  const elapsed = frame - startFrame;
  const progress = Math.max(0, 1 - elapsed / durationFrames);
  const barColor = progress > 0.4 ? COLORS.timerGold : COLORS.wrong;
  return (
    <AbsoluteFill style={{ top: 'auto', bottom: 60, height: 12, background: '#333' }}>
      <div style={{ width: `${progress * 100}%`, height: '100%', background: barColor, transition: 'background 0.3s' }} />
    </AbsoluteFill>
  );
};

const AnswerReveal: React.FC<{ question: QuizQuestion; visible: boolean }> = ({ question, visible }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 10], [0, 1], { extrapolateRight: 'clamp' });
  if (!visible) return null;
  return (
    <AbsoluteFill style={{ opacity, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', padding: '0 60px 120px' }}>
      <div style={{ background: COLORS.correct, borderRadius: 16, padding: '16px 40px', color: COLORS.white, fontSize: 40, fontWeight: 900 }}>{question.answer}</div>
      {question.funFact && (
        <div style={{ color: COLORS.white, fontSize: 22, marginTop: 16, textAlign: 'center', opacity: 0.85 }}>{question.funFact}</div>
      )}
    </AbsoluteFill>
  );
};

const Outro: React.FC<{ correct: number; total: number; channelName: string }> = ({ correct, total, channelName }) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 20], [0, 1], { extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{ opacity, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ color: COLORS.cyan, fontSize: 52, fontWeight: 900 }}>Final Score</div>
      <div style={{ color: COLORS.white, fontSize: 80, fontWeight: 900, margin: '20px 0' }}>{correct}/{total}</div>
      <div style={{ color: COLORS.orange, fontSize: 28, fontWeight: 700 }}>Subscribe to {channelName}</div>
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------------------
// Question block
// ---------------------------------------------------------------------------

const QuestionBlock: React.FC<{ question: QuizQuestion; questionNumber: number; totalQuestions: number; correctSoFar: number }> = ({
  question, questionNumber, totalQuestions, correctSoFar,
}) => {
  const frame = useCurrentFrame();
  const isAnswerVisible = frame >= FRAMES.QUESTION_ENTER + FRAMES.TIMER_DURATION;
  const fadeOut = frame >= FRAMES.QUESTION_ENTER + FRAMES.TIMER_DURATION + FRAMES.ANSWER_REVEAL
    ? interpolate(frame, [FRAMES.QUESTION_ENTER + FRAMES.TIMER_DURATION + FRAMES.ANSWER_REVEAL, FRAMES.PER_QUESTION], [1, 0], { extrapolateRight: 'clamp' })
    : 1;

  void correctSoFar; // used by parent for display; kept for API compat

  return (
    <AbsoluteFill style={{ opacity: fadeOut }}>
      <QuestionCard question={question} questionNumber={questionNumber} totalQuestions={totalQuestions} />
      {frame >= FRAMES.QUESTION_ENTER && frame < FRAMES.QUESTION_ENTER + FRAMES.TIMER_DURATION && (
        <TimerBar durationFrames={FRAMES.TIMER_DURATION} startFrame={FRAMES.QUESTION_ENTER} />
      )}
      <AnswerReveal question={question} visible={isAnswerVisible} />
      <Sequence from={FRAMES.QUESTION_ENTER + FRAMES.TIMER_DURATION} durationInFrames={30}>
        <Audio src={staticFile('audio/ding.mp3')} volume={0.8} />
      </Sequence>
      <Sequence from={FRAMES.PER_QUESTION - 15} durationInFrames={15}>
        <Audio src={staticFile('audio/whoosh.mp3')} volume={0.5} />
      </Sequence>
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------------------
// Main composition
// ---------------------------------------------------------------------------

export const QuizVideo: React.FC<{ config?: QuizConfig }> = ({ config = SAMPLE_QUIZ_CONFIG }) => {
  const { questions } = config;
  const totalQuestions = questions.length;
  let cursor = FRAMES.INTRO;
  const sequences: React.ReactNode[] = [];

  questions.forEach((q, i) => {
    const prevDiff = getDifficultyAtIndex(i - 1, totalQuestions);
    const currDiff = getDifficultyAtIndex(i, totalQuestions);
    if (i > 0 && prevDiff !== currDiff) {
      cursor += FRAMES.DIFFICULTY_BADGE;
    }
    sequences.push(
      <Sequence key={`q-${i}`} from={cursor} durationInFrames={FRAMES.PER_QUESTION}>
        <QuestionBlock question={q} questionNumber={i + 1} totalQuestions={totalQuestions} correctSoFar={i} />
      </Sequence>,
    );
    cursor += FRAMES.PER_QUESTION;
  });

  const diffProgress = (totalQuestions - 1) / Math.max(1, totalQuestions - 1);

  return (
    <AbsoluteFill style={{ fontFamily: "'Arial Black', Impact, sans-serif" }}>
      <Background difficultyProgress={diffProgress} />
      <Audio src={staticFile(config.backgroundMusic)} volume={0.25} loop />
      <Sequence from={0} durationInFrames={FRAMES.INTRO}>
        <Intro config={config} />
      </Sequence>
      {sequences}
      <Sequence from={cursor} durationInFrames={FRAMES.OUTRO}>
        <Outro correct={Math.round(totalQuestions * 0.8)} total={totalQuestions} channelName={config.channelName} />
      </Sequence>
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------------------
// Remotion Composition registration
// ---------------------------------------------------------------------------

export const QuizComposition: React.FC = () => {
  const defaultConfig = SAMPLE_QUIZ_CONFIG;
  const duration = calcDuration(defaultConfig.questions);

  return (
    <Composition
      id="QuizVideo"
      component={QuizVideo}
      durationInFrames={duration}
      fps={30}
      width={1920}
      height={1080}
      defaultProps={{ config: defaultConfig }}
    />
  );
};

export { calcDuration };
