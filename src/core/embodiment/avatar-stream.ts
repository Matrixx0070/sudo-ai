/**
 * Avatar stream planning and presence card helpers.
 * Extracted from AvatarSystem to keep files under 300 lines.
 */

import type { Avatar } from './avatar-system.js';

// ---------------------------------------------------------------------------
// Public types (re-exported by avatar-system)
// ---------------------------------------------------------------------------

export interface StreamConfig {
  title:    string;
  platform: string;
  avatarId: string;
  /** Planned duration in minutes. */
  duration: number;
  topics:   string[];
}

export interface StreamPlan {
  plan:      string;
  checklist: string[];
}

export interface PresenceCard {
  name:         string;
  role:         string;
  capabilities: string[];
  avatar:       Avatar | null;
}

// ---------------------------------------------------------------------------
// SUDO capabilities list
// ---------------------------------------------------------------------------

export const SUDO_CAPABILITIES: string[] = [
  'Autonomous multi-step task execution',
  'Voice synthesis and speech recognition',
  'Multi-platform social media management',
  'Code writing and self-evolution',
  'YouTube channel automation and analytics',
  'Real-time trend detection and intelligence',
  'Multi-agent swarm coordination',
  'Financial tracking and revenue optimization',
  'Memory and knowledge management',
  'Browser automation and web research',
];

// ---------------------------------------------------------------------------
// planStream
// ---------------------------------------------------------------------------

/**
 * Generate a structured stream plan document and pre-stream checklist.
 *
 * @param config     - Stream configuration.
 * @param avatarName - Resolved display name of the avatar.
 */
export function buildStreamPlan(config: StreamConfig, avatarName: string): StreamPlan {
  if (!config.title?.trim()) throw new TypeError('StreamConfig.title is required');
  if (!config.platform?.trim()) throw new TypeError('StreamConfig.platform is required');
  if (config.duration <= 0) throw new TypeError('StreamConfig.duration must be > 0');

  const topicList = (config.topics ?? []).map((t, i) => `  ${i + 1}. ${t}`).join('\n');

  const plan = [
    `Stream Plan: "${config.title}"`,
    `Platform   : ${config.platform}`,
    `Duration   : ${config.duration} minutes`,
    `Avatar     : ${avatarName}`,
    '',
    'Segment Breakdown:',
    `  0–${Math.floor(config.duration * 0.1)} min  — Intro / Hook`,
    `  ${Math.floor(config.duration * 0.1)}–${Math.floor(config.duration * 0.8)} min — Main Content`,
    `  ${Math.floor(config.duration * 0.8)}–${config.duration} min — Outro / CTA`,
    '',
    'Topics:',
    topicList || '  (none specified)',
  ].join('\n');

  const checklist = [
    `Avatar "${avatarName}" loaded and expression set to "excited"`,
    `Stream title configured: "${config.title}"`,
    `Platform account connected: ${config.platform}`,
    'Audio output device verified',
    'Intro sound/animation queued',
    'Content outline reviewed',
    'CTA links prepared',
    'Thumbnail uploaded',
    'Stream health check passed (bitrate / keyframe interval)',
    'Backup recording software running',
  ];

  return { plan, checklist };
}

// ---------------------------------------------------------------------------
// generatePresenceCard
// ---------------------------------------------------------------------------

/**
 * Build SUDO's public presence card.
 *
 * @param currentAvatar - The currently active Avatar, or null.
 */
export function buildPresenceCard(currentAvatar: Avatar | null): PresenceCard {
  return {
    name:         'SUDO',
    role:         'Autonomous AI Agent Platform',
    capabilities: SUDO_CAPABILITIES,
    avatar:       currentAvatar,
  };
}
