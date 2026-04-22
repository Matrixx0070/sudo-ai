#!/usr/bin/env node

const [, , ...args] = process.argv;

if (args[0] === '--help' || args[0] === '-h') {
  console.log('Usage: sudo-x-app [options]');
  process.exit(0);
}

console.log('sudo-x-app running with args:', args);
