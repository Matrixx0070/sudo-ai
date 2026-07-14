import { consciousnessControlTool } from './src/core/tools/builtin/meta/consciousness-control.js';
import { healthCheckTool } from './src/core/tools/builtin/meta/health-check.js';
import { serviceControlTool } from './src/core/tools/builtin/meta/service-control.js';
import { selfConfigTool } from './src/core/tools/builtin/meta/self-config.js';
import { cronManagerTool } from './src/core/tools/builtin/meta/cron-manager.js';
import { toolCreatorTool } from './src/core/tools/builtin/meta/tool-creator.js';

console.log('✓ consciousness-control:', consciousnessControlTool.name);
console.log('✓ health-check:', healthCheckTool.name);
console.log('✓ service-control:', serviceControlTool.name);
console.log('✓ self-config:', selfConfigTool.name);
console.log('✓ cron-manager:', cronManagerTool.name);
console.log('✓ tool-creator:', toolCreatorTool.name);
console.log('\nAll 6 tools loaded successfully!');
