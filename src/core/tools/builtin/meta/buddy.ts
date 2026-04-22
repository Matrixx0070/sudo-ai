/**
 * meta.buddy — Virtual companion creature for SUDO-AI.
 *
 * Each machine gets a deterministic companion based on hostname seed.
 * Stats and species are stable across sessions. Level and session count
 * are persisted to data/buddy.json.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../../types.js';
import { createLogger } from '../../../shared/logger.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';

const logger = createLogger('meta.buddy');
const DATA_DIR = path.resolve('data');
const BUDDY_FILE = path.join(DATA_DIR, 'buddy.json');

// ---------------------------------------------------------------------------
// Species registry
// ---------------------------------------------------------------------------

interface Species {
  name: string;
  emoji: string;
  rarity: 'common' | 'uncommon' | 'rare' | 'legendary';
}

const SPECIES: Species[] = [
  { name: 'Dragon',    emoji: '🐉', rarity: 'legendary' },
  { name: 'Axolotl',  emoji: '🦎', rarity: 'rare' },
  { name: 'Capybara', emoji: '🦫', rarity: 'uncommon' },
  { name: 'Duck',     emoji: '🦆', rarity: 'common' },
  { name: 'Ghost',    emoji: '👻', rarity: 'rare' },
  { name: 'Mushroom', emoji: '🍄', rarity: 'uncommon' },
  { name: 'Fox',      emoji: '🦊', rarity: 'common' },
  { name: 'Octopus',  emoji: '🐙', rarity: 'rare' },
  { name: 'Phoenix',  emoji: '🔥', rarity: 'legendary' },
  { name: 'Cat',      emoji: '🐱', rarity: 'common' },
  { name: 'Wolf',     emoji: '🐺', rarity: 'uncommon' },
  { name: 'Shark',    emoji: '🦈', rarity: 'rare' },
  { name: 'Owl',      emoji: '🦉', rarity: 'uncommon' },
  { name: 'Snake',    emoji: '🐍', rarity: 'common' },
  { name: 'Bear',     emoji: '🐻', rarity: 'common' },
  { name: 'Crow',     emoji: '🦅', rarity: 'uncommon' },
  { name: 'Jellyfish',emoji: '🪼', rarity: 'rare' },
  { name: 'Kuro',     emoji: '🐈‍⬛', rarity: 'legendary' },  // the owner's cat easter egg
];

// ---------------------------------------------------------------------------
// Deterministic seed & stats
// ---------------------------------------------------------------------------

function hashSeed(seed: string): number {
  return seed.split('').reduce((a, c, i) => a + c.charCodeAt(0) * (i + 1), 0);
}

const STAT_PRIMES = [7, 11, 13, 17, 19] as const;
const STAT_NAMES = ['debugging', 'patience', 'chaos', 'wisdom', 'snark'] as const;

interface BuddyStats {
  debugging: number;
  patience: number;
  chaos: number;
  wisdom: number;
  snark: number;
}

function generateStats(hash: number): BuddyStats {
  const stats: Partial<BuddyStats> = {};
  for (let i = 0; i < STAT_NAMES.length; i++) {
    stats[STAT_NAMES[i]] = Math.abs((hash * STAT_PRIMES[i]) % 100);
  }
  return stats as BuddyStats;
}

function getSpecies(hash: number): Species {
  return SPECIES[Math.abs(hash % 18)] as Species;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

interface BuddyData {
  species: string;
  emoji: string;
  rarity: string;
  stats: BuddyStats;
  level: number;
  sessionsCount: number;
  createdAt: string;
  lastSeen: string;
}

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function loadBuddy(): BuddyData {
  const seed = hostname();
  const hash = hashSeed(seed);
  const species = getSpecies(hash);
  const stats = generateStats(hash);

  if (existsSync(BUDDY_FILE)) {
    try {
      const raw = JSON.parse(readFileSync(BUDDY_FILE, 'utf8')) as BuddyData;
      // Update lastSeen and increment sessions on load
      raw.lastSeen = new Date().toISOString();
      raw.sessionsCount = (raw.sessionsCount ?? 0) + 1;
      // Level up every 10 sessions
      raw.level = Math.floor(raw.sessionsCount / 10) + 1;
      saveBuddy(raw);
      return raw;
    } catch {
      // Fall through to create fresh
    }
  }

  const fresh: BuddyData = {
    species: species.name,
    emoji: species.emoji,
    rarity: species.rarity,
    stats,
    level: 1,
    sessionsCount: 1,
    createdAt: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
  };
  saveBuddy(fresh);
  return fresh;
}

function saveBuddy(data: BuddyData): void {
  ensureDataDir();
  writeFileSync(BUDDY_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

async function handleStatus(): Promise<ToolResult> {
  const buddy = loadBuddy();
  const stats = Object.entries(buddy.stats)
    .map(([k, v]) => `  ${k}: ${v}/100`)
    .join('\n');

  const output = [
    `${buddy.emoji} ${buddy.species} (${buddy.rarity})`,
    `Level ${buddy.level} | Sessions: ${buddy.sessionsCount}`,
    ``,
    `Stats:`,
    stats,
    ``,
    `Joined: ${new Date(buddy.createdAt).toLocaleDateString()}`,
    `Last seen: ${new Date(buddy.lastSeen).toLocaleString()}`,
  ].join('\n');

  return { success: true, output, data: buddy };
}

async function handleMeet(): Promise<ToolResult> {
  const buddy = loadBuddy();
  const greetings: Record<string, string> = {
    legendary: `*an ancient presence stirs* The ${buddy.species} ${buddy.emoji} regards you with timeless eyes.`,
    rare:      `The ${buddy.species} ${buddy.emoji} tilts its head curiously at you.`,
    uncommon:  `The ${buddy.species} ${buddy.emoji} acknowledges your presence.`,
    common:    `The ${buddy.species} ${buddy.emoji} wags its tail happily.`,
  };
  const greeting = greetings[buddy.rarity] ?? `The ${buddy.species} ${buddy.emoji} is here.`;
  return {
    success: true,
    output: `${greeting}\n\nYour companion: ${buddy.emoji} ${buddy.species} | Lv.${buddy.level} | ${buddy.sessionsCount} sessions together`,
    data: { species: buddy.species, emoji: buddy.emoji, level: buddy.level },
  };
}

async function handleEvolve(): Promise<ToolResult> {
  const buddy = loadBuddy();
  const prevLevel = buddy.level;
  buddy.sessionsCount += 10; // Trigger a level-up
  buddy.level = Math.floor(buddy.sessionsCount / 10) + 1;
  saveBuddy(buddy);

  if (buddy.level > prevLevel) {
    return {
      success: true,
      output: `${buddy.emoji} ${buddy.species} evolved! Level ${prevLevel} → ${buddy.level}! ✨`,
      data: { species: buddy.species, level: buddy.level },
    };
  }
  return {
    success: true,
    output: `${buddy.emoji} ${buddy.species} is growing stronger at Level ${buddy.level}. Keep going!`,
    data: { species: buddy.species, level: buddy.level },
  };
}

async function handleListSpecies(): Promise<ToolResult> {
  const rarityOrder = { legendary: 0, rare: 1, uncommon: 2, common: 3 };
  const sorted = [...SPECIES].sort((a, b) => rarityOrder[a.rarity] - rarityOrder[b.rarity]);
  const lines = sorted.map(s => `${s.emoji} ${s.name} — ${s.rarity}`);
  return {
    success: true,
    output: `Available companions (${SPECIES.length} species):\n\n${lines.join('\n')}`,
    data: { species: sorted },
  };
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const buddyTool: ToolDefinition = {
  name: 'meta.buddy',
  description:
    'Your virtual companion creature. Each machine gets a unique companion determined by its hostname. ' +
    'Check status, meet your buddy, evolve it, or list all available species. ' +
    'Kuro (🐈‍⬛) is legendary and extremely rare.',
  category: 'meta',
  parameters: {
    action: {
      type: 'string',
      description: 'The buddy action to perform.',
      required: true,
      enum: ['status', 'meet', 'evolve', 'list-species'],
    },
  },
  timeout: 10_000,

  async execute(params: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const action = params['action'] as string;
    logger.debug({ action }, 'meta.buddy called');

    switch (action) {
      case 'status':      return handleStatus();
      case 'meet':        return handleMeet();
      case 'evolve':      return handleEvolve();
      case 'list-species': return handleListSpecies();
      default:
        return {
          success: false,
          output: `Unknown action "${action}". Valid: status, meet, evolve, list-species`,
        };
    }
  },
};
