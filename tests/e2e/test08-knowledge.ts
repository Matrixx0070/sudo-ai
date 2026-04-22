import { KnowledgeGraph } from '../../src/core/knowledge/index.js';

const start = Date.now();
try {
  const kg = new KnowledgeGraph('data/test-knowledge.db');
  const node1 = kg.addNode('concept', 'TypeScript', 'A typed superset of JavaScript', ['programming']);
  const node2 = kg.addNode('concept', 'Node.js', 'JavaScript runtime built on V8', ['runtime']);
  kg.addEdge(node1.id as number, node2.id as number, 'related_to', 0.9);
  const found = kg.findNodes('TypeScript');
  const neighbors = kg.getNeighbors(node1.id as number);
  console.log('Nodes found:', found.length, 'Neighbors:', neighbors.length);
  if (found.length > 0 && neighbors.length > 0) {
    console.log(`TEST 8 KNOWLEDGE GRAPH: PASS (${Date.now() - start}ms)`);
  } else {
    console.log('TEST 8 KNOWLEDGE GRAPH: FAIL - no results');
    process.exit(1);
  }
  kg.close();
} catch (err) {
  console.error('TEST 8 KNOWLEDGE GRAPH: FAIL', err);
  process.exit(1);
}
