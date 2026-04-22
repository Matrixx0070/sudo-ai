/**
 * SocialIntelligence — track relationships, manage community, map influence.
 *
 * Provides high-level methods for:
 *   - Contact management (add, update, get, search)
 *   - Interaction tracking (record, history)
 *   - Influence mapping (top influencers, collaboration candidates)
 *   - Community analytics (stats, most active)
 *   - Reputation monitoring (recent mentions, sentiment summary)
 */

import { nanoid } from 'nanoid';
import { createLogger } from '../shared/logger.js';
import { SocialIntelligenceDB } from './social-intelligence-db.js';

const logger = createLogger('social-intelligence');

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface Contact {
  id: string;
  name: string;
  /** 'youtube' | 'telegram' | 'twitter' | 'email' | 'other' */
  platform: string;
  platformId?: string;
  relationship: 'viewer' | 'subscriber' | 'collaborator' | 'competitor' | 'mentor' | 'friend' | 'unknown';
  /** 0–10 */
  trustScore: number;
  interactionCount: number;
  lastInteraction?: string;
  notes: string;
  tags: string[];
}

export interface Interaction {
  id: string;
  contactId: string;
  /** 'comment' | 'dm' | 'mention' | 'collaboration' | 'email' | 'call' */
  type: string;
  content: string;
  sentiment: 'positive' | 'neutral' | 'negative';
  platform: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const VALID_PLATFORMS   = new Set(['youtube', 'telegram', 'twitter', 'email', 'other']);
const VALID_RELATIONS   = new Set(['viewer', 'subscriber', 'collaborator', 'competitor', 'mentor', 'friend', 'unknown']);
const VALID_SENTIMENTS  = new Set(['positive', 'neutral', 'negative']);
const VALID_INT_TYPES   = new Set(['comment', 'dm', 'mention', 'collaboration', 'email', 'call']);

function validateTrustScore(score: number): number {
  if (typeof score !== 'number' || isNaN(score)) return 5.0;
  return Math.max(0, Math.min(10, score));
}

function normalisePlatform(p: string): string {
  return VALID_PLATFORMS.has(p) ? p : 'other';
}

function normaliseRelationship(r: string): Contact['relationship'] {
  return VALID_RELATIONS.has(r) ? (r as Contact['relationship']) : 'unknown';
}

function normaliseSentiment(s: string): Interaction['sentiment'] {
  return VALID_SENTIMENTS.has(s) ? (s as Interaction['sentiment']) : 'neutral';
}

// ---------------------------------------------------------------------------
// SocialIntelligence
// ---------------------------------------------------------------------------

export class SocialIntelligence {
  private readonly storage: SocialIntelligenceDB;

  constructor(dbPath: string) {
    if (!dbPath || typeof dbPath !== 'string') {
      throw new TypeError('SocialIntelligence: dbPath must be a non-empty string');
    }
    this.storage = new SocialIntelligenceDB(dbPath);
    logger.info({ dbPath }, 'SocialIntelligence initialised');
  }

  // -------------------------------------------------------------------------
  // Contact management
  // -------------------------------------------------------------------------

  /**
   * Add a new contact. Returns the generated contact ID.
   */
  addContact(contact: Omit<Contact, 'id' | 'interactionCount'>): string {
    if (!contact.name?.trim()) throw new Error('Contact name is required');

    const id = nanoid();
    const now = new Date().toISOString();
    const c: Contact = {
      id,
      name:             contact.name.trim(),
      platform:         normalisePlatform(contact.platform ?? 'other'),
      platformId:       contact.platformId?.trim() || undefined,
      relationship:     normaliseRelationship(contact.relationship ?? 'unknown'),
      trustScore:       validateTrustScore(contact.trustScore ?? 5.0),
      interactionCount: 0,
      lastInteraction:  contact.lastInteraction || undefined,
      notes:            contact.notes?.trim() ?? '',
      tags:             Array.isArray(contact.tags) ? contact.tags.map(String) : [],
    };

    this.storage.insertContact(c);
    logger.info({ id, name: c.name, platform: c.platform }, 'Contact added');
    return id;
  }

  /**
   * Update fields on an existing contact.
   */
  updateContact(id: string, updates: Partial<Contact>): void {
    if (!id?.trim()) throw new Error('Contact id is required');

    const sanitised: Partial<Contact> = { ...updates };
    if (updates.platform    !== undefined) sanitised.platform    = normalisePlatform(updates.platform);
    if (updates.relationship !== undefined) sanitised.relationship = normaliseRelationship(updates.relationship);
    if (updates.trustScore  !== undefined) sanitised.trustScore  = validateTrustScore(updates.trustScore);
    if (updates.tags        !== undefined) sanitised.tags        = Array.isArray(updates.tags) ? updates.tags.map(String) : [];
    if (updates.name        !== undefined && !updates.name.trim()) throw new Error('name cannot be empty');

    const ok = this.storage.updateContact(id, sanitised);
    if (!ok) throw new Error(`Contact not found: ${id}`);
    logger.info({ id, fields: Object.keys(sanitised) }, 'Contact updated');
  }

  /**
   * Return a single contact by ID, or null if not found.
   */
  getContact(id: string): Contact | null {
    if (!id?.trim()) throw new Error('Contact id is required');
    return this.storage.getContactById(id);
  }

  /**
   * Full-text search across name, notes, tags, platform.
   */
  searchContacts(query: string): Contact[] {
    if (!query?.trim()) throw new Error('Search query is required');
    const results = this.storage.searchContacts(query.trim(), 50);
    logger.debug({ query, count: results.length }, 'Contacts searched');
    return results;
  }

  // -------------------------------------------------------------------------
  // Interaction tracking
  // -------------------------------------------------------------------------

  /**
   * Record an interaction event. Returns the generated interaction ID.
   * Also increments the contact's interaction_count and updates last_interaction.
   */
  recordInteraction(interaction: Omit<Interaction, 'id'>): string {
    if (!interaction.contactId?.trim()) throw new Error('contactId is required');
    if (!interaction.content?.trim())   throw new Error('content is required');

    const contact = this.storage.getContactById(interaction.contactId);
    if (!contact) throw new Error(`Contact not found: ${interaction.contactId}`);

    const id  = nanoid();
    const now = new Date().toISOString();
    const i: Interaction = {
      id,
      contactId: interaction.contactId,
      type:      VALID_INT_TYPES.has(interaction.type) ? interaction.type : 'comment',
      content:   interaction.content.trim(),
      sentiment: normaliseSentiment(interaction.sentiment ?? 'neutral'),
      platform:  normalisePlatform(interaction.platform ?? 'other'),
      timestamp: interaction.timestamp || now,
    };

    this.storage.insertInteraction(i);
    logger.info({ id, contactId: i.contactId, type: i.type, sentiment: i.sentiment }, 'Interaction recorded');
    return id;
  }

  /**
   * Return interaction history for a contact, newest first.
   */
  getInteractionHistory(contactId: string, limit = 20): Interaction[] {
    if (!contactId?.trim()) throw new Error('contactId is required');
    const clamped = Math.max(1, Math.min(500, limit));
    return this.storage.getInteractionsByContact(contactId, clamped);
  }

  // -------------------------------------------------------------------------
  // Influence mapping
  // -------------------------------------------------------------------------

  /**
   * Return contacts ranked by trust score (then interaction count).
   */
  getTopInfluencers(limit = 10): Contact[] {
    const clamped = Math.max(1, Math.min(100, limit));
    const results = this.storage.getTopByTrust(clamped);
    logger.debug({ count: results.length }, 'Top influencers retrieved');
    return results;
  }

  /**
   * Return contacts that are strong candidates for collaboration:
   * relationship in (collaborator, friend, mentor) AND trust >= 7.
   */
  getCollaborationCandidates(): Contact[] {
    const results = this.storage.getCollaborationCandidates();
    logger.debug({ count: results.length }, 'Collaboration candidates retrieved');
    return results;
  }

  // -------------------------------------------------------------------------
  // Community analytics
  // -------------------------------------------------------------------------

  /**
   * Aggregate stats: total contacts, by platform, by relationship, avg trust.
   */
  getCommunityStats(): {
    total: number;
    byPlatform: Record<string, number>;
    byRelationship: Record<string, number>;
    avgTrust: number;
  } {
    return this.storage.getCommunityStats();
  }

  /**
   * Return contacts sorted by interaction count descending.
   */
  getMostActive(limit = 10): Contact[] {
    const clamped = Math.max(1, Math.min(100, limit));
    return this.storage.getTopByInteractions(clamped);
  }

  // -------------------------------------------------------------------------
  // Reputation monitoring
  // -------------------------------------------------------------------------

  /**
   * Return the most recent interactions across all contacts (mentions/comments).
   */
  getRecentMentions(limit = 20): Interaction[] {
    const clamped = Math.max(1, Math.min(200, limit));
    return this.storage.getRecentInteractions(clamped);
  }

  /**
   * Aggregate sentiment counts across all stored interactions.
   */
  getSentimentSummary(): { positive: number; neutral: number; negative: number } {
    return this.storage.getSentimentCounts();
  }
}
