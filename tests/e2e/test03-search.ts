import { MindDB, hybridSearch } from '../../src/core/memory/index.js';

const start = Date.now();
try {
  const db = new MindDB('data/test-search.db');
  db.storeChunk('JavaScript is a programming language used for web development', 'test/search', 'file');
  db.storeChunk('Python is popular for machine learning and data science', 'test/search', 'file');
  db.storeChunk('TypeScript adds static typing to JavaScript', 'test/search', 'file');
  const results = await hybridSearch(db, null, { query: 'JavaScript programming', maxResults: 3, minScore: 0.01 });
  console.log('Search results:', results.length, 'Top match:', results[0]?.chunk?.text?.substring(0, 50));
  console.log('Scores:', results.map(r => r.score.toFixed(4)));
  if (results.length > 0) {
    console.log(`TEST 3 HYBRID SEARCH: PASS (${Date.now() - start}ms)`);
  } else {
    console.log('TEST 3 HYBRID SEARCH: FAIL - no results');
    process.exit(1);
  }
  db.close();
} catch (err) {
  console.error('TEST 3 HYBRID SEARCH: FAIL', err);
  process.exit(1);
}
