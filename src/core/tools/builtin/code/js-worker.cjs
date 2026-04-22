/**
 * js-worker.cjs — CommonJS worker bootstrap for the JS sandbox.
 *
 * This file MUST be .cjs because:
 *   - The project uses "type": "module" (ESM)
 *   - Worker eval:true scripts inherit ESM mode in Node 22+
 *   - vm and worker_threads built-ins need require() in CJS context
 *   - Using a .cjs file forces CommonJS regardless of package.json type
 *
 * Communication:
 *   Input:  workerData = { code: string, contextSnapshot: Record<string, unknown> }
 *   Output: parentPort.postMessage(WorkerOutput)
 *
 * Safe globals only — no require, process, fs, or global object.
 */

'use strict';

const { parentPort, workerData } = require('worker_threads');
const vm = require('vm');

const { code, contextSnapshot } = workerData;
const stdoutLines = [];
const stderrLines = [];

// Build a safe context — only JSON-safe primitives from snapshot + safe globals
const safeContext = Object.assign(Object.create(null), contextSnapshot, {
  console: {
    log: function () {
      const args = Array.prototype.slice.call(arguments);
      stdoutLines.push(args.map(String).join(' '));
    },
    error: function () {
      const args = Array.prototype.slice.call(arguments);
      stderrLines.push(args.map(String).join(' '));
    },
    warn: function () {
      const args = Array.prototype.slice.call(arguments);
      stderrLines.push('[warn] ' + args.map(String).join(' '));
    },
    info: function () {
      const args = Array.prototype.slice.call(arguments);
      stdoutLines.push('[info] ' + args.map(String).join(' '));
    },
    debug: function () {
      const args = Array.prototype.slice.call(arguments);
      stdoutLines.push('[debug] ' + args.map(String).join(' '));
    },
  },
  JSON: JSON,
  Math: Math,
  parseInt: parseInt,
  parseFloat: parseFloat,
  isNaN: isNaN,
  isFinite: isFinite,
  Number: Number,
  String: String,
  Boolean: Boolean,
  Array: Array,
  Object: Object,
  Date: Date,
  Error: Error,
  TypeError: TypeError,
  RangeError: RangeError,
  Promise: Promise,
  // Explicitly undefined — blocks access
  require: undefined,
  process: undefined,
  global: undefined,
  globalThis: undefined,
  __dirname: undefined,
  __filename: undefined,
});

vm.createContext(safeContext);

var returnValue;
var execError = null;

try {
  returnValue = vm.runInContext(code, safeContext, {
    filename: 'sandbox.js',
    timeout: 4500,
  });
} catch (err) {
  execError = String(err);
}

// Extract exportable context snapshot (JSON-serializable values only, skip safe globals)
var SKIP_KEYS = new Set([
  'console', 'JSON', 'Math', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'Number', 'String', 'Boolean', 'Array', 'Object', 'Date',
  'Error', 'TypeError', 'RangeError', 'Promise',
  'require', 'process', 'global', 'globalThis', '__dirname', '__filename',
]);

var updatedSnapshot = {};
var keys = Object.keys(safeContext);
for (var i = 0; i < keys.length; i++) {
  var k = keys[i];
  if (SKIP_KEYS.has(k)) continue;
  var v = safeContext[k];
  try {
    JSON.stringify(v);
    updatedSnapshot[k] = v;
  } catch (e) {
    // skip non-serializable values
  }
}

// Handle Promise return values
if (returnValue !== null && returnValue !== undefined && typeof returnValue === 'object' && typeof returnValue.then === 'function') {
  returnValue.then(
    function (resolved) {
      parentPort.postMessage({
        stdout: stdoutLines.join('\n'),
        stderr: stderrLines.join('\n'),
        value: resolved,
        error: null,
        contextSnapshot: updatedSnapshot,
      });
    },
    function (rejected) {
      parentPort.postMessage({
        stdout: stdoutLines.join('\n'),
        stderr: stderrLines.join('\n'),
        value: undefined,
        error: String(rejected),
        contextSnapshot: {},
      });
    }
  );
  return;
}

parentPort.postMessage({
  stdout: stdoutLines.join('\n'),
  stderr: stderrLines.join('\n'),
  value: returnValue,
  error: execError,
  contextSnapshot: updatedSnapshot,
});
