/**
 * ptc-worker.cjs — Programmatic Tool Calling sandbox (gap #15).
 *
 * Same posture as js-worker.cjs (CJS-forced because the project is ESM and
 * worker_threads + vm need CommonJS in Node 22+). The script the model
 * writes can call host tools via an injected `tool(name, args)` async
 * primitive: the worker posts `{type:'tool-call', id, name, args}` to the
 * parent and awaits a matching `{type:'tool-result', id, result}` message.
 *
 * The Promise constructor exposed to the sandbox is the same Promise the
 * worker thread itself uses (passed via `Promise: Promise` in the context
 * map), so the IIFE return value can be awaited at the worker top level
 * without crossing realm boundaries.
 *
 * Trust model (Hermes a1, copied as the gap requires):
 *   - The host registry runs each tool call through its normal permission
 *     and approval gates; the worker is not privileged.
 *   - The sandbox exposes ONLY `tool`, `print`, `console`, and JS built-ins
 *     — no require, process, fs, global, network, or filesystem primitives.
 *   - VM execution does not honour cooperative timeouts (the wrapping IIFE
 *     awaits); the outer worker.terminate() in meta.ptc enforces the cap.
 */

'use strict';

const { parentPort, workerData } = require('worker_threads');
const vm = require('vm');

const { script } = workerData;
const stdoutLines = [];
const stderrLines = [];
const callLog = [];

let nextCallId = 0;
const pending = new Map(); // id -> { resolve, reject }

// Receive tool-result messages from the parent and resolve the matching call.
parentPort.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type !== 'tool-result') return;
  const slot = pending.get(msg.id);
  if (!slot) return;
  pending.delete(msg.id);
  if (msg.error) {
    slot.reject(new Error(String(msg.error)));
  } else {
    slot.resolve(msg.result);
  }
});

// Bridge primitive: model writes `await tool('coder.read-file', {path: '...'})`
// and receives the ToolResult the host registry produced.
function callTool(name, args) {
  if (typeof name !== 'string' || name.length === 0) {
    return Promise.reject(new Error('tool(): name must be a non-empty string'));
  }
  const safeArgs = (args !== undefined && args !== null && typeof args === 'object') ? args : {};
  const id = nextCallId++;
  callLog.push({ name: name, args: safeArgs });
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve, reject: reject });
    parentPort.postMessage({ type: 'tool-call', id: id, name: name, args: safeArgs });
  });
}

function makePrintFn(buf) {
  return function () {
    const args = Array.prototype.slice.call(arguments);
    buf.push(args.map(function (a) {
      if (typeof a === 'string') return a;
      try { return JSON.stringify(a); } catch (_) { return String(a); }
    }).join(' '));
  };
}

const sandbox = Object.assign(Object.create(null), {
  // Host bridge
  tool: callTool,
  print: makePrintFn(stdoutLines),
  console: {
    log: makePrintFn(stdoutLines),
    error: makePrintFn(stderrLines),
    warn: makePrintFn(stderrLines),
    info: makePrintFn(stdoutLines),
    debug: makePrintFn(stdoutLines),
  },
  // Safe JS built-ins (mirrors js-worker.cjs)
  JSON: JSON,
  Math: Math,
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
  parseInt: parseInt,
  parseFloat: parseFloat,
  isNaN: isNaN,
  isFinite: isFinite,
  // Explicitly blocked
  require: undefined,
  process: undefined,
  global: undefined,
  globalThis: undefined,
  __dirname: undefined,
  __filename: undefined,
});

vm.createContext(sandbox);

// Wrap user code in an async IIFE so `await tool(...)` works at the top of
// the script — the SDK's docs tell the model it can `await` directly.
const wrapped =
  '(async function() {\n' +
  String(script) +
  '\n}())';

(async function run() {
  try {
    const maybePromise = vm.runInContext(wrapped, sandbox, {
      filename: 'ptc-script.js',
    });
    const value = await maybePromise;
    parentPort.postMessage({
      type: 'done',
      stdout: stdoutLines.join('\n'),
      stderr: stderrLines.join('\n'),
      value: serialise(value),
      callLog: callLog,
      error: null,
    });
  } catch (err) {
    parentPort.postMessage({
      type: 'done',
      stdout: stdoutLines.join('\n'),
      stderr: stderrLines.join('\n'),
      value: undefined,
      callLog: callLog,
      error: (err && err.message) ? String(err.message) : String(err),
    });
  }
})();

function serialise(v) {
  try {
    // Round-trip through JSON so the parent never receives a function /
    // proxy / class instance that crosses worker postMessage boundaries.
    return JSON.parse(JSON.stringify(v === undefined ? null : v));
  } catch (_) {
    return null;
  }
}
