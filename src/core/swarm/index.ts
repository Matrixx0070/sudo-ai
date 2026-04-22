/**
 * Swarm module public API.
 *
 * Re-exports SwarmManager and all associated types so consumers can import
 * from a single stable path: `import { SwarmManager } from '../swarm/index.js'`
 */

export { SwarmManager } from './swarm-manager.js';
export type { SwarmAgent, SwarmTask } from './swarm-manager.js';
