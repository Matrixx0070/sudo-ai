import { CommandRegistry, registerBuiltinCommands } from '../../src/core/commands/index.js';

const start = Date.now();
try {
  const reg = new CommandRegistry();
  registerBuiltinCommands(reg);
  const all = reg.listAll();
  console.log('Commands registered:', all.length);
  console.log('Command names:', all.map(c => c.name).join(', '));
  const isHelp = reg.isCommand('/help');
  const isNotCmd = reg.isCommand('hello');
  console.log('Is command "/help":', isHelp);
  console.log('Is command "hello":', isNotCmd);
  const parsed = reg.parse('/model gpt-4o');
  console.log('Parsed:', JSON.stringify(parsed));
  if (all.length > 0 && isHelp && !isNotCmd) {
    console.log(`TEST 16 COMMANDS: PASS (${Date.now() - start}ms)`);
  } else {
    console.log('TEST 16 COMMANDS: FAIL');
    process.exit(1);
  }
} catch (err) {
  console.error('TEST 16 COMMANDS: FAIL', err);
  process.exit(1);
}
