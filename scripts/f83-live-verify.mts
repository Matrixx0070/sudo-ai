/**
 * F83 live verification — runs ONE real consolidation pass against a COPY of the
 * prod consciousness.db (never the real file). LLM (brain) is mocked with a canned
 * response so the pass is free. Prints the resulting sleep_sessions row.
 *
 * Usage: npx tsx scripts/f83-live-verify.mts /tmp/f83-prod-copy.db
 */
import { ConsciousnessDB } from '../src/core/consciousness/consciousness-db.js';
import { EpisodicMemory } from '../src/core/consciousness/episodic-memory/index.js';
import { SleepCycle } from '../src/core/consciousness/sleep-cycle/consolidator.js';
import { getRecentSessions } from '../src/core/consciousness/sleep-cycle/store.js';

const dbPath = process.argv[2];
if (!dbPath) { console.error('need path to a COPY of consciousness.db'); process.exit(1); }
if (dbPath.includes('/sudo-ai-v4/data/consciousness.db')) { console.error('refusing to run on the real prod DB'); process.exit(1); }

const cdb = new ConsciousnessDB(dbPath);
const episodic = new EpisodicMemory(cdb);
const before = cdb.getDb().prepare('SELECT COUNT(*) c FROM sleep_sessions').get() as { c: number };
const epCount = cdb.getDb().prepare('SELECT COUNT(*) c FROM episodes').get() as { c: number };

const cycle = new SleepCycle({
  cdb,
  brain: { call: async () => ({ content: '1. Recurring browser-login friction; prefer durable profiles.\n2. Ambiguous tool choices should escalate to the planner.\n3. Heartbeat-only episodes carry low signal.' }) },
  episodicMemory: episodic,
  counterfactualEngine: { runIdleBatch: async () => [] },
  selfModel: { updateFromEpisode: () => undefined },
  temporalSelf: { takeSnapshot: () => undefined },
  metacognition: { runBatchReflection: async () => [] },
  wisdomStore: { storeInsight: () => undefined },
});

const session = await cycle.startSleep();
const rows = getRecentSessions(cdb.getDb(), 1);
console.log('=== F83 LIVE (copied prod DB) ===');
console.log('episodes in store:', epCount.c);
console.log('sleep_sessions before:', before.c);
console.log('new session:', JSON.stringify({
  id: session.id,
  episodesReplayed: session.episodesReplayed,
  memoriesStrengthened: session.memoriesStrengthened,
  memoriesWeakened: session.memoriesWeakened,
  patternsFound: session.patternsFound,
  insightsGenerated: session.insightsGenerated,
  degraded: session.degraded,
  integrityScore: session.integrityScore,
  dreamLen: session.dreamJournalEntry.length,
}, null, 2));
console.log('persisted row episodesReplayed:', rows[0]?.episodesReplayed);
cdb.close();
