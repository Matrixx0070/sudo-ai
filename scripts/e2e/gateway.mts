/** Entry point for the gateway boot-a-child E2E harness. Run: SUDO_E2E=1 pnpm e2e:gateway */
import { main } from '../../src/core/eval/gateway-e2e/runner.js';
await main();
