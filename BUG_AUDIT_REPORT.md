# SUDO-AI v4 — Line-by-Line Correctness Bug Audit

_Repository:_ `/root/sudo-ai-v4` (github.com/Matrixx0070/sudo-ai) · _Generated:_ 2026-06-06

## Executive summary

- **180 confirmed bugs** (each independently confirmed by **two** skeptic verifiers that re-read the cited code): **2 critical**, **39 high**, **74 medium**, **65 low**.
- **28 disputed** findings (one verifier confirmed, the other did not — review individually).
- **216 candidates** raised; 8 rejected by both verifiers.

### Coverage

- **1127 of 1,678 files** read in full (63/94 chunks).
- **31 chunks (~551 files) were NOT audited**: the model API returned cyber-safeguard policy blocks on those finder agents (this repo implements offensive/sandbox-escape/injection capability, which tripped the safeguard). See **Appendix B** for the exact unaudited file list. Absence of bugs in those files is **not** established.

### Methodology

Every assigned file was read end-to-end by a finder agent hunting only concrete correctness defects (logic errors, missing `await`/floating promises, null derefs, races/TOCTOU, resource leaks, broken error handling, wrong API usage, parsing/coercion bugs, security-correctness). Style, naming, perf opinions, missing tests, and compiler-caught issues were excluded. Each candidate was then re-checked by **two independent skeptic agents** that reopened the code; only findings **both** marked `real` are listed as confirmed.

---

## 🔴 Critical confirmed bugs

### C1. TOML key=value parser reads the key capture group as the value (wrong regex group)

**`src/core/config/settings-manager.ts:541`** · _parsing/coercion bug_ · confidence 0.97

**What:** In the lightweight fallback parser, the kv regex `/^(?:"([^"]+)"|([a-zA-Z0-9_.-]+))\s*=\s*(.+)$/` puts the value in capture group 3. The code instead reads `kvMatch[2]` (the bare-key capture) as the value: `const rawValue = kvMatch[2].trim();`. For a bare-key line like `maxIterations = 42`, the parsed value becomes the string "maxIterations" instead of 42 (verified: settings parse to {key: key} for every entry). For a quoted-key line like `"agent.name" = "x"`, group 2 is undefined so `kvMatch[2].trim()` throws a TypeError, which loadTomlFile() catches and returns an EMPTY settings file — silently discarding ALL settings in that file. Should be `kvMatch[3]`.

**Failure scenario:** A team checks in settings.toml with `[settings]\nmaxIterations = 42`. On load, getSetting('maxIterations') returns the string "maxIterations" instead of 42, corrupting every consumer. If any key is quoted (e.g. dotted keys `"agent.name" = "x"`), the parser throws, the file is treated as empty, and all that scope's settings (including tool allow/deny security rules) are silently dropped.

**Fix:** Use the correct capture group: `const rawValue = kvMatch[3].trim();` (capture group 3 is the value).

~~~ts
const key = kvMatch[1] ?? kvMatch[2]; // quoted key or bare key
const rawValue = kvMatch[2].trim();
~~~

> **Skeptic (real):** Confirmed by reading lines 538-544 and testing the regex /^(?:"([^"]+)"|([a-zA-Z0-9_.-]+))\s*=\s*(.+)$/ directly. The value is in capture group 3, but line 541 reads `const rawValue = kvMatch[2].trim()` which is the bare-key capture. For `maxIterations = 42`, kvMatch[2]='maxIterations' so the value becomes the string 'maxIterations' (parseTomlValue returns it unchanged via the string fallback at line 681). For a quoted key like `"agent.name" = "x"`, kvMatch[2] is undefined and `.trim()` throws TypeError; parseSettingsToml has no try/catch around the loop, so it propagates to loadTomlFile's catch (lines 459-463) which returns empty settings — silently dropping the whole file, including toolDeny security rules (verified: `patterns = ["destructive:*"]` yields rawValue='patterns', and parseTomlArray('patterns') returns null at line 685, so nothing is pushed). The bug genuinely exists in the fallback parser. Reachability caveat: the fallback runs only when `require` is unavailable (dev/tsx mode); in production builds the esbuild banner (esbuild.config.cjs lines 51-53) injects createRequire and smol-toml is loaded correctly. But dev/tsx is a real run mode (pnpm dev, doctor, cli all use tsx, where I verified `require` is undefined), so the bug does trigger. Should be kvMatch[3].
>
> **Auditor (real):** Line 541 is `const rawValue = kvMatch[2].trim();`. I empirically verified the regex `/^(?:"([^"]+)"|([a-zA-Z0-9_.-]+))\s*=\s*(.+)$/`: for `maxIterations = 42`, group2='maxIterations', group3='42'; for `"agent.name" = "x"`, group1='agent.name', group2=undefined, group3='"x"'. So the value lives in group 3, but the code reads group 2. I reproduced this end-to-end by instantiating SettingsManager against a temp settings.toml under the tsx dev runtime: getSetting('port') returned the string "port" instead of 3000, and getSetting('maxIterations') returned "maxIterations" instead of 42. For a bare-key line every setting parses to {key: key}. For a quoted-key line, kvMatch[2] is undefined so .trim() throws (caught by loadTomlFile, which then returns empty settings, dropping all of that file's settings). The fallback parser is genuinely reachable: it is the executed path whenever require('smol-toml') is unavailable, which is exactly the case in the `pnpm dev`/`dev:server` (tsx ESM) runtime, a first-class supported entry point. Fix is kvMatch[3]. Confirmed bug.

---
### C2. SSE connect() never resolves — blocks the entire SSE MCP handshake forever

**`src/core/tools/mcp-sse-transport.ts:174`** · _logic error / hang_ · confidence 0.88

**What:** connect() awaits _connectWithRetry() -> _doConnect() -> _readStream(response.body). _readStream contains a `while (true)` loop that runs for the whole lifetime of the SSE stream (an SSE stream stays open indefinitely). _doConnect only resolves after _readStream returns, which only happens when the stream ENDS. Therefore connect() does not resolve while the connection is alive. Contrast with the WebSocket transport, which correctly resolves the promise inside the 'open' handler. The SSE path is missing this resolve-on-open behavior.

**Failure scenario:** In mcp-adapter._connectSse() (mcp-adapter.ts:311) the code does `await this.sseTransport.connect();` and then on line 314 `await this._rpc('initialize', ...)`. Because connect() never resolves while the stream is open, control never reaches the initialize handshake. The MCP SSE connection hangs forever: no initialize is sent, listTools()/callTool() can never run, and the awaiting caller (e.g. handleConnectServer) blocks until its own 30s/15s RPC timeout or indefinitely.

**Fix:** Resolve connect() when the SSE stream is established (after `this.emit('open')` in _doConnect) and run _readStream(response.body) as a detached background task (e.g. `void this._readStream(response.body).catch(...)`) instead of awaiting it inside the connect path. Mirror the WSTransport pattern of resolving on 'open'.

~~~ts
      this.state = 'connected';
      this.emit('open');
      log.info({ url: this.config.url }, 'SSE connection established');

      // Start reading the stream
      await this._readStream(response.body);
~~~

> **Skeptic (real):** Confirmed. _doConnect (lines 138-179) sets state='connected', emits 'open' (line 170), then on line 174 does `await this._readStream(response.body)`. _readStream (line 181) runs `while (true)` (line 189) that only breaks when the stream ends (done, line 191). For a live SSE stream this never returns. Therefore _doConnect never returns, _connectWithRetry (line 114 `await this._doConnect()`) never returns, and connect() (line 101) never resolves. In mcp-adapter._connectSse, `await this.sseTransport.connect()` (line 311) blocks forever and the `initialize` handshake on line 314 is never reached. Contrast: the WS transport resolves the promise inside the 'open' handler (mcp-ws-transport line 179) and does NOT await the read loop. The SSE path is missing resolve-on-open. Real critical hang.
>
> **Auditor (real):** connect() (line 94) does `await this._connectWithRetry()`; _connectWithRetry (line 104) does `await this._doConnect()`; _doConnect (line 138) after emitting 'open' (line 170) does `await this._readStream(response.body)` (line 174). _readStream (line 181) runs `while (true) { reader.read() }` which only breaks when the stream ENDS (done=true). A live SSE stream stays open indefinitely, so reader.read() blocks forever and _readStream never returns. Therefore _doConnect's awaited call never completes, _connectWithRetry never returns, and connect() never resolves while the connection is alive. Contrast the WS transport: _doConnect returns a Promise that resolves inside the 'open' handler (mcp-ws-transport.ts:179). In mcp-adapter._connectSse (line 311) `await this.sseTransport.connect()` blocks, so line 314 `_rpc('initialize')` is never reached. Confirmed real and matches the WS-vs-SSE asymmetry described.

---

## 🟠 High confirmed bugs

### H1. JSON.stringify replacer array strips all nested arg fields, collapsing distinct tool calls to one signature

**`src/core/agent/doom-loop.ts:247`** · _wrong API/library usage_ · confidence 0.92

**What:** _hashArgs computes JSON.stringify(args, Object.keys(args).sort()). The second argument is a JSON replacer ALLOWLIST, not a sort/space argument. An array replacer only includes the listed property NAMES at EVERY level of the object. Since only the top-level keys are listed, every nested object is serialized as '{}'. As verified at runtime, {request:{url:'a',method:'GET'}} and {request:{url:'b',method:'POST'}} both serialize to {"request":{}} and hash to the identical signature.

**Failure scenario:** An agent makes a series of legitimately DIFFERENT tool calls whose arguments differ only in nested-object fields (e.g. an http tool called with {request:{url,...}} for 8 different URLs, or any tool with structured nested params). All 8 produce the same argsSignature, so cycleMap counts them as one repeated cycle. At count>=DOOM_LOOP_RO_THRESHOLD (8) recordCall returns action:'abort' and force-terminates the agent loop even though it was making real progress. Conversely, real loops whose args differ only at top level can still be distinguished, but the false-abort on nested-arg tools is the dangerous behavior.

**Fix:** Serialize with stable nesting instead of a replacer allowlist, e.g. use a recursive stable-stringify, or JSON.stringify(sortKeysDeep(args)). At minimum do NOT pass Object.keys(args).sort() as the replacer; pass undefined and sort keys via a custom canonicalizer.

~~~ts
const json = JSON.stringify(args, Object.keys(args).sort());
~~~

> **Skeptic (real):** Confirmed at runtime: JSON.stringify(args, Object.keys(args).sort()) treats the array as a replacer ALLOWLIST applied at every nesting level. {request:{url:'a',method:'GET'}} and {request:{url:'b',method:'POST'}} both serialize to {"request":{}} and thus hash identically. _hashArgs (line 245-254) feeds argsSignature into the cycleMap key (line 139). recordCall is wired into the live agent loop at loop.ts:1926; on count>=DOOM_LOOP_RO_THRESHOLD (8) across distinct turns it returns action:'abort' and loop.ts:1933-1942 sets guardAborted=true and breaks the loop. Tool calls differing only in nested-object fields (e.g. http {request:{url,...}}) across 8 turns collapse to one signature and trigger a false abort. Genuine bug; no guard prevents it.
>
> **Auditor (real):** Confirmed at runtime: JSON.stringify({request:{url:'a',method:'GET'}}, Object.keys(args).sort()) yields '{"request":{}}', identical for {request:{url:'b',method:'POST'}}. The second arg to JSON.stringify is a replacer ALLOWLIST applied at every nesting level; since only top-level keys are listed, all nested objects serialize to '{}'. _hashArgs therefore hashes distinct nested-arg calls to the same signature. Traced the integration in loop.ts: recordCall is called with state.iteration (line 1926), and state.iteration increments every inner-loop iteration (line 1494). The cross-turn count only increments when existing.lastTurn !== turnNumber, so 8 sequential calls to e.g. an http tool with different nested {request:{...}} args across 8 model turns collapse to one signature, count reaches DOOM_LOOP_RO_THRESHOLD (8), and recordCall returns action:'abort', force-terminating a legitimately-progressing agent. Bug genuinely manifests.

---
### H2. Inverted/dead condition makes Slack Socket Mode reconnect even after stop()

**`src/core/channels/slack-receive.ts:90`** · _logic-error_ · confidence 0.92

**What:** In the WS 'close' handler, line 89 sets this._active = false, then line 90 checks `if (this._active !== false) return;`. After the preceding assignment this._active is always false, so the guard never returns early and the code always schedules onReconnect(). The intent (per the comment 'closed by stop()') was to NOT reconnect when the close was triggered by disconnect()/stop(). disconnect() also sets _active=false and nulls _ws, but the close handler still fires onReconnect() (which is `() => void this.start()` from slack.ts). The _active flag is never used to distinguish a deliberate stop from an unexpected drop.

**Failure scenario:** Operator calls SlackAdapter.stop() → SlackSocketMode.disconnect() closes the WS. The 'close' event fires, the broken guard does not return, and after 5s onReconnect()->start() reopens the Socket Mode connection. The 'stopped' Slack adapter silently resurrects itself, keeping a live WebSocket and processing inbound events after shutdown.

**Fix:** Capture the pre-close state into a local before mutating: `const wasActive = this._active; this._active = false; if (!wasActive) return; setTimeout(() => this.onReconnect(), 5_000);` so a deliberate disconnect (which already set _active=false) skips reconnect.

~~~ts
ws.on('close', () => {
  log.warn('Slack Socket Mode WS closed');
  this._active = false;
  if (this._active !== false) return; // closed by stop()
  setTimeout(() => this.onReconnect(), 5_000);
});
~~~

> **Skeptic (real):** Confirmed at lines 88-91: `this._active = false;` then `if (this._active !== false) return;`. After the assignment, `_active` is always false, so `_active !== false` is always false and the early return is dead code; `setTimeout(() => this.onReconnect(), 5_000)` always runs. slack.ts:129 constructs the SocketMode with `onReconnect = () => void this.start()`, and slack.ts:145 `stop()` calls `_socketMode.disconnect()` which fires the WS 'close' event. So a deliberate stop schedules a reconnect that re-opens the socket 5s later. The `_active` flag was meant to distinguish stop vs drop but the comparison is broken. Note start() guards on `_isConnected`, but stop() sets `_isConnected=false`, so that guard does not prevent the resurrection. Real bug.
>
> **Auditor (real):** Confirmed in the code: line 89 `this._active = false;` then line 90 `if (this._active !== false) return;`. After the assignment _active is always false, so the guard evaluates `false !== false` = false and never returns early — setTimeout(onReconnect, 5000) always runs. The intent (per the comment 'closed by stop()') was to skip reconnect on deliberate close. disconnect() (called by SlackAdapter.stop() at slack.ts:145) sets _active=false and closes the WS; the close handler then fires and, with the dead guard, still schedules onReconnect = `() => void this.start()` (slack.ts:129). start() only early-returns when _isConnected is true, but stop() sets _isConnected=false (slack.ts:150), so start() proceeds and reopens Socket Mode. The stopped adapter silently resurrects itself. The _active flag is never actually used to distinguish stop from drop. Real bug; suggested fix (capture pre-close state) is correct.

---
### H3. GIF two-pass: -ss/-t inserted into wrong argv positions, producing invalid ffmpeg command

**`src/core/superpowers/ffmpeg-tools.ts:177`** · _wrong API/library usage_ · confidence 0.92

**What:** In the GIF second pass, options.startTime is inserted with pass2.splice(1, 0, '-ss', startTime). pass2 starts as ['-i', input, '-i', palette, '-lavfi', filter, output], so inserting at index 1 places '-ss' BETWEEN '-i' and the input filename, yielding 'ffmpeg -i -ss <time> input ...'. ffmpeg then treats '-ss' as the input filename. The duration branch is equally broken: pass2.indexOf('-i', 1) finds the SECOND '-i' (the palette input), so splice inserts '-t <dur>' right before the palette path, producing 'ffmpeg ... -i -t <dur> palette ...' where '-t' becomes the second input filename.

**Failure scenario:** Calling super.ffmpeg operation='gif' with options.startTime and/or options.duration set causes the second ffmpeg pass to fail (invalid input / option ordering). GIF creation with any trim window never succeeds.

**Fix:** Build pass2 with -ss/-t placed immediately before the first '-i input', e.g. const pass2 = ['-i', input]; if(startTime) pass2.unshift('-ss', startTime) is also wrong; instead construct as const pre = []; if(startTime) pre.push('-ss', startTime); if(duration) pre.push('-t', duration); const pass2 = [...pre, '-i', input, '-i', palette, '-lavfi', filter, output];

~~~ts
const pass2 = ['-i', input, '-i', palette, '-lavfi', `fps=...`, output];
if (options.startTime) pass2.splice(1, 0, '-ss', options.startTime);
if (options.duration) pass2.splice(pass2.indexOf('-i', 1) + 1, 0, '-t', options.duration);
~~~

> **Skeptic (real):** Confirmed at lines 176-178. pass2 = ['-i', input, '-i', palette, '-lavfi', filter, output]. splice(1,0,'-ss',startTime) inserts at index 1, yielding ['-i','-ss',startTime,input,...] so ffmpeg sees '-i -ss' and treats '-ss' as the input filename. Correct placement requires -ss BEFORE the first -i (cf. buildArgs first pass at lines 97-99 which correctly does ['-i',input] then pushes -ss/-t for palettegen — but the input-side -ss/-t there is also placed AFTER -i; regardless, in pass2 inserting at index 1 is clearly wrong). For duration, indexOf('-i',1) finds the SECOND '-i' (palette at index 2, or index 4 if startTime already spliced), so '-t dur' is inserted right before the palette path, making '-t'/palette the broken second input. Any gif call with startTime or duration fails.
>
> **Auditor (real):** pass2 = ['-i'(0), input(1), '-i'(2), palette(3), '-lavfi'(4), filter(5), output(6)]. splice(1,0,'-ss',startTime) inserts BEFORE the input filename, yielding ['-i','-ss','<time>','input',...], so ffmpeg consumes '-ss' as the first input's filename. For duration: indexOf('-i',1) skips index 0 and finds the SECOND '-i' (palette's, index 2), so splice at 3 inserts '-t <dur>' immediately before the palette path, making '-t' the palette input's filename. Both branches corrupt argv ordering; any gif call with startTime or duration set produces an invalid second-pass command that ffmpeg will reject. Confirmed real.

---
### H4. QuizVideo composition duration omits difficulty-badge frames, clipping the Outro

**`src/remotion/quiz/QuizVideo.tsx:244`** · _logic-error_ · confidence 0.92

**What:** calcDuration() (lines 93-95) computes durationInFrames as INTRO + questions.length*PER_QUESTION + OUTRO and this value is used to register the Composition (line 256/263). But the QuizVideo render advances `cursor` by FRAMES.DIFFICULTY_BADGE (60) at every difficulty transition (lines 222-224) and places the Outro Sequence at `from={cursor}` (line 243). Because calcDuration never adds the badge frames, the actual content extends past the registered durationInFrames. For SAMPLE_QUIZ_CONFIG (5 questions, 3 difficulty transitions) cursor reaches 1270 while durationInFrames is 1090, so the final 180 frames — the entire Outro 'Final Score' screen — fall outside the composition and are never rendered.

**Failure scenario:** Rendering the default QuizVideo composition (or any config whose questions span more than one difficulty band) produces a video whose registered length (1090 frames) is shorter than its content (1270 frames). The Outro Sequence starts at frame 1270, after the video has already ended, so the Final Score / Subscribe screen is silently dropped from every rendered quiz video.

**Fix:** Make calcDuration account for the badge gaps using the same transition logic as the render (count difficulty transitions and add DIFFICULTY_BADGE per transition), or compute the final cursor once and use it both for layout and for durationInFrames. E.g. count transitions: const transitions = questions.filter((_,i)=> i>0 && getDifficultyAtIndex(i-1,n)!==getDifficultyAtIndex(i,n)).length; duration = INTRO + n*PER_QUESTION + transitions*DIFFICULTY_BADGE + OUTRO.

~~~ts
function calcDuration(questions: QuizQuestion[]): number {
  return FRAMES.INTRO + questions.length * FRAMES.PER_QUESTION + FRAMES.OUTRO;
}
~~~

> **Skeptic (real):** Confirmed by tracing the code. calcDuration (lines 93-95) = INTRO(90) + 5*PER_QUESTION(850) + OUTRO(150) = 1090, and this is the registered durationInFrames (line 256/262). But QuizVideo (lines 219-231) adds FRAMES.DIFFICULTY_BADGE(60) at every difficulty transition. For SAMPLE_QUIZ_CONFIG, getDifficultyAtIndex(i,5) yields easy,easy,medium,hard,impossible → 3 transitions (i=2,3,4), adding 180 frames. The cursor reaches 1120 when the Outro Sequence is placed at from={cursor}=1120 (line 243), running to 1270. Since registered duration is 1090 and the Outro starts at 1120 (>1090), the entire Outro 'Final Score' screen falls outside the composition and is never rendered. The finding's exact figure 'cursor reaches 1270' is the content END not the Outro start (1120), a minor wording imprecision, but the core claim is correct and the failure is plausible for any config spanning multiple difficulty bands. calcDuration must add transitions*DIFFICULTY_BADGE.
>
> **Auditor (real):** Traced cursor for SAMPLE_QUIZ_CONFIG (5 questions). getDifficultyAtIndex yields easy,easy,medium,hard,impossible at i=0..4, producing 3 difficulty transitions (i=2,3,4), each adding FRAMES.DIFFICULTY_BADGE=60 → +180 frames. cursor: 90→260→430, then +60→490→660, +60→720→890, +60→950→1120. So the last QuestionBlock spans 950-1120 and the Outro Sequence is placed at from=1120 with duration 150 (ends 1270). calcDuration (lines 93-95) = INTRO(90)+5*170(850)+OUTRO(150)=1090, which omits the 180 badge frames. The Composition registers durationInFrames=1090 (line 256/262). Since 1120 > 1090, the entire Outro 'Final Score' Sequence falls outside the composition window and is never rendered, and the last question is also clipped by 30 frames. The finding's exact numbers are slightly off (it uses OUTRO=180 and cursor=1270 for the Outro start, while OUTRO is 150 and the Outro starts at frame 1120 with content ending at 1270), but the core defect — registered duration shorter than laid-out content, dropping the Outro — is confirmed.

---
### H5. Interactive setup model selector is non-functional — model can never be changed

**`src/cli/commands/setup.tsx:491`** · _logic-error_ · confidence 0.9

**What:** In the 'xai' phase, a SetupSelect list of AVAILABLE_MODELS is rendered with selectedIndex={selIndex}, and the step text says 'Model (use arrows + ENTER)'. However, the useInput handler for the 'xai' phase (lines 367-373) only handles key.return (commits xaiKey and advances to 'cross'). Arrow keys are only handled for phases in ['cross','profiles','soul','service'] (line 374). So selIndex never changes while on the model screen, and even on ENTER the code never reads AVAILABLE_MODELS[selIndex] nor calls commitAnswer({ defaultModel: ... }). The selected model is therefore always whatever was prefilled (currentModel / props.currentModel), regardless of what the user appears to choose.

**Failure scenario:** User runs `sudo-ai setup`, reaches Step 2/7, presses Down/Up to pick e.g. 'xai/grok-4-0709', presses ENTER. The arrow keys do nothing (no handler) and ENTER advances without recording the choice. The generated sudo-ai.json5/toml are written with the default 'xai/grok-4-1-fast-non-reasoning' (or prior config value), silently ignoring the user's model selection.

**Fix:** In the useInput 'xai' branch, handle key.upArrow/key.downArrow to move selIndex within AVAILABLE_MODELS bounds, and on key.return do commitAnswer({ xaiKey: inputVal.trim(), defaultModel: AVAILABLE_MODELS[selIndex].value }) before go('cross').

~~~ts
if (phase === 'xai') {
  if (key.return) {
    commitAnswer({ xaiKey: inputVal.trim() });
    go('cross');
  }
  return;
}
~~~

> **Skeptic (real):** Confirmed by reading the useInput handler (lines 367-373) and render (lines 479-499). The 'xai' phase branch only handles key.return, which calls commitAnswer({ xaiKey: inputVal.trim() }) and go('cross') — it never reads AVAILABLE_MODELS[selIndex] nor sets defaultModel. Arrow-key handling exists only for ['cross','profiles','soul','service'] at line 374, and the 'xai' branch returns before reaching it, so selIndex stays 0 on the model screen. The UI text at lines 489/496 explicitly promises 'use arrows + ENTER' / 'arrows change selection', but neither works. defaultModel is initialized to props.currentModel (line 329) and is never overwritten, so the model written to sudo-ai.json5 (line 101 'id: ${answers.defaultModel}') and toml (line 151) is always the prefilled value regardless of the user's apparent selection. Genuine functional bug.
>
> **Auditor (real):** Confirmed by reading the full SetupWizard component. SetupSelect (setup/components/SetupSelect.tsx) is purely presentational — it has no useInput and relies entirely on the parent's keyboard routing. The parent useInput at lines 354-399 handles the 'xai' phase only via the branch at lines 367-372, which on key.return calls commitAnswer({ xaiKey: inputVal.trim() }) and go('cross'), with no arrow-key handling. Arrow keys are handled only for phases in ['cross','profiles','soul','service'] (line 374), which excludes 'xai', so selIndex stays 0 while the model list is shown. A grep of the entire file shows defaultModel is only ever set in initial state (line 329: props.currentModel); there is NO commitAnswer({ defaultModel: ... }) anywhere. Therefore arrows do nothing, ENTER advances without recording the choice, and buildSetupJson5/buildSetupToml (lines 101, 151) always emit answers.defaultModel = props.currentModel regardless of the user's apparent selection. Bug manifests exactly as described.

---
### H6. _hashArgs uses JSON.stringify replacer-array which discards nested object values

**`src/core/agent/loop-guard.ts:233`** · _wrong API/library usage_ · confidence 0.9

**What:** _hashArgs calls JSON.stringify(args, Object.keys(args).sort()). The second argument to JSON.stringify is a REPLACER, not a key sorter. When it's an array of property names, JSON.stringify only includes those top-level property names AND, critically, strips ALL keys of nested objects (nested objects serialize as {}). It also reorders keys to the array order rather than sorting object content recursively. So two tool calls whose only difference is inside nested argument objects (e.g. {path:'a', opts:{x:1}} vs {path:'a', opts:{x:99}}) produce identical hashes.

**Failure scenario:** Agent makes 10+ legitimately-different tool calls in one turn that share the same top-level arg keys but differ only inside nested arg objects (very common for tools that take a nested config/params object). The repeat detector and ping-pong detector treat them as identical, so recordCall returns 'warn' at 10 and 'abort' at 20, falsely killing a valid working loop with a spurious '[LoopGuard] Loop detected' break and a misleading user-facing message.

**Fix:** Hash the full structure with a deterministic recursive serializer, e.g. contentHash(JSON.stringify(sortDeep(args))) where sortDeep recursively sorts keys, or use a stable-stringify library. Do NOT pass Object.keys(args).sort() as the second JSON.stringify argument.

~~~ts
private _hashArgs(args: Record<string, unknown>): string {
  try {
    return contentHash(JSON.stringify(args, Object.keys(args).sort()));
  } catch {
    return 'unhashable';
  }
}
~~~

> **Skeptic (real):** Confirmed by reading _hashArgs (loop-guard.ts:231-237) and empirically. JSON.stringify(args, Object.keys(args).sort()) passes the second argument as a REPLACER allowlist, not a sort comparator. When it is a string array, the SDK applies it recursively to ALL nested objects, stripping any keys not in the top-level array. Ran node: {path:'a',opts:{x:1}} and {path:'a',opts:{x:99}} both serialize to {"opts":{},"path":"a"} -> identical contentHash. _checkRepeat (line 149) keys repeatCounts on toolName:argsHash and aborts at 20 / warns at 10 identical hashes (_checkPingPong also compares argsHash). So 10-20 legitimately-different calls of a nested-config tool collide and falsely trip the loop guard. Real bug; impact gated on real-world call patterns but the defect is genuine.
>
> **Auditor (real):** Confirmed empirically. `JSON.stringify(args, Object.keys(args).sort())` treats the array as a REPLACER, not a sorter. Only top-level keys named in the array are kept; any nested object whose keys are not in that top-level list serializes as `{}`. Tested: `{path:'a',opts:{x:1}}` and `{path:'a',opts:{x:99}}` both serialize to `{"opts":{},"path":"a"}` (equal). contentHash (shared/utils.ts:33) simply SHA-256s that string, so both produce identical hashes. This argsHash feeds `_checkRepeat` (key=`tool:argsHash`, warn at REPEAT_WARN_THRESHOLD=10, abort at 20) and `_checkPingPong` (compares argsHash). Tool calls that differ only inside nested arg objects (very common for tools taking a nested config/params object) are treated as identical, so a legitimate working loop can be falsely warned/aborted. The bug manifests as described.

---
### H7. buildTokenUsage reads non-existent promptTokens/completionTokens from AI SDK v6 usage object

**`src/core/brain/costs.ts:207`** · _wrong API/library usage_ · confidence 0.9

**What:** buildTokenUsage() destructures raw?.promptTokens and raw?.completionTokens, but it is called in brain.ts (lines 789 and 898) with result.usage from the Vercel AI SDK v6 (ai@6.0.138). The SDK's LanguageModelUsage type exposes ONLY inputTokens, outputTokens, and totalTokens (verified in node_modules/ai/dist/index.d.ts lines 267-309). There is no promptTokens/completionTokens field, and no normalization happens between result.usage and buildTokenUsage. As a result promptTokens and completionTokens always default to 0, totalTokens falls back to 0+0=0, and estimateCost(modelId, 0, 0) always returns 0.

**Failure scenario:** Every non-streaming and streaming LLM call through Brain records 0 prompt tokens, 0 completion tokens, 0 total tokens, and $0.00 estimated cost. All downstream cost tracking, budgeting (cost-reporter.ts thresholds, checkBudget), tokens-per-dollar metrics, energy estimates, and the /cost report are silently wrong (always zero), so budget alerts and cost transparency are completely non-functional even when real spend occurs.

**Fix:** Accept the SDK shape: change buildTokenUsage to read both naming conventions, e.g. const promptTokens = raw?.promptTokens ?? raw?.inputTokens ?? 0; const completionTokens = raw?.completionTokens ?? raw?.outputTokens ?? 0; and widen the parameter type to include inputTokens?/outputTokens?. Alternatively map result.usage at the call sites in brain.ts.

~~~ts
raw?: { promptTokens?: number; completionTokens?: number; totalTokens?: number },
) : TokenUsage {
  const promptTokens = raw?.promptTokens ?? 0;
  const completionTokens = raw?.completionTokens ?? 0;
  const totalTokens = raw?.totalTokens ?? promptTokens + completionTokens;
~~~

> **Skeptic (real):** Verified ai@6.0.138 installed (node_modules/ai/package.json). LanguageModelUsage (node_modules/ai/dist/index.d.ts lines 267-325) exposes ONLY inputTokens, outputTokens, totalTokens, inputTokenDetails, outputTokenDetails, deprecated reasoningTokens/cachedInputTokens, and raw. There is NO promptTokens or completionTokens field. GenerateTextResult.usage (line 806) and the awaited StreamTextResult.usage (line 2476) are both LanguageModelUsage. brain.ts imports generateText/streamText directly from 'ai' (line 8) with no usage normalization, and calls buildTokenUsage(modelId, result.usage) at line 898 and buildTokenUsage(modelId, finalUsage=await result.usage) at line 789. In buildTokenUsage, raw?.promptTokens and raw?.completionTokens are always undefined -> default to 0, and estimateCost(modelId, 0, 0) returns 0. So promptTokens, completionTokens, and estimatedCost are always 0 for every LLM call, breaking all cost tracking/budgeting. Minor correction to the finding: totalTokens does NOT fall back to 0+0 because raw.totalTokens DOES exist on the SDK type and would be read correctly; but the core bug (zero prompt/completion tokens and zero cost) is genuine and the failure scenario holds.
>
> **Auditor (real):** Confirmed installed ai@6.0.138. buildTokenUsage (costs.ts:205-218) destructures raw?.promptTokens and raw?.completionTokens. It is called at brain.ts:789 (await result.usage from streamText) and brain.ts:898 (result.usage from generateText), both of type LanguageModelUsage. Verified in node_modules/ai/dist/index.d.ts that LanguageModelUsage exposes ONLY inputTokens, outputTokens, totalTokens (plus token-detail sub-objects) — there is NO promptTokens or completionTokens field. No normalization happens at either call site; raw usage is passed directly. Therefore promptTokens and completionTokens always resolve to undefined -> default 0, and estimateCost(modelId, 0, 0) (costs.ts:188-196) always returns 0, so estimatedCost is always $0.00 and the stored prompt/completion token counts are always 0. Cost tracking/budgeting is silently broken. One nuance vs the finding text: totalTokens is populated from raw?.totalTokens (which the SDK DOES provide), so the stored totalTokens may be correct/non-zero rather than 0+0=0; but the substantive bug (always-zero cost and zero per-token breakdown) is real.

---
### H8. getStateHistory time-window filter is broken by timestamp-format mismatch

**`src/core/consciousness/embodied-state/store.ts:71`** · _parsing/coercion bug_ · confidence 0.9

**What:** The history query filters with `WHERE sampled_at >= datetime('now', @offset)`. The `sampled_at` values are stored as ISO-8601 strings containing a 'T' separator and trailing 'Z' (both the app insert at store.ts:135 using `state.sampledAt` = `new Date().toISOString()`, and the column default `strftime('%Y-%m-%dT%H:%M:%fZ','now')` in consciousness-db.ts:51). However SQLite's `datetime('now', '-N hours')` returns a SPACE-separated string like `2026-06-06 09:00:00` (no 'T', no 'Z', no fractional seconds). The comparison is a lexicographic string compare. Character 'T' (code 84) is greater than ' ' (code 32), so any row from the same calendar date compares as >= the cutoff regardless of the actual time of day.

**Failure scenario:** With `now` = noon and `hours` = 3, the cutoff is `datetime('now','-3 hours')` = `2026-06-06 09:00:00`. A row sampled at `2026-06-06T01:00:00.000Z` (1am, 11 hours old) compares `'2026-06-06T01...' >= '2026-06-06 09...'` → TRUE because 'T'(84) > ' '(32). The 1am row is wrongly returned despite being far outside the 3-hour window. getStateHistory therefore returns rows from the entire current day (and any later day) instead of the requested rolling window, corrupting any downstream analysis that relies on the window.

**Fix:** Compute the cutoff in JS the same way as the stored format, e.g. `const since = new Date(Date.now() - hours*3600000).toISOString(); ... WHERE sampled_at >= ?` bound with `since`; or normalize stored timestamps and the comparison to the same format. Mirror the correct approach already used in emotional-memory/state.ts getEmotionalHistory which binds an ISO string on both sides.

~~~ts
WHERE  sampled_at >= datetime('now', @offset)
ORDER  BY sampled_at ASC
~~~

> **Skeptic (real):** Confirmed: the selectHistory query (store.ts:71) compares `sampled_at >= datetime('now', @offset)`. The sampled_at column stores ISO-8601 with 'T' and 'Z' (consciousness-db.ts:51 default `strftime('%Y-%m-%dT%H:%M:%fZ','now')`, and app inserts state.sampledAt = new Date().toISOString() per index.ts:169/mapper.ts:85). SQLite's datetime('now','-N hours') returns space-separated 'YYYY-MM-DD HH:MM:SS' with no 'T'/'Z'/fractional seconds. This is a lexicographic TEXT comparison: at index 10, stored 'T'(84) > cutoff ' '(32), so every row from the same calendar date (or later) compares >= cutoff regardless of actual time, returning rows far outside the requested window. The correct pattern is right next door in emotional-memory/state.ts:239-249 which binds a JS-computed ISO string (`new Date(Date.now()-hours*3.6e6).toISOString()`) on both sides via a parameter. The bug genuinely exists with no guard preventing it.
>
> **Auditor (real):** Confirmed. Stored sampled_at is ISO-8601 with 'T' separator and 'Z': the insert (store.ts:135) binds state.sampledAt (set via new Date().toISOString() per the finding) and the column default in consciousness-db.ts:51 is strftime('%Y-%m-%dT%H:%M:%fZ','now') (verified). The selectHistory query (store.ts:71) compares WHERE sampled_at >= datetime('now', @offset). SQLite's datetime() returns a space-separated 'YYYY-MM-DD HH:MM:SS' string (no 'T', no 'Z', no fractional seconds). The comparison is a lexicographic TEXT compare. For cutoff '2026-06-06 09:00:00' vs row '2026-06-06T01:00:00.000Z', the strings match through the date prefix, then at index 10 the cutoff has ' '(32) and the row has 'T'(84); since 84>32 the row sorts as >= cutoff and is wrongly returned even though it is far outside the window. So the window degenerates to 'everything from the current date onward', corrupting downstream window analysis. The sibling getEmotionalHistory (emotional-memory/state.ts:239,246) demonstrates the correct fix: compute the cutoff in JS via new Date(Date.now()-hours*3_600_000).toISOString() and bind it, comparing two same-format ISO strings. Genuine parsing/coercion bug.

---
### H9. GoalStopDetector.detect() called with malformed GoalProgress — always throws (gate is inert)

**`src/core/agent/loop.ts:2405`** · _null/undefined dereference; wrong API usage_ · confidence 0.88

**What:** detect() is invoked as detect({ goal: _userGoal }), but its parameter type is GoalProgress, whose required field customEvidence: string[] (and totalSteps, errorCount, etc.) are absent. detect() does `for (const ce of progress.customEvidence)` (goal-stop-detector.ts:153). Since customEvidence is undefined, this throws TypeError: undefined is not iterable. The throw is swallowed by the surrounding try/catch (loop.ts:2413), so the goal-completion gate never functions — it can NEVER inject the 'goal incomplete' continue message it was built to inject.

**Failure scenario:** On every text-response (finishReason='stop') the loop reaches the GoalStopDetector block. detect({goal}) throws TypeError on `for...of undefined`, the catch logs 'detect threw — continuing to exit', and the loop always exits. The entire premature-stop-prevention feature is dead code; the agent never gets nudged to keep working on incomplete goals. (Separately, if customEvidence were defaulted to [], the all-undefined progress would score ~0.167 → verdict 'incomplete' → `continue` re-enters the loop with no state change → spins until maxIterations.)

**Fix:** Build a real GoalProgress object from loop state (completed/total steps, errorCount, filesModified, testsRun, userMessageAddressed, customEvidence: []) before calling detect(); or make detect() defensively default `progress.customEvidence ?? []` and treat missing numeric/boolean fields. At minimum pass customEvidence: [].

~~~ts
const stopResult = (this._goalStopDetector as unknown as { detect(progress: { goal: string }): { verdict: string; reason?: string } }).detect({ goal: _userGoal });
if (stopResult.verdict === 'incomplete') {
~~~

> **Skeptic (real):** Confirmed. loop.ts:2405 calls detect({ goal: _userGoal }) (a TS cast that lies about the runtime shape). The real detect(progress: GoalProgress) in autonomy/goal-stop-detector.ts computes signals 1-6 (lines 92-150, which tolerate undefined via comparisons) then executes `for (const ce of progress.customEvidence)` at line 153. customEvidence is undefined here -> verified `for...of undefined` throws TypeError. The throw is swallowed by the catch at loop.ts:2413 ('detect threw — continuing to exit'), so the verdict==='incomplete' continue at line 2410 can NEVER fire. The premature-stop-prevention gate is dead code on every stop-finish.
>
> **Auditor (real):** detect() is invoked as `detect({ goal: _userGoal })` but its real signature is detect(progress: GoalProgress). Signals 1-6 (goal-stop-detector.ts:93-150) only do property reads/comparisons on undefined values (e.g. `undefined > 0` -> false), so no throw there. But line 153 does `for (const ce of progress.customEvidence)` and customEvidence is undefined; verified that `for...of undefined` throws TypeError ('not iterable'). The throw propagates out of detect() and is swallowed by the try/catch at loop.ts:2413, which logs 'detect threw — continuing to exit' and falls through to break. The verdict==='incomplete' branch (line 2406) can therefore never execute, so the premature-stop-prevention continue-injection is dead code on every text response. Bug manifests as described.

---
### H10. Independent tool results keyed by tool NAME instead of call ID, breaking the documented result map contract and dropping duplicate-tool results

**`src/core/tools/tool-parallelism.ts:179`** · _logic-error_ · confidence 0.86

**What:** executeParallel returns a Map<string, ToolCallResult> documented (line 31, 38) as 'Results keyed by call ID'. For dependent calls the map is keyed by call.id (line 186), but for independent calls it is keyed by `r.name ?? r.toolCallId` (the tool name). Since executeCall always sets `name`, independent results are ALWAYS keyed by tool name, never call ID. Any consumer that looks up results by the LLM-assigned tool_call_id (the normal way to feed tool outputs back to the model) will not find independent results, and if the LLM emits two independent calls to the same tool name, the second overwrites the first.

**Failure scenario:** LLM returns two independent calls: id='call_1' name='Read' and id='call_2' name='Read'. executeParallel runs both, but `results.set(r.name, r)` stores only one entry under key 'Read' — one result is silently lost. The agent loop, which matches results by toolCallId ('call_1'/'call_2'), finds neither and sends malformed/empty tool results back to the model, corrupting the conversation.

**Fix:** Key all results by call ID for consistency with the dependent path and the documented contract: `for (const r of independentResults) { results.set(r.toolCallId, r); }`.

~~~ts
const independentResults = await this.executeBatch(group.independent, registry, ctx);
for (const r of independentResults) {
  results.set(r.name ?? r.toolCallId, r);
}
~~~

> **Skeptic (real):** Confirmed by reading executeParallel and executeCall. Line 179: `results.set(r.name ?? r.toolCallId, r)` for independent results. registry.executeCall (registry.ts:455-459) ALWAYS sets `name: call.name`, so the `??` always resolves to the tool name, never the call ID. By contrast the documented contract (interface comments lines 31 and 37-38: 'Results keyed by call ID'), the single-call path (line 168: `results.set(call.id, result)`), and the dependent path (line 187: `results.set(call.id, result)`) all key by call.id. So the independent batch is the lone inconsistent path. If two independent calls share a tool name (e.g. two Read calls call_1 and call_2), the second overwrites the first under key 'Read' and one result is lost; any consumer looking up by tool_call_id finds neither. The existing test (tools/tool-parallelism.test.ts:110-128) uses 12 distinct tool names so it passes despite the bug and never asserts keys are call IDs. The bug genuinely exists; only executeParallel's lack of in-tree callers (export-only) tempers severity, but the contract violation and data loss are real.
>
> **Auditor (real):** Confirmed. ParallelResult.results is documented as 'keyed by call ID' (lines 31, 37-38), and the dependent path keys by call.id (line 187). But line 179 keys independent results by `r.name ?? r.toolCallId`. registry.executeCall (registry.ts:455-460) ALWAYS sets `name = call.name` (a non-empty string), so the `??` always resolves to the tool NAME, never the call ID. This (a) violates the documented contract — a consumer looking up by the LLM's tool_call_id will not find independent results, and (b) if two independent calls share a tool name (e.g. two 'Read' calls), `results.set('Read', r)` overwrites, silently losing one result. The existing test (lines 110-128) passes only because all 12 calls use distinct tool names, so it does not exercise the collision. The dependent vs independent inconsistency and the data loss on duplicate names are concrete defects.

---
### H11. RSS sampling measures the soak runner itself, not the target server

**`scripts/soak.ts:113`** · _wrong API/library usage_ · confidence 0.85

**What:** getCurrentPid() returns process.pid, which is the PID of the soak-runner Node process, not the SUDO-AI server under test. runSoak() then samples RSS of that PID every 10s and reports it as the soak memory profile. The SoakConfig.pid field (documented as 'optional PID for RSS measurement') is never populated from CLI args nor used. The entire memory-leak detection therefore observes the wrong process and produces meaningless data about the target server.

**Failure scenario:** An operator runs `node scripts/soak.ts --target=http://server:18900` to detect a memory leak in the admin endpoints. The RSS samples printed reflect the soak script's own (essentially flat) memory, so a real leak in the server is never observed. The soak passes/reports clean while the server is actually leaking.

**Fix:** Parse a `--pid=` argument in parseArgs into config.pid and use config.pid for sampleRss (resolve target server PID separately, e.g. from a /healthz endpoint or a passed PID). Do not default to process.pid.

~~~ts
function getCurrentPid(): number | null {
  return process.pid ?? null;
}
...
const pid = getCurrentPid();
...
const rssKb = sampleRss(pid);
~~~

> **Skeptic (real):** getCurrentPid() (line 113) returns process.pid, the soak runner's own PID. runSoak() at line 166 calls getCurrentPid() and the rssInterval at lines 170-177 samples that PID via sampleRss(). parseArgs (lines 31-54) never populates config.pid (the returned object at line 53 omits pid) and there is no --pid arg case in the switch. So the RSS samples printed/reported (rssSamples, summary.rssSamples) reflect the soak script process, not the target server at config.target. For its stated purpose (memory-leak detection of the SUDO-AI server admin endpoints), the memory profile observes the wrong process. Bug confirmed.
>
> **Auditor (real):** Confirmed by reading parseArgs (lines 31-54) and runSoak (lines 153-177). getCurrentPid() at line 112-114 returns process.pid, the PID of the soak-runner Node process. parseArgs never parses a --pid flag and its return at line 53 is {duration, rps, target, token} with no pid field, so config.pid (declared optional at line 28) is always undefined. runSoak at line 166 calls getCurrentPid() and sampleRss(pid) at line 172 samples that PID's RSS, pushing it into rssSamples reported as the soak memory profile. Therefore the memory-leak detection observes the soak script's own (flat) memory, not the target server. A real server leak would go undetected. The described failure scenario manifests exactly as stated.

---
### H12. Sub-agent timeout AbortController is never wired to loop.run(), so timed-out agents are not actually stopped

**`src/core/agent/swarm.ts:222`** · _resource-leak_ · confidence 0.85

**What:** spawn() (and spawnAsync()) create an AbortController and set a setTimeout that calls controller.abort() when the wall-clock timeout elapses. However, AgentLoop.run(sessionId, message, onEvent?, opts?) takes no AbortSignal, and the AgentLoop constructor also accepts no signal (brain, toolRegistry, sessionManager, config, consciousness, security, workspaceInjector, hooks, sandboxManager). The controller.signal is never passed to the loop. Aborting it therefore has no effect on the running loop; it only causes the post-hoc check at line 254 (controller.signal.aborted) to relabel an eventual error as a timeout. The loop keeps running to its own natural completion regardless of the swarm timeout.

**Failure scenario:** A sub-agent task that runs longer than its timeout (e.g. a model that loops or a long tool chain) is NOT killed at the timeout. The timer fires, controller.abort() is called, but loop.run keeps executing — consuming model tokens, holding the PQueue slot, and keeping the ActiveAgent entry — until the loop finishes on its own. The promised 'sub-agent is killed if it exceeds its timeout' contract is violated, leading to runaway execution and resource exhaustion.

**Fix:** Pass controller.signal through to AgentLoop (add an AbortSignal parameter to run()/the constructor) and have the loop check signal.aborted between iterations / tool calls and abort outstanding awaits, OR race loop.run() against a rejecting timeout promise and ensure the loop observes the abort. Merely calling controller.abort() without the loop honoring it does nothing.

~~~ts
const timer = setTimeout(() => {
  controller.abort();
  log.error({ id, timeout }, 'Sub-agent timed out — aborting');
}, timeout);
try {
  const agentResult = await loop.run(sessionId, taskDescription);
~~~

> **Skeptic (real):** Confirmed in loop.ts: run() signature is run(sessionId, message, onEvent?, opts?: { race?: boolean }) (line 905) and the constructor (line 317) accepts brain, toolRegistry, sessionManager, config, consciousness, security, workspaceInjector, hooks, sandboxManager — no AbortSignal parameter anywhere. In swarm.ts the controller created at line 151/311 is stored only on the ActiveAgent record; controller.signal is never passed into AgentLoop. The setTimeout at line 222/380 calls controller.abort() but nothing in the loop observes it. config.timeout is placed in the AgentConfig (line 197-200) but DEFAULT_CONFIG.timeout=0 (loop.ts:205) and grep shows config.timeout is never consumed in the run path; the loop is bounded only by maxIterations (loop.ts:1493, :2434), not wall-clock. So a runaway sub-agent keeps executing, holding the PQueue slot and ActiveAgent entry; the abort merely lets the post-hoc check at line 254 relabel an eventual error as a timeout. Bug genuinely exists.
>
> **Auditor (real):** Verified directly. AgentLoop.run() signature (loop.ts:905) is (sessionId, message, onEvent?, opts?) with no AbortSignal, and the AgentLoop constructor (loop.ts:317) takes no signal parameter either. swarm.ts:219/377 constructs the loop without ever passing controller.signal, and never passes it to run() at lines 229/387. Crucially, grep shows config.timeout is stored in this.config but NEVER read anywhere in loop.ts (the only 'timeout' references are DEFAULT_CONFIG timeout:0 and an unrelated 3s veto gate); the loop only self-bounds via maxIterations. So when setTimeout fires controller.abort(), nothing observes the signal — the loop runs to natural completion, the await at line 229 does not reject early, and the finally block (which clears the timer and deletes the active record) only executes after the loop finishes. The post-hoc check at line 254 (controller.signal.aborted) merely relabels an eventually-thrown error as a timeout. The documented contract 'sub-agent is killed if it exceeds its timeout' (swarm.ts:6-7,134) is violated. Both spawn() and spawnAsync() share this defect.

---
### H13. detectCapabilityGaps compares numeric level against a string Set — always returns empty

**`src/core/consciousness/self-evolution/detector.ts:59`** · _logic-error_ · confidence 0.85

**What:** WEAK_LEVELS is `new Set(['novice','developing'])` (strings), and detectCapabilityGaps filters `WEAK_LEVELS.has(w.level)`. The injected duck interface EvoSelfModelLike declares `getWeaknesses(): {domain; level: string; confidence}[]`, but the real SelfModel.getWeaknesses() (self-model/model.ts:97-105) returns CapabilityAssessment whose `level` is a NUMBER (LEVEL_MAP-mapped 0.1/0.3/0.5/0.7/0.9 — see store.ts rowToCapability and types.ts:222 `level: number`). At runtime `Set<string>.has(0.1)` is always false, so detectCapabilityGaps NEVER surfaces any gap and always returns []. TypeScript does not catch this because the duck-typed interface lies about the field type.

**Failure scenario:** A SelfEvolution constructed with a real SelfModel (the documented intent: detector header says 'surfaces weak domains from the self-model') calls detectCapabilityGaps(). Even with domains assessed as 'novice' (level 0.1) or 'developing' (0.3), the .filter never matches because 0.1 !== 'novice', so the function returns an empty array and the self-evolution layer believes it has no capability gaps.

**Fix:** Either filter on the numeric level (e.g. `w.level < 0.4`) to match novice/developing thresholds from numericLevelToLabel, or convert via numericLevelToLabel(w.level) before checking WEAK_LEVELS. Also fix EvoSelfModelLike.level to `number` so the type mismatch is caught.

~~~ts
const gaps = weaknesses
  .filter((w) => WEAK_LEVELS.has(w.level))
  .map((w) => w.domain);
~~~

> **Skeptic (real):** Confirmed. detector.ts:27 defines WEAK_LEVELS = new Set(['novice','developing']) (Set<string>) and line 60 filters with WEAK_LEVELS.has(w.level). The real SelfModel.getWeaknesses() (model.ts:97-105) returns CapabilityAssessment[] whose level is a NUMBER: types.ts:222 declares `level: number`, and store.ts:48-53 rowToCapability sets `level: LEVEL_MAP[row.level] ?? 0.3` where LEVEL_MAP (store.ts:36-42) maps novice→0.1, developing→0.3, etc. So Set<string>.has(0.1) is always false → detectCapabilityGaps would always return [] for any real self-model data. The duck interface EvoSelfModelLike (types.ts:105) lies, declaring level:string, hiding the mismatch from the type checker. Corroboration that real SelfModel carries numeric levels: temporal-self/timeline.ts:89 correctly does numericToLabel(cap.level) on the same getWeaknesses() output. Note the only current production caller (cli.ts:898) injects a stub `{getWeaknesses: () => []}` so the bug is presently latent (empty in == empty out), and no test exercises it. But the function is documented (detector.ts:7,51-54) to surface weak domains from the self-model, and the comparison logic is genuinely wrong for the data shape it is meant to process — it can never match a real weakness. Real logic/type-mismatch bug.
>
> **Auditor (real):** Confirmed by reading the type chain. CapabilityAssessment.level is declared `number` in consciousness/types.ts:222. self-model/store.ts rowToCapability (line 53) maps the DB text level to a number via LEVEL_MAP (novice=0.1, developing=0.3, competent=0.5, proficient=0.7, expert=0.9). The real SelfModel.getWeaknesses() (model.ts:97-105) returns CapabilityAssessment[], so w.level is a number at runtime. WEAK_LEVELS is `new Set(['novice','developing'])` (Set<string>), so WEAK_LEVELS.has(w.level) evaluates Set<string>.has(0.1) which is always false → detectCapabilityGaps always returns []. The duck-typed EvoSelfModelLike declares level:string (types.ts:105), which lies about the runtime type and prevents TypeScript from catching the mismatch. The detector code is genuinely incorrect for its documented intent ('surfaces weak domains from the self-model'). Caveat: the sole current production wire-up (cli.ts:895-899) passes an empty stub `{ getWeaknesses: () => [], getStrengths: () => [] }`, so today it returns [] for a different reason (empty input) and the type bug is latent; but the cited code is itself buggy and would never surface a gap if a real SelfModel were injected, so the finding is correct about the code defect.

---
### H14. Merged PR is re-deployed forever — checkAndDeploy never stops its own monitor

**`src/core/self-build/deployment-hook.ts:90`** · _broken state machine_ · confidence 0.85

**What:** monitorPR() installs a setInterval that calls checkAndDeploy(prNumber, issueNumber) every 30s. checkAndDeploy reaches a terminal outcome (deployed, or rolled-back on CI failure) but never calls this.stopMonitoring(prNumber). The PR state stays 'merged' on every subsequent poll, so the 30s interval keeps re-fetching status, re-running the full CI suite (pnpm lint && pnpm test) and re-running pm2 reload (or re-running rollback) indefinitely. There is no external caller that stops monitoring (grep shows monitorPR/stopMonitoring are unused outside this file and its test).

**Failure scenario:** A PR is merged; checkAndDeploy runs CI, deploys via pm2 reload, posts a comment, and returns. 30s later the interval fires again: PR is still 'merged', so CI runs again and pm2 reload fires again. This repeats every 30 seconds forever — duplicate deploy comments on the issue, continuous CI churn, and repeated process reloads until the process is killed.

**Fix:** After a terminal outcome (successful deploy, or rollback after CI failure) call this.stopMonitoring(prNumber) before returning, so a merged PR is processed exactly once.

~~~ts
const intervalId = setInterval(() => {
  void this.checkAndDeploy(prNumber, issueNumber);
}, 30_000);
// checkAndDeploy never calls stopMonitoring after deploy/rollback
~~~

> **Skeptic (real):** monitorPR (line 73-76) installs a 30s setInterval calling checkAndDeploy and stores it in this.timers. checkAndDeploy returns after rollback (line 113) or after deploy (line 126) without ever calling stopMonitoring. Line 98 only returns early when state !== 'merged'; a merged PR stays 'merged' (getPRStatus sets state='merged' whenever data.merged is truthy, lines 158-159), so each subsequent poll re-runs runCI() (pnpm lint && pnpm test) and deploy()/rollback() and re-posts deploy comments. grep confirms no external caller of stopMonitoring/checkAndDeploy for DeploymentHook (the stopMonitoring hits were in self-healer.ts, an unrelated class). Only cleanup() clears all timers, never invoked per-PR. The infinite re-deploy/re-CI loop is genuine.
>
> **Auditor (real):** monitorPR() (line 73-76) installs a 30s setInterval calling checkAndDeploy. getPRStatus() sets state='merged' whenever data['merged'] is truthy (line 158-159), which is permanent after merge. checkAndDeploy (line 90-132) returns after deploy (line 123-126) or after rollback on CI failure (line 113) without ever calling this.stopMonitoring(prNumber). Grep confirms monitorPR/stopMonitoring/checkAndDeploy are referenced only in this file and its test — no production caller stops the monitor. Therefore every 30s the interval re-fires, re-fetches the still-merged PR, re-runs runCI() (pnpm lint && pnpm test) and re-runs deploy() (pm2 reload) or re-runs rollback() indefinitely, posting duplicate comments each time. Classic broken state machine with no terminal stop.

---
### H15. Format auto-detection for extract/list reads the wrong path (output/undefined instead of input)

**`src/core/superpowers/archive-manager.ts:130`** · _logic error_ · confidence 0.85

**What:** format defaults to detectFormat(output) when output exists, else 'tar.gz'. For 'extract', output is the destination DIRECTORY (no archive extension), so detectFormat returns 'tar.gz' even for a .zip/.tar.bz2 input. For 'list', output is not provided (not required), so format is always 'tar.gz'. The actual archive type lives in `input`, which is never inspected.

**Failure scenario:** super.archive operation='list' input='/x/a.zip' (no format) runs 'tar -tzf a.zip' and fails. super.archive operation='extract' input='/x/a.zip' output='/dest' (no format) runs 'tar -xzf a.zip -C /dest' and fails. Users must always pass format explicitly, contradicting the 'auto-detected from extension' documentation.

**Fix:** For extract/list, detect from the input archive path: const format = formatParam ?? detectFormat(operation==='compress' ? (output ?? input) : input);

~~~ts
const format: Format = (formatParam as Format | undefined) ?? (output ? detectFormat(output) : 'tar.gz');
~~~

> **Skeptic (real):** Confirmed at line 130: format defaults to detectFormat(output) when output exists else 'tar.gz'. detectFormat (lines 36-40) only checks extension and falls back to tar.gz. For extract, output is a destination DIRECTORY with no archive extension (validated as required at line 126), so detectFormat returns 'tar.gz' even for a .zip input -> 'tar -xzf a.zip' fails. For list, output is not required and not provided, so format is always 'tar.gz' -> 'tar -tzf a.zip' fails. The archive type lives in `input`, which detectFormat never inspects for extract/list, contradicting the 'Auto-detected from extension' doc at line 112.
>
> **Auditor (real):** format = formatParam ?? (output ? detectFormat(output) : 'tar.gz'). detectFormat only inspects file-extension suffixes (.zip/.tar.bz2/.tbz2). For 'extract' the output is a destination DIRECTORY with no archive extension, so detectFormat(output) returns the 'tar.gz' fallback regardless of the real input archive type. For 'list' output is not required (validation at 126 only enforces output for compress/extract), so output is undefined and format is always 'tar.gz'. The actual archive type lives in input, which is never passed to detectFormat. Listing/extracting a .zip or .tar.bz2 without an explicit format runs tar with gzip flags and fails, contradicting the 'Auto-detected from extension' docstring. Confirmed real.

---
### H16. Idempotency check fails when today's log is absent, causing duplicate context injection

**`src/core/workspace/injector.ts:120`** · _logic-error_ · confidence 0.85

**What:** injectWorkspaceContext detects prior injection by searching session.messages for a system message whose content starts with '## Today\n'. That marker is only ever added when today's daily log file exists and has content (lines 143-146). If today's log is missing/empty but yesterday's log or MEMORY.md exist, those messages are injected WITHOUT the '## Today\n' marker. On the next call within the same session the idempotency check finds no marker and re-injects yesterday + MEMORY again.

**Failure scenario:** Session starts on a day before any 'today' note is written (very common at the start of a day or after restart). Yesterday's log and/or long-term MEMORY.md are injected. Each subsequent turn that calls injectWorkspaceContext prepends another copy of yesterday + MEMORY, unboundedly growing the context window with duplicated system messages and wasting tokens / risking truncation of real conversation.

**Fix:** Use a stable, always-present sentinel for the idempotency check (e.g. push a marker system message regardless of which sections were found, or set a flag on the session), rather than keying off the optional '## Today\n' content marker.

~~~ts
const alreadyInjected = session.messages.some(
  (m) => m.role === 'system' && typeof m.content === 'string' && m.content.startsWith('## Today\n'),
);
if (alreadyInjected) { ... return; }
~~~

> **Skeptic (real):** Confirmed. The idempotency check at line 120-122 looks for a system message starting with '## Today\n'. That marker is ONLY pushed at line 143-144 when tryReadFile returns truthy todayContent (today's log exists and is non-empty after trim). Yesterday's log (line 152) and MEMORY.md (line 161) use different markers ('## Yesterday', '## Long-Term Memory'). So if today's log is missing/empty but yesterday/MEMORY exist, toInject is non-empty and gets unshifted, but NO '## Today' marker is present. On the next call within the same session, alreadyInjected is false, so yesterday + MEMORY are re-injected again, growing context unboundedly. The code's own comment ('the idempotency marker is on today's note') confirms the design assumes today's note is always present. The start-of-day / pre-first-note scenario is common and plausible. No guard prevents this.
>
> **Auditor (real):** The idempotency check at lines 120-122 keys solely off a system message whose content startsWith('## Today\n'). That marker is pushed ONLY when todayContent is truthy (lines 143-146). If today's log file is missing/empty (common at the start of a day or right after restart) but yesterday's log (## Yesterday) and/or MEMORY.md (## Long-Term Memory) exist, those get injected without any '## Today\n' message. On the next call within the same session, session.messages.some(...startsWith('## Today\n')) returns false, so alreadyInjected is false and yesterday + MEMORY are re-injected. Every subsequent turn prepends another copy, unboundedly growing the context. The code's own comment at line 173 ('the idempotency marker is on today's note') confirms the marker is tied to today's note existing. Real bug; the suggested fix (always-present sentinel or a session flag) is appropriate.

---
### H17. agent:stream-chunk handler captures stale streamingMessageId (always null), so streamed chunks are dropped

**`src/renderer/components/chat/ChatView.tsx:25`** · _stale-closure / dropped streaming output_ · confidence 0.85

**What:** useIpcOn(channel, callback) only re-subscribes when `channel` changes — its effect dep array is `[channel]` and the callback is intentionally excluded (see src/renderer/hooks/useIpc.ts lines 19-26 and ipcOn in ipc-client.ts which registers the callback once via window.sudo.on). Therefore the FIRST render's callback stays registered for the component's lifetime, capturing `streamingMessageId` from the initial closure where the store value is `null` (chatStore.ts line 50/63). When a stream begins, setStreaming(true, assistantId) updates the store, but the registered handler still reads the stale `streamingMessageId === null`, so the guard `if (data.chunk && streamingMessageId)` is always falsy and appendToMessage is never called.

**Failure scenario:** Running under Electron IPC (window.sudo present), the user sends a message; the main process emits 'agent:stream-chunk' events. The handler sees streamingMessageId===null, so no chunk is ever appended and the assistant bubble stays empty for the entire stream; only when `done` arrives is streaming cleared, leaving a blank reply.

**Fix:** Read the id from the store at event time instead of from closure: `const id = useChatStore.getState().streamingMessageId; if (data.chunk && id) appendToMessage(id, data.chunk);` (and use getState() for appendToMessage), or make useIpcOn re-subscribe when the callback changes / wrap the callback in a ref.

~~~ts
useIpcOn('agent:stream-chunk', (...args) => {
  const data = args[0] as { messageId?: string; chunk?: string; done?: boolean };
  if (data.chunk && streamingMessageId) {
    appendToMessage(streamingMessageId, data.chunk);
  }
  if (data.done) { setStreaming(false); }
});
~~~

> **Skeptic (real):** Confirmed. useIpcOn (useIpc.ts:19-26) has effect dep array [channel] with the callback intentionally excluded (eslint-disable comment present), and ipcOn (ipc-client.ts:177-186) registers the callback once via window.sudo.on. ChatView passes an inline arrow on every render, but only the FIRST render's closure is registered, capturing streamingMessageId from the initial store value (null, chatStore.ts:50). InputBar.handleSend calls setStreaming(true, assistantId) (InputBar.tsx:40), updating the store, but the registered handler still reads the stale captured streamingMessageId===null, so 'if (data.chunk && streamingMessageId)' is always false and appendToMessage is never called. This affects only the Electron IPC path (window.sudo present); the WebSocket fallback uses a separate ipcInvoke->sendViaWebSocket path that resolves the whole reply and never emits agent:stream-chunk. For the IPC streaming path, chunks are genuinely dropped and the bubble stays empty until done. Real bug.
>
> **Auditor (real):** Confirmed structural stale-closure bug. ChatView calls useChatStore() with no selector, so it re-renders on every store change and reads streamingMessageId fresh per render. But useIpcOn (hooks/useIpc.ts:19-26) has dep array [channel] with callback intentionally excluded, so its useEffect runs only once on mount; ipcOn (ipc-client.ts:177-186) registers the FIRST render's callback via window.sudo.on for the component lifetime. That callback closes over streamingMessageId === null (chatStore.ts:50 initial value). When a stream starts, InputBar calls setStreaming(true, assistantId) which updates the store; the component re-renders with a fresh closure, but the effect does not re-run (deps unchanged), so the new closure is never registered. The registered stale callback sees streamingMessageId === null, making the guard `if (data.chunk && streamingMessageId)` always falsy, so appendToMessage is never called and chunks are dropped. The bug manifests under the Electron IPC path (window.sudo present); the WebSocket fallback uses a different request/response + custom-event path. Caveat: no agent:stream-chunk IPC emitter or window.sudo preload is currently wired in this repo, so the defect is latent until the IPC streaming path is connected, but the renderer code is genuinely buggy. Suggested fix (read id via useChatStore.getState() at event time, or ref the callback) is correct.

---
### H18. listPending test deletes ALL real workspace/approvals/pending files (production data loss)

**`tests/security/approval/approval-registry.test.ts:143`** · _data-corruption_ · confidence 0.85

**What:** APPROVALS_BASE in the registry resolves to path.resolve('workspace/approvals') — the REAL project workspace, not a temp dir. The file's own docstring (lines 4-17) falsely claims the tests 'never touch the real workspace/approvals/ directory' and use TMPDIR; no vi.mock or path override is ever implemented. The 'returns empty array when no pending files exist' test unconditionally reads PENDING_DIR and unlinks EVERY *.json file there before asserting. Any genuine pending approval that a human operator is about to approve/deny will be silently deleted by a test run.

**Failure scenario:** An operator runs `npm test` while a real exec-approval request is pending in workspace/approvals/pending/. The test wipes that file. The blocked agent's waitForDecision() then never finds a decision and times out as 'expired', and the operator's intended approval/denial is lost. Same destructive deletion also exists in tests/security/approval-registry.test.ts (the byte-identical sibling).

**Fix:** Redirect the registry's base dir to a per-test temp directory (e.g. via the documented vi.mock that was promised but never written, or by making APPROVALS_BASE configurable and pointing it at fs.mkdtempSync). Never readdir+unlink against path.resolve('workspace/approvals').

~~~ts
const existing = fs.readdirSync(PENDING_DIR).filter(f => f.endsWith('.json'));
for (const f of existing) {
  fs.unlinkSync(path.join(PENDING_DIR, f));
}
~~~

> **Skeptic (real):** Confirmed by reading src/core/security/approval/approval-registry.ts:28 (APPROVALS_BASE = path.resolve('workspace/approvals')) which resolves to the REAL /root/sudo-ai-v4/workspace/approvals, not a temp dir. The test file's docstring (lines 4-17) falsely claims TMPDIR usage and vi.mock/APPROVALS_BASE shimming, but grep shows vi.mock and APPROVALS_BASE only appear in comments; the makeTmpDir() helper (lines 35-37) is dead code never called; no setupFiles/globalSetup in vitest.config.ts and no process.chdir. The test at lines 143-146 unconditionally readdirSync(PENDING_DIR) and unlinkSync every *.json in the real pending dir. Failure scenario is plausible: if npm test runs while a real exec-approval is pending, the file is deleted; approve(id) then calls readRecord(pFile) and throws 'pending request not found' (registry line 201), so the operator cannot approve and waitForDecision times out as 'expired' (registry line 184). This is a genuine destructive test-hygiene/data-loss bug. Line 143 is the exact destructive readdirSync call.
>
> **Auditor (real):** Verified the registry (src/core/security/approval/approval-registry.ts:28) uses APPROVALS_BASE = path.resolve('workspace/approvals'), and the test (line 84) uses WORKSPACE_APPROVALS = path.resolve('workspace/approvals'). Both resolve against the same process.cwd() at vitest runtime, so they point to the identical real directory. There is NO vi.mock, no process.chdir, no APPROVALS_BASE override anywhere — grep shows 'vi.mock' and 'APPROVALS_BASE' appear ONLY inside the docstring comments (lines 13,16), never in executable code; the imported `vi`, `os`, and helpers like makeTmpDir/writePendingFile are unused for isolation. The docstring's claim that tests 'never touch the real workspace/approvals/ directory' and use TMPDIR is false. The 'returns empty array' test at line 143 unconditionally does fs.readdirSync(PENDING_DIR).filter(.json) then fs.unlinkSync each. So any genuine pending approval file present when `npm test` runs is silently deleted; waitForDecision (registry line 139) only resolves non-expired if it finds a decided file, so the blocked agent times out as 'expired' and the operator's intended decision is lost. The identical destructive code also exists in the byte-identical sibling file. The failure scenario manifests exactly as described.

---
### H19. Uncontrolled input never reflects programmatic clear (Clear button leaves stale text)

**`src/renderer/components/common/SearchInput.tsx:68`** · _logic error_ · confidence 0.83

**What:** The text field is rendered uncontrolled via defaultValue={value} (line 68). The component also renders a Clear button (shown only when the parent's value is non-empty) whose onClick calls onChange('') (line 96). Because the input is uncontrolled, React does not update the DOM input's text when value changes; defaultValue is only applied on the first mount. So clicking Clear updates the parent state (and the search results) but the previously typed text remains visible in the box. The same divergence happens any time the parent resets/changes value externally — the displayed text and the actual filter value drift apart.

**Failure scenario:** User types 'foo', the debounced onChange propagates 'foo', the Clear button appears, user clicks it. Parent value becomes '' and results reset, but the input box still shows 'foo'. UI now shows a search term that is not actually applied; further typing builds on the stale text. Any external value reset (e.g., navigating away and back) also fails to update the visible text.

**Fix:** Make the input controlled (value={value}) and keep an internal display state synced to props, OR force a remount on external clears via a key. Minimal fix: render <input value=... /> with a local state that mirrors `value` (useEffect to sync) and debounce the upstream onChange, so the Clear button and external resets actually update what is shown.

~~~ts
<input
  type="search"
  defaultValue={value}
  onChange={handleChange}
/>
...
<button onClick={() => onChange('')}>
~~~

> **Skeptic (real):** Line 68 renders the input with defaultValue={value}, making it uncontrolled — React only applies defaultValue at initial mount and never updates the DOM input.value when the `value` prop changes. The Clear button (line 96) calls onChange('') which updates parent state (confirmed: all callers pass value={search} onChange={setSearch}, e.g. ToolsPage:228, CronPage:286), but the DOM input keeps the typed text because nothing syncs it — no controlled `value` prop, no key tied to value, no useEffect writing back to the input. So clicking Clear resets the parent filter/results while the box still shows the old text; the same drift happens on any external value reset. The component also debounces user typing (handleChange, lines 20-29) which is the only thing that updates the input, so a programmatic clear is never reflected. Genuine logic bug.
>
> **Auditor (real):** The input at line 65-89 is uncontrolled (defaultValue={value}, line 68), so React never updates the DOM input's text when the `value` prop changes — defaultValue is only honored at mount. The Clear button (line 96) calls onChange(''). All callers (ToolsPage:228, CronPage:286, LogsPage, SessionsPage:266) wire onChange directly to setSearch, with `const [search,setSearch]=useState('')`. So clicking Clear sets parent state to '' (results reset, and the button at line 92 disappears because `value` is now falsy), but the DOM input still visibly shows the previously typed text. The displayed text and the applied filter value genuinely diverge. The same applies to any external reset of `value`, which the uncontrolled input ignores. Confirmed real logic bug. Note: the debounce only affects when the parent learns the typed value; it does not change the conclusion, since the bug is about the input not re-reflecting prop changes back into the DOM.

---
### H20. Integrity check 2 falsely fails when counterfactual insights exceed 3x pattern count

**`src/core/consciousness/sleep-cycle/integrity-verifier.ts:62`** · _logic-error_ · confidence 0.82

**What:** Check 2 bounds insightsGenerated by patternsFound*3. But in phases.ts, acc.insightsGenerated is incremented in BOTH Phase 2 (pattern finding) and Phase 3 (counterfactual lessons), while acc.patternsFound is set ONLY by Phase 2. Counterfactual lessons therefore inflate insightsGenerated without raising patternsFound, so the bound insightsGenerated <= patternsFound*3 can be exceeded by an entirely healthy cycle. Because each of the 4 logical checks is worth 0.25 and coherent requires score > 0.75, a single false failure of this check drops score to exactly 0.75 (not > 0.75), flipping the session to incoherent and causing the consolidator to set _degraded=true and mark the SleepSession as degraded.

**Failure scenario:** Phase 2 returns 1 pattern (patternsFound=1, insightsGenerated=1). Phase 3 (runIdleBatch(3)) yields 3 counterfactuals with lessons, raising insightsGenerated to 4. Check 2: 4 > 1*3 = true -> failure pushed -> logical score = 0.75 -> coherent=false -> _runIntegrityCheck sets _degraded=true and the session is persisted with degraded=true and a low integrityScore, despite the cycle having run normally.

**Fix:** Track pattern-derived insights separately from counterfactual insights, or change the bound to compare against the total expected insight sources (e.g. patternsFound*3 + counterfactualsRun), or compute the bound from the same population that produced insightsGenerated. At minimum exclude Phase 3 lesson counts from this check.

~~~ts
if (acc.insightsGenerated < 0 || acc.insightsGenerated > acc.patternsFound * 3) {
  failures.push('insightsGenerated-out-of-bounds');
}
~~~

> **Skeptic (real):** Confirmed in phases.ts: runPhase2PatternFinding sets acc.patternsFound = rawInsights.length (line 112) and increments acc.insightsGenerated once per pattern (line 122). runPhase3Counterfactuals increments acc.insightsGenerated per counterfactual lesson (line 158) but never touches patternsFound. The integrity check at consolidator.ts:506 runs AFTER Phase 3 completes, so insightsGenerated includes both pattern insights and counterfactual lessons while patternsFound counts only patterns. Check 2 (integrity-verifier.ts:62) is `insightsGenerated > patternsFound*3`. With patternsFound=1, insightsGenerated=4 (1 pattern + 3 counterfactual lessons), 4 > 3 = true -> one logical failure -> checksPassed=3/4 -> score=0.75. coherent is `score > 0.75` (strict, line 107), so 0.75 is NOT coherent -> _runIntegrityCheck sets _degraded=true (consolidator.ts:821) and _finalise persists degraded=true with integrityScore=0.75. Even more easily triggered: patternsFound=0 (LLM returns no parseable patterns) with any counterfactual lesson -> insightsGenerated>0 fails the bound immediately. This is a genuine logic error that flips a healthy cycle to degraded; the bound is computed from a population (patternsFound) that does not produce all of insightsGenerated.
>
> **Auditor (real):** Verified across phases.ts, integrity-verifier.ts, and consolidator.ts. In runPhase2PatternFinding, acc.patternsFound = rawInsights.length AND acc.insightsGenerated is incremented once per pattern, so after Phase 2 patternsFound == insightsGenerated. In runPhase3Counterfactuals, acc.insightsGenerated is incremented per counterfactual lesson with NO change to patternsFound. Scenario: patternsFound=1, insightsGenerated=1 after Phase 2; Phase 3 (runIdleBatch(3)) yields up to 3 lessons -> insightsGenerated=4. Check 2 (line 62): 4 > 1*3=3 is true -> 'insightsGenerated-out-of-bounds' pushed. That is one logical failure -> score = (4-1)/4 = 0.75. Line 107: coherent = score > 0.75 (strict), so 0.75 is NOT coherent. _runIntegrityCheck (consolidator:821) sets _degraded=true; _finalise (consolidator:861) persists degraded with a low integrityScore on an otherwise healthy cycle. Also fails with patternsFound=0 and any counterfactual lesson (bound=0). The bug genuinely manifests.

---
### H21. getRevenue double-counts revenue across multiple snapshots per video

**`src/core/earning/tracker.ts:218`** · _logic-error_ · confidence 0.82

**What:** getRevenue() sums revenue_usd over ALL rows in video_metrics (SUM(revenue_usd) FROM video_metrics, and the period branch likewise sums every matching snapshot). The video_metrics schema explicitly stores multiple rows per video_id ('Multiple rows per video_id'), and pullMetrics()/storeVideoMetrics() insert a brand-new snapshot row on every pull. YouTube estimatedRevenue is cumulative per date-range, so each re-pull stores roughly the same total again. Summing all snapshots therefore multiplies total revenue by the number of times metrics were pulled. The sibling method getTopVideos() correctly de-duplicates with 'id IN (SELECT MAX(id) FROM video_metrics GROUP BY video_id)', proving the intended semantics are one (latest) snapshot per video — getRevenue omits this de-dup.

**Failure scenario:** A channel has 3 videos, each pulled daily for 30 days (90 snapshot rows). getRevenue('all') returns ~30x the real revenue. This feeds the user-facing 'Total revenue' tool output, RevenueTracker.checkMilestones() (fires milestones far too early), and getROI() (grossly inflated ROI). Reported earnings become meaningless / corrupted.

**Fix:** Mirror getTopVideos de-dup: SELECT COALESCE(SUM(revenue_usd),0) FROM video_metrics WHERE id IN (SELECT MAX(id) FROM video_metrics GROUP BY video_id) [AND snapshot_at LIKE :prefix || '%'] so only the latest snapshot per video_id is summed.

~~~ts
const row = db.db
  .prepare<[], { total: number }>('SELECT COALESCE(SUM(revenue_usd), 0) AS total FROM video_metrics')
  .get();
total = row?.total ?? 0;
~~~

> **Skeptic (real):** Confirmed in code. schema.ts:235 states 'Multiple rows per video_id'; db.ts:548 storeVideoMetrics does a plain INSERT (new row every pull, no upsert/dedup); pullMetrics (tracker.ts:104-179) fetches a 30-day cumulative estimatedRevenue window and inserts a fresh snapshot each call. getRevenue (tracker.ts:222-235) sums revenue_usd over ALL rows for both the 'all' branch and the period branch, with no per-video dedup. The sibling getTopVideos (tracker.ts:264) deliberately dedups via 'id IN (SELECT MAX(id) ... GROUP BY video_id)', proving the intended one-latest-snapshot-per-video semantics that getRevenue omits. Repeated periodic pulls (class is described as 'Periodic analytics snapshots') therefore multiply summed revenue by the number of pulls. This feeds user-facing total revenue (earning/index.ts:105,271), checkMilestones (revenue.ts:85 — fires too early), getReport (revenue.ts:63), and getROI (revenue.ts:112 — inflated ROI). Real logic error.
>
> **Auditor (real):** Confirmed by reading the full code and schema. video_metrics schema (schema.ts:235, db.ts:545) explicitly states 'Multiple rows per video_id' and storeVideoMetrics() (db.ts:548) does a plain INSERT with no upsert/dedup, so every pullMetrics() call (tracker.ts:168) appends a brand-new snapshot row. getRevenue('all') (tracker.ts:224) does SUM(revenue_usd) over ALL rows, and the period branch (line 231) likewise sums every matching snapshot. The sibling getTopVideos() (tracker.ts:264) deliberately de-dups with 'id IN (SELECT MAX(id) FROM video_metrics GROUP BY video_id)', proving the intended one-latest-snapshot-per-video semantics that getRevenue omits. YouTube estimatedRevenue is pulled for a fixed 30-day window (tracker.ts:113-116, cumulative for that range), so repeated daily pulls store overlapping totals; summing all snapshots inflates revenue by ~the number of pulls. Confirmed real consumers: RevenueTracker.checkMilestones() (revenue.ts:85) and getROI() (revenue.ts:112) both call getRevenue('all'), and the earning tool surfaces it (earning/index.ts:105,271), so milestones fire too early and ROI is grossly inflated. Genuine logic error.

---
### H22. _loadFromDb LIMIT 20 across all sessions can fail to find an existing active session

**`src/core/sessions/manager.ts:345`** · _logic-error_ · confidence 0.82

**What:** _loadFromDb selects session meta chunks with `ORDER BY rowid DESC LIMIT 20` then scans for a matching (channel, peerId, active). Because _persistToDb writes session meta via db.storeChunk(), and storeChunk dedups by CONTENT HASH while the meta JSON embeds `updatedAt` (which changes on every save), each save() INSERTs a brand-new meta row with a higher rowid. The newest-20-rows window therefore covers only the 20 most-recently-saved sessions across ALL peers, not per-peer. On a cache miss (after process restart or after _evictIfOverLimit drops the entry), getOrCreate calls _loadFromDb; if more than ~20 distinct sessions were saved more recently than the target peer's, the target's active meta row is outside the LIMIT 20 and _loadFromDb returns undefined.

**Failure scenario:** Multi-user deployment: peer A has an active session. 20+ other peers exchange messages (each save inserts newer meta rows). Process restarts (or A's cache entry is evicted). A sends a new message -> getOrCreate cache-misses -> _loadFromDb scans only the 20 newest meta rows, none of which is A's -> returns undefined -> a brand-new duplicate session is created for A, losing prior conversation continuity. The accumulating meta rows also make _listActiveFromDb (no LIMIT) progressively slower and the chunks table grow unbounded.

**Fix:** Query meta by the specific path/peer, e.g. SELECT the latest meta row per session filtered by channel/peerId, or store one canonical meta row per session (UPSERT by path instead of hash-deduped INSERT). At minimum remove the LIMIT 20 and pick the most-recent row per session id matching channel+peerId+active.

~~~ts
`SELECT text, path FROM chunks WHERE path LIKE :path AND source = 'conversation' ORDER BY rowid DESC LIMIT 20`
~~~

> **Skeptic (real):** Confirmed in manager.ts:345-373. _persistToDb (line 309) calls db.storeChunk(meta, ...) where meta JSON embeds updatedAt (line 306), which changes on every save. storeChunk (db.ts:244-269) dedups by SHA-256 content hash, so a changed updatedAt yields a new hash and a brand-new INSERT with a higher rowid; there is no UPSERT-by-path and no cleanup (grep found no DELETE of :meta chunks). Thus meta rows accumulate, one+ per save per session. _loadFromDb's query 'WHERE path LIKE session:%:meta ... ORDER BY rowid DESC LIMIT 20' matches ALL sessions' meta rows, not the target peer, and only inspects the newest 20. On a cache miss (process restart clears the cache; _evictIfOverLimit drops oldest when size>200) getOrCreate calls _loadFromDb (line 93). If >20 newer meta rows exist from other peers' saves, peer A's active meta row falls outside the window, the scan finds no channel+peerId+active match, returns undefined, and a duplicate session is created (line 102-104), losing continuity. _listActiveFromDb (line 412) has no LIMIT and re-parses every accumulated row, confirming unbounded growth. Failure scenario is plausible in any multi-user deployment.
>
> **Auditor (real):** Confirmed by tracing the full chain. _persistToDb (manager.ts:298-309) builds meta JSON that embeds updatedAt, and save() (line 137) sets session.updatedAt = new Date() on every save, so the meta content (and thus its sha256 hash) changes each save. db.storeChunk (db.ts:244-253) dedups by content hash; since the hash differs each save, every save INSERTs a brand-new chunk row with a higher rowid rather than updating. _loadFromDb (line 345-349) queries `WHERE path LIKE 'session:%:meta' ... ORDER BY rowid DESC LIMIT 20`, where the LIKE pattern matches ALL sessions/peers, so the 20-row window spans every peer's meta rows, not per-peer. On a cache miss (process restart, or _evictIfOverLimit dropping the entry when cache > MAX_CACHE=200), getOrCreate (line 93) calls _loadFromDb. If 20+ newer meta rows exist (e.g. an idle target peer while 20+ other peers actively save), the target's active meta row falls outside LIMIT 20, so the scan (line 351-372) never matches and returns undefined -> a duplicate session is created (line 102), losing continuity. _listActiveFromDb (line 408-414) has no LIMIT and dedups by id, so it grows progressively slower as rows accumulate. Real bug.

---
### H23. Broken bundled-skill pagination: wrong total and skipped/missing skills

**`src/core/skills/registry-routes.ts:82`** · _logic-error_ · confidence 0.82

**What:** The list endpoint fetches only the first `limit + offset` rows across ALL trust tiers via registry.list(limit + offset, 0), then filters to bundled and slices [offset, offset+limit]. Because registry.list orders by created_at DESC over every tier (not just bundled) and the filter happens AFTER the SQL LIMIT, bundled skills below the limit+offset cutoff are never seen. `total` is reported as bundled.length, which is only the count of bundled skills within the fetched window, not the true bundled total. Pagination therefore returns wrong totals and can drop or omit valid bundled skills.

**Failure scenario:** A registry holds 100 bundled skills (older) plus 2000 newer non-bundled skills. A client requests GET /v1/registry/skills?limit=50&offset=0. registry.list(50,0) returns the 50 newest rows, all non-bundled, so bundled=[] → the API responds with data:[] and total:0 even though 100 bundled skills exist. Indexers see an empty registry.

**Fix:** Filter to bundled in SQL (e.g. add a bundled-only query) or fetch all candidates and paginate on the bundled subset: compute the full bundled list first (or a COUNT for total), then slice for the requested page. Do not pass limit+offset as a SQL LIMIT over mixed tiers.

~~~ts
const all     = registry.list(limit + offset, 0);
const bundled = all.filter(isBundled);
const page    = bundled.slice(offset, offset + limit);
sendJson(res, 200, { data: page.map(toPublicEntry), total: bundled.length, limit, offset });
~~~

> **Skeptic (real):** Confirmed via registry-sql.ts:93-101 that registry.list() SQL is `SELECT ... FROM skills ... WHERE archived_at IS NULL ORDER BY created_at DESC LIMIT ? OFFSET ?` over ALL trust tiers (no tier filter). The route at registry-routes.ts:82-87 calls registry.list(limit+offset, 0), then .filter(isBundled), then .slice(offset, offset+limit). registry.ts inserts mixed-tier skills (lines 114/206/361/377 handle 'indexed','unreviewed','workspace' as well as 'bundled'), so a registry can hold many newer non-bundled skills. Because the SQL LIMIT (limit+offset) is applied across mixed tiers BEFORE the bundled filter, bundled skills that fall outside the newest limit+offset window are never fetched and silently dropped. Also `total: bundled.length` is the count of bundled skills within the fetched window, not the true bundled total, so totals are wrong. The failure scenario (100 older bundled + 2000 newer non-bundled => data:[] total:0) is exactly correct given DESC-by-created_at ordering. Real bug, both pagination and total are broken.
>
> **Auditor (real):** Confirmed by reading registry-routes.ts:82-87, the isBundled filter in registry-route-types.ts:309, and the list SQL in registry-sql.ts:93-101. The list query selects across ALL trust tiers (WHERE only excludes archived, no tier filter), ordered by created_at DESC with LIMIT ? OFFSET ?. The route calls registry.list(limit+offset, 0), fetching only the newest limit+offset rows mixed across tiers, THEN filters to bundled and slices. Bundled skills older than the created_at cutoff are never fetched. I simulated the exact failure scenario (100 older bundled + 2000 newer non-bundled, limit=50/offset=0): result is page=[] and total=0 despite 100 bundled skills existing. Also total is reported as bundled.length within the fetched window, not the true bundled total. Both defects manifest exactly as described.

---
### H24. Non-numeric pollIntervalMs makes status action start a 1ms CPU-burning poll loop

**`src/core/tools/builtin/meta/event-daemon-tool.ts:137`** · _resource-leak_ · confidence 0.82

**What:** In the 'status' action, when starting the daemon, pollMs = Math.max(5_000, Number(params['pollIntervalMs'] ?? DEFAULT_POLL_MS)). If pollIntervalMs is a non-numeric value, Number(...) yields NaN, and Math.max(5_000, NaN) yields NaN (verified). EventDaemon.start guards with `pollIntervalMs < 5_000`, but `NaN < 5_000` is false, so the guard passes. setInterval(fn, NaN) coerces the delay to ~0/1ms, so _cycle() (the full detection pass) fires continuously, pinning a CPU core and flooding the DB for the entire process lifetime.

**Failure scenario:** Agent calls meta.event-daemon with action='status', pollIntervalMs='30s' (a string) or any non-number while the daemon is not yet running. Number('30s')=NaN -> Math.max(5000,NaN)=NaN -> guard `NaN<5000` is false -> setInterval(_cycle, NaN) runs the detection cycle at ~1ms forever, hanging the process with 100% CPU and unbounded DB writes.

**Fix:** Coerce and validate before use: `const raw = Number(params['pollIntervalMs'] ?? DEFAULT_POLL_MS); const pollMs = Number.isFinite(raw) ? Math.max(5_000, raw) : DEFAULT_POLL_MS; d.start(pollMs);`

~~~ts
const pollMs = Math.max(5_000, Number(params['pollIntervalMs'] ?? DEFAULT_POLL_MS));
d.start(pollMs);
~~~

> **Skeptic (real):** Confirmed by reading both files and running Node. At line 137 pollMs = Math.max(5_000, Number(params['pollIntervalMs'] ?? DEFAULT_POLL_MS)). I verified Number('30s')=NaN and Math.max(5000,NaN)=NaN. EventDaemon.start (event-daemon.ts:111) guards with `if (pollIntervalMs < 5_000) throw`, but NaN<5000 is false (verified), so the guard is bypassed. start then calls setInterval(() => void this._cycle(), NaN) at line 117; I verified setInterval(fn, NaN) fires immediately/repeatedly (3 rapid fires in test). _cycle runs a full detection pass that calls _persistEvent (DB INSERTs), so this pins a CPU core and floods the DB for the process lifetime. The code itself uses Number(...) coercion, showing it does not assume the param is already numeric, and params is typed Record<string, unknown>; an agent can pass a string. No earlier guard prevents it. The auto-start path (ensureStarted, line 44) uses the safe DEFAULT_POLL_MS, but the status-action path at 137-138 is exploitable. Genuine high-severity bug.
>
> **Auditor (real):** Verified the full chain. The tool registry (src/core/tools/registry.ts:415) passes raw params straight to tool.execute with NO type coercion/validation against the declared JSON Schema, so a string pollIntervalMs (e.g. '30s') reaches the tool unmodified. In the 'status' branch (line 137): Number('30s')=NaN, and I empirically confirmed Math.max(5000,NaN)=NaN. d.start(NaN) is called (line 138). In EventDaemon.start (event-daemon.ts:111) the guard `pollIntervalMs < 5_000` is `NaN < 5000` which is false, so the guard does NOT throw. Then setInterval(()=>void this._cycle(), NaN) (line 117) — I empirically confirmed setInterval with NaN delay fires ~every 1ms (5 times in 8ms). _cycle() runs the full detection pass (DB inserts via _persistEvent + queries) on each fire, pinning a CPU core and flooding the DB. The daemon is a process-lifetime singleton with no stop exposed via the tool, so the loop persists. All steps manifest as described.

---
### H25. social.multi-post double-posts when 'schedule' is combined with a live platform

**`src/core/tools/builtin/social/platform-tools.ts:122`** · _logic-error_ · confidence 0.82

**What:** In multi-post, each platform in the `platforms` array is processed in its own loop iteration. When the caller passes both a live platform and 'schedule' (e.g. ['twitter','schedule']), the live platform's iteration posts the content immediately, AND the 'schedule' iteration computes `realPlatforms = platforms.filter(p => p !== 'schedule')` and schedules those same live platforms for the future. The result is the content is published twice: once now and once at scheduleTime. The schedule branch also overwrites results[p] for those live platforms, masking/clobbering the immediate-post result (e.g. an immediate failure becomes a scheduled 'success', desynchronizing results vs the errors[] array used to compute the top-level success flag).

**Failure scenario:** User calls social.multi-post with content='Launch!', platforms=['twitter','schedule'], scheduleTime=tomorrow. The tweet is posted immediately (twitter iteration) and a scheduled job is also created for twitter at tomorrow's time, so the same tweet goes out twice. If the immediate tweet failed, results['twitter'] is overwritten with the scheduled-success object, hiding the failure.

**Fix:** Treat 'schedule' as a mode, not a peer platform: if 'schedule' is present, schedule the OTHER platforms and skip their immediate-post iterations (e.g. compute the live platforms and only post immediately those NOT being scheduled), or require schedule to be the sole entry. Do not both post and schedule the same platform.

~~~ts
const realPlatforms = platforms.filter((p) => p !== 'schedule');
for (const p of realPlatforms) {
  const entry = store.insert({ id: genId(), content, platforms: [p], ... });
  scheduleResults[p] = { success: true, scheduleId: entry.id, scheduleTime: validated };
}
for (const [p, r] of Object.entries(scheduleResults)) { results[p] = r; }
~~~

> **Skeptic (real):** Confirmed in the execute loop (lines 62-147). The platforms enum (line 42) allows both live platforms and 'schedule' in the same array. For platforms=['twitter','schedule'] the 'twitter' iteration (lines 64-92) posts the tweet immediately via the Twitter API. Then the 'schedule' iteration (lines 111-139) computes realPlatforms = platforms.filter(p => p !== 'schedule') = ['twitter'] (line 122), inserts a future scheduled entry for twitter (lines 124-134), and overwrites results['twitter'] with the scheduled-success object (lines 136-138). So the same content is published now AND scheduled for scheduleTime (double-post), and the immediate-post result (including any failure) is clobbered by the scheduled-success entry, desyncing results vs the errors[] used for the top-level success flag (line 151). No guard prevents combining a live platform with 'schedule'. Real logic error.
>
> **Auditor (real):** Confirmed. The execute() loop (line 62) iterates each entry of `platforms` independently. For platforms=['twitter','schedule'], the 'twitter' iteration (lines 64-92) performs an immediate live POST to the Twitter API. Then the 'schedule' iteration computes realPlatforms = platforms.filter(p => p !== 'schedule') = ['twitter'] (line 122) and inserts a scheduled job for twitter (lines 124-134), so the same content is both posted now AND scheduled for scheduleTime — a true double-post. Additionally, lines 136-138 overwrite results['twitter'] with the schedule-success object; since 'twitter' precedes 'schedule' in the array, an immediate failure stored in results['twitter'] (e.g. line 88) is clobbered by a {success:true,...} schedule entry, desynchronizing the data map from reality. (The top-level success flag stays correct because the failure is still pushed to errors[] at line 89, but the per-platform data is masked.) The tool description (line 45, 'required when "schedule" in platforms') shows schedule is intended as a mode, not a peer platform, confirming this is unintended behavior.

---
### H26. WebSocket close on unmount schedules an uncancelable zombie reconnect loop

**`src/renderer/chat/hooks/useWebSocket.ts:54`** · _resource leak_ · confidence 0.82

**What:** The ws.onclose handler always schedules setTimeout(connect, RECONNECT_DELAY_MS). On component unmount the cleanup runs clearTimeout(reconnectTimeoutRef.current) and then wsRef.current.close(). But close() fires onclose asynchronously AFTER cleanup has already returned, so onclose runs setTimeout(connect, ...) again — and that new timer was created after cleanup, so it is never cleared. connect() then opens a brand-new WebSocket on an unmounted component, which itself reconnects forever. Handlers are never detached (no ws.onclose = null) and there is no isMounted guard, so setConnected is also called after unmount.

**Failure scenario:** User navigates away from the chat view (or React StrictMode unmounts the component during dev double-invoke). The cleanup closes the socket, but ~immediately the deferred close event fires onclose, which sets a 3s timer that the already-finished cleanup can't cancel. After 3s a new WebSocket connects, and every subsequent disconnect reschedules another. The page leaks a perpetually reconnecting socket and emits setState-on-unmounted warnings; repeated mounts multiply the zombie connections.

**Fix:** Track an isMounted/closing flag in a ref. In onclose, only schedule the reconnect when not unmounting. In cleanup, set the flag, null out ws.onclose/onerror (or set a 'manual close' flag), clear the timer, then close: e.g. `const closing = useRef(false)`; in onclose `if (!closing.current) reconnectTimeoutRef.current = setTimeout(connect, ...)`; in cleanup `closing.current = true; clearTimeout(...); wsRef.current && (wsRef.current.onclose = null, wsRef.current.close())`.

~~~ts
ws.onclose = () => {
  setConnected(false);
  onDisconnectRef.current?.();
  reconnectTimeoutRef.current = setTimeout(connect, RECONNECT_DELAY_MS);
};
~~~

> **Skeptic (real):** Confirmed by reading the full hook. ws.onclose (lines 54-58) unconditionally schedules setTimeout(connect, RECONNECT_DELAY_MS) into reconnectTimeoutRef.current. The cleanup (lines 85-92) clears reconnectTimeoutRef.current and then calls wsRef.current.close(), but never detaches the handler (no ws.onclose = null) and has no isMounted/closing guard. Per the WebSocket spec, close() does NOT fire the close event synchronously; it is dispatched as a later task on the event loop. So after cleanup returns, the deferred close event runs onclose, which (a) calls setConnected(false) on an unmounted component and (b) creates a brand-new reconnect timer AFTER cleanup already ran clearTimeout, so that timer is never cancelled. After 3s connect() builds a new WebSocket on the dead component, whose own onclose reschedules again -> perpetual zombie reconnect loop, multiplied per mount (notably under React StrictMode dev double-invoke). The described failure scenario is fully plausible and not prevented by any guard.
>
> **Auditor (real):** Confirmed by reading lines 36-93. ws.onclose (54-58) unconditionally schedules reconnectTimeoutRef.current = setTimeout(connect, RECONNECT_DELAY_MS). The cleanup (85-92) first clearTimeout(reconnectTimeoutRef.current), then wsRef.current.close(). close() dispatches the close event ASYNCHRONOUSLY (a microtask/task after the synchronous cleanup returns), and the onclose handler is never detached (no ws.onclose = null) and there is no isMounted/closing guard. So after cleanup has already returned, onclose fires, schedules a NEW setTimeout(connect) that was created after the clearTimeout ran and is therefore never cancelled. After 3s connect() runs on the unmounted component, opening a fresh WebSocket which itself reconnects on every subsequent close — a perpetual zombie loop. Additionally setConnected(false) and onDisconnectRef are invoked post-unmount, causing setState-on-unmounted warnings. The connect callback has an empty dependency array so it is stable, meaning the same leaky handler is reused. The failure scenario (navigation away or StrictMode double-invoke) manifests exactly as described. This is the classic React WebSocket unmount leak; the suggested fix (closing flag + null handlers) is correct.

---
### H27. AGENT_HOME_ROOM uses rooms that don't match the store's currentRoom, mispositioning agents

**`src/renderer/components/office/MissionControl.tsx:72`** · _logic-error_ · confidence 0.82

**What:** getAgentPosition compares currentRoom against AGENT_HOME_ROOM. But AGENT_HOME_ROOM lists 'library' for SUDO-3 and 'conference' for SUDO-8, which are not valid RoomId values and are NOT the rooms these agents actually live in. In constants.ts/officeStore, SUDO-3.defaultRoom is 'workspace', SUDO-7.defaultRoom is 'workspace', and SUDO-8.defaultRoom is 'meeting-room'. So at rest, currentRoom !== homeRoom for these agents, so the function returns the generic ROOM_POSITIONS slot instead of the agent's calibrated desk in AGENT_PIXEL_POS.

**Failure scenario:** On normal load (no drama movement), SUDO-3 and SUDO-7 both have currentRoom 'workspace' but homeRoom 'library'/'meeting-room', so both render at ROOM_POSITIONS['workspace'] = {x:360,y:370}, stacking two sprites on top of each other away from their intended desks ({880,340} and {920,700}). SUDO-8 renders at ROOM_POSITIONS['meeting-room'] = {960,740} instead of its desk {1040,740}. The carefully-calibrated AGENT_PIXEL_POS desks for these agents are never used.

**Fix:** Make AGENT_HOME_ROOM match each agent's actual defaultRoom from constants (SUDO-3:'workspace', SUDO-7:'workspace'/whatever its real default is, SUDO-8:'meeting-room'), or derive homeRoom from AGENTS[i].defaultRoom directly instead of a hand-maintained map.

~~~ts
const homeRoom = AGENT_HOME_ROOM[code];
if (currentRoom && currentRoom !== homeRoom && ROOM_POSITIONS[currentRoom]) {
  return ROOM_POSITIONS[currentRoom];
}
return AGENT_PIXEL_POS[code];
~~~

> **Skeptic (real):** Verified against constants.ts and officeStore.ts. buildInitialAgents (officeStore.ts:31) sets runtime.currentRoom = def.defaultRoom. constants.ts defaultRoom values: SUDO-1/2/3/5/6/7 = 'workspace', SUDO-4 = 'server-room', SUDO-8 = 'meeting-room'. AGENT_HOME_ROOM (MissionControl.tsx:61-70) only matches for SUDO-1 ('workspace'), SUDO-2 ('workspace'), SUDO-4 ('server-room'); it mismatches for SUDO-3 ('library' vs 'workspace'), SUDO-5 ('break-room' vs 'workspace'), SUDO-6 ('lobby' vs 'workspace'), SUDO-7 ('meeting-room' vs 'workspace'), SUDO-8 ('conference' vs 'meeting-room'). In getAgentPosition (line 72-78), at rest the condition currentRoom && currentRoom !== homeRoom && ROOM_POSITIONS[currentRoom] is true for all mismatched agents, so they return the generic ROOM_POSITIONS slot instead of their AGENT_PIXEL_POS desk. SUDO-3/5/6/7 (defaultRoom 'workspace') all collapse onto ROOM_POSITIONS['workspace']={360,370}, and SUDO-1/2 also land there, so up to six sprites stack at one point; SUDO-8 renders at ROOM_POSITIONS['meeting-room']={960,740} instead of its desk {1040,740}. The calibrated AGENT_PIXEL_POS desks for these agents are never used at rest. The finding's core claim is correct (it actually understates the count of affected agents). 'library'/'conference' aren't even valid RoomIds, confirming the map is stale.
>
> **Auditor (real):** Confirmed by tracing the data. Store init (officeStore.ts:31) sets each agent's currentRoom = def.defaultRoom. From constants.ts: SUDO-3 defaultRoom='workspace', SUDO-7 defaultRoom='workspace', SUDO-8 defaultRoom='meeting-room'. But AGENT_HOME_ROOM (MissionControl.tsx:61-70) has SUDO-3='library', SUDO-7='meeting-room', SUDO-8='conference'. In getAgentPosition (72-78), at rest currentRoom !== homeRoom for these agents AND ROOM_POSITIONS[currentRoom] exists, so it returns the generic room slot instead of AGENT_PIXEL_POS. Concretely: SUDO-3 and SUDO-7 both render at ROOM_POSITIONS['workspace']={360,370} (stacked, away from desks {880,340} and {920,700}); SUDO-8 renders at ROOM_POSITIONS['meeting-room']={960,740} instead of desk {1040,740}. The calibrated desks are never used for these agents. The finding is actually understated — SUDO-5 (home 'break-room' vs default 'workspace') and SUDO-6 (home 'lobby' vs default 'workspace') are also mispositioned. Note the only agents whose home matches default are SUDO-1, SUDO-2 (workspace) and SUDO-4 (server-room). 'library' and 'conference' are also not valid RoomId values per constants.ts ROOMS. A minor wording inconsistency in the description ('library'/'meeting-room' for SUDO-7) does not change the verified outcome.

---
### H28. React hook (useOfficeStore) called inside useMemo, violating rules of hooks

**`src/renderer/components/office/furniture/TaskBoard.tsx:40`** · _wrong API/library usage_ · confidence 0.82

**What:** Inside the `useMemo(() => {...}, [])` callback, the code does `const mod = require('@renderer/stores/officeStore')` and then calls `mod.useOfficeStore()` — a zustand React hook — conditionally and inside a memo callback that only runs on the first render. Hooks must be called unconditionally at the top level of a component on every render and in the same order. Calling `useOfficeStore()` here registers React's internal hooks (zustand uses useSyncExternalStore) during the first render only.

**Failure scenario:** On the component's initial render, `useOfficeStore()` runs (when the store module resolves), registering React hooks. Because the useMemo has empty deps, the callback never runs again, so on the next render those internal hooks are NOT called. React compares hook call counts between renders and throws 'Rendered fewer hooks than expected. This may be caused by an accidental early return statement.' / 'Rendered fewer hooks than during the previous render', crashing the office scene. In the milder case where the store happens to be unavailable so the hook never fires, the board permanently shows FALLBACK_TASKS and never reflects live task updates because the value is memoized once with [] deps.

**Fix:** Do not call a hook inside useMemo. Import useOfficeStore normally at module top and select tasks at the top level of the component: `const storeTasks = useOfficeStore((s) => s.tasks);` then `const tasks = storeTasks && storeTasks.length > 0 ? storeTasks : FALLBACK_TASKS;`. If dynamic loading is required, use a non-hook accessor like `useOfficeStore.getState().tasks` instead of calling the hook.

~~~ts
  const tasks = useMemo<OfficeTask[]>(() => {
    try {
      const mod = require('@renderer/stores/officeStore') as { useOfficeStore?: () => { tasks?: OfficeTask[] } };
      if (mod && typeof mod.useOfficeStore === 'function') {
        const state = mod.useOfficeStore();
~~~

> **Skeptic (real):** Confirmed at officeStore.ts:94 that `useOfficeStore = create<OfficeState>(...)` is a zustand hook, so calling `mod.useOfficeStore()` (line 40, with no selector) invokes React's `useSyncExternalStore` internally. This call sits inside a `useMemo(() => {...}, [])` callback (lines 35-47) with empty deps. That is a Rules of Hooks violation: the internal hooks register only on the first render (when the memo callback runs once), but the callback never re-runs, so subsequent renders call fewer hooks, producing React's 'Rendered fewer hooks than during the previous render' error and crashing the office scene. Even in the milder runtime case where `require('@renderer/stores/officeStore')` throws (likely under an ESM/Vite bundle where `require` may be unavailable) or the hook never fires, the catch swallows it and the board is permanently memoized to FALLBACK_TASKS with `[]` deps, never reflecting live task updates. The described bug genuinely exists; the try/catch does not prevent the hook-count mismatch on re-render. Suggested fix (use `useOfficeStore((s)=>s.tasks)` at top level, or `useOfficeStore.getState().tasks` as a non-hook accessor) is correct.
>
> **Auditor (real):** Confirmed in officeStore.ts that useOfficeStore is a zustand hook created via create() (line 94), and called with no selector argument (line 40 of TaskBoard) it returns full state via useSyncExternalStore, which IS a React hook. In TaskBoard.tsx the call happens inside useMemo(() => {...}, []) (lines 35-47), so: (1) it is conditional (inside try and behind the typeof===function check), and (2) the useMemo has empty deps, so the callback only runs on the initial render. On first render useOfficeStore() registers React's internal hooks; on any subsequent re-render the useMemo callback does not re-run, so those internal hooks are not called again. React detects the changed hook count and throws 'Rendered fewer hooks than during the previous render', crashing the office scene. The module @renderer/stores/officeStore exists and exports useOfficeStore, so the require succeeds and the hook genuinely fires on first render, making the crash real on the next re-render. This is a clear Rules-of-Hooks violation. The suggested fix (call useOfficeStore as a top-level selector, or use useOfficeStore.getState() for a non-reactive read) is correct.

---
### H29. Test wipes the real production install directory data/installed-skills (not a temp dir)

**`tests/skills/skills-hub.test.ts:81`** · _data corruption / resource handling_ · confidence 0.82

**What:** cleanupInstalledDir() resolves the install directory as join(process.cwd(), 'data/installed-skills') — the SAME path SkillsHub uses at runtime (src/core/skills/skills-hub.ts line 33: INSTALLED_SKILLS_DIR = 'data/installed-skills'). It runs rmSync(installedDir, { recursive: true, force: true }) in BOTH beforeEach (line 89) and afterEach (line 100). Every other temp resource in this file uses os.tmpdir(), but this one targets the real repo-relative data dir.

**Failure scenario:** If the test suite is executed from the project root (the normal case) on a machine where the user/agent has actually installed skills into data/installed-skills, running this test file permanently deletes all installed skills with no recovery (force recursive delete). It also makes the install/list/remove tests interfere with any concurrently running app that uses the same directory.

**Fix:** Point the install directory to a unique os.tmpdir() path for the duration of the test (e.g., set the env/config the hub reads, or construct SkillsHub with an injected install dir), and never rmSync a repo-relative runtime data directory.

~~~ts
const INSTALLED_SKILLS_DIR = 'data/installed-skills';
function cleanupInstalledDir(): void {
  const installedDir = join(process.cwd(), INSTALLED_SKILLS_DIR);
  ...
    rmSync(installedDir, { recursive: true, force: true });
~~~

> **Skeptic (real):** Confirmed. In the test, cleanupInstalledDir() (lines 72-82) resolves installedDir = join(process.cwd(), 'data/installed-skills') and runs rmSync(installedDir, { recursive: true, force: true }) when it exists, then mkdirSync. It is called in both beforeEach (line 89) and afterEach (line 100). The SkillsHub source uses the EXACT same path: src/core/skills/skills-hub.ts line 33 INSTALLED_SKILLS_DIR = 'data/installed-skills', resolved via join(process.cwd(), INSTALLED_SKILLS_DIR) at lines 95, 214, 277, 353, 424 — this is the live runtime install directory. Every other temp resource in the test file uses os.tmpdir() (testDir at line 85), but this one targets the repo-relative runtime data dir. If the suite runs from the project root (normal) with real installed skills present, a force-recursive delete permanently destroys them with no recovery, and it can interfere with a concurrently running app. The failure is plausible and unguarded.
>
> **Auditor (real):** Confirmed. In the test, INSTALLED_SKILLS_DIR = 'data/installed-skills' (line 70) is identical to the production constant in src/core/skills/skills-hub.ts line 33. cleanupInstalledDir() (lines 72-82) resolves installedDir = join(process.cwd(), 'data/installed-skills') — exactly the same repo-relative path SkillsHub uses at runtime — and calls rmSync(installedDir, { recursive: true, force: true }) inside the existsSync guard. It is invoked in both beforeEach (line 89) and afterEach (line 100). Every other temp resource in the file uses tmpdir() (testDir at line 85), but this one targets the real data dir. When the suite runs from the project root (the normal case), executing this file force-recursive-deletes any actually-installed skills with no recovery, and would race any concurrently running app sharing the same directory. The failure scenario manifests exactly as described.

---
### H30. Destructive-command 'never' guard trivially bypassed by substring matching

**`src/core/autonomy/approval-matrix.ts:300`** · _security-correctness_ · confidence 0.8

**What:** Arg-constraint matching for 'never' rules such as 'system.exec:rm -rf', 'control.exec:rm -rf', 'system.exec:dd if=' uses a plain command.includes(argConstraint) substring test. The block can be evaded by trivial command variations that are semantically identical but not literal substrings: 'rm  -rf' (two spaces), 'rm -fr', 'rm --recursive --force', '/bin/rm -rf', or quoting. When the literal substring is absent, the command falls through to the broad 'control.*' (tier 'auto') / 'system.exec' (tier 'notify') rule and executes without confirmation.

**Failure scenario:** An autonomous control action runs cu.exec('rm  -fr /important') (note double space / reordered flags). classify('control.exec', {cmd}) no longer matches 'control.exec:rm -rf' (the literal 'rm -rf' substring is absent), so the only match is 'control.*' = auto. executeControl proceeds to delete the directory with zero approval, defeating the entire purpose of the 'never' tier.

**Fix:** Do not rely on substring matching for safety-critical 'never' rules. Tokenize/normalize the command (collapse whitespace, resolve binary basename, parse argv) and match on the canonical command + flags, or maintain an allowlist instead of a denylist for autonomous exec.

~~~ts
const command = (args?.cmd as string | undefined) || (args?.command as string | undefined);
if (command && command.includes(argConstraint)) return true;
~~~

> **Skeptic (real):** _matches() (lines 289-308) matches arg-constraint rules via plain `command.includes(argConstraint)` (line 304). classify() (lines 136-157) selects the longest matching pattern. DEFAULT_RULES (lines 79-89) define 'control.exec:rm -rf' as tier 'never' but also 'control.*' as tier 'auto'. For toolName 'control.exec' with cmd 'rm  -fr ...' (double space / reordered flags / '/bin/rm -rf' / '--recursive --force'), the literal substring 'rm -rf' is absent, so the never-rule does not match; the only matching rule is 'control.*' = auto, so the command auto-executes with no approval. The substring denylist is genuinely and trivially bypassable for safety-critical never rules. Real security-correctness defect.
>
> **Auditor (real):** _matches() (lines 289-308) handles arg-constrained patterns like 'control.exec:rm -rf' by extracting argConstraint='rm -rf' and testing command.includes(argConstraint) (line 304) — a plain literal substring test. A semantically-identical command such as 'rm  -fr /important' (double space, reordered flags), 'rm --recursive --force', or '/bin/rm -rf' does not contain the literal substring 'rm -rf', so this never-tier rule fails to match. classify() (lines 136-157) then selects the longest-pattern rule among matches; with the never rule not matching, the broad 'control.*' default rule (line 86, tier 'auto') matches 'control.exec' and is selected, so the destructive command is auto-approved with zero confirmation. The same flaw applies to 'system.exec:rm -rf' (falls through to 'system.exec' tier 'notify', line 70) and 'system.exec:dd if='. The bypass manifests exactly as described — a denylist relying on substring matching is trivially evaded by command normalization differences.

---
### H31. save() on a session not present in cache re-persists ALL messages, duplicating history in the DB

**`src/core/sessions/manager.ts:135`** · _data-corruption_ · confidence 0.8

**What:** save() adds a cache entry with persistedMessageCount:0 when the key is absent (line 141-144), then _persistToDb slices session.messages from index 0 and inserts every message as 'new'. But a session obtained via get(sessionId) is hydrated from the DB (_hydrateSession loads up to 100 prior messages) and is NEVER inserted into the cache. So the natural pattern get() -> mutate -> save() treats all already-persisted messages as new and re-inserts them, duplicating the entire loaded history (and FTS rows) on every such save.

**Failure scenario:** AgentLoop.run (src/core/agent/loop.ts:918) calls sessionManager.get(sessionId) which hydrates ~100 messages from the DB without caching, then later (loop.ts:1329) calls sessionManager.save(session). save() sees no cache entry, sets persistedMessageCount=0, and _persistToDb re-stores all ~100 loaded messages plus the new turn as 'new' rows. Every turn after a restart/eviction duplicates the full message history, corrupting message counts, transcripts, and FTS search.

**Fix:** When save() creates a cache entry for a session that already has messages, initialise persistedMessageCount to session.messages.length minus the unsaved delta, or have get()/_loadBySessionId populate the cache with persistedMessageCount = messages.length so subsequent saves only persist truly-new messages. Alternatively persist messages with INSERT OR IGNORE keyed on a stable message id.

~~~ts
if (!this.cache.has(key)) {
  this.cache.set(key, { session, persistedMessageCount: 0 });
  this._evictIfOverLimit();
}
this._persistToDb(session);
~~~

> **Skeptic (real):** Confirmed via the chat.send/sessions.send path. get(sessionId) (manager.ts:117-127) returns the cached object if present but does NOT populate the cache on a DB load; _loadBySessionId (380-406) -> _hydrateSession (463-492) loads up to 100 messages without caching. AgentLoop.run calls get(sessionId) at loop.ts:918, pushes new messages (e.g. loop.ts:1319), then calls save(session) at loop.ts:1329. save() (135-154) does 'if (!cache.has(key)) { cache.set(key, {persistedMessageCount: 0}) }' then _persistToDb, which slices session.messages from alreadyPersisted=0 (288-334) and INSERTs every message via storeMessage (db.ts:340-368, plain INSERT, no dedup, autoincrement PK) — duplicating the entire hydrated history. The normal pipeline (http-api, bridge-protocol) calls getOrCreate first, which DOES populate the cache (line 95 sets persistedMessageCount = existing.messages.length), preventing the bug on that path. BUT rpc-handlers.ts:117 (sessions.send) and :145 (chat.send) take an existing sessionId from params and call loop.run(sessionId, message) with NO prior getOrCreate. After a restart/eviction the cache is empty for that key, so get() hydrates ~100 messages uncached, save() resets persistedMessageCount to 0, and the full history is re-inserted every turn. Mechanism and a concrete unguarded caller both confirmed.
>
> **Auditor (real):** Verified end to end. get(sessionId) (line 117-127) checks the cache by id; on miss it calls _loadBySessionId -> _hydrateSession (line 463-492) which loads up to 100 messages via db.getSessionMessages but NEVER inserts the session into the cache. save(session) (line 135) then computes the peer key, finds no cache entry (line 141), and sets persistedMessageCount:0 (line 142). _persistToDb (line 314-318) reads alreadyPersisted=0 and slices session.messages from index 0, calling db.storeMessage for every message. db.storeMessage (db.ts:349-356) is a plain INSERT with no dedup (no hash, no INSERT OR IGNORE, no stable message id), so all hydrated messages are re-inserted as new rows (also duplicating FTS entries). The exact get->mutate->save pattern is exercised by AgentLoop.run: loop.ts:918 calls sessionManager.get(sessionId) and loop.ts:1329 calls sessionManager.save(session); the wired sessionManager is DualSessionManager whose get/save delegate directly to the primary SessionManager (dual-manager.ts:62-64, 75-77). The bug manifests specifically after a restart or cache eviction (when no cache entry exists yet for the peer), which matches the reported scenario. In the steady-state live path getOrCreate pre-populates the cache with the correct count and get() returns the cached object, so the bug is conditional, but the restart/eviction path is real and corrupts message counts/transcripts. Real bug.

---
### H32. Failed update silently abandons stashed working-tree changes (wrong recovery condition)

**`src/core/update/update-manager.ts:313`** · _logic-error_ · confidence 0.8

**What:** _applyUpdate stashes a dirty working tree before pulling (lines 261-265), which makes the tree CLEAN. If the subsequent pull/install/build fails, the catch block restores the stash only `if (this._isGitDirty())`. After a successful stash the tree is clean, so _isGitDirty() returns false and `git stash pop` never runs — the user's stashed changes are silently left in the stash and effectively lost from the working tree. The recovery should be conditioned on whether a stash was actually created, not on the current dirty state.

**Failure scenario:** User has local uncommitted edits. Auto-update runs: `git stash` succeeds (tree now clean), `git pull` or `pnpm build:cli` fails. Catch block checks _isGitDirty() → false → skips `git stash pop`. The update returns failure, but the user's working changes have vanished from the tree and remain orphaned in the stash with no notification.

**Fix:** Track stashing with a flag in the outer scope (e.g. `let stashed = false;` set true after `git stash`), and in the catch restore with `if (stashed) this._exec('git stash pop 2>/dev/null || true');` instead of re-checking _isGitDirty().

~~~ts
try {
  if (this._isGitDirty()) {
    this._exec('git stash pop 2>/dev/null || true');
  }
} catch {
  // Best effort
}
~~~

> **Skeptic (real):** Confirmed by reading _applyUpdate. Lines 261-265: if `_isGitDirty()` it runs `git stash`, which makes the working tree CLEAN. _isGitDirty (lines 421-432) returns true only when `git status --porcelain` has output, so after a successful stash it returns false. If a later step (git pull line 270, pnpm install line 276, pnpm build:cli line 282) throws, the catch block at lines 313-316 guards `git stash pop` with `if (this._isGitDirty())` — which is now false because the stash cleaned the tree — so the pop never runs. The user's uncommitted changes remain orphaned in the stash and are not restored to the working tree, with no notification (the function just returns success:false). The recovery should be conditioned on whether a stash was actually created (a flag), not on current dirty state. The bug genuinely exists and the failure scenario is plausible whenever an auto-update with a dirty tree fails after stashing.
>
> **Auditor (real):** Confirmed. Lines 261-265 stash only when _isGitDirty() is true; `git stash` then makes the working tree CLEAN. _isGitDirty() (verified body) runs `git status --porcelain` and returns true only when there are uncommitted changes. In the catch block (lines 313-316) the stash is restored only `if (this._isGitDirty())`. After a successful stash the tree is clean, so _isGitDirty() returns false and `git stash pop` is skipped. For common failures — notably `pnpm build:cli` (line 282) failing after a clean `git pull`, or an install failure — the tree stays clean, the stash is never popped, and the user's uncommitted changes are orphaned in the stash with no notification. The recovery should track a 'stashed' flag rather than re-check dirty state. Real logic error.

---
### H33. buildOptimizedPrompt cache returns stale dynamic content on hit

**`src/core/brain/prompt-cache-optimizer.ts:121`** · _logic-error_ · confidence 0.78

**What:** The cache key is computed only from the stable inputs (identity, agents, tools), but the value stored and returned is the FULL combined prompt (stable + dynamic). On a cache hit the function returns splitPrompt(cachedCombined), which re-emits the dynamic section (date, memoryContext, consciousness, customInstructions) that was captured on the FIRST call. Any later call with the same stable inputs but different dynamic inputs receives the old, stale date/memory/mood/instructions. This directly contradicts the function's own comment ('dynamic fields change per session and must not produce a stale hit when they differ').

**Failure scenario:** Call buildOptimizedPrompt with identity/agents/tools X and dateTime='2026-06-06', memoryContext='task A'. Later call with identical X but dateTime='2026-06-07', memoryContext='task B'. Because the key only hashes X, the second call hits the cache and returns the first call's combined prompt containing the OLD date and OLD memory context, so the model is fed wrong/stale session state.

**Fix:** Cache only the stable section (store/return parts.stable keyed on the stable hash) and always rebuild the dynamic section fresh; or include the dynamic inputs in the cache key. Do not store combined (stable+dynamic) under a stable-only key.

~~~ts
const cachedCombined = promptCache.getCachedPrompt(cacheKey);
if (cachedCombined) {
  // Re-split so callers get accurate stable/dynamic sections even on a hit.
  return splitPrompt(cachedCombined);
}
~~~

> **Skeptic (real):** Confirmed. The cache key (lines 112-118) is derived ONLY from identity/agents/tools. But the stored value is `combined` = stable + dynamic (lines 141, 146 store `combined`). getCachedPrompt (prompt-cache.ts:90) returns entry.systemPrompt, i.e. the full combined string from the FIRST call. On a hit, line 125 returns splitPrompt(cachedCombined), which re-emits the originally captured dynamic section (dateTime, memoryContext, consciousness, customInstructions). A later call with identical stable inputs but different dynamic inputs (within the 1h TTL) gets the OLD date/memory/mood/instructions. This directly contradicts the function's own comment at lines 110-111 ('dynamic fields change per session and must not produce a stale hit when they differ'). The fix would be to cache only the stable section or include dynamic inputs in the key. Real logic error.
>
> **Auditor (real):** Confirmed by reading the full function (lines 101-154) and PromptCacheManager. The cache key (lines 112-118) is hashed only from identity/agents/tools (stable). The value stored at line 146 is `combined` = stable + dynamic (line 141), which embeds the FIRST call's dateTime/memoryContext/consciousness/customInstructions. On a hit (lines 121-126) it returns `splitPrompt(cachedCombined)`; splitPrompt merely re-partitions the stored string by markers, so both the returned `.dynamic` and `.combined` carry the first call's stale dynamic content. A later call with identical stable inputs but different dynamic inputs (e.g. new date/memory) hits the cache and gets the old dynamic section. This directly contradicts the function's own comment at lines 110-111 ('dynamic fields change per session and must not produce a stale hit when they differ'). Caveat: buildOptimizedPrompt is currently not wired to any live caller (only `promptCache` is imported in agent/loop.ts; the function itself is unused outside its file), so the bug is latent, but it is a genuine defect in this exported, documented function as written.

---
### H34. runSelfImprovement crashes when data/mind.db does not exist

**`src/core/self-improvement/engine.ts:188`** · _null/undefined dereference_ · confidence 0.78

**What:** STEP 1 calls detectPatterns(windowDays) before any existence check. detectPatterns opens the DB with `new Database(DB_PATH, { readonly: true, fileMustExist: true })` outside its try block. If data/mind.db is absent (fresh install / first run), better-sqlite3 throws synchronously and runSelfImprovement rejects with an unhandled SqliteError. The existsSync(DB_PATH) guard that would have prevented this only appears at line 195, after detectPatterns has already run, and only protects the FeedbackMemory step.

**Failure scenario:** Weekly self-improvement cron fires on a node where mind.db has not been created yet. detectPatterns() throws 'unable to open database file', the entire run rejects, no LEARNINGS update / no log row is written, and the cron job reports failure.

**Fix:** Guard detectPatterns with `if (!existsSync(DB_PATH)) { return early with empty results }`, or wrap detectPatterns in try/catch and fall back to a default DetectedPatterns object.

~~~ts
// --- STEP 1: DETECT ---
const patterns = detectPatterns(windowDays);
...
if (existsSync(DB_PATH)) {   // existence check happens too late (line 195)
~~~

> **Skeptic (real):** STEP 1 (line 188) calls detectPatterns(windowDays) before any existsSync guard. In pattern-detector.ts line 73 the DB is opened with `new Database(DB_PATH, { readonly: true, fileMustExist: true })` OUTSIDE the try block (try starts line 76), so a missing DB throws synchronously. Both files resolve DB_PATH to data/mind.db. The existsSync(DB_PATH) guard in engine.ts only appears at line 195 and only protects the FeedbackMemory step — too late. On a fresh node where mind.db has not been created, runSelfImprovement rejects with an unhandled SqliteError before STEP 4 (which would otherwise create the DB). Real crash on first run.
>
> **Auditor (real):** runSelfImprovement calls detectPatterns(windowDays) at line 188 as STEP 1, before any existence guard. The existsSync(DB_PATH) check is at line 195 and only guards the FeedbackMemory/auto-research block. detectPatterns (pattern-detector.ts line 73) opens `new Database(DB_PATH, { readonly: true, fileMustExist: true })` OUTSIDE its try block (try starts at line 76). With fileMustExist:true and a missing data/mind.db, better-sqlite3 throws synchronously ('unable to open database file'). runSelfImprovement has no try/catch around line 188, so the whole run rejects with an unhandled SqliteError on a fresh install / first run. Real null/IO crash; the late existsSync guard does not protect detectPatterns.

---
### H35. WebSocket request/response uses single-flight module globals — concurrent sends cross-talk and drop replies

**`src/renderer/lib/ipc-client.ts:127`** · _race condition_ · confidence 0.78

**What:** sendViaWebSocket stores the resolve/reject/timeout for the in-flight request in module-level singletons (_pendingResolve, _pendingReject, _pendingTimeout). There is no per-request correlation id or queue. If a second ipcInvoke('agent:send-message') is issued while the first reply has not yet arrived, the second call overwrites _pendingResolve with its own resolver. When the first reply arrives, the onmessage handler reads the current _pendingResolve (the second request's) and resolves the WRONG promise with the first reply, while the second request's real reply is later dispatched as a stray 'sudo:push' event. The first request's promise then hangs until its 1800s timeout.

**Failure scenario:** User sends message A (cheap turn) then quickly sends message B before A's reply returns. A's reply arrives first; onmessage resolves B's promise with A's text. B's reply later finds _pendingResolve === null and is dispatched as a server push instead of returning from ipcInvoke. The chat UI shows A's answer attributed to B and B's send appears to never complete (until timeout).

**Fix:** Maintain a FIFO queue or a Map of correlation ids -> {resolve,reject,timeout} keyed by an id echoed back by the server, instead of overwriting single globals. At minimum, reject/queue a new send while one is already pending.

~~~ts
_pendingResolve = resolve;
_pendingReject = reject;
_pendingTimeout = setTimeout(() => {
  _pendingResolve = null;
  _pendingReject = null;
  _pendingTimeout = null;
  reject(new Error('WebSocket timeout — no reply in 1800s'));
}, 1_800_000);
~~~

> **Skeptic (real):** Confirmed by reading lines 50-147. _pendingResolve/_pendingReject/_pendingTimeout are module-level singletons (lines 51-53). sendViaWebSocket (line 127) unconditionally assigns _pendingResolve = resolve (line 130) with no pending-check, no correlation id, and no queue. The onmessage handler (lines 90-100) clears and reads whatever _pendingResolve currently is and resolves with data, with zero correlation to which request the reply belongs to. Two overlapping calls: the 2nd overwrites the 1st's resolver/timeout (the 1st timeout handle is leaked too). The 1st reply to arrive resolves the 2nd promise; the 1st promise hangs. A later stray reply finds _pendingResolve===null and is dispatched as a 'sudo:push' CustomEvent (line 99) instead of returning. The described cross-talk and hang are genuinely reproducible. No guard prevents concurrency.
>
> **Auditor (real):** Traced sendViaWebSocket (lines 127-147) and the onmessage handler (lines 75-101). _pendingResolve/_pendingReject/_pendingTimeout are module-level singletons (lines 51-53). Each send overwrites them (lines 130-133) with no correlation id or queue. onmessage (line 91) reads the single current _pendingResolve and clears it (lines 92-94), so any incoming message that is not a thinking/progress/user_echo event resolves whatever the latest pending request is, and a subsequent real reply finds _pendingResolve===null and is dispatched as a stray sudo:push (lines 97-99). The first request then hangs until the 1800s timeout (line 137). The described failure mechanism is exactly correct. Note: the InputBar UI guards a second send via isStreaming (InputBar.tsx:21,40, disabled fields), which mitigates the literal 'send B while A pending' UI path. However the same defect manifests with only ONE in-flight send: the codebase has a POST /api/message REST path (web.ts:10) whose server-pushed message arrives over the same socket; onmessage cannot distinguish a push from a reply, so a push arriving while a send is pending will wrongly resolve the pending send's promise and the real reply becomes a stray push. The single-flight global design is genuinely broken; verdict real.

---
### H36. Two byte-identical approval-registry test files share the same real workspace dir (cross-file race + flaky failures)

**`tests/security/approval-registry.test.ts:84`** · _race-condition_ · confidence 0.78

**What:** tests/security/approval-registry.test.ts and tests/security/approval/approval-registry.test.ts are byte-for-byte identical (verified via diff) and BOTH hard-code WORKSPACE_APPROVALS = path.resolve('workspace/approvals'), PENDING_DIR and DECIDED_DIR on that shared real directory. Each file only cleans up UUIDs it tracked in createdIds, but the 'listPending returns empty' test in each file deletes ALL pending files — including those created concurrently by the other file's requestApproval/'returns pending records' test. Under vitest's default multi-worker/file-parallel execution these two suites collide on the same filesystem state.

**Failure scenario:** Vitest runs both suites in parallel workers. File A's requestApproval test writes a pending file; File B's 'returns empty array' test deletes it (and vice-versa). File A's 'returns pending records after requestApproval' then finds 0 records and the expect(found).toBeDefined() assertion fails non-deterministically. The duplicate suite also runs every destructive operation twice against production data.

**Fix:** Isolate each suite to its own temp directory (configurable APPROVALS_BASE / mocked module path) and de-duplicate the two identical files into one.

~~~ts
const WORKSPACE_APPROVALS = path.resolve('workspace/approvals');
const PENDING_DIR = path.join(WORKSPACE_APPROVALS, 'pending');
const DECIDED_DIR = path.join(WORKSPACE_APPROVALS, 'decided');
~~~

> **Skeptic (real):** diff confirmed the two files (tests/security/approval-registry.test.ts and tests/security/approval/approval-registry.test.ts) are byte-for-byte identical. Both hard-code WORKSPACE_APPROVALS = path.resolve('workspace/approvals') at line 84 on the shared real directory. vitest.config.ts has no fileParallelism:false, no isolate:false, and no single-thread pool override, so vitest's default behavior runs the two files in parallel worker processes against the same filesystem state. Each suite's afterEach only cleans up its own createdIds, but the 'returns empty array' test (lines 143-146) deletes ALL pending files, including those created concurrently by the other file's 'returns pending records after requestApproval' test (lines 151-161), which would make expect(found).toBeDefined() (line 158) fail non-deterministically. The duplicate suite also runs every destructive operation twice against the production workspace dir. The race and duplicate-destructive-op claims are both supported; line 84 is the shared-dir declaration that is the root cause.
>
> **Auditor (real):** Confirmed via `diff` that tests/security/approval-registry.test.ts and tests/security/approval/approval-registry.test.ts are byte-for-byte identical. Both hardcode WORKSPACE_APPROVALS/PENDING_DIR/DECIDED_DIR on path.resolve('workspace/approvals') (line 84-86), the same real on-disk directory the registry uses. vitest@^4.1.1 defaults to the forks pool with file-level parallelism ENABLED; vitest.config.ts sets no fileParallelism:false, singleFork, pool, or maxWorkers:1, and there is no vitest.workspace file or shared setup overriding this. Therefore the two suites run concurrently in separate worker processes over shared filesystem state. File A's 'returns pending records after requestApproval' test writes a pending file (requestApproval -> writeAtomic), while File B's 'returns empty array' test (line 143) does a blanket readdirSync+unlink of every .json in the shared pending dir, deleting File A's just-created file before File A's listPending()/expect(found).toBeDefined() runs -> non-deterministic failure. afterEach only cleans createdIds it itself tracked, so it cannot guard against the other file's blanket deletion. The duplicate suite also runs every destructive operation twice against production data. The race and flakiness manifest as described.

---
### H37. LAYER 3 sliding window can orphan tool-result messages from their assistant tool-call message

**`src/core/agent/loop-helpers.ts:819`** · _wrong API/library usage; broken protocol invariant_ · confidence 0.72

**What:** prepareMessages builds `windowed = [...systemMsgs.slice(0,2), ...nonSystemMsgs.slice(-WINDOW_SIZE)]` and returns it to brain.call(). An assistant message containing toolCalls and its corresponding role:'tool' result messages are all 'non-system'. The slice(-12) boundary can cut between an assistant message (with toolCalls) and its tool results, leaving tool-result messages whose declaring assistant message was dropped (or vice versa). The code's own comment (lines 668-674) states toolCallId/toolName MUST be matched or the Vercel AI SDK throws AI_MissingToolResultsError / unmatched-tool-call errors.

**Failure scenario:** In a long turn with many tool calls, the 12-message window starts in the middle of a tool-call/tool-result group. The trimmed array passed to brain.call() contains a role:'tool' message with a toolCallId that has no matching assistant tool_call (or an assistant tool_call with no matching result). On the next brain.call(), convertToLanguageModelPrompt throws, aborting the agent turn with a hard error rather than continuing.

**Fix:** When windowing, never split a tool-call group: include the assistant message that declared a tool_call together with all its tool-result messages, or advance the window boundary to a safe message-role boundary (start window on a user/assistant-text message, never on an orphan tool result).

~~~ts
const windowed: BrainMessage[] = [
  ...systemMsgs.slice(0, 2),
  ...nonSystemMsgs.slice(-WINDOW_SIZE),
];
~~~

> **Skeptic (real):** Confirmed across the pipeline. Assistant tool-call messages (loop.ts:1817-1822) and their role:'tool' results (loop-helpers commit at 670) are stored as separate non-system messages. prepareMessages LAYER 3 (loop-helpers.ts:823-826) builds windowed = [...systemMsgs.slice(0,2), ...nonSystemMsgs.slice(-12)] and returns collapseToolResults(windowed) straight to brain.call (loop.ts:1502,1657). collapseToolResults (151-164) only shrinks content, never repairs orphans; toSDKMessages (brain.ts:119-164) blindly emits a tool-result part for any role:'tool' message and a tool-call part for any assistant.toolCalls with no cross-matching. slice(-12) frequently starts on a role:'tool' message whose declaring assistant is at -13, producing a tool-result with no matching tool-call. The AI SDK convertToModelMessages throws on that (the code's own comment at 668-674 states matching is required). Because the malformed message is identical across all failover attempts, brain.call cannot recover: each profile throws (brain.ts:712), then LLMError('All failover attempts failed') at 721 (and consensus mode falls through to the same). Hard turn abort. Real.
>
> **Auditor (real):** Confirmed reachable. Assistant tool-call messages are stored as single entries with `toolCalls:[...]` (loop.ts:1817-1822) and the corresponding role:'tool' results are SEPARATE entries pushed later (loop-helpers.ts commit() at 670, and stubs at loop.ts:1873). All are non-system, so `nonSystemMsgs.slice(-12)` can cut mid-group. Simulated a realistic mixed sequence (groups of size 1 and 3, 14 non-system msgs): the last-12 window started with an orphaned role:'tool' message whose declaring assistant was dropped. collapseToolResults (151-164) only collapses content, no orphan repair; the windowed array is returned and passed directly to brain.call (loop.ts:1502/1657-1658). toSDKMessages (brain.ts:119-165) converts each message independently with no orphan filtering/synthesis, then calls generateText/streamText (ai@6.0.138). The codebase itself documents this exact failure (loop.ts:1868-1871: missing tool_result entries cause AI_MissingToolResultsError, which is why EpistemicGate synthesizes stubs). So a mid-group window cut produces an orphan that triggers the SDK error. Real, though probabilistic (depends on group sizes vs the window boundary).

---
### H38. goal:completed hook emitted even when goal was not completed

**`src/core/autonomy/wake-sleep-cycle.ts:219`** · _logic-error_ · confidence 0.72

**What:** dispatchGoal() emits the 'goal:completed' hook event whenever the work handler returns without throwing. The work handler is only documented to 'do work for a goal' (it may make partial progress, schedule a wake, or pause the goal), and the example even shows completion being optional. There is no check that the goal's status is actually 'completed' (e.g. via goalEngine.getGoal(goal.id)). Any subscriber to 'goal:completed' (legacy snapshots, outcome ledger, notifications) will be told the goal finished on the very first tick of work.

**Failure scenario:** A goal is dispatched; the work handler does one increment of progress (e.g. recordWorkSession(id, 20)) and returns. WakeSleepCycle fires 'goal:completed' with the goalId. Downstream systems mark the goal done / record a completion outcome / stop scheduling it, while GoalEngineV2 still has the goal as 'active' with 20% progress. The goal is silently abandoned mid-pursuit and a false completion is recorded.

**Fix:** After awaiting the work handler, re-read the goal and only emit 'goal:completed' when goalEngine.getGoal(goal.id)?.status === 'completed'. Otherwise emit a 'goal:worked' style event or nothing.

~~~ts
await this.workHandler(goal);
// Emit goal:completed event if work handler didn't throw.
if (this.hookManager) {
  await this.hookManager.emit('goal:completed', {
    event: 'goal:completed',
    meta: { goalId: goal.id, title: goal.title },
  });
}
~~~

> **Skeptic (real):** Confirmed in dispatchGoal() (lines 211-230): after `await this.workHandler(goal)` returns, it unconditionally emits 'goal:completed' with the goalId, guarded only by `if (this.hookManager)`. There is no read-back of goal status (e.g. goalEngine.getGoal(goal.id)?.status === 'completed'). The WorkHandler type doc (line 27-28) only says it 'does the actual work for a goal', and the class example (lines 60-66) shows the handler must call engine.completeGoal(goal.id) itself — completion is explicitly the handler's responsibility, not guaranteed. getGoalsReadyToWork() returns active goals with partial progress, so a handler doing one increment and returning is a normal path that would falsely fire 'goal:completed'. The in-code comment 'Emit goal:completed event if work handler didn't throw' confirms the missing status check. Genuine logic error.
>
> **Auditor (real):** In dispatchGoal() (lines 211-230), the code awaits this.workHandler(goal) and then unconditionally emits the 'goal:completed' hook event (lines 219-224) as long as the handler did not throw. There is NO check that the goal's status is actually 'completed' (goalEngine.getGoal(goal.id)?.status === 'completed'), even though getGoal() exists in GoalEngineV2 (line 213). The WorkHandler type is documented (line 27) merely as 'Handler that does the actual work for a goal', and the class docstring (lines 56-58) explicitly says completing/pausing/sleeping goals is handled by GoalEngineV2 and that this class 'only orchestrates'. A handler that only makes partial progress (e.g. recordWorkSession with progress<100, or scheduleWake to put the goal to sleep) returns normally and triggers a false 'goal:completed'. The event is wired through typed-hooks.ts, plugin-hooks.ts and sse-stream.ts, so subscribers would be told the goal finished. The contract is genuinely ambiguous (the example on lines 62-65 does call engine.completeGoal explicitly), and there are no in-repo work-handler implementations to confirm concrete downstream damage, but the code as written emits a completion signal with no completion check, which is the reported logic error.

---
### H39. Rollback resets to the merged PR head SHA instead of the previous good commit

**`src/core/self-build/deployment-hook.ts:106`** · _wrong variable_ · confidence 0.72

**What:** On CI failure after a merge, the code calls this.rollback(prStatus.headSha). prStatus.headSha is the tip of the merged PR's head (feature) branch, not the previous state of the deployment branch. rollback() does `git reset --hard <sha>`, and its parameter is literally named previousCommitSha — the intent is to reset to the pre-merge commit. Resetting --hard to the feature-branch head does NOT undo the merge; it moves HEAD/working tree to the PR head commit, which may not even be an ancestor of the deployment branch, leaving the repo in a wrong/detached state.

**Failure scenario:** PR #42 is merged into the deployment branch; CI fails. rollback(headSha) runs `git reset --hard <PR-head-sha>`, hard-resetting the checkout to the feature branch tip rather than the known-good pre-merge commit. The deployed code is now whatever the feature branch tip was (still the bad change, or an unrelated commit), and the merge is not actually reverted.

**Fix:** Capture the deployment branch's pre-merge SHA (e.g. `git rev-parse HEAD` before the merge, or use the merge commit's first parent HEAD~1) and pass that to rollback(); do not pass prStatus.headSha.

~~~ts
await this.rollback(prStatus.headSha);
// headSha = merged PR head, not the previous good commit
~~~

> **Skeptic (real):** On CI failure line 106 calls this.rollback(prStatus.headSha). headSha is parsed from data.head.sha (lines 160-161) = the PR's head/feature branch tip, not the pre-merge state of the deployment branch. rollback() (line 202-216) runs `git reset --hard <sha>` and its parameter is literally named previousCommitSha, confirming the intent is the prior good commit. Hard-resetting to the feature head does not revert the merge and can leave the checkout on an unrelated/non-ancestor commit. Wrong-variable bug is real.
>
> **Auditor (real):** On CI failure (line 104-114) the code calls this.rollback(prStatus.headSha). prStatus.headSha is parsed from data['head']['sha'] (line 160-161) — the tip of the PR's head/feature branch, not the deployment branch's pre-merge commit. rollback() (line 202-216) runs `git reset --hard <sha>` and its parameter is literally named previousCommitSha, confirming the intent is the prior good commit. Hard-resetting the deployment checkout to the feature-branch head does not revert the merge and may move HEAD to a commit that is not the known-good pre-merge state. The correct value (pre-merge HEAD or merge-commit's first parent) is never captured. Wrong variable used for rollback target — real bug.

---

## 🟡 Medium confirmed bugs

### M1. Dead guard `wasPending !== undefined` re-fires task:completed hook on re-completion

**`src/core/agent/task-manager.ts:198`** · _logic error_ · confidence 0.9

**What:** In updateTask(), the completion block is gated by `patch.status === 'completed' && wasPending !== undefined`. `wasPending` is a boolean (`task.status === 'pending'`), so `wasPending !== undefined` is ALWAYS true. The guard is effectively just `patch.status === 'completed'`. Because the transition-validation block at lines 179-184 only runs when `patch.status !== task.status`, calling updateTask with status:'completed' on an already-completed task is NOT rejected, falls through, and re-enters this block — re-emitting the task:completed hook and overwriting completedAt. This is exercised by the chunk-74 task-manager.test.ts hook tests (which only complete once and therefore miss it). The intended guard was almost certainly `&& wasPending` (only fire on a true transition) or a check that the status actually changed.

**Failure scenario:** A caller (or a UI re-sync) calls tm.updateTask(id, { status: 'completed' }) on a task that is already 'completed'. The task:completed hook fires a SECOND time (downstream listeners run twice — e.g. duplicate notifications, double-counted metrics, duplicate propagateUnblock), and completedAt is reset to a later timestamp, corrupting the recorded completion time. Empirically confirmed: handler call count went 1 -> 2 and completedAt changed on the second call.

**Fix:** Replace the dead condition with one that fires only on an actual transition into 'completed', e.g.: `if (patch.status === 'completed' && task.completedAt === undefined)` or capture `const wasCompleted = task.status === 'completed'` before mutation and use `if (patch.status === 'completed' && !wasCompleted)`.

~~~ts
const wasPending = task.status === 'pending';
if (patch.status !== undefined && patch.status !== task.status) {
  task.status = patch.status;
}
// Handle completion.
if (patch.status === 'completed' && wasPending !== undefined) {
  task.completedAt = new Date().toISOString();
  this.propagateUnblock(task);
~~~

---
### M2. ToolOutcomeLearner.onSessionEnd fed fabricated per-tool success flags (first-N-are-success)

**`src/core/agent/loop.ts:1389`** · _logic error_ · confidence 0.85

**What:** At session end, outcomes are built as `_w10bToolSequence.map((toolName, idx) => ({ toolName, success: idx < _w10bToolSuccessCount }))`. This marks the FIRST _w10bToolSuccessCount tools in call order as successes and the rest as failures, regardless of which tools actually succeeded. The real per-call success was already known at emit time via isToolResultSuccess() but is discarded. The learner therefore receives systematically wrong per-tool outcome labels.

**Failure scenario:** A session calls toolA (fails), toolB (succeeds). _w10bToolSuccessCount=1. outcomes=[{toolA, success:true},{toolB, success:false}] — exactly inverted from reality. ToolOutcomeLearner then learns that toolA succeeds and toolB fails, corrupting its prevention-rule / outcome statistics and biasing future tool routing.

**Fix:** Track the actual per-call success boolean alongside the tool name (e.g. push {name, success} into _w10bToolSequence) and emit those real outcomes, instead of the idx<successCount approximation.

~~~ts
const outcomes = _w10bToolSequence.map((toolName, idx) => ({
  toolName,
  success: idx < _w10bToolSuccessCount, // approximate: first N are successes
}));
this._toolOutcomeLearner.onSessionEnd(sessionId, outcomes);
~~~

---
### M3. saveUserModel uses INSERT OR REPLACE without created_at, resetting account creation timestamp on every update

**`src/core/consciousness/theory-of-mind/store.ts:108`** · _data corruption_ · confidence 0.85

**What:** The user_models table has a created_at column with a DEFAULT of now(). saveUserModel issues `INSERT OR REPLACE` but omits created_at from the column list. SQLite implements INSERT OR REPLACE by DELETEing the conflicting row and INSERTing a fresh one, so any column not supplied falls back to its DEFAULT. Because created_at is omitted, every save (which happens on each interaction via updateUserModel -> saveUserModel) deletes the original row and re-inserts with created_at = now(), permanently overwriting the user's original creation timestamp.

**Failure scenario:** User U interacts on day 1 (created_at = day1). On day 30 the same user interacts again; updateUserModel calls saveUserModel which does INSERT OR REPLACE without created_at. The old row is deleted and re-created with created_at = day30. The genuine signup/first-seen date is lost and any analytics or relationship-age logic that reads user_models.created_at now reports the wrong (most-recent) date.

**Fix:** Either switch to an explicit UPDATE for existing rows, or preserve created_at: add `created_at` to the INSERT column list using COALESCE against the existing value, e.g. `created_at = (SELECT COALESCE((SELECT created_at FROM user_models WHERE user_id=@userId), strftime(...)))`, or use `INSERT ... ON CONFLICT(user_id) DO UPDATE SET ...` which does not touch unlisted columns.

~~~ts
INSERT OR REPLACE INTO user_models
  (user_id, traits, preferences, communication_style, trust_level,
   known_triggers, known_delights, last_interaction, interaction_count,
   updated_at)
VALUES
  (@userId, ..., strftime('%Y-%m-%dT%H:%M:%fZ','now'))
~~~

---
### M4. Every-minute cron '* * * * *' fires hourly, not every minute

**`src/core/operators/operator-scheduler.ts:78`** · _parsing/cron bug_ · confidence 0.85

**What:** msUntilNextCron/cronRepeatMs only inspect the minute and hour fields. For an every-minute expression (* * * * *), minutePart='*' makes targetMinute=now.getMinutes() and hourPart='*' makes targetHour=-1, so the 'every-hour' branch is taken: the next fire is set to the current minute of the NEXT hour, and cronRepeatMs returns 60*60*1000. There is no validation that warns the operator author. A common, valid cron expression therefore runs 60x less often than requested.

**Failure scenario:** An operator declares schedule = { type='cron', value='* * * * *' } expecting to run once per minute. It actually fires only once per hour, silently breaking any minute-cadence automation with no error logged.

**Fix:** Treat a wildcard minute field combined with a wildcard hour as a 60s repeat (or reject/warn on minute-granularity wildcards), and compute msUntilNextCron accordingly instead of falling into the hourly branch.

~~~ts
const [, hourPart] = parts;
if (hourPart === '*') return 60 * 60 * 1000;   // every hour
return 24 * 60 * 60 * 1000;                      // every day
~~~

---
### M5. npm audit 'moderate' severity is silently downgraded to 'info'

**`src/core/superpowers/security-scan.ts:101`** · _logic error_ · confidence 0.85

**What:** npm audit reports severities as critical/high/moderate/low/info. The allow-list checked here is ['critical','high','medium','low']. Since 'moderate' is not in the list (the code expects 'medium' which npm never emits), every moderate-severity vulnerability falls through to severity 'info' in the findings and in the bySeverity tally.

**Failure scenario:** A project with moderate-severity npm vulnerabilities reports them as 'info', so the summary shows medium=0 and inflates info. Users scanning for medium-risk dependency issues see none, masking real vulnerabilities.

**Fix:** Map npm severities explicitly: const map={critical:'critical',high:'high',moderate:'medium',low:'low'} as const; const severity = map[vuln.severity] ?? 'info';

~~~ts
const severity = (['critical', 'high', 'medium', 'low'] as const).includes(
  vuln.severity as 'critical',
) ? (vuln.severity as Finding['severity']) : 'info';
~~~

---
### M6. exitPlanMode() leaves stale plan.json on disk, causing inconsistent restore (state=normal but activePlan non-null)

**`src/core/agent/plan-mode-v2.ts:186`** · _data corruption_ · confidence 0.85

**What:** exitPlanMode() sets this.activePlan = null then calls _persist(). _persist() only writes plan.json when `if (this.activePlan)` is truthy (line 331), so after exit it writes plan_mode.json with state='normal' but NEVER deletes or clears the previously-written plan.json. On the next construction, _restore() reads state='normal' from plan_mode.json AND reads the stale plan.json into this.activePlan (lines 350-355), producing an internally inconsistent machine: getState()==='normal' yet getActivePlan() returns a non-null finished/old plan. The chunk-74 plan-mode-v2.test.ts persist/restore test only restores while still in plan_approval (activePlan present), so it never exercises the exit-then-restore path.

**Failure scenario:** User enters plan mode, exits it, then the process restarts (or a new PlanModeStateMachine is constructed on the same dataDir). The new machine reports state 'normal' but getActivePlan() returns the stale, already-exited plan. Code that branches on getActivePlan() (e.g. step status updates, ACP toggle which only checks state) operates on or re-surfaces a dead plan — and togglePlanMode() in 'normal' state will enterPlanMode and overwrite, but any direct getActivePlan() consumer sees corrupted state. Empirically confirmed: after enterPlanMode/addStep/exitPlanMode, a fresh instance returned state='normal' with getActivePlan() === a non-null plan object.

**Fix:** In exitPlanMode() (or _persist when activePlan is null) remove the persisted plan.json, e.g. after setting activePlan=null: `try { const p = path.join(this.dataDir,'plan.json'); if (existsSync(p)) rmSync(p); } catch {}`; alternatively, in _restore() only load plan.json when the restored state !== 'normal'.

~~~ts
const plan = this.activePlan;
this._transition('normal');
if (plan) { if (plan.status === 'executing') { plan.status = 'completed'; } }
this.activePlan = null;
this._persist(); // writes plan_mode.json (state=normal) but leaves stale plan.json
~~~

---
### M7. Test 3 write/check path mismatch (wrong directory) always reports false negative

**`tests/full-backend-test.ts:12`** · _logic error_ · confidence 0.85

**What:** Test 3 instructs the agent to create a file at the relative path "test-backend-output.txt" (which will be created under the current project dir /root/sudo-ai-v4 or its tool workspace), but the success check calls fs.existsSync('/root/sudo-ai-v3/test-backend-output.txt') — a completely different, stale project directory. The two paths can never refer to the same file, so the check (line 12) is guaranteed to evaluate to false even when the write actually succeeds. The cleanup at line 60 (unlinkSync of the same /root/sudo-ai-v3 path) likewise never deletes the real file that was created under v4, leaving a leftover artifact behind after each run.

**Failure scenario:** The agent successfully creates ./test-backend-output.txt in /root/sudo-ai-v4. The check looks at /root/sudo-ai-v3/test-backend-output.txt, finds nothing, and marks Test 3 as FAILED (false negative). Meanwhile the cleanup targets the v3 path, so the actual v4 file is never removed and accumulates across runs.

**Fix:** Compute the expected path relative to the actual write location (e.g. path.resolve(process.cwd(), 'test-backend-output.txt') or the tool workspace root) and use the same path for both the existsSync check and the unlinkSync cleanup. Hard-coding /root/sudo-ai-v3 is wrong for the v4 codebase.

~~~ts
check: (_r: string) => { try { return require('fs').existsSync('/root/sudo-ai-v3/test-backend-output.txt'); } catch { return false; } } },
~~~

---
### M8. 403 quota-exceeded is retried 3x despite docstring promising immediate fail

**`src/pipeline/youtube-uploader.ts:255`** · _incorrect error handling / bad retry_ · confidence 0.84

**What:** The function docstring (line 222) states it 'hard-fails immediately on HTTP 403', and initiateResumableUpload/uploadVideoFile deliberately tag 403 responses with code 'pipeline_upload_quota_exceeded'. However the whole upload closure is wrapped in retry() (line 255), and retry() has no error predicate — it retries on EVERY thrown error, including the quota 403. The special 403 handling only happens AFTER the retry loop finishes (line 265), so a 403 is actually retried 3 times with 5s/15s/30s backoff before being surfaced.

**Failure scenario:** When the daily YouTube quota is genuinely exceeded mid-batch, initiateResumableUpload throws pipeline_upload_quota_exceeded on the first attempt. Instead of failing fast, the code waits 5s + 15s + 30s (~50s) re-issuing doomed requests (and burning additional quota units / token refreshes) before finally throwing. This stalls the batch and can compound quota burn.

**Fix:** Pass an error predicate into retry (or check inside the closure) so that errors with code 'pipeline_upload_quota_exceeded' are rethrown immediately without retrying, matching the documented behavior.

~~~ts
videoId = await retry(
  async () => {
    const token = await getAccessToken();
    const uri = await initiateResumableUpload(token, seo, scheduleAt, contentLength);
    return uploadVideoFile(uri, videoPath);
  },
  3,
  [5_000, 15_000, 30_000],
);
~~~

---
### M9. Cost metrics report only the top model's tokens, not the system total due to GROUP BY

**`src/core/consciousness/heartbeat.ts:516`** · _wrong API/library usage_ · confidence 0.83

**What:** The query aggregates SUM(tokens) and the per-day SUM together with GROUP BY model, then ORDER BY cnt DESC LIMIT 1. Because of the GROUP BY, today_tokens and week_tokens are the sums for a SINGLE model (the one with the most rows), not totals across all models. These per-model partial sums are then assigned to metrics.tokensUsedToday / tokensUsedWeek and used to compute estimatedCostToday / estimatedCostWeek.

**Failure scenario:** With usage spread across several models (e.g. one Sonnet model has the most calls but Opus consumed far more tokens), the briefing reports only the top-call-count model's token totals and cost, drastically under-reporting actual usage and cost. The numbers are silently wrong every time more than one model is used.

**Fix:** Compute totals without GROUP BY for the token sums (a separate query/subquery over all rows), and use a second query GROUP BY model ORDER BY cnt DESC LIMIT 1 only to pick topModel. Do not derive token totals from the grouped row.

~~~ts
SELECT
  SUM(CASE WHEN date(created_at)=date('now') THEN tokens ELSE 0 END) AS today_tokens,
  SUM(tokens) AS week_tokens,
  model, COUNT(*) AS cnt
FROM tool_traces
WHERE created_at >= datetime('now','-7 days')
GROUP BY model ORDER BY cnt DESC LIMIT 1
~~~

---
### M10. /clear and Ctrl+L do not reset the agent session — "History cleared" is misleading and agent retains full context

**`src/cli/commands/chat/App.tsx:493`** · _logic-error_ · confidence 0.82

**What:** The /clear command (and Ctrl+L, lines 385-391) clear the UI `messages` array and the local `conversationRef.current`, and print "History cleared.". However the actual conversation history lives in the server-side AgentLoop session, which is keyed by `tuiSessionIdRef.current` (set once at line 136 via nanoid() and NEVER reset anywhere — confirmed by grep). The adapter calls `sessionManager.getOrCreate('web', opts.sessionId)` on every turn (agent-loop-adapter.ts line 176), so the same persistent session is reused and accumulates all prior turns server-side. After /clear, the very next message is still answered with the full prior context. `conversationRef` itself is never sent to the loop (the adapter is invoked with only `message: userText`), so clearing it has no effect on what the model sees.

**Failure scenario:** User runs a long conversation, types /clear, sees "History cleared.", then types a follow-up expecting a fresh context (e.g. for privacy or to drop a confusing thread). The agent still has every prior message in its session memory and answers as if nothing was cleared, leaking prior context and contradicting the displayed confirmation.

**Fix:** On /clear and Ctrl+L, rotate the session: `tuiSessionIdRef.current = nanoid()` (and/or call a session-reset/getOrCreate-fresh on the adapter) so the server-side AgentLoop starts a new empty session. Only then is the displayed "History cleared." accurate.

~~~ts
case '/clear':
  setMessages([]);
  conversationRef.current = [];
  setTurn(0);
  setTotalTokens(0);
  addSystemMsg('History cleared.');
  break;
~~~

---
### M11. Second @-mention never reopens the mention menu

**`src/cli/commands/chat/components/Input.tsx:38`** · _logic-error_ · confidence 0.82

**What:** The mention trigger condition `val.includes('@') && !value.includes('@')` only calls onMentionOpen() when the previous value contained NO '@'. After a first mention is completed (App.tsx sets the input to `...@file.txt ` and clears mentionFilter), the input permanently contains an '@'. There is no other code path that opens the mention menu (App.tsx's handleInputChange only UPDATES an already-open filter and there is no keybinding to open it). So typing a second '@' to mention another file does nothing.

**Failure scenario:** User types '@', selects README.md (input becomes '@README.md '), then types '@' again to mention a second file. Because `value` already contains '@', the menu never opens and autocomplete is silently broken for every mention after the first within a single input line.

**Fix:** Trigger on the newly typed '@' rather than overall presence, e.g. detect that the last typed character is '@' (val.length === value.length + 1 && val.endsWith('@')) or compare the count of '@' between val and value.

~~~ts
// Detect '@' anywhere in value
if (val.includes('@') && !value.includes('@')) {
  onMentionOpen();
}
~~~

---
### M12. Hardcoded concurrency cap of 4 contradicts MAX_SWARM_AGENTS (100) used by the swarm queue

**`src/core/agent/spawn-tool.ts:87`** · _logic-error_ · confidence 0.82

**What:** The tool rejects spawns when swarm.getActive().length >= 4 with the message 'max 4'. But AgentSwarm constructs its PQueue with concurrency = MAX_SWARM_AGENTS, which is defined as 100 in src/core/shared/constants.ts. The tool's gate is therefore inconsistent with the actual configured limit: it refuses legitimate spawns once 4 are running even though the swarm is configured to run up to 100, and conversely the swarm itself never enforces a hard cap of 4.

**Failure scenario:** When 4 sub-agents are running, all further agent.spawn tool calls fail with 'max 4' even though the swarm could run 96 more. If the intended hard cap was actually 4, then bypassing the tool (e.g. spawnMany or spawnAsync) lets 100 run, violating the cap. Either way behavior is wrong and the limit is not what either side believes it to be.

**Fix:** Import MAX_SWARM_AGENTS and compare against it (active.length >= MAX_SWARM_AGENTS) and use the constant in the error message, or expose the configured concurrency from AgentSwarm and use that single source of truth.

~~~ts
const active = swarm.getActive();
if (active.length >= 4) {
  return {
    success: false,
    output: `Cannot spawn sub-agent: ${active.length} sub-agents already running (max 4).`,
  };
}
~~~

---
### M13. Keyword heuristic mislabels no-match input as 'coding'

**`src/core/brain/negative-router.ts:225`** · _logic-error_ · confidence 0.82

**What:** The tie-break block at lines 225-227 runs unconditionally after the best-score loop. When no keyword/bigram matches, all category scores are 0, so bestScore stays 0. Then `scores.coding === bestScore` evaluates as `0 === 0` → true, overwriting bestCat from 'fast' to 'coding'. The function returns category='coding' (and model=ROUTING_MODELS.coding) for input that matched nothing. The tie-break should only apply when bestScore > 0.

**Failure scenario:** route('', 'hello how are you today') produces zero keyword matches. runKeywordHeuristic returns category='coding', confidence=0. In brain.ts the model isn't switched (confidence < 0.5) but RoutingResult.category is reported as 'coding' in logs/results, misclassifying a casual greeting as a coding task for any consumer that branches on category.

**Fix:** Guard the tie-break: `if (bestScore > 0) { if (scores.coding === bestScore) bestCat='coding'; else if (...) }`. When bestScore===0 leave bestCat='fast'.

~~~ts
if (scores.coding === bestScore) bestCat = 'coding';
else if (scores.analysis === bestScore) bestCat = 'analysis';
else if (scores.research === bestScore) bestCat = 'research';

// Normalise: score of 6+ is full confidence
const confidence = bestScore > 0 ? Math.min(bestScore / 6, 1) : 0;
~~~

---
### M14. Day-of-week / weekly cron expressions are ignored, causing daily firing

**`src/core/operators/operator-scheduler.ts:40`** · _parsing/cron bug_ · confidence 0.82

**What:** msUntilNextCron destructures only [minutePart, hourPart] and never reads parts[2] (day-of-month) or parts[4] (day-of-week). For a weekly expression like '0 9 * * 1' (Monday 09:00), it schedules the next 09:00 on the very next day and cronRepeatMs returns a 24h repeat. The day-of-week constraint is silently dropped, so a weekly operator fires every day.

**Failure scenario:** An operator scheduled '0 9 * * 1' (weekly, Monday morning) instead runs every single day at 09:00 — 7x more often than intended, e.g. sending a weekly report daily.

**Fix:** Parse and honor the day-of-month and day-of-week fields when computing the next fire time and the repeat interval, or reject cron expressions whose day fields are not '*' with a clear error rather than silently ignoring them.

~~~ts
const now = new Date();
const [minutePart, hourPart] = parts;
// parts[2] (day-of-month) and parts[4] (day-of-week) are never read
~~~

---
### M15. WebSocket subprotocol passed via options.protocol is ignored by the ws library

**`src/core/tools/mcp-ws-transport.ts:161`** · _wrong API/library usage_ · confidence 0.82

**What:** The code requests the 'json-rpc' subprotocol by setting `options.protocol = this.config.protocol` and passing options as the only argument to `new WebSocket(url, options)`. The ws library's initAsClient explicitly overwrites `protocol: undefined` AFTER spreading the caller options (node_modules/ws/lib/websocket.js line ~671), and only sets the Sec-WebSocket-Protocol header from the second positional `protocols` constructor argument. Therefore the requested subprotocol is never sent to the server.

**Failure scenario:** mcp-adapter.ts constructs WSTransport with `protocol: 'json-rpc'`. The server never receives a Sec-WebSocket-Protocol: json-rpc header. A server that requires/negotiates that subprotocol will either reject the handshake or fall back to no subprotocol, breaking or silently degrading the connection — and the agent believes it negotiated json-rpc when it did not.

**Fix:** Pass the subprotocol as the second positional argument: `new WebSocket(this.config.url, this.config.protocol ? [this.config.protocol] : [], options)` and remove the ineffective `options.protocol` assignment.

~~~ts
      if (this.config.protocol) {
        options.protocol = this.config.protocol;
      }
      ...
      const ws = new WebSocket(this.config.url, options);
~~~

---
### M16. Partial system-alert clobbers existing metrics with undefined

**`src/renderer/hooks/useOfficeWebSocket.ts:178`** · _logic error_ · confidence 0.82

**What:** The 'system-alert' handler guards entry on whether ANY of cpu/memory/disk/uptime is defined (lines 172-177), but then unconditionally passes all four keys to updateMetrics. officeStore.updateMetrics does `{ ...s.metrics, ...metrics }`, so any key whose value is undefined overwrites the previously stored numeric value with undefined. The metrics fields are typed `number`, so this puts the store into an invalid runtime state.

**Failure scenario:** Backend emits a system-alert containing only `{cpu: 50}` (memory/disk/uptime omitted). dispatch calls updateMetrics({cpu:50, memory:undefined, disk:undefined, uptime:undefined}). The spread overwrites memory/disk/uptime with undefined. MissionControl.tsx then renders `{metrics.memory}%` as 'undefined%' and calls formatUptime(undefined), producing NaN/garbage output. Previously-known good values are permanently lost until a full alert arrives.

**Fix:** Build the partial payload conditionally, only including keys that are defined, e.g.: `const m: Partial<OfficeMetrics> = {}; if (msg.cpu !== undefined) m.cpu = msg.cpu; if (msg.memory !== undefined) m.memory = msg.memory; ...; updateMetrics(m);`

~~~ts
updateMetrics({
  cpu: msg.cpu,
  memory: msg.memory,
  disk: msg.disk,
  uptime: msg.uptime,
});
~~~

---
### M17. sendJson calls res.write() after res.end() (write-after-end) — masked by the in-chunk test mock

**`src/core/cron/multi-delivery-routes.ts:44`** · _wrong API/library usage_ · confidence 0.82

**What:** The sendJson helper writes the body via r.end?.(body) and then immediately via r.write?.(body). On a real Node http.ServerResponse, calling write() after end() raises ERR_STREAM_WRITE_AFTER_END (an error is emitted on the response stream). Every cron REST route (listJobs/createJob/getJob/updateJob/deleteJob/runJob/enableJob/disableJob) funnels through this helper, so each successful response would trigger a write-after-end error against a real server. The assigned in-chunk test tests/cron/multi-delivery.test.ts hides this defect: its mockRes (lines 263-278) defines end and write as harmless field setters, so the bug never surfaces in the test, and the route helper appears correct. A correct mirror of Node's response (where write-after-end throws/emits) would have failed and caught this.

**Failure scenario:** When createCronRoutes is wired to a real http.Server (the routes are explicitly written to operate on Node-style req/res), any 2xx/4xx response calls res.end(body) then res.write(body); Node emits ERR_STREAM_WRITE_AFTER_END on the response. Depending on how the server handles the response 'error' event, this logs an unhandled error and/or corrupts/duplicates the response. The unit test passes regardless because the mock res.write is a no-op setter, giving false confidence the handler is correct.

**Fix:** Send the body exactly once: write the body then end with no args, or end with the body and do not call write. e.g. replace the two lines with `r.end?.(body);` only (drop the r.write?.(body) line). For symmetry with the dashboard routes, prefer `res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(data));`. Additionally, update the test's mockRes so write-after-end is detectable (e.g. set an 'ended' flag in end() and throw from write() if already ended).

~~~ts
  r.statusCode = status;
  r.setHeader?.('Content-Type', 'application/json');
  const body = JSON.stringify(data);
  r.end?.(body);
  r.write?.(body);
~~~

---
### M18. usage-stats DB mock is a no-op; tests silently read real production data/audit.db

**`tests/tools/skill-meta.test.ts:138`** · _wrong API/library usage; non-hermetic test_ · confidence 0.82

**What:** The `requireSpy` calls `vi.spyOn({ require } as ..., 'require')` on a throwaway object literal, so it never intercepts the `require('better-sqlite3')` performed inside src/core/tools/builtin/skill/tools/usage-stats.ts (line 30). vi.spyOn is also given no mock implementation, so even the wrapped function would call through to the real constructor. Consequently the in-memory `auditDb`/`calibDb` built in beforeEach are never injected into usageStatsTool. getUsageStats opens `path.resolve('data')/audit.db` and `calibration.db`, and those files actually exist at the repo root (verified: data/audit.db, data/calibration.db present). The tests in the 'skill.usage-stats' block (lines 152-177), explicitly titled 'returns empty stats when no DB file exists (fail-open)', therefore exercise the real production DB rather than a missing/mocked DB, and only pass because their assertions are extremely loose (result.success===true, result.output truthy).

**Failure scenario:** In an environment where data/audit.db is absent the tool takes the fail-open branch; in this repo (and CI checkouts that include the data/ artifacts) the same test reads real production audit rows. The test outcome thus depends on external on-disk state — it is non-hermetic and gives false confidence that the DB-backed code path is covered. A real regression in the DB query path would not be caught because the intended in-memory fixtures are never used.

**Fix:** Mock the module under test's dependency directly, e.g. `vi.mock('better-sqlite3', () => ({ default: vi.fn(() => inMemoryDb) }))` and point DATA_DIR/AUDIT_DB at a temp dir (or have usage-stats accept an injectable db), so getUsageStats receives the in-memory auditDb/calibDb. Remove the ineffective requireSpy on the object literal.

~~~ts
requireSpy = vi.spyOn(
  // @ts-expect-error — accessing module internals for mocking
  { require } as { require: NodeJS.Require },
  'require',
);
~~~

---
### M19. updateTask re-fires task:completed (and resets completedAt / re-propagates unblock) on an already-completed task

**`src/core/agent/task-manager.ts:198`** · _logic-error_ · confidence 0.8

**What:** The completion branch is gated by `patch.status === 'completed' && wasPending !== undefined`. wasPending is a boolean (`task.status === 'pending'`), so `wasPending !== undefined` is ALWAYS true and is a no-op guard. Meanwhile the transition-validation at line 179 is skipped when patch.status === task.status. So calling updateTask(id, {status:'completed'}) on a task that is already 'completed' bypasses validation, then enters the completion block, overwrites completedAt with a new timestamp, calls propagateUnblock again, and emits a duplicate task:completed hook.

**Failure scenario:** An agent or caller idempotently sets a completed task to 'completed' again. Instead of being a no-op, completedAt is silently overwritten to a later time and the task:completed hook fires a second (or Nth) time, causing duplicate downstream side effects (notifications, metrics, dependency re-processing). The misnamed `wasPending` guard provides no protection.

**Fix:** Guard on an actual transition into completed: e.g. `const becameCompleted = patch.status === 'completed' && task.status !== 'completed';` capture BEFORE applying status, and use that boolean. Remove the meaningless `wasPending !== undefined` check.

~~~ts
const wasPending = task.status === 'pending';
if (patch.status !== undefined && patch.status !== task.status) {
  task.status = patch.status;
}
if (patch.status === 'completed' && wasPending !== undefined) {
  task.completedAt = new Date().toISOString();
  this.propagateUnblock(task);
~~~

---
### M20. Trigger ID derived only from Date.now() collides and silently overwrites when two triggers are created in the same millisecond

**`src/core/agent/remote-triggers.ts:72`** · _logic-error_ · confidence 0.8

**What:** createTrigger generates id = `trigger-${Date.now()}` and stores it in the Map. Two triggers created within the same millisecond produce identical IDs; the second triggers.set overwrites the first with no warning. The first trigger is lost from the store and can never be enabled/disabled/deleted/fired.

**Failure scenario:** A bootstrap routine or batch import registers several triggers in a tight loop (sub-millisecond). Some triggers silently vanish (overwritten), so scheduled prompts that were supposed to run never fire, and deleteTrigger/enableTrigger on the lost ID report 'not found'.

**Fix:** Use a collision-resistant ID such as genId() (nanoid, already used elsewhere in this codebase) or append a random suffix: `trigger-${Date.now()}-${nanoid(6)}`.

~~~ts
const id = `trigger-${Date.now()}`;
const trigger: RemoteTrigger = { id, name, cron, prompt, agentType, enabled: true };
triggers.set(id, trigger);
~~~

---
### M21. SlackPoller uses one shared _lastTs cursor across multiple channels, causing message loss

**`src/core/channels/slack-receive.ts:183`** · _logic-error_ · confidence 0.8

**What:** SlackPoller._poll iterates over all configured channels but uses a single shared this._lastTs both as the `oldest` query parameter and as the high-water mark, updated to the ts of the last processed message in whichever channel was iterated last. Because channels are polled sequentially with the same cursor, after processing channel A's newest message the cursor advances; channel B is then queried with `oldest=<A's newest ts>`, silently skipping any of B's messages older than that timestamp. The cursor is also reset across the channel loop iterations, so it ends each cycle pinned to the last channel.

**Failure scenario:** With SLACK_POLL_CHANNELS=C1,C2 and traffic in both, C1 receives a recent message advancing _lastTs; on the same or next poll cycle C2's slightly older but unseen message has ts < _lastTs, so the `oldest=` filter excludes it and the message is never dispatched. Inbound Slack messages are dropped.

**Fix:** Track a per-channel cursor: `private _lastTs = new Map<string,string>()` keyed by channelId, initialise each lazily, and use/update the per-channel value inside the loop.

~~~ts
for (const msg of [...data.messages].reverse()) {
  if (msg['bot_id']) continue;
  await this._handler?.({ /* ... */ ts: String(msg['ts'] ?? ''), /* ... */ });
  this._lastTs = String(msg['ts']);
}
~~~

---
### M22. consolidate() appends freshly-detected patterns to existing patterns without dedup, causing unbounded growth

**`src/core/consciousness/dream-consolidator.ts:249`** · _resource leak / unbounded growth_ · confidence 0.8

**What:** Each consolidate() call loads existing patterns, runs detectPatterns() over the surviving memories, then writes `[...existingPatterns, ...newPatterns]`. detectPatterns() emits one pattern per topic with 3+ memories, generating a brand-new id (genId) and foundAt every run. Because memories persist across runs, the same topics regenerate equivalent patterns on every consolidation pass and are appended indefinitely. There is no replacement, dedup, or pruning of prior patterns.

**Failure scenario:** A long-running agent calls consolidate() during idle cycles (its intended use). With, say, 5 topics each holding 3+ memories, every consolidation adds 5 new pattern records. After 1,000 idle consolidations patterns.json holds ~5,000 near-duplicate pattern entries describing the same 5 topics, bloating disk, load/parse time, and getPatterns()/getStats() results.

**Fix:** Replace rather than append: write only `newPatterns`, or merge by topic/key and dedupe (e.g. keep the latest pattern per topic), or cap the retained pattern history.

~~~ts
const newPatterns = this.detectPatterns(compacted);
const allPatterns = [...existingPatterns, ...newPatterns];
savePatterns(this.config.dataDir, allPatterns);
~~~

---
### M23. fbDb SQLite handle leaks when any feedback/auto-research step throws

**`src/core/self-improvement/engine.ts:269`** · _resource leak_ · confidence 0.8

**What:** fbDb is opened at line 197 and closed at line 269, but the close() call is the last statement inside the try block. Any throw between lines 198-267 (e.g. getToolStats/getSuccessPatterns, or an unexpected error path) jumps to the catch at line 270, which logs a warning and returns without ever calling fbDb.close(). The handle (opened in WAL mode) is leaked. Repeated leaked WAL connections keep -wal/-shm files and connections alive and can accumulate across runs.

**Failure scenario:** feedbackMemory.getToolStats() or getSuccessPatterns() throws on a corrupt or locked DB. Control jumps to the outer catch; fbDb.close() is skipped. The connection leaks; over many cron runs the process accumulates open SQLite handles / WAL files.

**Fix:** Wrap the body in try/finally and call fbDb.close() in the finally block (declare fbDb outside the try so finally can see it).

~~~ts
const fbDb = new Database(DB_PATH);
...
      fbDb.close();
    } catch (err) {
      log.warn(...); // close() skipped on throw
~~~

---
### M24. Playwright browser not closed when page.goto/page.pdf throws

**`src/core/superpowers/pdf-generator.ts:122`** · _resource leak_ · confidence 0.8

**What:** The browser is launched at line 98. If page.goto (networkidle can hang/throw) or page.pdf throws, control jumps to the catch block which only unlinks the temp file. browser.close() is never called, leaking a headless Chromium process (and its OS resources) for every failed render.

**Failure scenario:** A PDF render that fails (e.g. waitUntil:'networkidle' times out, malformed HTML, output path unwritable) leaves an orphaned Chromium process. Repeated failures accumulate zombie browser processes and exhaust memory/file descriptors over time.

**Fix:** Track the browser in an outer-scope variable and close it in a finally block: let browser; try { browser = await chromium.launch(...); ... } finally { await browser?.close().catch(()=>{}); await unlink(tmpFile).catch(()=>{}); }

~~~ts
      await browser.close();
      await unlink(tmpFile).catch(() => { /* non-fatal */ });
...
    } catch (err) {
      ...
      await unlink(tmpFile).catch(() => { /* non-fatal */ });
      return { success: false, output: `PDF generation failed: ${msg}` };
~~~

---
### M25. WebSocket heartbeat fires only once — periodic liveness checks stop after the first ping

**`src/core/tools/mcp-ws-transport.ts:238`** · _logic error / broken state machine_ · confidence 0.8

**What:** _startHeartbeat -> _scheduleHeartbeat sets a one-shot setTimeout. When it fires it pings and calls _scheduleHeartbeatTimeout(), but it never re-arms the next heartbeat (no recursive _scheduleHeartbeat() call) and never resets heartbeatTimer. On 'pong'/'message' only _resetHeartbeatTimeout() runs, which clears the pong-timeout timer but also does not reschedule the next heartbeat. As a result exactly one ping is ever sent for the lifetime of a connection.

**Failure scenario:** A WebSocket MCP connection that silently dies (half-open TCP, no FIN/RST) after the first heartbeat interval will never be probed again. The heartbeat-timeout-driven reconnect (`_scheduleHeartbeatTimeout` -> terminate -> reconnect) can therefore never trigger, so the adapter keeps a dead connection indefinitely and tool calls time out individually instead of forcing a reconnect.

**Fix:** After sending the ping in _scheduleHeartbeat, schedule the next heartbeat (e.g. call this._scheduleHeartbeat() again), or restart the heartbeat in _resetHeartbeatTimeout()/on pong, so pings recur every heartbeatIntervalMs.

~~~ts
    this.heartbeatTimer = setTimeout(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();
        this._scheduleHeartbeatTimeout();
      }
    }, this.config.heartbeatIntervalMs);
~~~

---
### M26. Bootstrap retry-exhaustion fallback returns empty string instead of last input

**`src/core/workspace/bootstrap.ts:186`** · _logic-error_ · confidence 0.8

**What:** _runStep loops up to MAX_RETRIES. If every attempt fails validation, the fallback returns `(this.state.data[step.key] ?? '').trim()`. But state.data[step.key] is only assigned by run() AFTER _runStep returns (line 137). During the first time a step is processed, state.data[step.key] is undefined, so the fallback always yields '' — discarding the `raw` value the comment claims to reuse ('using last raw input').

**Failure scenario:** User repeatedly gives invalid answers to a required field (e.g. ownerName or vibe). After 3 failed validations, instead of accepting the last entered text the function stores an empty string. IDENTITY.md / USER.md are then written with blank or fallback values, silently losing the user's actual input.

**Fix:** Capture the last received `raw` in a local variable inside the loop and return that on exhaustion: `let last = ''; ... last = raw; ... return (step.transform ? step.transform(last) : last.trim());`.

~~~ts
    // After max retries, accept whatever was last received
    log.warn({ step: step.key }, 'Step exceeded max retries — using last raw input');
    return (this.state.data[step.key] ?? '').trim();
~~~

---
### M27. Manual Refresh error handling is dead code; ErrorBanner never displays errors

**`src/renderer/admin/Dashboard.tsx:49`** · _incorrect-error-handling_ · confidence 0.8

**What:** refresh() awaits refreshDigest()/refreshVeto() inside try/catch and pushes any thrown error into errorsList, then only calls setErrors(errorsList)/setStatus('error') when errorsList.length>0 (lines 48-62). But the hooks' refresh is fetchDigest/fetchThreshold, which internally catch all errors, set their own `error` state, and never re-throw (useDigest.ts/useVetoThreshold.ts). So `await refreshDigest()` never rejects, the catch blocks (lines 50-52, 54-57) never execute, errorsList is always empty, and setErrors is never called with anything. Consequently the `errors` state is permanently [] and <ErrorBanner errors={errors}> (line 181) never renders. The manual Refresh path also always sets status='ok' (line 64-66) even when the underlying fetch failed, before the separate effect (lines 104-122) corrects it.

**Failure scenario:** Admin clicks Refresh while the digest/veto endpoint is down. The catch blocks never run, status is set to 'ok' with statusText 'Connected', and the ErrorBanner stays hidden. The dashboard briefly/falsely reports success and the dedicated error banner UI is effectively dead, so failures are only ever shown via the small status text (and only because of the secondary effect), never the banner.

**Fix:** Have the hooks expose a refresh that rejects on failure (return the promise and re-throw in fetch), OR drive the Dashboard error state from the hooks' returned error fields (digestError/vetoError) instead of relying on thrown exceptions, populating `errors` from those values so ErrorBanner can render.

~~~ts
    try {
      await refreshDigest();
    } catch (e) {
      errorsList.push(`digest: ${e instanceof Error ? e.message : 'Unknown error'}`);
    }
~~~

---
### M28. Environment variable value is masked/displayed using key+value concatenation, corrupting the displayed value and the masking decision

**`src/renderer/components/admin/system/AdminSystemPage.tsx:387`** · _logic error / data corruption_ · confidence 0.8

**What:** maskValue is called with `key + value` instead of `value`. maskValue (lines 51-63) (a) decides sensitivity by substring-matching the passed string and (b) when not sensitive returns the (possibly truncated) string itself. Passing `key + value` means non-sensitive values are rendered with the variable name prepended (e.g. key='NODE_ENV', value='production' shows 'NODE_ENVproduction'), and the sensitivity test now matches the key name as well, so masking can be triggered or suppressed by the key rather than the value's content.

**Failure scenario:** On the System > Environment tab, a non-sensitive variable such as NODE_ENV=production is displayed as 'NODE_ENVproduction', and the 60-char truncation cutoff is computed against the wrong (longer) string. A value that should be masked but whose key+value contains no sensitive keyword (e.g. key='HEADER', value='Bearer abc...') is shown in cleartext.

**Fix:** Mask only the value: `value: maskValue(value)` (keep maskValue checking the value's own content, or pass the key separately if key-based masking is intended).

~~~ts
const mapped: EnvRow[] = Object.entries(record ?? {}).map(([key, value]) => ({
  key,
  value: maskValue(key + value),
}));
~~~

---
### M29. Inverted percent-sign logic: '%' shown only for integer changes, omitted for fractional ones

**`src/renderer/components/dashboard/MetricCard.tsx:29`** · _logic error_ · confidence 0.8

**What:** changeText appends '%' based on `typeof change === 'number' && !Number.isInteger(change) ? '' : '%'`. Since `change` is typed (and passed) as number, `typeof change === 'number'` is always true, so the suffix collapses to: non-integer change => '' (no percent), integer change => '%'. This is inverted/incorrect: fractional percentage deltas render without a unit while whole-number deltas get a '%'. The 'vs last week' label and arrow imply all of these are percentages.

**Failure scenario:** DashboardView passes viewsChange=12.4 and revenueChange=8.2 (non-integers) and videosChange=6 (integer). The card renders '+12.4 vs last week' (missing %) for views/revenue, but '+6% vs last week' for videos. Users see inconsistent, mislabeled metric deltas; a 12.4% change looks like a raw count.

**Fix:** Always append '%' (the metric is a percentage delta): `const changeText = `${isPositive ? '+' : ''}${change}%`;` — or remove the broken conditional entirely.

~~~ts
const changeText = `${isPositive ? '+' : ''}${change}${typeof change === 'number' && !Number.isInteger(change) ? '' : '%'}`;
~~~

---
### M30. downloadLogs bypasses auth header and ignores non-OK responses

**`src/renderer/lib/admin-api.ts:270`** · _incorrect error handling / auth_ · confidence 0.8

**What:** Every other admin call routes through the api() helper, which attaches the `Authorization: Bearer <_token>` header (lines 29-30) and throws on non-OK responses (line 36). downloadLogs instead calls a bare `fetch('/api/admin/logs/download')` with no Authorization header and no `r.ok` check, returning `r.text()` directly. The admin router (src/core/api/admin-router.ts:133-145) rejects every admin route with 401 when SUDO_AI_DASHBOARD_TOKEN is configured.

**Failure scenario:** With SUDO_AI_DASHBOARD_TOKEN set, downloadLogs() sends no Bearer token, the server responds 401 with a JSON error body, and the function returns that error JSON string as if it were the downloaded log file. The user gets a 'log file' whose contents are `{"error":{"message":"Unauthorized","code":401}}` with no error surfaced.

**Fix:** Route through the authenticated helper and check status, e.g. add a text-returning branch in api() or: `const res = await fetch('/api/admin/logs/download', { headers: _token ? { Authorization: `Bearer ${_token}` } : {} }); if (!res.ok) throw new Error(`API error: ${res.status}`); return res.text();`

~~~ts
export const downloadLogs = () =>
  fetch('/api/admin/logs/download').then((r) => r.text());
~~~

---
### M31. Cached empty self-id after whoami failure permanently disables own-message filtering (self-response loop)

**`src/core/channels/matrix.ts:171`** · _logic-error_ · confidence 0.78

**What:** _getSelfId() caches the result in this._selfId. On the first call, if the whoami request throws, the catch sets this._selfId = '' (empty string). Because the cache guard is `if (this._selfId !== undefined) return this._selfId`, an empty string is treated as a valid cached value and whoami is never retried. In _processSync, own-message filtering is `if (sender === selfId) continue;` — with selfId='' this never matches a real Matrix user_id, so the bot's OWN outbound messages (which appear in the joined-room timeline on the next sync) get dispatched to the handler.

**Failure scenario:** A transient network error on the very first whoami call (e.g., homeserver briefly unavailable during startup) sets _selfId=''. The bot then treats every message — including the ones it just sent — as inbound, dispatches them to the brain, generates a reply, sends it, which appears in the next sync, and so on: an infinite self-reply loop / message storm.

**Fix:** Do not cache the empty fallback: only memoize a non-empty user_id (e.g., `if (this._selfId) return this._selfId;` and leave it undefined on failure so it retries), or store a sentinel and skip dispatch when selfId is unknown.

~~~ts
private async _getSelfId(): Promise<string> {
  if (this._selfId !== undefined) return this._selfId;
  try {
    const data = await this._req('GET', '/_matrix/client/v3/account/whoami');
    this._selfId = String(data['user_id'] ?? '');
  } catch { this._selfId = ''; }
  return this._selfId;
}
~~~

---
### M32. One-shot tasks inherit recurring 7-day expiry and can be deleted before firing

**`src/core/consciousness/cron-scheduler.ts:295`** · _logic error_ · confidence 0.78

**What:** In schedule(), `expiresAt` is computed as `now + recurringExpiryDays * 24h` for EVERY task regardless of `kind`. The documented contract (file header) states one-shot tasks should only auto-delete after firing once, while only recurring tasks auto-expire after 7 days. Because cron expressions can target specific future dates/months, a one-shot task whose next match is more than `recurringExpiryDays` (default 7) days away will be removed by the expiry check in tick() (lines 413-417) before its scheduled time ever arrives, so it never fires.

**Failure scenario:** On June 3 a one-shot task `0 9 1 7 *` (July 1, 09:00) is scheduled. expiresAt is set to ~June 10. In tick() the expiry check `new Date(task.expiresAt).getTime() <= now` fires on June 10 and the task is added to toDelete and removed. When July 1 arrives the task no longer exists and never fires, silently dropping the scheduled action.

**Fix:** Only apply the 7-day expiry to recurring tasks; for one-shot tasks either omit expiry or set expiresAt based on the computed next fire time of the cron expression. E.g. `const expiresAt = kind === 'recurring' ? new Date(now.getTime()+...).toISOString() : <far-future-or-next-fire>;`

~~~ts
const expiresAt = new Date(
  now.getTime() + this.config.recurringExpiryDays * 24 * 60 * 60 * 1000,
).toISOString();
~~~

---
### M33. getBestUploadTime always returns 00:00 UTC because recordedAt has no time component

**`src/core/earning/optimizer.ts:135`** · _logic-error_ · confidence 0.78

**What:** getBestUploadTime() derives the upload hour via extractUploadHour(v.recordedAt) -> new Date(iso).getUTCHours(). But recordedAt is always a date-only string 'YYYY-MM-DD': getTopVideos sets recordedAt = r.snapshot_at.split('T')[0], and pullMetrics sets recordedAt = todayISO() which is also date-only (todayISO = new Date().toISOString().split('T')[0]). new Date('2026-03-27') parses to UTC midnight, so getUTCHours() returns 0 for every video (it is a valid date, so the isNaN fallback of 12 never triggers). The 'best upload hour' computation is therefore degenerate.

**Failure scenario:** With any real stored data, every video maps to hour bucket 0, so getBestUploadTime always returns '00:00 UTC' and getRecommendations always advises 'Optimal upload window: 00:00 UTC' regardless of actual performance — the optimizer's core recommendation is systematically wrong.

**Fix:** Preserve the full timestamp: have getTopVideos return the full snapshot_at (not split('T')[0]) for recordedAt, or compute upload-hour analytics from the full snapshot_at column directly in SQL/JS rather than from a date-truncated field.

~~~ts
for (const v of videos) {
  const hour = extractUploadHour(v.recordedAt);
  if (!hourMap[hour]) hourMap[hour] = [];
  hourMap[hour].push(v.views);
}
~~~

---
### M34. getRecentMessages returns the OLDEST n messages, not the most recent n

**`src/core/sessions/outcome-adapters.ts:47`** · _logic-error_ · confidence 0.78

**What:** getRecentMessages is documented as 'Return the last n messages' and is consumed by SessionOutcomeListener (session-outcome-listener.ts:146 requests n=20) to evaluate whether a session's goal was achieved. It calls store.getMessages(sessionId, n), but SqliteSessionStore.getMessages uses `ORDER BY id ASC LIMIT ?` (sqlite-session-store.ts:181-187), which returns the FIRST n (oldest) messages. For any session with more than n messages, the goal evaluator receives the opening messages instead of the final outcome messages.

**Failure scenario:** A session accumulates 200 messages and then reaches a terminal state. The outcome listener requests the 'last 20' messages to judge goal completion, but receives messages 1-20 (the start of the conversation). Goal evaluation is performed on irrelevant early context, producing wrong achieved/failed outcomes recorded to the OutcomesLedger.

**Fix:** Add an ordering option to getMessages (or a dedicated getRecentMessages) that selects the latest rows: `ORDER BY id DESC LIMIT ?` then reverse to chronological, mirroring MindDB.getSessionMessages.

~~~ts
const rows = store.getMessages(sessionId, n);
return rows.map((r) => ({ role: r.role, content: r.content }));
~~~

---
### M35. Watermark text interpolated into SVG without XML escaping

**`src/core/superpowers/image-editor.ts:124`** · _parsing/coercion bug_ · confidence 0.78

**What:** Watermark text is inserted directly into an SVG template: `<text ...>${w.text}</text>`. If the text contains XML-special characters (<, >, &, " or unbalanced markup), the resulting SVG is malformed. sharp parses SVG strictly and will throw, failing the whole image operation; in some cases it could inject arbitrary SVG/markup.

**Failure scenario:** super.edit-image with a watermark op text='A & B <fast>' produces invalid XML, sharp throws 'Input buffer contains unsupported image format' / parse error, and the edit fails for legitimate text containing ampersands or angle brackets.

**Fix:** Escape the text before embedding: const esc = w.text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); then use esc in the template.

~~~ts
const svg = Buffer.from(
  `<svg><text x="10" y="30" font-size="24" fill="white" opacity="0.7">${w.text}</text></svg>`,
);
~~~

---
### M36. Running-average duration computation uses wrong denominator when some rows lack durationMs

**`src/core/tools/builtin/skill/tools/usage-stats.ts:101`** · _parsing-coercion-bug_ · confidence 0.78

**What:** avgDurationMs is updated with the incremental-mean formula `(avg*(total-1)+dur)/total` using `entry.totalCalls`, which is incremented for EVERY audit row regardless of whether that row carried a durationMs sample. The incremental-mean formula is only correct when totalCalls equals the count of samples seen so far. When some rows have no durationMs (or non-numeric/zero), the denominator overcounts the number of duration samples, so the computed average is systematically wrong (skewed toward zero and not a true mean of the available samples).

**Failure scenario:** A tool has 10 audit rows but only 4 carry durationMs. By the 4th duration sample, totalCalls may already be 8, so the formula divides by 8 instead of 4, producing an avgDurationMs far below the real average. skill.usage-stats and skill.explain then report an incorrect average latency.

**Fix:** Track a separate per-entry counter for rows that actually contributed a duration sample (e.g. entry.durationSamples), and use that as the denominator/weight in the incremental mean instead of entry.totalCalls.

~~~ts
if (typeof dur === 'number' && dur > 0) {
  // Running average: (prev_avg * (total-1) + new) / total
  entry.avgDurationMs = (entry.avgDurationMs * (entry.totalCalls - 1) + dur) / entry.totalCalls;
}
~~~

---
### M37. SSE event/data parsing reads the wrong source, duplicating and mis-pairing messages

**`src/core/tools/mcp-sse-transport.ts:210`** · _parsing bug_ · confidence 0.78

**What:** When a line beginning with 'event:' is encountered, _readNextDataLine is called with only the leftover `buffer` and reads NEW chunks from the stream to find the following 'data:' line. But the corresponding 'data:' line is normally already present in the current `lines` array (the outer loop already split the chunk). _readNextDataLine ignores those already-split lines and blocks on reader.read() for the next chunk. The real data line is then ALSO processed by the outer loop as a standalone 'data:' message.

**Failure scenario:** For a typical SSE frame delivered in one chunk ('event: message\ndata: {json}\n'), the parser emits a first message by blocking until the NEXT network chunk arrives (pairing the event with unrelated future data), and separately emits the {json} line as its own message via the outer loop. This yields duplicated/mis-ordered JSON-RPC responses and stalls until additional traffic arrives, corrupting MCP request/response matching.

**Fix:** Parse SSE frames by accumulating field lines until a blank line (event terminator), associating event/id/retry/data fields within the same frame from the already-split lines, instead of doing an out-of-band read for the next data line.

~~~ts
          } else if (trimmed.startsWith('event:')) {
            const eventType = trimmed.slice(6).trim();
            const nextLine = await this._readNextDataLine(reader, decoder, buffer);
            if (nextLine.data) {
              this._emitMessage({ event: eventType, data: nextLine.data, id: lastEventId, retry: nextLine.retry });
              buffer = nextLine.buffer;
            }
~~~

---
### M38. Reasoning extraction treats SDK v6 result.reasoning (an array) as string/object-with-text

**`src/core/brain/brain.ts:889`** · _wrong API/library usage_ · confidence 0.75

**What:** In _callSingleModel, when result.text is empty the code tries to recover content from result.reasoning, handling it as either a string or an object { text?: string }. In the installed AI SDK v6 (ai@6.0.138), GenerateTextResult.reasoning is typed Array<ReasoningPart> (verified at node_modules/ai/dist/index.d.ts line 758); the plain string lives in result.reasoningText (line 762). For an array: typeof result.reasoning === 'string' is false, and (result.reasoning as {text?:string})?.text is undefined, so extractedText becomes '' (the ?? '' fallback).

**Failure scenario:** For Ollama cloud reasoning models (kimi-k2.6:cloud, glm-5.1:cloud) that return content only in the reasoning channel — exactly the case this code block was written for — extractedText stays empty. The Brain returns empty content (or triggers the empty/no-tools retry loop unnecessarily) instead of the model's actual answer, dropping the response.

**Fix:** Use the string field: if (!extractedText.trim() && result.reasoningText) { extractedText = result.reasoningText; } and/or join reasoning part texts: Array.isArray(result.reasoning) ? result.reasoning.map(p => p.text ?? '').join('') : ...

~~~ts
let extractedText = result.text ?? '';
if (!extractedText.trim() && result.reasoning) {
  extractedText = typeof result.reasoning === 'string'
    ? result.reasoning
    : (result.reasoning as { text?: string })?.text ?? '';
~~~

---
### M39. Approval YES/NO parsing uses naive substring match, misclassifying words containing YES/NO

**`src/core/agent/approval.ts:215`** · _parsing/coercion/regex bugs_ · confidence 0.72

**What:** parseApprovalReply sets approved = upper.includes('YES') and denied = upper.includes('NO'). These are unbounded substring checks. 'YESTERDAY' contains 'YES' and 'NOPE'/'NOW'/'KNOW'/'NORTH' contain 'NO'. A reply containing both (e.g. 'no, do it yesterday') yields approved=true because YES presence wins regardless of NO.

**Failure scenario:** User replies to a dangerous-tool approval prompt with text like 'No way — maybe yesterday' (contains both NO and YES). parseApprovalReply returns approved=true, the destructive tool runs despite the user denying it. This is a security-relevant misclassification on the human-in-the-loop gate.

**Fix:** Match whole-word tokens, e.g. /\bYES\b/ and /\bNO\b/, and when both/neither match return null (ambiguous) rather than defaulting to approved.

~~~ts
const approved = upper.includes('YES');
    const denied = upper.includes('NO');
~~~

---
### M40. Impact-classification regexes match substrings, misclassifying benign tool names

**`src/core/cognition/epistemic-gate.ts:65`** · _parsing/regex bug_ · confidence 0.72

**What:** classifyImpact() tests tool names against unanchored alternations (e.g. CRITICAL_TOOL_RE = /delete|drop|rm|wipe|format|shutdown|exec|eval|shell/i and HIGH_TOOL_RE = /write|create|update|insert|post|put|patch/i). With no word boundaries, the short tokens match as substrings of unrelated names: 'rm' matches transform_data / perform_x / confirm_order (=> CRITICAL), 'put' matches compute_sum / output_result / reputation (=> HIGH), 'post' matches compose. The derived impact then feeds gateToolCall(), so a CONJECTURE- or UNKNOWN-tagged rationale on a perfectly benign tool gets escalated to REPLAN.

**Failure scenario:** Agent emits a CONJECTURE-tagged rationale ("I think...") while calling a tool named transform_data. classifyImpact returns CRITICAL (because 'rm' is a substring), gateToolCall returns REPLAN, and the harmless tool call is wrongly blocked / forced to replan, stalling progress. Verified empirically: transform_data, perform_x, confirm_order all classify as CRITICAL; compute_sum, output_result, reputation.check classify as HIGH.

**Fix:** Anchor the matches to identifiers, e.g. tokenize the tool name on non-alphanumeric boundaries and test whole segments, or use word-boundary patterns like /\b(rm|delete|drop|wipe|format|shutdown|exec|eval|shell)\b/i.

~~~ts
const CRITICAL_TOOL_RE = /delete|drop|rm|wipe|format|shutdown|exec|eval|shell/i;
const HIGH_TOOL_RE     = /write|create|update|insert|post|put|patch/i;
~~~

---
### M41. compareSemver returns 1 (not 0) for two equal pre-release versions, causing a false 'update available' and update loop

**`src/core/update/version-resolver.ts:47`** · _logic-error_ · confidence 0.72

**What:** When major.minor.patch are equal and both versions carry an identical pre-release tag, the final branch `if (preA && preB) return preA < preB ? -1 : 1;` returns 1 for equal tags (since preA < preB is false → returns 1). It should return 0 for equality. compareSemver is exported and used in checkForUpdate as `compareSemver(remote.version, currentVersion)`; a result > 0 means 'update available'.

**Failure scenario:** Current installed version and the remote dist-tag version are both e.g. '4.1.0-beta.1'. checkForUpdate computes cmp = compareSemver('4.1.0-beta.1','4.1.0-beta.1') = 1 > 0 → reports update available. With autoApply enabled, _applyUpdate pulls/rebuilds/restarts to install the same version every check cycle — a perpetual no-op update/restart loop.

**Fix:** Return 0 when pre-release tags are equal: `if (preA && preB) return preA === preB ? 0 : (preA < preB ? -1 : 1);`

~~~ts
if (preA && !preB) return -1;
if (!preA && preB) return 1;
if (preA && preB) return preA < preB ? -1 : 1;
return 0;
~~~

---
### M42. Single shared debounce timer drops change events for distinct files

**`src/core/workspace/files.ts:171`** · _logic-error_ · confidence 0.72

**What:** watchForChanges creates ONE debounce wrapper over _onFileChange and feeds every fs.watch event through it. debounce (utils.ts) clears the pending timer on each call and only invokes fn with the LAST args. Because all filenames share the same debounced function, when two different workspace files change within WATCH_DEBOUNCE_MS (200ms) of each other, only the last filename's 'changed' event is emitted; the earlier file's change notification is silently dropped.

**Failure scenario:** A process (or the user's editor doing atomic saves) modifies SOUL.md and then IDENTITY.md within 200ms. Only one 'changed' event fires (for IDENTITY). Consumers that reload SOUL on its 'changed' event never see the update, so SUDO-AI keeps stale identity/soul content until the next unrelated change.

**Fix:** Debounce per-filename (maintain a Map<filename, timer>) or debounce only the directory-scan trigger and re-read all changed files, so concurrent changes to different files are not collapsed into a single notification.

~~~ts
const debouncedHandler = debounce(
  ((...args: unknown[]) => void this._onFileChange(args[0] as string | null)) as (...args: unknown[]) => void,
  WATCH_DEBOUNCE_MS,
);
... this.watcher = watch(this.workspaceDir, ..., (_event, filename) => { debouncedHandler(filename); });
~~~

---
### M43. load() wipes in-memory requests to [] on transient read/parse failure during concurrent writes

**`src/core/agent/coordinator.ts:103`** · _race conditions, TOCTOU, shared mutable state without guards_ · confidence 0.7

**What:** load() reads the whole mailbox file and JSON.parses it; on any parse error the catch sets this.requests = []. save() writes the full file with writeFileSync (non-atomic). When multiple Coordinator processes share data/coordinator-mailbox.json, waitForResolution() calls load() every 3s. If a reader reads while another process is mid-write (partial/truncated JSON), JSON.parse throws and the in-memory request list is silently replaced with an empty array.

**Failure scenario:** Process A is polling waitForResolution(). Process B calls save() (writeFileSync, not atomic). Process A's load() reads a half-written file, JSON.parse throws, catch sets this.requests = []. Now getPending()/getForWorker() report no requests and the polled request can never be found again, so waitForResolution eventually returns 'timeout' even though the request was approved. Pending coordinator approvals are lost.

**Fix:** Write atomically (write to temp file then fs.renameSync). In load()'s catch, keep the previous this.requests instead of replacing with [] (only initialise to [] when the file genuinely does not exist).

~~~ts
} catch { this.requests = []; }
~~~

---
### M44. Cloud task IDs use Date.now() only, causing Map key collisions / overwrites

**`src/core/agent/cloud-tasks.ts:74`** · _logic errors_ · confidence 0.7

**What:** createCloudTask generates id = `cloud-${Date.now()}` with no random/sequence component. Two tasks created within the same millisecond produce identical IDs. tasks.set(task.id, task) then overwrites the first task with the second in the Map.

**Failure scenario:** A caller creates two cloud tasks in a tight loop (or two near-simultaneous requests within 1ms). Both get id 'cloud-1712345678901'. The second set() overwrites the first; getCloudTask/updateCloudTask for the first task now operate on the second's record. Status/diff/result of the first task are lost and the first task is untrackable.

**Fix:** Append a random suffix or monotonic counter, e.g. `cloud-${Date.now()}-${Math.random().toString(36).slice(2,8)}` (as BackgroundAgentExecutor.dispatch already does), or use genId().

~~~ts
id: `cloud-${Date.now()}`,
~~~

---
### M45. worktreeAgent creates a temp directory with mkdtempSync but never removes it

**`src/core/agent/subagent-models.ts:87`** · _resource-leak_ · confidence 0.7

**What:** When options.workdir is not supplied, worktreeAgent calls mkdtempSync(path.join(tmpdir(), 'sudo-worktree-')) to create a fresh temp directory, but there is no cleanup anywhere in the module (no rm/rmdir/cleanup). Every call leaks a directory under the OS temp dir.

**Failure scenario:** Repeated worktree sub-agent runs accumulate one orphaned 'sudo-worktree-XXXX' directory per call indefinitely, eventually exhausting inodes/disk space on long-running processes and leaving stale (possibly sensitive) working files on disk.

**Fix:** Track the created workdir and remove it in a finally block (fs.rmSync(workdir, { recursive: true, force: true })) once the agent call completes, or document and implement a retention/cleanup policy.

~~~ts
const workdir = options.workdir ?? mkdtempSync(path.join(tmpdir(), 'sudo-worktree-'));
~~~

---
### M46. Revenue trend double-counts invoices paid on month boundary (inclusive end)

**`src/core/business/analytics.ts:118`** · _logic-error_ · confidence 0.7

**What:** getRevenueTrend builds, for month i, start=startOfMonth(i) (first of the month) and end=startOfMonth(i-1) (first of the NEXT month). _revenueForPeriod filters with `paid_date >= startIso AND paid_date <= endIso`, both inclusive. Because paid_date is stored as a date-only string (YYYY-MM-DD, see invoicing.ts markPaid line 193), an invoice paid on the first day of a month is included in BOTH the previous month's window (paid_date <= firstOfNextMonth) and the current month's window (paid_date >= firstOfThisMonth), so its revenue is counted twice across the trend. The end bound should be exclusive (< endIso) or end-1 day.

**Failure scenario:** Invoice paid_date='2026-05-01'. For the April bucket end='2026-05-01' so `paid_date <= '2026-05-01'` includes it. For the May bucket start='2026-05-01' so `paid_date >= '2026-05-01'` also includes it. The May 1st invoice appears in both April and May revenue points, overstating totals.

**Fix:** Use an exclusive upper bound: `paid_date < ?` with endIso = startOfMonth(i-1) for the next month, and for the current month use start-of-tomorrow / `< endExclusive`. Alternatively compute end as the last day of month i and keep <=.

~~~ts
const end = startOfMonth(i - 1); // start of the NEXT month
const endIso = i === 0 ? new Date().toISOString().slice(0, 10) : end.toISOString().slice(0, 10);
const stats = this._revenueForPeriod(startIso, endIso);
~~~

---
### M47. Budget totals undercount when api_costs has more than 500 rows in the window

**`src/core/commands/builtin/budget.ts:166`** · _logic error_ · confidence 0.7

**What:** The fallback DB path selects at most the 500 most-recent api_costs rows (ORDER BY <ts> DESC LIMIT 500) with no date predicate, then sums them into today/week/month buckets in JS. The week and especially the month (30-day) totals are computed only from those 500 rows. If more than 500 cost records exist within 30 days, the monthly (and possibly weekly) figure is silently truncated and reports a value lower than the real spend.

**Failure scenario:** A busy install records > 500 API calls in a 30-day period. /budget falls back to the DB path (no injected costTracker). The query returns only the newest 500 rows; all older-but-still-in-month rows are dropped, so 'This month' shows a materially understated cost figure, misleading budget decisions.

**Fix:** Aggregate in SQL with date predicates (e.g. SELECT SUM(<amount>) FROM api_costs WHERE <ts> >= ? for each window) instead of fetching a capped row set and summing client-side, or at minimum filter by the 30-day cutoff and remove the LIMIT.

~~~ts
const sql =
  `SELECT ${amountColumn} AS amount, ${timestampColumn} AS created_at ` +
  `FROM api_costs ORDER BY ${timestampColumn} DESC LIMIT 500`;
~~~

---
### M48. fs.watch on a single file stops firing after atomic-rename saves

**`src/core/config/watcher.ts:125`** · _resource leak / wrong API usage_ · confidence 0.7

**What:** start() attaches fs.watch directly to the config file path. Many editors and config writers save via an atomic write-to-temp-then-rename, which replaces the file's inode. On Linux, fs.watch follows the original inode: it will deliver a single 'rename' event and then stop receiving further events because the original inode is now unlinked. The watcher is never re-armed (it is only created once in start() and _handleChange never re-creates it). As a result the very first atomic save is detected, but every subsequent change is silently missed and hot-reload stops working.

**Failure scenario:** User edits config/sudo-ai.json5 with an editor that saves via rename (vim with backupcopy=no, VS Code on some setups, or any tool using rename()). The first save triggers a reload; all later edits are never detected, so the running process keeps using stale config indefinitely while appearing to be watching.

**Fix:** Watch the parent directory (fs.watch(dirname) filtering on basename), or re-establish the watcher inside the change handler when an eventType==='rename' is observed (close + recreate the FSWatcher on the resolved path).

~~~ts
this.watcher = fs.watch(this.configPath, { persistent: false }, (eventType) => {
  if (eventType === 'change' || eventType === 'rename') {
    log.debug({ eventType }, 'ConfigWatcher: file event detected');
    debouncedHandler();
  }
});
~~~

---
### M49. _renderProgressBar throws RangeError when progress > 100, crashing briefing generation

**`src/core/consciousness/heartbeat.ts:762`** · _null/undefined dereference_ · confidence 0.7

**What:** _renderProgressBar computes filled = round(percent/10) and empty = 10 - filled. For percent > 100, filled exceeds 10 and empty becomes negative; String.prototype.repeat with a negative count throws RangeError. goal.progress originates from externally-supplied goals.json (parsed as BriefingGoal[] with an unconstrained number) and is passed straight through, and _renderMarkdown is invoked at line 241 OUTSIDE the surrounding try/catch (which only wraps writeFileSync).

**Failure scenario:** A goals.json file containing a goal with progress: 120 (or any value > 100, e.g. a stale/miscomputed percentage) causes '░'.repeat(-2) to throw RangeError inside _renderMarkdown, which is not caught, rejecting the generateBriefing() promise and producing no HEARTBEAT.md at all.

**Fix:** Clamp percent to [0,100] before computing the bar: const p = Math.min(100, Math.max(0, percent)); const filled = Math.round(p/10); const empty = Math.max(0, 10 - filled);

~~~ts
private _renderProgressBar(percent: number): string {
  const filled = Math.round(percent / 10);
  const empty = 10 - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}
~~~

---
### M50. _computeStage 'recent conflict' check has no recency — permanently pins stage to 'acquaintance'

**`src/core/consciousness/relationship-model/tracker.ts:258`** · _logic-error_ · confidence 0.7

**What:** recentConflict is `conflictHistory.length > 0 && conflictHistory.slice(-3).some(c => c.trim().length > 0)`. conflictHistory is only ever appended to (line 125) and is never trimmed or aged, and every entry pushed is a non-empty `episode.summary.slice(0,120)`. So `slice(-3).some(non-empty)` is true whenever the user has ever recorded any conflict (for users with <=3 lifetime conflicts it always includes the very first one). There is no time-based recency, contrary to the doc ('conflict pushes back ... if conflict is recent'). When recentConflict is true the function returns 'acquaintance' before reaching the totalInteractions thresholds, so the relationship can never advance to 'familiar' or 'trusted' once any conflict is recorded.

**Failure scenario:** A user has one negative episode early in the relationship (conflictHistory=['...']). From then on, every updateFromInteraction recomputes stage; recentConflict stays permanently true, so even after 100+ positive interactions the stage is locked at 'acquaintance' instead of progressing to familiar/trusted.

**Fix:** Track conflict timestamps and treat a conflict as 'recent' only within a time/interaction window (e.g. compare lastInteraction or store conflict timestamps and check age), rather than treating the last 3 ever-recorded conflict strings as recent.

~~~ts
const recentConflict =
  conflictHistory.length > 0 &&
  conflictHistory.slice(-3).some((c) => c.trim().length > 0);
if (recentConflict) return 'acquaintance';
~~~

---
### M51. evolveStyle throws a UNIQUE constraint violation when the same base style version is evolved more than once

**`src/core/creative/creative-engine.ts:143`** · _wrong API usage / unhandled error_ · confidence 0.7

**What:** art_styles.name has a UNIQUE constraint. evolveStyle computes newVersion = base.version + 1 and sets the new style's name to `${base.name} v${newVersion}`. Because it always derives the version from the (unchanging) base row rather than from the count of existing descendants, evolving the same styleId twice produces the identical name both times. The second INSERT inside the transaction violates the UNIQUE(name) constraint and throws an unhandled SqliteError, aborting the transaction.

**Failure scenario:** createArtStyle returns style A (id=X, name='Cyber', version=1). Caller invokes evolveStyle(X, 'feedback1') -> inserts name 'Cyber v2'. Caller later invokes evolveStyle(X, 'feedback2') to branch again -> recomputes newVersion=2, name 'Cyber v2' -> INSERT fails with UNIQUE constraint failed: art_styles.name, throwing out of the transaction wrapper and bubbling an unhandled exception to the caller.

**Fix:** Derive the next version from the actual max version of styles sharing the lineage (e.g. SELECT MAX(version) ... ) or append a uniqueness suffix (timestamp/uuid fragment) to the generated name, and/or wrap the INSERT to detect the constraint and retry with a disambiguated name.

~~~ts
const newVersion = base.version + 1;
const evolved: ArtStyle = {
  ...base, id: evolvedId,
  name: `${base.name} v${newVersion}`,
  ...
};
~~~

---
### M52. Embedding cache key mismatch: write keyed by hash only, read keyed by (hash, model)

**`src/core/memory/embeddings.ts:189`** · _wrong API/library usage_ · confidence 0.7

**What:** _getCached selects WHERE hash = :hash AND model = :model, but _putCached uses INSERT OR REPLACE into embedding_cache whose PRIMARY KEY is `hash` alone (confirmed in schema.ts line 122: `hash TEXT PRIMARY KEY`). When two EmbeddingService instances use different models on the same text, the second write REPLACEs the first model's row (same hash). A later read for the first model then finds a row whose model column no longer matches and returns null, forcing an avoidable API re-fetch; meanwhile the originally cached vector is permanently lost. The cache cannot hold two models' embeddings for the same text.

**Failure scenario:** Service A (model text-embedding-3-small) caches embedding for text T. Service B (model text-embedding-3-large) embeds the same text T: INSERT OR REPLACE overwrites the row (hash is PK), storing B's vector with model=large. Service A.embed(T) then runs _getCached(hash) WHERE hash AND model='small' -> no row -> A re-calls the OpenAI API every time. Repeated A/B alternation churns the cache forever and double-bills the API.

**Fix:** Make the cache key composite: change schema PK to PRIMARY KEY(hash, model) (or add UNIQUE(hash, model)) so distinct models coexist, and ensure INSERT OR REPLACE conflicts on (hash, model) rather than hash alone.

~~~ts
this.db.db.prepare(`
  INSERT OR REPLACE INTO embedding_cache (hash, embedding, model)
  VALUES (:hash, :embedding, :model)
`).run({ hash, embedding: blob, model: this.model });
~~~

---
### M53. activeTasks map keyed by composite key is overwritten by concurrent enqueues, undercounting active tasks

**`src/core/sessions/session-lanes.ts:108`** · _race-condition_ · confidence 0.7

**What:** enqueue() stores activeTasks[taskKey] = {...} at enqueue time, keyed only by laneType:laneKey. When two tasks share the same key (the serialized case), the second enqueue overwrites the first's entry. In the finally block, the FIRST task to complete calls activeTasks.delete(taskKey), removing the entry that belongs to the SECOND (still-running) task. getActiveCount() / getStats().totalActive then report 0 active tasks while a task is actually running. The entry is also set at enqueue time (not start), so queued-but-not-yet-running tasks are counted as active.

**Failure scenario:** Two tasks enqueued under lane key 'sessionId-X' run serially. Task1 finishes and its finally deletes activeTasks['default:sessionId-X']. Task2 is now executing but getActiveCount() returns 0, so any backpressure/shutdown logic relying on getActiveCount (e.g. 'wait until 0 active before teardown') proceeds while Task2 is mid-flight, and getStats undercounts load.

**Fix:** Track active tasks by a unique per-invocation id (e.g. nanoid) rather than the shared composite key, and set/delete the entry inside the task wrapper (on start/finish) instead of at enqueue time so counts reflect actually-running tasks.

~~~ts
this.activeTasks.set(taskKey, {
  laneType: effectiveLaneType,
  laneKey,
  startedAt: Date.now(),
});
~~~

---
### M54. loadBuddy() increments sessionsCount and re-levels on every action, not per session

**`src/core/tools/builtin/meta/buddy.ts:100`** · _logic-error_ · confidence 0.7

**What:** loadBuddy() unconditionally bumps sessionsCount (+1), recomputes level = floor(sessionsCount/10)+1, and writes the file every time it is called. It is called by handleStatus, handleMeet, and handleEvolve. So merely reading status or meeting the buddy increments the persisted session count and can trigger spurious level-ups. The file/doc describe sessionsCount and level as per-session persistence, but they actually count tool invocations. handleEvolve compounds this: loadBuddy adds +1 (and writes), then it adds +10 (and writes), so an 'evolve' advances 11 sessions, not the intended 10.

**Failure scenario:** User calls meta.buddy action='status' ten times in a row to view the buddy. Each call increments sessionsCount and persists it, so the buddy 'levels up every 10 sessions' purely from status checks, and the displayed/persisted session count no longer reflects real sessions.

**Fix:** Separate read from mutation: have status/meet load without incrementing (a readOnly loadBuddy), and only increment sessionsCount once per genuine new session (e.g., keyed by sessionId) rather than on every tool call. In handleEvolve, avoid the implicit +1 from loadBuddy.

~~~ts
raw.lastSeen = new Date().toISOString();
raw.sessionsCount = (raw.sessionsCount ?? 0) + 1;
raw.level = Math.floor(raw.sessionsCount / 10) + 1;
saveBuddy(raw);
return raw;
~~~

---
### M55. getAccessToken always performs a network refresh when a refresh_token exists, even for valid tokens

**`src/core/tools/mcp-oauth.ts:263`** · _logic error_ · confidence 0.7

**What:** isTokenExpired() unconditionally returns false (line 287, acknowledged as 'simplified'), and getAccessToken() ignores expiry entirely: whenever a cached token has a refresh_token it always calls refreshToken() (network round-trip) and returns the refreshed token. There is no check of token validity/expiry before refreshing.

**Failure scenario:** Every HTTP/SSE/WS MCP request that obtains a token (mcp-adapter _connectHttp/_connectSse/_connectWebSocket and refreshOAuthToken) triggers a full OAuth refresh POST per call. Beyond unnecessary latency/load, if the authorization server only allows one-time-use refresh tokens (rotation), the first refresh invalidates the stored refresh_token; the next call's refresh fails, tokenCache is nulled, and the adapter silently loses its token (returns null) — breaking authenticated calls.

**Fix:** Track issuedAt/expiry from expires_in and only refresh when the token is actually near expiry; otherwise return the cached access_token. Implement isTokenExpired() against a stored timestamp instead of always returning false.

~~~ts
    // Token exists but may be expired - refresh if needed
    if (this.tokenCache.refresh_token) {
      try {
        const refreshed = await this.refreshToken(this.tokenCache.refresh_token);
        return refreshed.access_token;
~~~

---
### M56. All A/B variants stored with identical stub CTR makes winner selection meaningless

**`src/core/youtube/thumbnail-ab.ts:267`** · _logic error_ · confidence 0.7

**What:** _fetchAndStoreCtr writes the exact same hardcoded measured_ctr=0.04 for every variant (and the same per-video viewCount, queried by test.videoId not per-variant). selectWinner then does withCtr.reduce((best,v)=> v.measuredCtr > best.measuredCtr ? v : best). Because all CTRs are equal, the strict > comparison is always false, so reduce keeps the initial accumulator — i.e. the first variant — every time.

**Failure scenario:** Any completed A/B test always declares variant 'A' (first by insertion/ORDER BY variant ASC) the winner regardless of real performance, defeating the entire purpose of the feature and producing a wrong, deterministic 'winner'.

**Fix:** Fetch a real per-variant metric (requires OAuth/analytics) and store distinct values; or, while data is a stub, explicitly mark the test inconclusive instead of declaring a winner from tied CTRs.

~~~ts
const winner = withCtr.reduce((best, v) =>
  (v.measuredCtr ?? 0) > (best.measuredCtr ?? 0) ? v : best,
);
~~~

---
### M57. getPersistentWs creates a second socket when called during CONNECTING, orphaning the first

**`src/renderer/lib/ipc-client.ts:68`** · _resource leak_ · confidence 0.7

**What:** getPersistentWs only reuses _persistentWs when its readyState === OPEN. While a socket is still CONNECTING, a second call sees readyState !== OPEN, constructs a brand-new WebSocket, and reassigns _persistentWs (and its onmessage/onerror/onclose). The first socket is now orphaned but still open with its own onmessage handler that mutates the same module-level _pending* globals. When the orphaned socket later receives data it will resolve/dispatch against the wrong pending state.

**Failure scenario:** Two ipcInvoke calls (or the eager connect at line 124 plus a user send) both run before the initial socket finishes its handshake. Two live sockets exist; the abandoned one's onmessage still fires and resolves or rejects the current global pending request with data meant for a different connection, and the leaked socket is never explicitly closed.

**Fix:** Reuse the existing socket when readyState is CONNECTING or OPEN (e.g. return _persistentWs if it is non-null and readyState !== CLOSING/CLOSED), and only create a new one once the previous is fully closed.

~~~ts
function getPersistentWs(): WebSocket {
  if (_persistentWs && _persistentWs.readyState === WebSocket.OPEN) {
    return _persistentWs;
  }
  const ws = new WebSocket(getWsUrl());
  _persistentWs = ws;
~~~

---
### M58. launchBackground IDs use Date.now() only, causing Map key collisions / overwrites

**`src/core/agent/background-agent.ts:58`** · _logic errors_ · confidence 0.68

**What:** launchBackground sets id = `bg-${Date.now()}` with no random component. Two background agents launched in the same millisecond collide on the same id and the second overwrites the first in the agents Map. (Note BackgroundAgentExecutor.dispatch on line 195 already adds randomness, but this free-function registry does not.)

**Failure scenario:** Two fire-and-forget background tasks are launched in quick succession (same ms). Both get id 'bg-1712345678901'; agents.set overwrites the first. completeBackground/failBackground/cancelBackground for the first id mutate the second agent, and the first agent's onComplete callback context is lost — its completion can never be recorded correctly.

**Fix:** Use a unique id generator, e.g. `bg-${Date.now()}-${Math.random().toString(36).slice(2,8)}` or genId(), matching BackgroundAgentExecutor.dispatch.

~~~ts
id: `bg-${Date.now()}`,
~~~

---
### M59. updateEvent patch can wipe start/end times not included in the partial

**`src/core/business/calendar.ts:202`** · _wrong-api-usage_ · confidence 0.68

**What:** updateEvent accepts a Partial patch but converts it with localToGEvent(patch as Omit<CalendarEvent,'id'>). localToGEvent unconditionally sets start: { dateTime: ev.start } and end: { dateTime: ev.end }. When the caller patches only e.g. the title, ev.start/ev.end are undefined, producing start: { dateTime: undefined } / end: { dateTime: undefined }, which serialize to start: {} / end: {} in the request body. Sending an (empty/partial) start or end object to Google Calendar's events.patch can clobber or invalidate the existing event timing rather than leaving it untouched.

**Failure scenario:** client.updateEvent(id, { title: 'Renamed' }) is called (see business/index.ts:438, personal/index.ts:319). The request body sent to events.patch includes start: {} and end: {}, which Google rejects ('Missing start time') or overwrites the event's existing start/end, corrupting the calendar entry.

**Fix:** Build the GCal patch body conditionally: only include summary/description/location/start/end when the corresponding patch field is defined (e.g. omit start unless patch.start is set).

~~~ts
const res = await this.calendarApi.events.patch({
  calendarId: this.calendarId,
  eventId: id,
  requestBody: localToGEvent(patch as Omit<CalendarEvent, 'id'>),
});
~~~

---
### M60. Resume leaves stale 'awaiting_approval' StepResult, corrupting {{prev}} stdin and step results

**`src/core/workflows/lobster.ts:154`** · _state-machine_ · confidence 0.65

**What:** When a workflow pauses on an approval gate it pushes a StepResult {status:'awaiting_approval'} for that step into completedSteps (line 208) and returns. On resume, runWorkflow spreads resumeState (keeping the stale awaiting_approval entry in completedSteps) and restarts at pendingStepIndex, re-executing the same step. After execution a SECOND StepResult for the same id is appended. More importantly, if the very next executed step uses stdin:'{{prev}}', it reads completedSteps[length-1] which (right after resume, before the approval step's real result is pushed) can be the stale awaiting_approval entry whose stdout is undefined, yielding '' instead of the intended previous stdout.

**Failure scenario:** A pipeline: step A (produces stdout) -> step B (approval:true, stdin:'{{prev}}'). On first run it pauses at B with an awaiting_approval result appended. After approval, resume re-runs B; '{{prev}}' resolves to completedSteps.last == the awaiting_approval entry (stdout undefined) -> B receives empty stdin instead of A's output, producing wrong results. completedSteps also ends with two entries for B.

**Fix:** On resume, drop any trailing 'awaiting_approval' StepResult before restarting (e.g. pop entries whose status === 'awaiting_approval' / index >= pendingStepIndex) so {{prev}} and the final result set are consistent.

~~~ts
const runState: WorkflowRunState = resumeState
  ? { ...resumeState, pendingStepIndex: undefined, resumeToken: undefined }
  : { ... };
const startIndex = resumeState?.pendingStepIndex ?? 0;
~~~

---
### M61. acquireLock has a TOCTOU race; concurrent dream runs can both proceed

**`src/core/memory/auto-dream.ts:72`** · _race conditions, TOCTOU_ · confidence 0.62

**What:** acquireLock checks existsSync(LOCK_FILE)/reads the PID, then unconditionally writeFileSync(LOCK_FILE, pid) without an atomic exclusive-create. Two processes that start nearly simultaneously can both observe no live lock (or a stale lock) and both fall through to writeFileSync, each overwriting the other and each returning true. The stated safety goal ('PID-based lock file prevents concurrent runs') is then violated, allowing two AutoDream.runDream() executions to mutate the same DB (synthesize/prune/link) at once and to clobber MEMORY.md via competing atomic renames.

**Failure scenario:** Cron and a manual trigger both invoke runDream() within the same few ms. Both pass acquireLock (no existing lock, or both see the same stale PID), both writeFileSync their own PID, both return true, both run all four phases concurrently. releaseLock() from the first finisher unlinks the lock while the second is still running, and both can interleave INSERTs / MEMORY.md rewrites.

**Fix:** Acquire the lock atomically: writeFileSync(LOCK_FILE, pid, { flag: 'wx' }) inside a try/catch; on EEXIST, read the PID and only remove + retry once if process.kill(pid,0) proves it stale. Never use a plain (overwriting) write to claim the lock.

~~~ts
  writeFileSync(LOCK_FILE, String(process.pid), 'utf-8');
  return true;
~~~

---
### M62. Untracked files outside cleaned roots permanently wedge the tick in dirty-state

**`src/core/self-build/orchestrator.ts:444`** · _broken state machine_ · confidence 0.62

**What:** revertAgentChanges() runs `git checkout -- .` (only reverts tracked files) and `git clean -fd` only for src/core/self-build/ and .githooks/. If the agent created an untracked file elsewhere (e.g. src/core/foo/new.ts) and then failed tsc/vitest or threw, that untracked file survives the revert. On the next tick, the dirty-tree gate runs `git checkout -- .` (which cannot remove untracked files), re-checks porcelain (line 448), still finds the untracked file, and returns 'dirty-state'. Every subsequent tick then aborts with 'dirty-state' — the orchestrator is permanently blocked until a human cleans the tree.

**Failure scenario:** Agent adds a new untracked file in src/core/foo/ then produces a tsc error. tsc gate reverts via revertAgentChanges, but the untracked file in src/core/foo/ is not in the cleaned roots so it remains. Next tick: dirty gate's `git checkout -- .` leaves the untracked file, recheck still dirty -> returns 'dirty-state'. Self-build stops making any progress indefinitely.

**Fix:** Track which files the agent created (git ls-files --others before vs after) and `git clean -fd` those specific untracked paths during revert, or in the dirty-tree gate explicitly remove untracked self-build-created files (still excluding human WIP) rather than only `git checkout -- .`.

~~~ts
execSafe('git checkout -- .', { cwd });
const recheckResult = execSafe('git status --porcelain', { cwd });
if (recheckResult.stdout.trim().length > 0) {
  return { status: 'dirty-state', alignScore, budgetUsdToday };
~~~

---
### M63. ipcOn unsubscribe removes ALL listeners on the channel, not just the one it registered

**`src/renderer/lib/ipc-client.ts:177`** · _wrong API/library usage_ · confidence 0.62

**What:** ipcOn registers a single callback via window.sudo.on(channel, callback) but its returned unsubscribe function calls removeAllListeners(channel), which tears down every listener on that channel. If two callers subscribe to the same ListenChannel (e.g. two components both listen to 'system:metrics'), one component unmounting and calling its unsubscribe will silently kill the other component's still-active subscription.

**Failure scenario:** Component X and Component Y both call ipcOn('system:metrics', ...). X unmounts and runs its cleanup, calling removeAllListeners('system:metrics'). Y stops receiving metrics updates even though it never unsubscribed, causing its UI to go stale with no error.

**Fix:** Expose a removeListener(channel, callback) on the preload bridge and have the unsubscribe call that, or track per-callback registrations so removal is scoped to the specific callback.

~~~ts
  window.sudo!.on(channel, callback);
  return () => {
    window.sudo?.removeAllListeners(channel);
  };
~~~

---
### M64. Generated image saved via `img:last-child` selector grabs the wrong element

**`scene01-pipeline.mjs:110`** · _wrong selector / wrong result used_ · confidence 0.6

**What:** When no download button is present, the script falls back to `saveFromSrc(page, 'img:last-child', ...)`. The `img:last-child` selector matches an <img> only when it is the LAST child of its parent node, which is almost never the generated result image in Grok's DOM. getAttribute('src') is taken from whatever that matches (often a small avatar/icon or nothing), so the saved scene01-image.jpg can be a wrong/tiny image, and then that wrong image is uploaded as the video reference in Step 2, corrupting the whole pipeline output.

**Failure scenario:** Grok does not expose a download button; fallback runs; `img:last-child` resolves to an unrelated last-child <img> (e.g. an icon). Its src is fetched and written as the scene image, then fed into the video generator, producing a video of the wrong subject — silently, with no error.

**Fix:** Select the actual result image deterministically (e.g. largest <img> by bounding box, or the result container's img), not `img:last-child`. Validate the fetched bytes length before accepting.

~~~ts
} else {
  // Grab largest img src
  await saveFromSrc(page, 'img:last-child', imgOutPath);
}
~~~

---
### M65. Soak error rate ignores 4xx, producing false PASS for auth/not-found failures

**`scripts/soak.ts:137`** · _logic errors_ · confidence 0.6

**What:** doRequest counts a request as an error only when resp.status >= 500 (or on fetch throw). 4xx responses (401, 403, 404, 429) are recorded as successful. The documented FAIL criterion is 'Any endpoint error rate > 1%'. Because the soak hits admin endpoints that typically require a bearer token, running with an empty/invalid token yields 401 on every request, all counted as success.

**Failure scenario:** Run the soak against /v1/admin/* without a valid --token. Every request returns 401, errorCount stays 0, errorRate is 0%, and the verdict is PASS even though every single request failed authentication and no real load was applied to the handlers.

**Fix:** Treat non-2xx (and non-expected) statuses as errors, e.g. `if (resp.status >= 400) stats.errorCount++;`, or explicitly whitelist acceptable status codes per endpoint.

~~~ts
stats.statusCodes[resp.status] = (stats.statusCodes[resp.status] ?? 0) + 1;
await resp.text();
if (resp.status >= 500) {
  stats.errorCount++;
}
~~~

---
### M66. Optional chaining does not guard the fallback; empty contexts crashes instead of creating a page

**`scripts/final-needs-test.mjs:5`** · _null/undefined dereference_ · confidence 0.6

**What:** The expression `contexts[0]?.pages()[0] || await contexts[0].newPage()` only guards `contexts[0]` being nullish before `.pages()`. If `contexts` is empty, `contexts[0]?.pages()` short-circuits to undefined, then `undefined[0]` throws 'Cannot read properties of undefined (reading 0)'. The intended fallback `contexts[0].newPage()` is never reached (and would itself throw on undefined). The same construct appears identically in how-i-feel-test.mjs:5, hundred-percent-test.mjs:5, military-grade-test.mjs:5, new-powers-test.mjs:5, skills-created-test.mjs:5, step1-characters.mjs:5, sudo-needs-test.mjs:5, and video-steps-test.mjs:5.

**Failure scenario:** Connecting via CDP to a Chrome instance that has no browser contexts (fresh/headless without a default context) makes contexts an empty array; the script crashes on line 5 with a TypeError before any test logic runs, instead of opening a new page.

**Fix:** Guard the whole chain: `const ctx = contexts[0] ?? await browser.newContext(); const page = ctx.pages()[0] ?? await ctx.newPage();`

~~~ts
const contexts = browser.contexts();
const page = contexts[0]?.pages()[0] || await contexts[0].newPage();
~~~

---
### M67. LLM-supplied candidateIndex used as array index without bounds validation

**`src/core/agent/best-of-n.ts:202`** · _null/undefined dereference; unchecked optional/array access_ · confidence 0.6

**What:** winnerIndex is set from validScores[0].candidateIndex, which originates from _parseJudgeResponse → Number(s.candidateIndex ?? 0) parsed from the model's JSON. This is then used as candidates[winnerIndex]. There is no validation that candidateIndex is within [0, candidates.length). A judge that returns candidateIndex:7 (or a negative/NaN-coerced value) makes candidates[winnerIndex] undefined.

**Failure scenario:** The judge model returns scores with candidateIndex larger than the candidate count (common LLM off-by-one or hallucinated index). validScores sorts by totalScore and picks that bogus index. candidates[winnerIndex] is undefined; the function returns winnerIndex pointing at a non-existent candidate and winnerOutput '' / success false, silently discarding the actual best candidate's output. Downstream callers that merge winnerIndex's branch act on a wrong/nonexistent candidate.

**Fix:** Clamp/validate candidateIndex against candidates.length when parsing the judge response, and after selecting winnerIndex verify candidates[winnerIndex] exists, falling back to the first successful candidate otherwise.

~~~ts
validScores.sort((a, b) => b.totalScore - a.totalScore);
      winnerIndex = validScores[0].candidateIndex;
~~~

---
### M68. CRITICAL tool-output injection detected only AFTER the poisoned result is already in session history

**`src/core/agent/loop.ts:2306`** · _incorrect error handling; security-correctness_ · confidence 0.6

**What:** The injection scan on tool outputs runs after executeToolCalls() has already appended the tool-result messages to session.messages. On CRITICAL severity it sets validToolCalls.length=0, pushes a 'refusing to trust result' system note, and breaks the inner scan loop — but the malicious tool-result content remains in session.messages and will be sent to the model on the next brain.call(). Clearing validToolCalls is also a no-op here because the tools have already executed and the loop falls through to `continue` regardless.

**Failure scenario:** A tool (e.g. web fetch / file read) returns content containing a prompt-injection payload classified CRITICAL. The result is committed to history, the scan flags it, but the agent only appends a warning and continues — the injected instructions stay in context for the next LLM call, so the 'refusing to trust result' guard does not actually remove the attacker-controlled text the model will read.

**Fix:** On CRITICAL, redact/remove or replace the offending role:'tool' message content in session.messages (e.g. substitute a '[REDACTED: injection]' placeholder keyed by toolCallId) rather than only appending a warning, so the poisoned text never reaches the next brain.call().

~~~ts
const toolReplanMsg = '[INJECTION-CRITICAL] tool output contains prompt injection: refusing to trust result';
session.messages.push({ role: 'system', content: toolReplanMsg });
...
(validToolCalls as unknown[]).length = 0;
break;
~~~

---
### M69. acquireLock has a check-then-write race allowing two concurrent dream cycles

**`src/core/consciousness/auto-dream.ts:98`** · _race condition / TOCTOU_ · confidence 0.6

**What:** acquireLock() reads LOCK_FILE with existsSync/readFileSync, decides whether the lock is stale, and only then writes a new lock with writeFileSync (no O_EXCL/exclusive-create flag). Two processes (e.g. a cron-triggered run and a manual run, or two cron fires) can both observe no lock (or a stale lock), both write the lock, and both return true. There is no atomic create-if-not-exists, so the lock provides no mutual exclusion across concurrent invocations.

**Failure scenario:** Two AutoDream.run() invocations start within the same window. Both pass acquireLock(). Both execute phaseConsolidate concurrently, each doing await writeFile(MEMORY_MD, existing + section). The two read-modify-write cycles interleave: one process's write clobbers or duplicates the other's appended dream-cycle section, corrupting/losing MEMORY.md content. Both also writeState() with conflicting sessionCountAtRun values.

**Fix:** Create the lock atomically with an exclusive flag: writeFileSync(LOCK_FILE, data, { flag: 'wx' }) and treat EEXIST as 'lock held'; only after a successful exclusive create proceed. Handle stale-lock by unlinking then retrying the exclusive create.

~~~ts
function acquireLock(): boolean {
  if (existsSync(LOCK_FILE)) { /* ...staleness check... */ }
  ensureDataDir();
  writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, startedAt: ... }), 'utf8');
  return true;
}
~~~

---
### M70. getBalance ordering tie-break can read a stale balance for same-millisecond transactions

**`src/core/economy/wallet.ts:106`** · _race-condition_ · confidence 0.6

**What:** getBalance() determines the current balance with 'ORDER BY created_at DESC LIMIT 1', where created_at is an ISO timestamp at millisecond resolution (new Date().toISOString()). When two transactions for the same currency are inserted within the same millisecond, their created_at values are identical and SQLite's ORDER BY tie-break is unspecified — it may return the earlier row's balance_after. Because credit()/debit() read the balance, compute newBalance, then insert (a non-atomic read-modify-write with no surrounding transaction), reading the wrong 'latest' row yields a wrong newBalance that is then persisted.

**Failure scenario:** Two rapid debits in the same millisecond: debit A reads balance 100, writes balance_after 90; debit B's getBalance ties on created_at and returns A's pre-existing 100 instead of 90, writes 90 again — losing 10 from the ledger. Balance drifts and an insufficient-funds check can pass when it should fail, corrupting the token ledger.

**Fix:** Order by a monotonic key (add an INTEGER PRIMARY KEY AUTOINCREMENT rowid and ORDER BY that DESC), and wrap the read-modify-write of credit/debit in a single db.transaction() to make balance computation atomic.

~~~ts
const row = this.db.prepare(
  'SELECT balance_after FROM agent_wallet WHERE currency = ? ORDER BY created_at DESC LIMIT 1',
).get(currency) as { balance_after: number } | undefined;
return row?.balance_after ?? 0;
~~~

---
### M71. Post-commit protected-path revert ignores git revert failure

**`src/core/self-build/orchestrator.ts:655`** · _incorrect error handling_ · confidence 0.6

**What:** If a protected path is detected in the committed diff, the code runs `git revert HEAD --no-edit` via execSafe and then latchHalt + returns 'protected-path-reverted'. execSafe never throws and its exit code is not checked here. If `git revert` fails (e.g. merge conflict, gpg/hooks failure, or it opens an editor in some configs despite --no-edit), the protected-path commit remains in the branch history and on HEAD, but the function still reports 'protected-path-reverted' and halts as if the revert succeeded.

**Failure scenario:** Agent commit touches a protected path; post-commit check fires; `git revert HEAD --no-edit` fails with a non-zero exit (conflict or hook). The bad commit is still HEAD, but the orchestrator returns status 'protected-path-reverted' and latches halt, leaving the protected-path change committed and live on the self-build branch.

**Fix:** Check the exitCode of the `git revert` execSafe result; if non-zero, escalate (e.g. `git reset --hard HEAD~1` as a fallback) and reflect the real failure in the returned status/message.

~~~ts
execSafe('git revert HEAD --no-edit', { cwd });
latchHalt(cwd, state, `S8: protected path in commit: ${file}`);
return { status: 'protected-path-reverted', message: file, ... };
~~~

---
### M72. probeVolume spawns a throwaway ffprobe process with no error handler, then kills it

**`src/pipeline/quality-gate.ts:131`** · _resource leak_ · confidence 0.6

**What:** probeVolume first spawns an ffprobe process (`proc`) that performs no useful work, attaches NO listeners (no 'error', no 'close'), then immediately calls proc.kill(). Only proc2 (the ffmpeg call) is actually used. The first spawn is dead code that wastes a process, and crucially has no 'error' listener.

**Failure scenario:** If the ffprobe binary is unavailable or spawn fails, the first `proc` emits an 'error' event with no listener attached, which Node turns into an uncaught exception that can crash the process. Even when ffprobe exists, a process is spawned and killed on every quality check for no reason.

**Fix:** Remove the dead first spawn entirely and only spawn the ffmpeg `proc2`; if any process is spawned, attach an 'error' listener.

~~~ts
const proc = spawn('ffprobe', ['-v', 'quiet',
  '-of', 'json',
  '-show_entries', 'format_tags',
  filePath,
], { stdio: ['ignore', 'pipe', 'pipe'] });
// volumedetect must run through ffmpeg, not ffprobe — use ffmpeg directly
proc.kill();
~~~

---
### M73. _streamAnthropic emits the 'done' usage chunk more than once, double-counting tokens

**`src/cli/commands/chat/provider.ts:229`** · _wrong-api-usage_ · confidence 0.55

**What:** During the for-await loop, every Anthropic 'message_delta' event that carries event.usage yields a {type:'done', usage} chunk (lines 229-237). After the loop, if not aborted, the code also yields ANOTHER 'done' chunk from stream.finalMessage().usage (lines 239-252). A consumer that sums usage on each 'done' (the natural contract, as App.tsx does: setTotalTokens(prev => prev + total)) will add the same final usage twice — once from the last message_delta and once from finalMessage. The 'done' chunk is also semantically a terminal marker, so emitting it multiple times mid-stream is incorrect.

**Failure scenario:** A direct consumer of chatStream() against an Anthropic provider receives a 'done' chunk for the final message_delta (with output_tokens), then a second 'done' from finalMessage with the same/overlapping usage, inflating the reported token total by roughly the output token count.

**Fix:** Track usage in a local variable inside the loop without yielding 'done' for each message_delta; emit exactly one terminal 'done' chunk after the loop (using finalMessage usage if available, else the accumulated usage).

~~~ts
} else if (event.type === 'message_delta' && event.usage) {
  yield { type: 'done', usage: { inputTokens: event.usage.input_tokens, outputTokens: event.usage.output_tokens } };
}
...
if (final?.usage) { yield { type: 'done', usage: {...} }; }
~~~

---
### M74. vector-only / bm25-only branches skip weight scaling, breaking minScore filter consistency

**`src/core/memory/hybrid-search.ts:313`** · _logic errors_ · confidence 0.55

**What:** When both result lists are non-empty, scores are blended via mergeHybridResults (vectorWeight*vec + textWeight*bm25), so a pure-vector hit of 0.5 becomes 0.35. But when only one source returns results, the raw, unweighted score is passed straight through (results = vectorResults / bm25Results). The downstream minScore filter (default 0.35) and final ranking therefore apply to fundamentally different score scales depending on whether the other source happened to match. The same chunk can pass or fail the minScore gate purely based on whether BM25 also matched the query.

**Failure scenario:** Query Q vector-matches chunk C at vec score 0.40. If BM25 also matches anything, C's merged score = 0.7*0.40 + 0.3*bm25 which can be ~0.28 and is dropped by minScore 0.35. If BM25 matches nothing, the vector-only branch keeps C's raw 0.40 and returns it. So adding/removing an unrelated BM25-matching chunk silently flips whether C is returned, producing inconsistent, non-monotonic results.

**Fix:** Always scale single-source results by their weight before the minScore filter, e.g. results = vectorResults.map(r => ({ ...r, score: vectorWeight * r.score })) and the analogous textWeight for the bm25-only branch, so all paths share one score scale.

~~~ts
} else if (vectorResults.length > 0) {
    results = vectorResults;
  } else {
    results = bm25Results.map((r) => ({ ...r, matchType: 'bm25' as const }));
  }
~~~

---

## 🔵 Low confirmed bugs

| # | Location | Category | Title | Fix |
|---|---|---|---|---|
| 1 | `tests/gateway/federation-error-routes.test.ts:586` | parsing/coercion bug | FED-ERR-31 prototype-pollution test does not actually send a __proto__ key | Send the payload as a raw JSON string containing a literal __proto__ key, e.g. doPostRaw(url, '{"errorSignature":"...","__proto__":{"admi... |
| 2 | `scripts/generate-tts-001.mjs:211` | parsing/coercion/integer mistakes | Duration display uses Math.round for minutes, overstating elapsed minutes | Use Math.floor for minutes: `${Math.floor(estDuration / 60)}m ${estDuration % 60}s`. |
| 3 | `tests/federation/federation-token-pool.test.ts:56` | wrong variable/shadowing | createMockVault set() reads setThrows from the wrong (shadowing) opts object — throw path is dead | Rename the inner parameter (e.g. `async (namespace, key, value, callOpts) => { ... }`) and check the captured factory option `opts?.setTh... |
| 4 | `src/core/tools/builtin/meta/event-daemon-tool.ts:152` | logic-error | status output always reports DEFAULT_POLL_MS instead of the actual poll interval | Track the actual interval used at start time in a module variable (e.g. `_pollMs`) and display that, or expose the interval from EventDae... |
| 5 | `src/cli/commands/chat/markdown.ts:142` | parsing-coercion-bug | Ordered list renders wrong numbers, ignores marked's token.start | Use the start offset: const startNum = typeof token.start === 'number' ? token.start : 1; then prefix = ordered ? `  ${startNum + idx}  `... |
| 6 | `src/cli/commands/chat/components/ToolCallCard.tsx:55` | parsing-coercion-bug | Negative slice when tool name length >= 40 garbles arg display | Clamp the budget: const maxArgLen = Math.max(4, 40 - name.length); and guard the slice index to be non-negative (Math.max(0, maxArgLen - ... |
| 7 | `src/core/superpowers/translate.ts:53` | parsing/coercion bug | restoreBlocks uses String.replace with raw content, mangling $-sequences in code blocks | Use a function replacement to bypass special pattern parsing: result = result.replace(placeholder, () => content); |
| 8 | `src/pipeline/voice-generator.ts:92` | logic error / off-by | Per-scene timestamps overshoot total audio duration (inter-scene pauses double-counted) | Either include the pause gaps as part of the proportional distribution (subtract pauseSeconds before distributing word-proportional speec... |
| 9 | `src/remotion/quiz/QuizVideo.tsx:233` | logic-error | diffProgress is a constant (always 1 for >=2 questions), background never varies | Compute a real progress value, e.g. drive Background per-question/per-difficulty band, or remove the dead computation. If a single global... |
| 10 | `src/renderer/components/chat/ToolCallCard.tsx:64` | logic error / dead code | Result truncation and 'Show full result' are dead code because the entire block is gated on expanded===true | Render a collapsed preview of the result (e.g. show displayResult when collapsed and full text only after a separate 'show full' toggle),... |
| 11 | `tests/health/error-reporter.test.ts:14` | race conditions / shared mutable state | ErrorReporter test uses a fixed on-disk SQLite path with no cleanup, leaking state across runs | Use a unique temp path per run (e.g. join(tmpdir(), `err-mem-${randomUUID()}.db`)) and rmSync it in afterEach, or use ':memory:'. |
| 12 | `src/core/channels/web.ts:393` | missing-await | Floating promise on /api/message dispatch can throw unhandled rejection and never replies on error | Add `.catch((err) => { log.error({err}); try { res.writeHead(500); res.end(JSON.stringify({ok:false})); } catch {} })` to the dispatch ch... |
| 13 | `src/core/swarm/swarm-manager.ts:208` | logic error | requestVote role-match uses non-lowercased agent.role against lowercased option | Lowercase both sides: const roleScore = opt.toLowerCase().includes(agent.role.toLowerCase()) ? 2 : 0; |
| 14 | `src/core/tools/builtin/meta/feedback.ts:46` | logic-error | Negative or non-numeric days yields a future/invalid 'since' cutoff | Clamp and validate: `const n = Number(params['days']); const days = Number.isFinite(n) && n > 0 ? Math.min(n, 365) : 30;` |
| 15 | `src/core/tools/builtin/pm/index.ts:388` | incorrect-error-handling | pm.time-tracker stop can re-stop an already-completed entry and corrupt its duration | When entryId is provided, verify the entry exists and is still running (no endTime) before stopping; otherwise return a 'timer already st... |
| 16 | `src/cli.ts:112` | race-condition | runShutdown mutates handler list with .reverse() and has no re-entrancy guard — double teardown if a second signal arrives during async shutdown | Add a re-entrancy guard at the top of runShutdown (e.g. `if (isShuttingDown) return; isShuttingDown = true;`) and iterate over a copy: `f... |
| 17 | `src/cli/commands/chat/components/Header.tsx:38` | parsing-coercion-bug | Narrow-terminal model truncation chops version dots (e.g. gpt-4.1 -> gpt-4) | Only strip a trailing date-like suffix (e.g. /\.[0-9]{6,8}$/), or truncate by character budget with an ellipsis rather than splitting on ... |
| 18 | `src/core/channels/rate-limit.ts:347` | resource-leak | Failed persistence renames temp file to unbounded .failed files | On failure, unlink the temp file rather than renaming it to .failed (e.g., `try { await unlink(tmpFile); } catch {}`), or cap/rotate the ... |
| 19 | `src/core/cognition/mistake-pattern-recognizer.ts:374` | logic error | findSimilar computes Jaccard against truncated 100-char signature vs full 500-char query | Compare against the same representation on both sides — store/compare the full normalizedText (or truncate the query to SIG_TRUNCATE_LEN ... |
| 20 | `src/core/consciousness/cron-scheduler.ts:459` | resource leak | Recurring task jitter timers are orphaned (not tracked/cleared) when re-scheduled each minute | In fireTask() (or via the setTimeout callback) delete the timer entry from this.timers after it runs; before setting a new timer for an i... |
| 21 | `src/core/consciousness/kairos.ts:551` | incorrect error handling / state machine | Telegram CRITICAL alert cooldown is committed before the notification is confirmed sent | Only set/persist the cooldown after the notification resolves successfully: `this.config.notifyFn(...).then(() => { lastNotifiedAt.set(ke... |
| 22 | `src/core/consciousness/theory-of-mind/helpers.ts:111` | parsing/coercion bug | detectFrustration counts numeric/symbol tokens as ALL-CAPS, producing false frustration signals | Require the token to contain at least one alphabetic character before treating it as ALL-CAPS, e.g. `w.length > 2 && /[A-Za-z]/.test(w) &... |
| 23 | `src/core/memory/auto-summarizer.ts:162` | wrong API/library usage | summarizeSession ignores constructor dbPath and always reads messages from hardcoded MIND_DB | Read messages from the same database the instance was constructed with (use this.db or store the constructor dbPath and open the readonly... |
| 24 | `src/core/skills/markdown-loader.ts:51` | parsing-bug | Frontmatter regex fails on CRLF line endings | Normalize line endings before matching (raw.replace(/\r\n/g, '\n')) or make the regex tolerate \r: /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\... |
| 25 | `src/core/tools/builtin/meta/cron-create.ts:50` | parsing-bug | Cron field regex accepts out-of-range and malformed field values | Validate per-field numeric ranges as cron-manager.ts already does (validateCronExpression). Reuse that range-aware validator here instead... |
| 26 | `src/core/tools/builtin/research/tools/research-tools.ts:182` | wrong-api-usage | arXiv ID lookup uses all: full-text search instead of id_list, often returns wrong/empty result | Add an id_list path to the arXiv helper (or a dedicated fetchArxivById) that builds the URL with `&id_list=<id>` instead of `search_query... |
| 27 | `src/core/tools/mcp-adapter.ts:671` | wrong API/protocol usage | JSON-RPC notifications are sent with an `id`, violating the spec | Send notifications without an id field: `this._send({ jsonrpc: '2.0', method, params })` and adjust the JsonRpcRequest type to make id op... |
| 28 | `src/pipeline/notifier.ts:51` | incorrect error handling | Unescaped error message and URL interpolated into HTML notification | HTML-escape all interpolated dynamic strings (replace &,<,>) before inserting into HTML-formatted messages. |
| 29 | `src/pipeline/voice-generator.ts:222` | logic error | Duration estimate and timestamp pause counts diverge when a scene has empty narration | Compute timestamps only over scenes that contributed narration (the same filter buildNarrationText uses), and pass that filtered count to... |
| 30 | `src/renderer/components/dashboard/DashboardView.tsx:67` | missing error handling | Floating IPC promises in mount effect drop errors (unhandled rejection) | Attach .catch handlers (e.g., log and/or surface via toast): getMetrics().then(...).catch(err => console.error('metrics load failed', err... |
| 31 | `src/renderer/components/office/rooms/MainWorkspace.tsx:31` | logic error | Redundant ternary places back-row chairs on the wrong side of rotated desks | Make the branches differ to mirror the rotation, e.g. `const chairZ = i >= 3 ? pos[2] - 0.9 : pos[2] + 0.9;` (and verify against the desk... |
| 32 | `src/renderer/components/settings/SettingsView.tsx:84` | parsing/coercion bug | maxTokens becomes NaN when the number field is cleared | Guard the parse: `const n = parseInt(e.target.value, 10); setModelConfig({ maxTokens: Number.isNaN(n) ? 0 : n });` (or keep the previous ... |
| 33 | `tests/channels/rate-limit.test.ts:286` | resource leak / test pollution | Persistence test writes to real cwd workspace/rate-limits.json and never deletes it | Write the persist file into an os.tmpdir() scratch dir, or register an afterEach/afterAll that unlinks workspace/rate-limits.json (and th... |
| 34 | `tests/tools/document.test.ts:103` | test correctness (false confidence) | Path-prefix acceptance tests pass trivially because empty html short-circuits before path validation | Provide valid non-empty html so execution reaches path validation, then assert that the accepted prefix does NOT produce a path error (an... |
| 35 | `scripts/all-10-test.mjs:91` | logic error / race | Completion detected as soon as input is re-enabled, even before any response exists | Only break on the explicit hasResponse check (assistant article with non-trivial prose). Remove the inputEnabled shortcut, or require BOT... |
| 36 | `scripts/tui-real-user-test.mjs:93` | logic errors | Validation harness reports PASS almost unconditionally due to weak success heuristic | Require explicit positive evidence per prompt (e.g. tool-call markers, actual file listing output) rather than 'absence of the word error... |
| 37 | `src/cli/commands/chat/hooks/useDigest.ts:53` | parsing-coercion-bug | Non-numeric API score coerces to NaN, silently shown as red with NaN value | Coerce safely with a fallback: const n = Number(found['score']); const score = Number.isFinite(n) ? n : 0.5; |
| 38 | `src/core/agent/context.ts:144` | logic errors | shouldCompact triggers at 50% but documents/logs 80% threshold | Pick the intended threshold and make doc/comment/code agree, e.g. const threshold = MAX_CONTEXT_TOKENS * 0.8 if 80% is intended. |
| 39 | `src/core/agent/spawn-tool.ts:86` | race-condition | TOCTOU between getActive() check and swarm.spawn() allows the advisory concurrency gate to be exceeded | Enforce concurrency inside AgentSwarm via the PQueue concurrency limit (single source of truth) and have spawn() reject when over capacit... |
| 40 | `src/core/business/analytics.ts:117` | parsing-coercion-bug | Month label and SQL start date can disagree by one day in positive-UTC-offset timezones | Build the YYYY-MM-DD strings from local components (getFullYear/getMonth/getDate) consistently, or construct the Date with Date.UTC so to... |
| 41 | `src/core/channels/matrix.ts:120` | error-handling | Prime-sync failure leaves _nextBatch undefined, causing first sync to replay full room history | If prime sync fails, retry it before entering the loop, or set _nextBatch to a sentinel and skip dispatching the first sync's timeline (t... |
| 42 | `src/core/consciousness/auto-dream.ts:200` | parsing/coercion bug | Invalid/missing lastRun in state silently bypasses the 24h cooldown | After parsing, validate Number.isFinite(new Date(state.lastRun).getTime()); if not finite, treat as 'no prior run' or reset state, and ne... |
| 43 | `src/core/consciousness/relationship-model/tracker.ts:277` | logic-error | _computeTrajectory uses cumulative counts, not a sliding window of recent outcomes | Maintain an actual ordered list of the last N outcome valences and compute positive/negative counts from that recency-ordered window, ins... |
| 44 | `src/core/orchestration/executor.ts:158` | incorrect error handling | onFail callback not invoked when a task fails via hard timeout | In the timeout callback, after queue.fail(), re-read the task and call this.options.onFail?.(task, msg) when its status is 'failed', mirr... |
| 45 | `src/core/superpowers/data-analyzer.ts:24` | parsing/coercion bug | parseCSV splits naively on commas/newlines, corrupting quoted fields | Use a real CSV parser that handles RFC-4180 quoting (e.g. a small state-machine parser or a library), instead of String.split(','). |
| 46 | `src/core/tools/builtin/system/tasks.ts:142` | logic error | Task id prefix matching can act on the wrong task and lacks ambiguity detection | Require an exact id match, or detect when more than one task matches the prefix and return an 'ambiguous id' error instead of acting on t... |
| 47 | `src/core/tools/builtin/system/tasks.ts:112` | race condition / data corruption | Read-modify-write of tasks.json is not atomic — concurrent operations lose updates | Serialize operations with an in-process async mutex/queue and write atomically (write to a temp file then rename). Avoid the silent empty... |
| 48 | `src/renderer/admin/hooks/useAuthToken.ts:40` | logic error | Query-token path strips entire query string, dropping other params | Remove only the token param and keep the rest: build params, params.delete('token'), then history.replaceState(null, '', pathname + (para... |
| 49 | `src/renderer/components/admin/security/SecurityPage.tsx:256` | react key collision | Access log DataTable uses non-unique 'timestamp' as keyField | Use a guaranteed-unique key (e.g. array index, or compose timestamp+ip+path) for keyField, or have the API return a unique id per entry. |
| 50 | `src/renderer/components/office/drama/DramaEngine.tsx:119` | resource-leak | Inner setTimeout revert timers are never cleared on unmount | Track pending revert timers in a Set/ref and clear them all in the effect cleanup, e.g. push each setTimeout id into a ref array and clea... |
| 51 | `tests/gateway/federation-ingest-verify.test.ts:42` | resource leak | In-memory better-sqlite3 Database created per test is never closed | Track the Database instance in the deps/TestServer and call db.close() in afterEach alongside the server close. |
| 52 | `tests/ide/bridge-discovery.test.ts:20` | wrong API/library usage | Wrong relative import path for shared-types/bridge-protocol | Change the import to the correct path: import type { BridgeDiscoveryPayload } from '../../shared-types/bridge-protocol.js'; |
| 53 | `scripts/all-10-capture.mjs:5` | null/undefined dereference | Fallback newPage() throws TypeError when CDP browser has zero contexts | Use a real guard, e.g. `const ctx = contexts[0] \|\| await browser.newContext(); const page = ctx.pages()[0] \|\| await ctx.newPage();` |
| 54 | `produce-kitchen.mjs:366` | parsing/coercion bug | Unvalidated parseFloat of ffprobe duration can propagate NaN through the whole pipeline | Guard: `const duration = parseFloat(durationStr); if (!Number.isFinite(duration) \|\| duration <= 0) throw new Error('Invalid narration d... |
| 55 | `src/cli/commands/doctor.ts:248` | parsing-bug | checkDiskSpace mis-parses df output when the device/Filesystem name wraps to its own line | Use `df -m -P <path>` (POSIX output guarantees one line per filesystem, no wrapping), or join all lines after the header and parse the la... |
| 56 | `src/core/agent/best-of-n.ts:238` | logic errors | Candidate worktree created with non-deterministic name unrelated to later cleanup/branch reference | Compute the worktree name once and reuse it for both creation and the error-path branch field. |
| 57 | `src/core/agent/response-compressor.ts:107` | logic-error | Line-count compression path does not re-enforce the character budget | After line compression, also apply the character truncation (slice to MAX_RESPONSE_CHARS with the truncation marker) before returning. |
| 58 | `src/core/awareness/proactive-notifier.ts:69` | logic-error | Notification trim removes a fixed count, leaving more than TRIM_TO entries | Trim to a target length: notifications.splice(0, notifications.length - TRIM_TO); |
| 59 | `src/core/business/calendar.ts:194` | logic-error | Stub updateEvent fabricates empty title/start/end instead of preserving prior values | Stub mode cannot know prior values without storage; at minimum document the limitation, or maintain an in-memory map of stub events so up... |
| 60 | `src/core/consciousness/attention-system/attention.ts:42` | null/coercion bug | Signal with unparseable timestamp never expires and is never drained | In validateSignal(), assert isFinite(new Date(signal.timestamp).getTime()); reject signals whose timestamp does not parse to a finite epoch. |
| 61 | `src/core/optimization/auto-optimizer.ts:216` | incorrect error handling | disableRule throws for rules present in DB but absent from in-memory map | Mirror enableRule: if the id is not in this.rules, look it up in the DB; if found, run the UPDATE active=0 and update the map; only throw... |
| 62 | `src/pipeline/assembler-filters.ts:30` | parsing/regex bug | drawtext escape omits '%', which ffmpeg drawtext expands as a special expansion token | Also escape '%' (e.g. replace '%' with '\\%') and consider escaping other filtergraph-significant characters in escapeDt. |
| 63 | `src/renderer/components/admin/channels/ChannelsPage.tsx:52` | logic error | Empty allowedUsers array displayed as 'All' instead of 'none' | Distinguish 'field absent' from 'empty array': only show 'All' when channel.config?.allowedUsers is undefined; otherwise show the count (... |
| 64 | `src/renderer/components/office/drama/DramaEngine.tsx:164` | broken-state-machine | Error recovery forces state to 'working' regardless of prior state, can leave idle agents permanently 'working' | Recover to 'idle' (matching other reverts) or restore the agent's previous state, e.g. setStateRef.current(agent.code, 'idle') after the ... |
| 65 | `src/pipeline/script-generator.ts:59` | null/undefined dereference | Scene index taken from raw LLM output without integer/uniqueness validation | Validate that index is a finite positive integer and unique across scenes; otherwise fall back to pos+1 and dedupe. |

---

## ⚪ Disputed findings (one verifier dissented)

**D1. [critical] Hand-rolled JSON5 parser corrupts single-quoted strings and any '//' inside string values, breaking readConfig on the real config** — `src/core/api/admin/config-io.ts:42`  
readConfig() converts JSON5 to JSON with regexes instead of a real parser. (1) It never converts single-quoted string values to double-quoted ones, so JSON.parse rejects them. (2) The comment-stripping regex /\/\/.*$/gm deletes from any '//' to end-of-line even when '//' occurs inside a string value (e.g. a URL). The shipped config/sudo-ai.json5 uses single-quoted values (timezone: 'UTC', id: 'ollama/kimi-k2.6:cloud', etc.), so readConfig() throws on the actual file.  
_Skeptic: real · Auditor: None_

**D2. [high] require('smol-toml') always throws in this ESM package, forcing the buggy fallback parser** — `src/core/config/settings-manager.ts:492`  
The package is `"type": "module"` (ESM, verified) and tsconfig module=ESNext. `parseSettingsToml` calls `const { parse } = require('smol-toml')` inside a try block; in a pure-ESM context `require` is not defined and throws `ReferenceError: require is not defined` (verified). The catch silently swallows it and always falls through to the hand-rolled lightweight parser. This means the spec-compliant smol-toml path is NEVER taken, so the kvMatch[2] bug (above) is the live code path for all real settings parsing, not a rare fallback. (By contrast, loader.ts correctly uses `await import('smol-toml')`.)  
_Skeptic: false_positive · Auditor: real_

**D3. [high] reject endpoint can overwrite an already-approved/applied proposal** — `src/core/gateway/learning-routes.ts:195`  
handleReject calls deps.proposalStore.reject(id, reason) without checking the proposal's current status. Unlike handleApprove (which returns 409 when status is 'approved' or 'applied'), reject has no idempotency/state guard, and ProposalStore.reject (proposal-store.ts:187) also performs an unconditional UPDATE ... SET status='rejected' with no status check (it only throws on not-found). As a result a proposal that was already approved — or already APPLIED to the live agent config — can be flipped back to 'rejected'.  
_Skeptic: None · Auditor: real_

**D4. [medium] better-sqlite3 DB handle leaked when a cost query throws after open** — `src/core/api/admin/models.handler.ts:235`  
In GET /api/admin/models/cost the Database is opened, then several prepared statements are executed. db.close() is only called on the table-missing path (line 245) and the success path (line 276). If new Database succeeds but any subsequent prepare/get/all throws (e.g. schema mismatch, locked db), execution jumps to the outer catch at line 279 which returns a placeholder but never closes db. Because db is a const declared inside try, the catch cannot close it either.  
_Skeptic: real · Auditor: None_

**D5. [medium] tool_sequences populated with message-content snippets instead of tool names, corrupting procedural memory** — `src/core/consciousness/orchestrator.ts:327`  
onInteractionEnd builds `toolCalls` as truncated message content strings (`messages.filter(m => m.role==='assistant' && m.content.includes('tool')).map(m => truncate(m.content, 60))`) and inserts JSON.stringify(toolCalls) into the `tool_sequences.sequence` column. The procedural-memory detector (detector.ts findRepeatedPatterns) JSON.parses that same column as an array of TOOL NAMES (`JSON.parse(row.sequence) as string[]`) and compiler.ts compiles each entry into a Procedure step `toolName`. So procedures get compiled from conversation-text fragments rather than actual tool names. This is the ONLY writer to tool_sequences in the codebase (procedural-memory's observeSequence, which would write real tool names, is never called from outside its module). The garbage procedures then surface through getIntelligenceBriefContext -> proceduralMemory.findMatchingProcedure(message) (orchestrator.ts:442), producing bogus 'matching procedure' guidance.  
_Skeptic: false_positive · Auditor: real_

**D6. [medium] after:tool-call hook always emits success:true even for failed tool results** — `src/core/agent/loop.ts:1011`  
The after:tool-call hook is emitted with hardcoded `success: true`, despite the immediately-following blocks computing the real outcome via isToolResultSuccess(_tr.result). Any hook handler subscribed to after:tool-call (metrics, failure tracking, retries) will always see success=true and never observe failures.  
_Skeptic: false_positive · Auditor: real_

**D7. [medium] Malformed numeric limit/offset query params yield empty marketplace results** — `src/core/gateway/community-routes.ts:194`  
handleMarketplaceSearch passes limit: parseInt(... ?? '20', 10) and offset: parseInt(... ?? '0', 10) straight into marketplace.search. parseInt returns NaN for non-numeric input (e.g. ?limit=abc). marketplace.search (marketplace.ts:272-274) uses filters.limit ?? maxPerPage and filters.offset ?? 0, but the ?? nullish operator does NOT replace NaN, so Math.min(NaN, max) = NaN and results.slice(offset, offset + NaN) returns [].  
_Skeptic: None · Auditor: real_

**D8. [medium] REST route test relies on fixed 50ms sleep and leaks GATEWAY_TOKEN if assertion or handler timing fails** — `tests/skills/skills-hub.test.ts:437`  
The handler is invoked via server.emit('request', ...) which runs asynchronously and is not awaited; the test then waits a hardcoded setTimeout(50ms) before asserting mockFetch was called. The GATEWAY_TOKEN env var restoration (lines 444-448) is placed AFTER the assertion at line 442, so if expect(mockFetch).toHaveBeenCalled() throws (e.g., handler not finished within 50ms, or fetch chain delayed by retry backoff), the env restore never executes and GATEWAY_TOKEN='test-token' leaks into all subsequent tests/files in the worker, potentially auth-bypassing or breaking later assertions.  
_Skeptic: false_positive · Auditor: real_

**D9. [medium] discover() dereferences card.capabilities which register() never validates** — `src/core/agent/a2a-protocol.ts:120`  
register() only validates card.id and card.endpoint (lines 92-93). It does not validate that card.capabilities is an array. discover() then calls card.capabilities.some(...) on every registered card. If any peer card was registered without a capabilities array (e.g. parsed from a remote agent card JSON that omitted the field, or a programmatic registration), discover() throws 'TypeError: Cannot read properties of undefined (reading some)'. Because discover iterates ALL registry entries, a single malformed peer breaks discovery for every capability query.  
_Skeptic: false_positive · Auditor: real_

**D10. [medium] Quoted-key value parsing branch unreachable / dropped for quoted keys** — `src/core/config/settings-manager.ts:540`  
Even after fixing the value to kvMatch[3], the parser handles quoted keys for the key name (kvMatch[1]) but the same quoted-key line currently crashes due to the kvMatch[2] value bug. Independently, when a quoted dotted key is present, the bare-key alternation group 2 is undefined; combined with the value bug this throws. This is the same root cause but is called out because the intended feature ("supports quoted keys with dots like agent.name") is completely non-functional: quoted-key lines are either crashed or, after the value fix, would still work — confirming the value-group fix is the single required change. Flagging so the fix is validated against quoted keys, not just bare keys.  
_Skeptic: false_positive · Auditor: real_

**D11. [medium] Inbound federation signature only covers payload, not event metadata (forgeable envelope)** — `src/core/gateway/federation-routes.ts:241`  
In the verify-on-ingest path the SignedArtifact is reconstructed with payload: fedEvent.payload only, and verifyWithPublicKey/buildSignInput sign exactly JSON.stringify(payload)+signedAt (signer.ts:110-112, 509). Outbound signing (audit-chain-sync.ts:189) likewise signs only envelope.payload. Therefore instanceId, eventType, ts, seq and id are never cryptographically bound to the signature.  
_Skeptic: None · Auditor: real_

**D12. [medium] Zero-tool sessions always classified as 'failure', overriding success signals** — `src/core/outcomes/goal-evaluator.ts:84`  
toolRatio is 0 when totalTools === 0 (line 72), and hasLowToolRatio = toolRatio < FAILURE_RATIO_THRESHOLD (0.3) is therefore true for every session with no tool calls. The failure branch is checked first (line 99) and returns immediately, so a session that has no tool calls but ends with a clear success keyword (e.g. 'completed successfully') is labeled 'failure'. The code even pushes the evidence 'No tool calls recorded' yet still returns failure, never reaching the success check.  
_Skeptic: false_positive · Auditor: real_

**D13. [medium] schemaToParam marks an object parameter as required:true whenever it merely HAS a (possibly empty) required key-list** — `src/core/tools/toolbox-schema.ts:207`  
For object schemas, `required` is computed as `objSchema.required !== undefined` (lines 207 and 255). TObject() (types file line 155) sets `required` to the combined required-key array, or `undefined` only when that array is empty. So any TObject that has at least one required sub-property yields a non-undefined `required` array → the whole object PARAMETER is marked required:true, conflating 'this object has required sub-fields' with 'this object parameter must itself be supplied by the LLM'. An optional object argument that contains required inner fields is wrongly forced to be always present.  
_Skeptic: uncertain · Auditor: real_

**D14. [medium] recordWorkSession can corrupt the progress/status of an already-completed goal** — `src/core/autonomy/goal-engine-v2.ts:142`  
recordWorkSession(goalId, progress) unconditionally overwrites progress and only flips status to 'completed' when progress>=100. It never guards against goals that are already 'completed' (or 'failed'/'paused'). Passing a progress value <100 on a completed goal sets progress back below 100 while leaving status='completed', producing an inconsistent record (status complete but progress e.g. 40).  
_Skeptic: false_positive · Auditor: real_

**D15. [medium] Aggregate-fallback double-counts cost when estimating input and output tokens** — `src/core/gateway/savings-routes.ts:163`  
When no per-model breakdown exists, the fallback reconstructs estInputTokens = total.estimatedUsd * 1e6 / 5 AND estOutputTokens = total.estimatedUsd * 1e6 / 20, each derived as if the ENTIRE total cost were spent on that one direction (100% input at $5/M, and simultaneously 100% output at $20/M). The two are then both fed to estimateEnergy and reported as the request's token counts.  
_Skeptic: None · Auditor: real_

**D16. [low] Request body cast to object before type-guard; JSON null body throws TypeError (returns 500 instead of 400)** — `src/core/api/admin/models.handler.ts:189`  
readJsonBody resolves any valid JSON value (string, number, null, array), not just objects. PUT /providers/:id/key casts `body as Record<string, unknown>` and immediately reads `b['key']` outside any try/catch. If the client sends the literal JSON `null`, `b['key']` throws 'Cannot read properties of null'. The dispatch loop catches it and returns a 500 'Internal server error' rather than the intended 400 validation error. Same cast-before-guard pattern in security.handler.ts POST /tokens (line 63 -> body['name']) and PUT /cors (line 167 -> body['origins']).  
_Skeptic: real · Auditor: None_

**D17. [low] CJS require() fallback is unreachable in ESM module (require is not defined)** — `src/core/skills/loader.ts:216`  
The package is "type":"module" and this file is an ESM module (uses dynamic import / pathToFileURL). The fallback path attempts `exports = require(entryPath)` to recover from an 'Unknown file extension' import error, but `require` is not defined in ESM scope, so this line throws ReferenceError instead of loading the module. The error is caught by the outer try/catch, so the intended recovery for .ts entry paths never actually recovers — the skill is silently skipped.  
_Skeptic: false_positive · Auditor: real_

**D18. [low] updateEnvVar does not sanitize value, allowing newline injection into .env** — `src/core/api/admin/config-io.ts:104`  
updateEnvVar writes `${key}=${value}` directly. The value is not escaped or validated for newlines. A value containing a '\n' would inject additional KEY=VALUE lines into the .env file. models.handler.ts PUT /providers/:id/key trims but does not strip embedded newlines before calling updateEnvVar.  
_Skeptic: real · Auditor: None_

**D19. [low] messageTimestamp cast to number can yield Invalid Date for Long-typed timestamps** — `src/core/channels/whatsapp.ts:320`  
Baileys types raw.messageTimestamp as `number | Long | null | undefined`. The code casts it directly: `new Date((raw.messageTimestamp as number) * 1000)`. When Baileys returns a Long object (common for large/64-bit timestamps) rather than a plain number, multiplying the object by 1000 produces NaN, so the message timestamp becomes an Invalid Date. There is also no null guard, so a missing timestamp yields `new Date(NaN)`.  
_Skeptic: false_positive · Auditor: real_

**D20. [low] observeSequence occurrence count and session_ids include duplicate sessions and are inconsistent with insert semantics** — `src/core/consciousness/procedural-memory/detector.ts:105`  
observeSequence inserts a new row on EVERY call, then counts `COUNT(*)` for that sequence and GROUP_CONCATs session_id. Because the same session can observe the same sequence multiple times, occurrences counts row insertions rather than distinct sessions, and session_ids contains duplicate session IDs. The result's sessionIds (later stored verbatim in Procedure.compiledFrom) therefore can contain repeats, and the '3 occurrences' threshold can be reached by a single session repeating the pattern 3 times rather than 3 independent observations as the docs claim ('seen enough times' / 'observed in N session(s)').  
_Skeptic: false_positive · Auditor: real_

**D21. [low] learnCooccurrence inserts edges without ensuring concept nodes exist (FK violation if called directly)** — `src/core/consciousness/spreading-activation/network.ts:201`  
concept_edges.from_id/to_id are declared REFERENCES concept_nodes(id) and the DB enables PRAGMA foreign_keys=ON (consciousness-db.ts:538). learnCooccurrence calls upsertEdge directly without first creating the referenced nodes. When reached via activate() the nodes are pre-created in the same flow, but learnCooccurrence is a public, documented method; calling it directly with previously-unseen concept ids will throw a FOREIGN KEY constraint failure (wrapped as ConsciousnessError consciousness_spreading_cooccurrence_failed).  
_Skeptic: false_positive · Auditor: real_

**D22. [low] httpsGet ignores HTTP status code; non-2xx bodies parsed as success** — `src/core/skills/intelligence/daily-brief/index.ts:51`  
httpsGet resolves with the full response body regardless of res.statusCode. A 4xx/5xx response (e.g. HN rate-limit 503 with an HTML body) is returned as if successful. Callers then JSON.parse it (HN) or HTML-scrape it (GitHub). For HN this surfaces as a thrown parse error caught by the try/catch (acceptable), but the helper itself never distinguishes a successful 200 from an error page, so error pages can be silently treated as content.  
_Skeptic: false_positive · Auditor: real_

**D23. [low] Quota check and increment are not atomic; concurrent uploads can over-spend quota** — `src/pipeline/youtube-uploader.ts:246`  
checkQuotaAvailable() reads quota.json at the start (line 246) but the quota is only incremented after a successful upload (lines 279-281). There is no reservation between the read and the later write. If two uploadToYouTube calls run concurrently (or overlap), both can pass the availability check while the file still shows the old 'used' value, both upload, and the second writeQuota overwrites the first's increment (last-writer-wins on readQuota/writeQuota), undercounting consumed quota.  
_Skeptic: uncertain · Auditor: uncertain_

**D24. [low] total_activations diverges between in-memory cache and DB; flush() overwrites the correct DB value** — `src/core/consciousness/spreading-activation/network.ts:67`  
_persist uses upsertNode whose ON CONFLICT does total_activations = total_activations + 1 in the DB. In addEdge, _persist(_getOrCreate(id)) is called purely to materialise nodes; _getOrCreate creates an in-memory node with totalActivations:0 and does not increment it, while upsertNode bumps the DB count. The in-memory ConceptNode therefore lags the DB. flushActivations (store.ts) writes total_activations = excluded.total_activations (the stale in-memory value), which would overwrite the DB's higher count. The corruption only manifests if flush() is invoked; flush()/decay() are not currently wired in the orchestrator, so impact is latent.  
_Skeptic: false_positive · Auditor: real_

**D25. [low] MCP bearer token compared with non-constant-time ===** — `src/core/gateway/mcp-server.ts:173`  
isTokenValid compares the client-supplied token with the configured SUDO_MCP_TOKEN using plain string equality (provided === opts.token). Every other gateway auth path in this codebase uses crypto.timingSafeEqual to avoid leaking token contents via comparison timing. While stdio transport is single-owner, the handler context is shared with the (planned) http transport, and the comparison is timing-observable.  
_Skeptic: None · Auditor: uncertain_

**D26. [low] Unrecognised operator desyncs results/logics arrays in evaluateCondition** — `src/core/workflows/executor.ts:173`  
When a comparison's middle token is not '===' or '!==', the code pushes a false result and advances by only one token (i++), instead of skipping the whole 3-token comparison. This misaligns the subsequent token stream so later '&&'/'||' tokens may be mis-parsed and the results[] / logics[] arrays no longer correspond positionally, producing an arbitrary boolean rather than the documented 'false on malformed input'.  
_Skeptic: real · Auditor: uncertain_

**D27. [low] Stop-confirmation setTimeout is not cleared on unmount** — `src/renderer/components/admin/dashboard/AdminDashboardPage.tsx:126`  
handleStop schedules `setTimeout(() => setConfirmStop(false), 5000)` but never stores or clears the timer. If the component unmounts within the 5s window after the first click, the timer fires and calls setState on an unmounted component. This is a minor leak/no-op-warning rather than data corruption.  
_Skeptic: real · Auditor: false_positive_

**D28. [low] SUDO_CROSS_CONTROL_DISABLE env var leaks if cu.exec rejects instead of resolving** — `tests/tools/computer-use-cross-platform.test.ts:166`  
The 'sandbox cross compat + kill switch' test sets process.env.SUDO_CROSS_CONTROL_DISABLE='1' (line 166) and only deletes it on line 171 after awaiting cu.exec and asserting. The delete is not in a try/finally. If cu.exec('echo') rejects (throws) rather than returning {success:false}, or the assertion on line 170 throws, the kill-switch env var persists and disables cross-platform control for every subsequent test in the same worker, causing cascading false failures.  
_Skeptic: false_positive · Auditor: real_

---

## Appendix A — confirmed bugs grouped by file

- **`produce-kitchen.mjs`** (1)
  - L366 [low] Unvalidated parseFloat of ffprobe duration can propagate NaN through the whole pipeline
- **`scene01-pipeline.mjs`** (1)
  - L110 [medium] Generated image saved via `img:last-child` selector grabs the wrong element
- **`scripts/all-10-capture.mjs`** (1)
  - L5 [low] Fallback newPage() throws TypeError when CDP browser has zero contexts
- **`scripts/all-10-test.mjs`** (1)
  - L91 [low] Completion detected as soon as input is re-enabled, even before any response exists
- **`scripts/final-needs-test.mjs`** (1)
  - L5 [medium] Optional chaining does not guard the fallback; empty contexts crashes instead of creating a page
- **`scripts/generate-tts-001.mjs`** (1)
  - L211 [low] Duration display uses Math.round for minutes, overstating elapsed minutes
- **`scripts/soak.ts`** (2)
  - L113 [high] RSS sampling measures the soak runner itself, not the target server
  - L137 [medium] Soak error rate ignores 4xx, producing false PASS for auth/not-found failures
- **`scripts/tui-real-user-test.mjs`** (1)
  - L93 [low] Validation harness reports PASS almost unconditionally due to weak success heuristic
- **`src/cli.ts`** (1)
  - L112 [low] runShutdown mutates handler list with .reverse() and has no re-entrancy guard — double teardown if a second signal arrives during async shutdown
- **`src/cli/commands/chat/App.tsx`** (1)
  - L493 [medium] /clear and Ctrl+L do not reset the agent session — "History cleared" is misleading and agent retains full context
- **`src/cli/commands/chat/components/Header.tsx`** (1)
  - L38 [low] Narrow-terminal model truncation chops version dots (e.g. gpt-4.1 -> gpt-4)
- **`src/cli/commands/chat/components/Input.tsx`** (1)
  - L38 [medium] Second @-mention never reopens the mention menu
- **`src/cli/commands/chat/components/ToolCallCard.tsx`** (1)
  - L55 [low] Negative slice when tool name length >= 40 garbles arg display
- **`src/cli/commands/chat/hooks/useDigest.ts`** (1)
  - L53 [low] Non-numeric API score coerces to NaN, silently shown as red with NaN value
- **`src/cli/commands/chat/markdown.ts`** (1)
  - L142 [low] Ordered list renders wrong numbers, ignores marked's token.start
- **`src/cli/commands/chat/provider.ts`** (1)
  - L229 [medium] _streamAnthropic emits the 'done' usage chunk more than once, double-counting tokens
- **`src/cli/commands/doctor.ts`** (1)
  - L248 [low] checkDiskSpace mis-parses df output when the device/Filesystem name wraps to its own line
- **`src/cli/commands/setup.tsx`** (1)
  - L491 [high] Interactive setup model selector is non-functional — model can never be changed
- **`src/core/agent/approval.ts`** (1)
  - L215 [medium] Approval YES/NO parsing uses naive substring match, misclassifying words containing YES/NO
- **`src/core/agent/background-agent.ts`** (1)
  - L58 [medium] launchBackground IDs use Date.now() only, causing Map key collisions / overwrites
- **`src/core/agent/best-of-n.ts`** (2)
  - L202 [medium] LLM-supplied candidateIndex used as array index without bounds validation
  - L238 [low] Candidate worktree created with non-deterministic name unrelated to later cleanup/branch reference
- **`src/core/agent/cloud-tasks.ts`** (1)
  - L74 [medium] Cloud task IDs use Date.now() only, causing Map key collisions / overwrites
- **`src/core/agent/context.ts`** (1)
  - L144 [low] shouldCompact triggers at 50% but documents/logs 80% threshold
- **`src/core/agent/coordinator.ts`** (1)
  - L103 [medium] load() wipes in-memory requests to [] on transient read/parse failure during concurrent writes
- **`src/core/agent/doom-loop.ts`** (1)
  - L247 [high] JSON.stringify replacer array strips all nested arg fields, collapsing distinct tool calls to one signature
- **`src/core/agent/loop-guard.ts`** (1)
  - L233 [high] _hashArgs uses JSON.stringify replacer-array which discards nested object values
- **`src/core/agent/loop-helpers.ts`** (1)
  - L819 [high] LAYER 3 sliding window can orphan tool-result messages from their assistant tool-call message
- **`src/core/agent/loop.ts`** (3)
  - L1389 [medium] ToolOutcomeLearner.onSessionEnd fed fabricated per-tool success flags (first-N-are-success)
  - L2306 [medium] CRITICAL tool-output injection detected only AFTER the poisoned result is already in session history
  - L2405 [high] GoalStopDetector.detect() called with malformed GoalProgress — always throws (gate is inert)
- **`src/core/agent/plan-mode-v2.ts`** (1)
  - L186 [medium] exitPlanMode() leaves stale plan.json on disk, causing inconsistent restore (state=normal but activePlan non-null)
- **`src/core/agent/remote-triggers.ts`** (1)
  - L72 [medium] Trigger ID derived only from Date.now() collides and silently overwrites when two triggers are created in the same millisecond
- **`src/core/agent/response-compressor.ts`** (1)
  - L107 [low] Line-count compression path does not re-enforce the character budget
- **`src/core/agent/spawn-tool.ts`** (2)
  - L86 [low] TOCTOU between getActive() check and swarm.spawn() allows the advisory concurrency gate to be exceeded
  - L87 [medium] Hardcoded concurrency cap of 4 contradicts MAX_SWARM_AGENTS (100) used by the swarm queue
- **`src/core/agent/subagent-models.ts`** (1)
  - L87 [medium] worktreeAgent creates a temp directory with mkdtempSync but never removes it
- **`src/core/agent/swarm.ts`** (1)
  - L222 [high] Sub-agent timeout AbortController is never wired to loop.run(), so timed-out agents are not actually stopped
- **`src/core/agent/task-manager.ts`** (2)
  - L198 [medium] Dead guard `wasPending !== undefined` re-fires task:completed hook on re-completion
  - L198 [medium] updateTask re-fires task:completed (and resets completedAt / re-propagates unblock) on an already-completed task
- **`src/core/autonomy/approval-matrix.ts`** (1)
  - L300 [high] Destructive-command 'never' guard trivially bypassed by substring matching
- **`src/core/autonomy/wake-sleep-cycle.ts`** (1)
  - L219 [high] goal:completed hook emitted even when goal was not completed
- **`src/core/awareness/proactive-notifier.ts`** (1)
  - L69 [low] Notification trim removes a fixed count, leaving more than TRIM_TO entries
- **`src/core/brain/brain.ts`** (1)
  - L889 [medium] Reasoning extraction treats SDK v6 result.reasoning (an array) as string/object-with-text
- **`src/core/brain/costs.ts`** (1)
  - L207 [high] buildTokenUsage reads non-existent promptTokens/completionTokens from AI SDK v6 usage object
- **`src/core/brain/negative-router.ts`** (1)
  - L225 [medium] Keyword heuristic mislabels no-match input as 'coding'
- **`src/core/brain/prompt-cache-optimizer.ts`** (1)
  - L121 [high] buildOptimizedPrompt cache returns stale dynamic content on hit
- **`src/core/business/analytics.ts`** (2)
  - L117 [low] Month label and SQL start date can disagree by one day in positive-UTC-offset timezones
  - L118 [medium] Revenue trend double-counts invoices paid on month boundary (inclusive end)
- **`src/core/business/calendar.ts`** (2)
  - L194 [low] Stub updateEvent fabricates empty title/start/end instead of preserving prior values
  - L202 [medium] updateEvent patch can wipe start/end times not included in the partial
- **`src/core/channels/matrix.ts`** (2)
  - L120 [low] Prime-sync failure leaves _nextBatch undefined, causing first sync to replay full room history
  - L171 [medium] Cached empty self-id after whoami failure permanently disables own-message filtering (self-response loop)
- **`src/core/channels/rate-limit.ts`** (1)
  - L347 [low] Failed persistence renames temp file to unbounded .failed files
- **`src/core/channels/slack-receive.ts`** (2)
  - L90 [high] Inverted/dead condition makes Slack Socket Mode reconnect even after stop()
  - L183 [medium] SlackPoller uses one shared _lastTs cursor across multiple channels, causing message loss
- **`src/core/channels/web.ts`** (1)
  - L393 [low] Floating promise on /api/message dispatch can throw unhandled rejection and never replies on error
- **`src/core/cognition/epistemic-gate.ts`** (1)
  - L65 [medium] Impact-classification regexes match substrings, misclassifying benign tool names
- **`src/core/cognition/mistake-pattern-recognizer.ts`** (1)
  - L374 [low] findSimilar computes Jaccard against truncated 100-char signature vs full 500-char query
- **`src/core/commands/builtin/budget.ts`** (1)
  - L166 [medium] Budget totals undercount when api_costs has more than 500 rows in the window
- **`src/core/config/settings-manager.ts`** (1)
  - L541 [critical] TOML key=value parser reads the key capture group as the value (wrong regex group)
- **`src/core/config/watcher.ts`** (1)
  - L125 [medium] fs.watch on a single file stops firing after atomic-rename saves
- **`src/core/consciousness/attention-system/attention.ts`** (1)
  - L42 [low] Signal with unparseable timestamp never expires and is never drained
- **`src/core/consciousness/auto-dream.ts`** (2)
  - L98 [medium] acquireLock has a check-then-write race allowing two concurrent dream cycles
  - L200 [low] Invalid/missing lastRun in state silently bypasses the 24h cooldown
- **`src/core/consciousness/cron-scheduler.ts`** (2)
  - L295 [medium] One-shot tasks inherit recurring 7-day expiry and can be deleted before firing
  - L459 [low] Recurring task jitter timers are orphaned (not tracked/cleared) when re-scheduled each minute
- **`src/core/consciousness/dream-consolidator.ts`** (1)
  - L249 [medium] consolidate() appends freshly-detected patterns to existing patterns without dedup, causing unbounded growth
- **`src/core/consciousness/embodied-state/store.ts`** (1)
  - L71 [high] getStateHistory time-window filter is broken by timestamp-format mismatch
- **`src/core/consciousness/heartbeat.ts`** (2)
  - L516 [medium] Cost metrics report only the top model's tokens, not the system total due to GROUP BY
  - L762 [medium] _renderProgressBar throws RangeError when progress > 100, crashing briefing generation
- **`src/core/consciousness/kairos.ts`** (1)
  - L551 [low] Telegram CRITICAL alert cooldown is committed before the notification is confirmed sent
- **`src/core/consciousness/relationship-model/tracker.ts`** (2)
  - L258 [medium] _computeStage 'recent conflict' check has no recency — permanently pins stage to 'acquaintance'
  - L277 [low] _computeTrajectory uses cumulative counts, not a sliding window of recent outcomes
- **`src/core/consciousness/self-evolution/detector.ts`** (1)
  - L59 [high] detectCapabilityGaps compares numeric level against a string Set — always returns empty
- **`src/core/consciousness/sleep-cycle/integrity-verifier.ts`** (1)
  - L62 [high] Integrity check 2 falsely fails when counterfactual insights exceed 3x pattern count
- **`src/core/consciousness/theory-of-mind/helpers.ts`** (1)
  - L111 [low] detectFrustration counts numeric/symbol tokens as ALL-CAPS, producing false frustration signals
- **`src/core/consciousness/theory-of-mind/store.ts`** (1)
  - L108 [medium] saveUserModel uses INSERT OR REPLACE without created_at, resetting account creation timestamp on every update
- **`src/core/creative/creative-engine.ts`** (1)
  - L143 [medium] evolveStyle throws a UNIQUE constraint violation when the same base style version is evolved more than once
- **`src/core/cron/multi-delivery-routes.ts`** (1)
  - L44 [medium] sendJson calls res.write() after res.end() (write-after-end) — masked by the in-chunk test mock
- **`src/core/earning/optimizer.ts`** (1)
  - L135 [medium] getBestUploadTime always returns 00:00 UTC because recordedAt has no time component
- **`src/core/earning/tracker.ts`** (1)
  - L218 [high] getRevenue double-counts revenue across multiple snapshots per video
- **`src/core/economy/wallet.ts`** (1)
  - L106 [medium] getBalance ordering tie-break can read a stale balance for same-millisecond transactions
- **`src/core/memory/auto-dream.ts`** (1)
  - L72 [medium] acquireLock has a TOCTOU race; concurrent dream runs can both proceed
- **`src/core/memory/auto-summarizer.ts`** (1)
  - L162 [low] summarizeSession ignores constructor dbPath and always reads messages from hardcoded MIND_DB
- **`src/core/memory/embeddings.ts`** (1)
  - L189 [medium] Embedding cache key mismatch: write keyed by hash only, read keyed by (hash, model)
- **`src/core/memory/hybrid-search.ts`** (1)
  - L313 [medium] vector-only / bm25-only branches skip weight scaling, breaking minScore filter consistency
- **`src/core/operators/operator-scheduler.ts`** (2)
  - L40 [medium] Day-of-week / weekly cron expressions are ignored, causing daily firing
  - L78 [medium] Every-minute cron '* * * * *' fires hourly, not every minute
- **`src/core/optimization/auto-optimizer.ts`** (1)
  - L216 [low] disableRule throws for rules present in DB but absent from in-memory map
- **`src/core/orchestration/executor.ts`** (1)
  - L158 [low] onFail callback not invoked when a task fails via hard timeout
- **`src/core/self-build/deployment-hook.ts`** (2)
  - L90 [high] Merged PR is re-deployed forever — checkAndDeploy never stops its own monitor
  - L106 [high] Rollback resets to the merged PR head SHA instead of the previous good commit
- **`src/core/self-build/orchestrator.ts`** (2)
  - L444 [medium] Untracked files outside cleaned roots permanently wedge the tick in dirty-state
  - L655 [medium] Post-commit protected-path revert ignores git revert failure
- **`src/core/self-improvement/engine.ts`** (2)
  - L188 [high] runSelfImprovement crashes when data/mind.db does not exist
  - L269 [medium] fbDb SQLite handle leaks when any feedback/auto-research step throws
- **`src/core/sessions/manager.ts`** (2)
  - L135 [high] save() on a session not present in cache re-persists ALL messages, duplicating history in the DB
  - L345 [high] _loadFromDb LIMIT 20 across all sessions can fail to find an existing active session
- **`src/core/sessions/outcome-adapters.ts`** (1)
  - L47 [medium] getRecentMessages returns the OLDEST n messages, not the most recent n
- **`src/core/sessions/session-lanes.ts`** (1)
  - L108 [medium] activeTasks map keyed by composite key is overwritten by concurrent enqueues, undercounting active tasks
- **`src/core/skills/markdown-loader.ts`** (1)
  - L51 [low] Frontmatter regex fails on CRLF line endings
- **`src/core/skills/registry-routes.ts`** (1)
  - L82 [high] Broken bundled-skill pagination: wrong total and skipped/missing skills
- **`src/core/superpowers/archive-manager.ts`** (1)
  - L130 [high] Format auto-detection for extract/list reads the wrong path (output/undefined instead of input)
- **`src/core/superpowers/data-analyzer.ts`** (1)
  - L24 [low] parseCSV splits naively on commas/newlines, corrupting quoted fields
- **`src/core/superpowers/ffmpeg-tools.ts`** (1)
  - L177 [high] GIF two-pass: -ss/-t inserted into wrong argv positions, producing invalid ffmpeg command
- **`src/core/superpowers/image-editor.ts`** (1)
  - L124 [medium] Watermark text interpolated into SVG without XML escaping
- **`src/core/superpowers/pdf-generator.ts`** (1)
  - L122 [medium] Playwright browser not closed when page.goto/page.pdf throws
- **`src/core/superpowers/security-scan.ts`** (1)
  - L101 [medium] npm audit 'moderate' severity is silently downgraded to 'info'
- **`src/core/superpowers/translate.ts`** (1)
  - L53 [low] restoreBlocks uses String.replace with raw content, mangling $-sequences in code blocks
- **`src/core/swarm/swarm-manager.ts`** (1)
  - L208 [low] requestVote role-match uses non-lowercased agent.role against lowercased option
- **`src/core/tools/builtin/meta/buddy.ts`** (1)
  - L100 [medium] loadBuddy() increments sessionsCount and re-levels on every action, not per session
- **`src/core/tools/builtin/meta/cron-create.ts`** (1)
  - L50 [low] Cron field regex accepts out-of-range and malformed field values
- **`src/core/tools/builtin/meta/event-daemon-tool.ts`** (2)
  - L137 [high] Non-numeric pollIntervalMs makes status action start a 1ms CPU-burning poll loop
  - L152 [low] status output always reports DEFAULT_POLL_MS instead of the actual poll interval
- **`src/core/tools/builtin/meta/feedback.ts`** (1)
  - L46 [low] Negative or non-numeric days yields a future/invalid 'since' cutoff
- **`src/core/tools/builtin/pm/index.ts`** (1)
  - L388 [low] pm.time-tracker stop can re-stop an already-completed entry and corrupt its duration
- **`src/core/tools/builtin/research/tools/research-tools.ts`** (1)
  - L182 [low] arXiv ID lookup uses all: full-text search instead of id_list, often returns wrong/empty result
- **`src/core/tools/builtin/skill/tools/usage-stats.ts`** (1)
  - L101 [medium] Running-average duration computation uses wrong denominator when some rows lack durationMs
- **`src/core/tools/builtin/social/platform-tools.ts`** (1)
  - L122 [high] social.multi-post double-posts when 'schedule' is combined with a live platform
- **`src/core/tools/builtin/system/tasks.ts`** (2)
  - L112 [low] Read-modify-write of tasks.json is not atomic — concurrent operations lose updates
  - L142 [low] Task id prefix matching can act on the wrong task and lacks ambiguity detection
- **`src/core/tools/mcp-adapter.ts`** (1)
  - L671 [low] JSON-RPC notifications are sent with an `id`, violating the spec
- **`src/core/tools/mcp-oauth.ts`** (1)
  - L263 [medium] getAccessToken always performs a network refresh when a refresh_token exists, even for valid tokens
- **`src/core/tools/mcp-sse-transport.ts`** (2)
  - L174 [critical] SSE connect() never resolves — blocks the entire SSE MCP handshake forever
  - L210 [medium] SSE event/data parsing reads the wrong source, duplicating and mis-pairing messages
- **`src/core/tools/mcp-ws-transport.ts`** (2)
  - L161 [medium] WebSocket subprotocol passed via options.protocol is ignored by the ws library
  - L238 [medium] WebSocket heartbeat fires only once — periodic liveness checks stop after the first ping
- **`src/core/tools/tool-parallelism.ts`** (1)
  - L179 [high] Independent tool results keyed by tool NAME instead of call ID, breaking the documented result map contract and dropping duplicate-tool results
- **`src/core/update/update-manager.ts`** (1)
  - L313 [high] Failed update silently abandons stashed working-tree changes (wrong recovery condition)
- **`src/core/update/version-resolver.ts`** (1)
  - L47 [medium] compareSemver returns 1 (not 0) for two equal pre-release versions, causing a false 'update available' and update loop
- **`src/core/workflows/lobster.ts`** (1)
  - L154 [medium] Resume leaves stale 'awaiting_approval' StepResult, corrupting {{prev}} stdin and step results
- **`src/core/workspace/bootstrap.ts`** (1)
  - L186 [medium] Bootstrap retry-exhaustion fallback returns empty string instead of last input
- **`src/core/workspace/files.ts`** (1)
  - L171 [medium] Single shared debounce timer drops change events for distinct files
- **`src/core/workspace/injector.ts`** (1)
  - L120 [high] Idempotency check fails when today's log is absent, causing duplicate context injection
- **`src/core/youtube/thumbnail-ab.ts`** (1)
  - L267 [medium] All A/B variants stored with identical stub CTR makes winner selection meaningless
- **`src/pipeline/assembler-filters.ts`** (1)
  - L30 [low] drawtext escape omits '%', which ffmpeg drawtext expands as a special expansion token
- **`src/pipeline/notifier.ts`** (1)
  - L51 [low] Unescaped error message and URL interpolated into HTML notification
- **`src/pipeline/quality-gate.ts`** (1)
  - L131 [medium] probeVolume spawns a throwaway ffprobe process with no error handler, then kills it
- **`src/pipeline/script-generator.ts`** (1)
  - L59 [low] Scene index taken from raw LLM output without integer/uniqueness validation
- **`src/pipeline/voice-generator.ts`** (2)
  - L92 [low] Per-scene timestamps overshoot total audio duration (inter-scene pauses double-counted)
  - L222 [low] Duration estimate and timestamp pause counts diverge when a scene has empty narration
- **`src/pipeline/youtube-uploader.ts`** (1)
  - L255 [medium] 403 quota-exceeded is retried 3x despite docstring promising immediate fail
- **`src/remotion/quiz/QuizVideo.tsx`** (2)
  - L233 [low] diffProgress is a constant (always 1 for >=2 questions), background never varies
  - L244 [high] QuizVideo composition duration omits difficulty-badge frames, clipping the Outro
- **`src/renderer/admin/Dashboard.tsx`** (1)
  - L49 [medium] Manual Refresh error handling is dead code; ErrorBanner never displays errors
- **`src/renderer/admin/hooks/useAuthToken.ts`** (1)
  - L40 [low] Query-token path strips entire query string, dropping other params
- **`src/renderer/chat/hooks/useWebSocket.ts`** (1)
  - L54 [high] WebSocket close on unmount schedules an uncancelable zombie reconnect loop
- **`src/renderer/components/admin/channels/ChannelsPage.tsx`** (1)
  - L52 [low] Empty allowedUsers array displayed as 'All' instead of 'none'
- **`src/renderer/components/admin/security/SecurityPage.tsx`** (1)
  - L256 [low] Access log DataTable uses non-unique 'timestamp' as keyField
- **`src/renderer/components/admin/system/AdminSystemPage.tsx`** (1)
  - L387 [medium] Environment variable value is masked/displayed using key+value concatenation, corrupting the displayed value and the masking decision
- **`src/renderer/components/chat/ChatView.tsx`** (1)
  - L25 [high] agent:stream-chunk handler captures stale streamingMessageId (always null), so streamed chunks are dropped
- **`src/renderer/components/chat/ToolCallCard.tsx`** (1)
  - L64 [low] Result truncation and 'Show full result' are dead code because the entire block is gated on expanded===true
- **`src/renderer/components/common/SearchInput.tsx`** (1)
  - L68 [high] Uncontrolled input never reflects programmatic clear (Clear button leaves stale text)
- **`src/renderer/components/dashboard/DashboardView.tsx`** (1)
  - L67 [low] Floating IPC promises in mount effect drop errors (unhandled rejection)
- **`src/renderer/components/dashboard/MetricCard.tsx`** (1)
  - L29 [medium] Inverted percent-sign logic: '%' shown only for integer changes, omitted for fractional ones
- **`src/renderer/components/office/MissionControl.tsx`** (1)
  - L72 [high] AGENT_HOME_ROOM uses rooms that don't match the store's currentRoom, mispositioning agents
- **`src/renderer/components/office/drama/DramaEngine.tsx`** (2)
  - L119 [low] Inner setTimeout revert timers are never cleared on unmount
  - L164 [low] Error recovery forces state to 'working' regardless of prior state, can leave idle agents permanently 'working'
- **`src/renderer/components/office/furniture/TaskBoard.tsx`** (1)
  - L40 [high] React hook (useOfficeStore) called inside useMemo, violating rules of hooks
- **`src/renderer/components/office/rooms/MainWorkspace.tsx`** (1)
  - L31 [low] Redundant ternary places back-row chairs on the wrong side of rotated desks
- **`src/renderer/components/settings/SettingsView.tsx`** (1)
  - L84 [low] maxTokens becomes NaN when the number field is cleared
- **`src/renderer/hooks/useOfficeWebSocket.ts`** (1)
  - L178 [medium] Partial system-alert clobbers existing metrics with undefined
- **`src/renderer/lib/admin-api.ts`** (1)
  - L270 [medium] downloadLogs bypasses auth header and ignores non-OK responses
- **`src/renderer/lib/ipc-client.ts`** (3)
  - L68 [medium] getPersistentWs creates a second socket when called during CONNECTING, orphaning the first
  - L127 [high] WebSocket request/response uses single-flight module globals — concurrent sends cross-talk and drop replies
  - L177 [medium] ipcOn unsubscribe removes ALL listeners on the channel, not just the one it registered
- **`tests/channels/rate-limit.test.ts`** (1)
  - L286 [low] Persistence test writes to real cwd workspace/rate-limits.json and never deletes it
- **`tests/federation/federation-token-pool.test.ts`** (1)
  - L56 [low] createMockVault set() reads setThrows from the wrong (shadowing) opts object — throw path is dead
- **`tests/full-backend-test.ts`** (1)
  - L12 [medium] Test 3 write/check path mismatch (wrong directory) always reports false negative
- **`tests/gateway/federation-error-routes.test.ts`** (1)
  - L586 [low] FED-ERR-31 prototype-pollution test does not actually send a __proto__ key
- **`tests/gateway/federation-ingest-verify.test.ts`** (1)
  - L42 [low] In-memory better-sqlite3 Database created per test is never closed
- **`tests/health/error-reporter.test.ts`** (1)
  - L14 [low] ErrorReporter test uses a fixed on-disk SQLite path with no cleanup, leaking state across runs
- **`tests/ide/bridge-discovery.test.ts`** (1)
  - L20 [low] Wrong relative import path for shared-types/bridge-protocol
- **`tests/security/approval-registry.test.ts`** (1)
  - L84 [high] Two byte-identical approval-registry test files share the same real workspace dir (cross-file race + flaky failures)
- **`tests/security/approval/approval-registry.test.ts`** (1)
  - L143 [high] listPending test deletes ALL real workspace/approvals/pending files (production data loss)
- **`tests/skills/skills-hub.test.ts`** (1)
  - L81 [high] Test wipes the real production install directory data/installed-skills (not a temp dir)
- **`tests/tools/document.test.ts`** (1)
  - L103 [low] Path-prefix acceptance tests pass trivially because empty html short-circuits before path validation
- **`tests/tools/skill-meta.test.ts`** (1)
  - L138 [medium] usage-stats DB mock is a no-op; tests silently read real production data/audit.db

---

## Appendix B — unaudited files (coverage gap)

These 551 files were in the 31 chunks blocked by API cyber-safeguards and were **not** audited:

- `apps/sudo-x-app/src/cli.ts`
- `ast_probe_tmp.js`
- `core/skills/youtube.pipeline/assemble-video-final.ts`
- `core/skills/youtube.pipeline/assemble-video-v2.ts`
- `core/skills/youtube.pipeline/assemble-video.ts`
- `core/skills/youtube.pipeline/generate-images.ts`
- `core/skills/youtube.pipeline/generate-voice-fixed.ts`
- `core/skills/youtube.pipeline/generate-voice.ts`
- `core/skills/youtube.pipeline/music-sync-fixed.ts`
- `core/skills/youtube.pipeline/music-sync.ts`
- `crystal-mc-test.mjs`
- `ecosystem.config.cjs`
- `elite-test/buggy-server.ts`
- `elite-test/calculator-test.ts`
- `elite-test/calculator.ts`
- `elite-test/cart.ts`
- `elite-test/models.ts`
- `elite-test/shop-test.ts`
- `err-test.mjs`
- `esbuild.config.cjs`
- `final-office.mjs`
- `final-test.mjs`
- `floor-test.mjs`
- `generate-all-scenes.mjs`
- `internal/misc/ast_probe_tmp.js`
- `internal/temp-scripts/crystal-mc-test.mjs`
- `internal/temp-scripts/err-test.mjs`
- `internal/temp-scripts/final-office.mjs`
- `internal/temp-scripts/final-test.mjs`
- `internal/temp-scripts/floor-test.mjs`
- `internal/temp-scripts/generate-all-scenes.mjs`
- `internal/temp-scripts/mc-live.mjs`
- `internal/temp-scripts/mc-test.mjs`
- `internal/temp-scripts/office-screenshot.mjs`
- `internal/temp-scripts/office-test.mjs`
- `internal/temp-scripts/pixel-test.mjs`
- `internal/temp-scripts/produce-kitchen.mjs`
- `internal/temp-scripts/render-map.mjs`
- `internal/temp-scripts/run-self-test.mjs`
- `internal/temp-scripts/scene01-grok-video.mjs`
- `internal/temp-scripts/scene01-grok.mjs`
- `internal/temp-scripts/scene01-pipeline.mjs`
- `internal/temp-scripts/scene01-sora-test.mjs`
- `internal/temp-scripts/screen-test.mjs`
- `internal/temp-scripts/sora-scene01.mjs`
- `internal/temp-scripts/test-admin-e2e.mjs`
- `internal/temp-scripts/test-pages.mjs`
- `internal/temp-scripts/test-tools-load.ts`
- `mc-live.mjs`
- `mc-test.mjs`
- `office-screenshot.mjs`
- `office-test.mjs`
- `ops/federation/ecosystem-peer-a.config.cjs`
- `ops/federation/ecosystem-peer-b.config.cjs`
- `src/core/agent/task-tracker.ts`
- `src/core/agent/team/agent-mailbox.ts`
- `src/core/agent/team/intelligence-team.ts`
- `src/core/agent/team/team-bus.ts`
- `src/core/agent/team/team-memory-sync.ts`
- `src/core/agent/team/team-orchestrator.ts`
- `src/core/agent/team/team-permission-sync.ts`
- `src/core/agent/teammate-idle.ts`
- `src/core/agent/termination-legacy.ts`
- `src/core/agent/todo-gate.ts`
- `src/core/agent/tool-outcome-learner.ts`
- `src/core/agent/tool-result-classifier.ts`
- `src/core/agent/tool-router.ts`
- `src/core/agent/truncation.ts`
- `src/core/agent/types.ts`
- `src/core/agent/veto-gate.ts`
- `src/core/agent/veto-override-store.ts`
- `src/core/agent/worktree-manager.ts`
- `src/core/agent/yolo-mode.ts`
- `src/core/agents/config-types.ts`
- `src/core/agents/index.ts`
- `src/core/agents/messenger.ts`
- `src/core/agents/non-coding-roles.ts`
- `src/core/agents/orchestrator.ts`
- `src/core/agents/roles.ts`
- `src/core/agents/routes.ts`
- `src/core/agents/spawner.ts`
- `src/core/agents/specialized-types.ts`
- `src/core/agents/store-queries.ts`
- `src/core/agents/store.ts`
- `src/core/agents/team-manager.ts`
- `src/core/agents/types.ts`
- `src/core/agents/validation.ts`
- `src/core/alignment/alignment-engine.ts`
- `src/core/alignment/index.ts`
- `src/core/api/admin-router.ts`
- `src/core/api/admin/tools-helpers.ts`
- `src/core/api/admin/tools.handler.ts`
- `src/core/api/agent-sdk.ts`
- `src/core/api/handlers.ts`
- `src/core/api/http-server.ts`
- `src/core/api/index.ts`
- `src/core/api/rate-limiter.ts`
- `src/core/api/responses-api.ts`
- `src/core/api/types.ts`
- `src/core/auth/credential-pool-routes.ts`
- `src/core/auth/credential-pool-types.ts`
- `src/core/auth/credential-pool.ts`
- `src/core/auth/index.ts`
- `src/core/auth/oauth-types.ts`
- `src/core/auth/oauth.ts`
- `src/core/automation/index.ts`
- `src/core/automation/standing-orders.ts`
- `src/core/automation/types.ts`
- `src/core/business/crm.ts`
- `src/core/business/email.ts`
- `src/core/business/index.ts`
- `src/core/business/invoicing.ts`
- `src/core/business/reports.ts`
- `src/core/business/sponsor-manager.ts`
- `src/core/business/sponsor-prospects.ts`
- `src/core/business/types.ts`
- `src/core/channels/adapter.ts`
- `src/core/channels/cross-channel-memory.ts`
- `src/core/channels/discord.ts`
- `src/core/channels/email.ts`
- `src/core/channels/gcalendar-connector.ts`
- `src/core/channels/github-connector.ts`
- `src/core/channels/github-issues.ts`
- `src/core/channels/gmail-connector.ts`
- `src/core/channels/imessage-connector.ts`
- `src/core/channels/index.ts`
- `src/core/cron/cron-manager.ts`
- `src/core/cron/heartbeat-hours.ts`
- `src/core/cron/heartbeat-response.ts`
- `src/core/cron/heartbeat-tasks.ts`
- `src/core/cron/heartbeat.ts`
- `src/core/cron/index.ts`
- `src/core/cron/multi-delivery-routes.ts`
- `src/core/cron/multi-delivery-types.ts`
- `src/core/cron/multi-delivery.ts`
- `src/core/cron/scheduler.ts`
- `src/core/cron/store.ts`
- `src/core/cron/types.ts`
- `src/core/daemon/event-daemon-schema.ts`
- `src/core/daemon/event-daemon.ts`
- `src/core/daemon/event-detectors.ts`
- `src/core/daemon/index.ts`
- `src/core/dashboard/dashboard-html.ts`
- `src/core/dashboard/dashboard-routes.ts`
- `src/core/evolution/analyzer.ts`
- `src/core/evolution/code-evolver.ts`
- `src/core/evolution/index.ts`
- `src/core/features/flags.ts`
- `src/core/federation/audit-chain-sync.ts`
- `src/core/federation/federation-error-ingestor-types.ts`
- `src/core/federation/federation-error-ingestor.ts`
- `src/core/federation/federation-error-sanitizer.ts`
- `src/core/federation/federation-token-pool-types.ts`
- `src/core/federation/federation-token-pool.ts`
- `src/core/federation/peer-key-cache.ts`
- `src/core/federation/peer-key-fetcher.ts`
- `src/core/federation/peer-registry.ts`
- `src/core/feedback/index.ts`
- `src/core/feedback/keyboard.ts`
- `src/core/feedback/learning-engine.ts`
- `src/core/feedback/store.ts`
- `src/core/feedback/youtube-analytics.ts`
- `src/core/feedback/youtube-api.ts`
- `src/core/files/index.ts`
- `src/core/files/routes.ts`
- `src/core/files/store.ts`
- `src/core/files/types.ts`
- `src/core/finance/index.ts`
- `src/core/finance/revenue-tracker.ts`
- `src/core/finance/types.ts`
- `src/core/forge/code-dna.ts`
- `src/core/forge/evolution-engine.ts`
- `src/core/forge/forge-orchestrator.ts`
- `src/core/forge/parallel-builder.ts`
- `src/core/forge/self-healer.ts`
- `src/core/forge/xai-ensemble.ts`
- `src/core/gateway/admin-routes.ts`
- `src/core/gateway/admin-sleep-routes.ts`
- `src/core/gateway/bench-routes.ts`
- `src/core/gateway/cache.ts`
- `src/core/gateway/server.ts`
- `src/core/gateway/sse-stream.ts`
- `src/core/gateway/static-middleware.ts`
- `src/core/gateway/synth-probe-routes.ts`
- `src/core/gateway/well-known-routes.ts`
- `src/core/gateway/ws-server.ts`
- `src/core/health/checks.ts`
- `src/core/health/error-memory.ts`
- `src/core/health/error-reporter-helpers.ts`
- `src/core/health/error-reporter-types.ts`
- `src/core/health/error-reporter.ts`
- `src/core/health/fixes.ts`
- `src/core/health/index.ts`
- `src/core/health/metrics.ts`
- `src/core/health/watchdog.ts`
- `src/core/hooks/hook-engine.ts`
- `src/core/hooks/hook-runner.ts`
- `src/core/hooks/index.ts`
- `src/core/hooks/typed-hooks.ts`
- `src/core/ide/bridge-adapter.ts`
- `src/core/ide/bridge-auth.ts`
- `src/core/ide/bridge-discovery.ts`
- `src/core/ide/bridge-protocol.ts`
- `src/core/ide/bridge-session.ts`
- `src/core/ide/bridge-types.ts`
- `src/core/ide/discovery.ts`
- `src/core/ide/index.ts`
- `src/core/ide/installer.ts`
- `src/core/ide/lsp-client.ts`
- `src/core/ide/types.ts`
- `src/core/identity/loader.ts`
- `src/core/identity/types.ts`
- `src/core/kanban/dispatcher.ts`
- `src/core/kanban/index.ts`
- `src/core/kanban/kanban-board.ts`
- `src/core/kanban/kanban-routes.ts`
- `src/core/kanban/kanban-types.ts`
- `src/core/kanban/swarm-orchestrator.ts`
- `src/core/kanban/worker-protocol.ts`
- `src/core/knowledge/fact-extractor.ts`
- `src/core/knowledge/index.ts`
- `src/core/knowledge/kg-schema.ts`
- `src/core/knowledge/knowledge-graph.ts`
- `src/core/knowledge/note-taker.ts`
- `src/core/knowledge/obsidian.ts`
- `src/core/knowledge/rag-engine.ts`
- `src/core/knowledge/research-agent.ts`
- `src/core/knowledge/types.ts`
- `src/core/knowledge/zettelkasten.ts`
- `src/core/learning/agent-config-evolver.ts`
- `src/core/learning/failure-learner.ts`
- `src/core/learning/index.ts`
- `src/core/outcomes/index.ts`
- `src/core/outcomes/session-outcome-listener.ts`
- `src/core/persistence/index.ts`
- `src/core/persistence/state-export.ts`
- `src/core/persistence/survival-backup.ts`
- `src/core/persistence/survival-probe.ts`
- `src/core/persistence/survival.ts`
- `src/core/pipeline/index.ts`
- `src/core/pipeline/orchestrator.ts`
- `src/core/pipeline/remotion-bridge.ts`
- `src/core/pipeline/stages/assembly.ts`
- `src/core/pipeline/stages/direction.ts`
- `src/core/pipeline/stages/image-gen.ts`
- `src/core/pipeline/stages/music.ts`
- `src/core/pipeline/stages/quality-gate.ts`
- `src/core/pipeline/stages/research.ts`
- `src/core/pipeline/stages/review.ts`
- `src/core/pipeline/stages/sfx.ts`
- `src/core/pipeline/stages/video-gen.ts`
- `src/core/pipeline/stages/voice.ts`
- `src/core/pipeline/types.ts`
- `src/core/plugins/index.ts`
- `src/core/plugins/loader.ts`
- `src/core/plugins/manager.ts`
- `src/core/plugins/marketplace.ts`
- `src/core/plugins/mcp-registry.ts`
- `src/core/plugins/persistence.ts`
- `src/core/plugins/plugin-api.ts`
- `src/core/plugins/plugin-hooks.ts`
- `src/core/plugins/plugin-loader.ts`
- `src/core/plugins/plugin-manifest.ts`
- `src/core/plugins/plugin-marketplace.ts`
- `src/core/plugins/types.ts`
- `src/core/prediction/index.ts`
- `src/core/prediction/predictor-logic.ts`
- `src/core/prediction/predictor-schema.ts`
- `src/core/prediction/predictor.ts`
- `src/core/privacy/zdr-mode.ts`
- `src/core/profiles/profile-manager.ts`
- `src/core/profiles/profile-routes.ts`
- `src/core/profiles/profile-types.ts`
- `src/core/recipes/index.ts`
- `src/core/recipes/recipe-composer.ts`
- `src/core/recipes/recipe-types.ts`
- `src/core/sandbox/index.ts`
- `src/core/sandbox/sandbox-manager.ts`
- `src/core/sandbox/sandbox-policy.ts`
- `src/core/sandbox/sandbox-profiles.ts`
- `src/core/sandbox/sandbox-runner.ts`
- `src/core/sandbox/sandbox-types.ts`
- `src/core/sandbox/wasm-runner.ts`
- `src/core/scheduling/index.ts`
- `src/core/scheduling/smart-scheduler-schema.ts`
- `src/core/scheduling/smart-scheduler.ts`
- `src/core/security/advisory-store.ts`
- `src/core/security/approval/allowlist.ts`
- `src/core/security/approval/approval-registry.ts`
- `src/core/security/approval/cli.ts`
- `src/core/security/approval/index.ts`
- `src/core/security/approval/types.ts`
- `src/core/security/artifact-signer.ts`
- `src/core/security/audit-banner.ts`
- `src/core/security/audit-chain.ts`
- `src/core/security/audit-trail.ts`
- `src/core/security/bash-ast-types.ts`
- `src/core/security/bash-ast.ts`
- `src/core/security/component-scanner.ts`
- `src/core/security/config-5pillar.ts`
- `src/core/security/discordance-detector.ts`
- `src/core/security/domain-validator.ts`
- `src/core/security/index.ts`
- `src/core/security/injection-detector.ts`
- `src/core/security/inspection-queue.ts`
- `src/core/security/key-rotation-store.ts`
- `src/core/security/osv-client.ts`
- `src/core/security/patterns.ts`
- `src/core/security/rate-limiter.ts`
- `src/core/security/sandbox.ts`
- `src/core/security/security-audit-routes.ts`
- `src/core/security/signer.ts`
- `src/core/security/taint-tracker.ts`
- `src/core/security/tool-translator.ts`
- `src/core/security/vault-cli.ts`
- `src/core/security/vault-credentials.ts`
- `src/core/security/vault-routes.ts`
- `src/core/security/vault.ts`
- `src/core/security/web-fetch-guard.ts`
- `src/core/self-build/auto-fix-trigger.test.ts`
- `src/core/self-build/auto-fix-trigger.ts`
- `src/core/self-build/cron-entry.ts`
- `src/core/skills/registry.ts`
- `src/core/skills/research/web-summary/index.ts`
- `src/core/skills/routes.ts`
- `src/core/skills/skill-optimization-store.ts`
- `src/core/skills/skill-optimizer.ts`
- `src/core/skills/skill-registry.ts`
- `src/core/skills/skill-sandbox.ts`
- `src/core/skills/skill-tool-index.ts`
- `src/core/skills/skills-hub-routes.ts`
- `src/core/skills/skills-hub-types.ts`
- `src/core/skills/skills-hub.ts`
- `src/core/skills/system/self-diagnostic/index.ts`
- `src/core/skills/tool-translator.ts`
- `src/core/skills/trust-policy.ts`
- `src/core/skills/versioning-io.ts`
- `src/core/skills/versioning.ts`
- `src/core/social/schedule-dispatcher-types.ts`
- `src/core/social/schedule-dispatcher.ts`
- `src/core/telemetry/otel-exporter.ts`
- `src/core/testing/checks.ts`
- `src/core/testing/index.ts`
- `src/core/testing/test-harness.ts`
- `src/core/tools/base-tool.ts`
- `src/core/tools/builtin/browser/__tests__/computer-use-tool.test.ts`
- `src/core/tools/builtin/browser/action-suite.ts`
- `src/core/tools/builtin/browser/anti-detect.ts`
- `src/core/tools/builtin/browser/auth.ts`
- `src/core/tools/builtin/browser/browser-manager.ts`
- `src/core/tools/builtin/browser/captcha.ts`
- `src/core/tools/builtin/browser/cdp-manager.ts`
- `src/core/tools/builtin/browser/click.ts`
- `src/core/tools/builtin/browser/computer-use-tool.ts`
- `src/core/tools/builtin/browser/computer-use.ts`
- `src/core/tools/builtin/browser/download.ts`
- `src/core/tools/builtin/browser/fetch-url.ts`
- `src/core/tools/builtin/browser/file-upload.ts`
- `src/core/tools/builtin/browser/form-filler.ts`
- `src/core/tools/builtin/browser/index.ts`
- `src/core/tools/builtin/browser/interact.ts`
- `src/core/tools/builtin/browser/mouse.ts`
- `src/core/tools/builtin/browser/navigate.ts`
- `src/core/tools/builtin/browser/profiles.ts`
- `src/core/tools/builtin/browser/scrape.ts`
- `src/core/tools/builtin/browser/screenshot.ts`
- `src/core/tools/builtin/browser/search.ts`
- `src/core/tools/builtin/browser/session-control.ts`
- `src/core/tools/builtin/browser/snapshot-engine.ts`
- `src/core/tools/builtin/browser/snapshot.ts`
- `src/core/tools/builtin/browser/ssrf-guard.ts`
- `src/core/tools/builtin/browser/tab-manager.ts`
- `src/core/tools/builtin/browser/type.ts`
- `src/core/tools/builtin/browser/vision.ts`
- `src/core/tools/builtin/browser/wait.ts`
- `src/core/tools/builtin/bundled-skills/index.ts`
- `src/core/tools/builtin/business/index.ts`
- `src/core/tools/builtin/business/shopping.ts`
- `src/core/tools/builtin/code/index.ts`
- `src/core/tools/builtin/code/js-worker.cjs`
- `src/core/tools/builtin/code/session-kernels.ts`
- `src/core/tools/builtin/code/tools/js-exec.ts`
- `src/core/tools/builtin/code/tools/python-exec.ts`
- `src/core/tools/builtin/coder/analyze.ts`
- `src/core/tools/builtin/coder/apply-patch.ts`
- `src/core/tools/builtin/coder/arsenal.ts`
- `src/core/tools/builtin/coder/cache.ts`
- `src/core/tools/builtin/coder/code-review.ts`
- `src/core/tools/builtin/coder/debugger.ts`
- `src/core/tools/builtin/coder/edit-file.ts`
- `src/core/tools/builtin/coder/git.ts`
- `src/core/tools/builtin/coder/glob.ts`
- `src/core/tools/builtin/coder/grep.ts`
- `src/core/tools/builtin/coder/index.ts`
- `src/core/tools/builtin/coder/multi-edit.ts`
- `src/core/tools/builtin/coder/multi-read.ts`
- `src/core/tools/builtin/coder/notebook-edit.ts`
- `src/core/tools/builtin/coder/npm.ts`
- `src/core/tools/builtin/coder/project-map.ts`
- `src/core/tools/builtin/coder/project-scaffold.ts`
- `src/core/tools/builtin/coder/read-file.ts`
- `src/core/tools/builtin/coder/scaffold-templates.ts`
- `src/core/tools/builtin/coder/smart-edit.ts`
- `src/core/tools/builtin/coder/swarm.ts`
- `src/core/tools/builtin/coder/test-runner.ts`
- `src/core/tools/builtin/coder/typecheck.ts`
- `src/core/tools/builtin/coder/unified-diff.ts`
- `src/core/tools/builtin/coder/write-file.ts`
- `src/core/tools/builtin/cognition/index.ts`
- `src/core/tools/builtin/comms/email-sender.ts`
- `src/core/tools/builtin/comms/gcalendar.ts`
- `src/core/tools/builtin/comms/github-notify.ts`
- `src/core/tools/builtin/comms/gmail.ts`
- `src/core/tools/builtin/comms/imessage.ts`
- `src/core/tools/builtin/comms/index.ts`
- `src/core/tools/builtin/comms/notification.ts`
- `src/core/tools/builtin/comms/slack-rt.ts`
- `src/core/tools/builtin/comms/slack.ts`
- `src/core/tools/builtin/comms/sms.ts`
- `src/core/tools/builtin/comms/voice.ts`
- `src/core/tools/builtin/comms/webhook.ts`
- `src/core/tools/builtin/computer-use/cross-platform/index.ts`
- `src/core/tools/builtin/computer-use/cross-platform/linux.ts`
- `src/core/tools/builtin/computer-use/cross-platform/mac.ts`
- `src/core/tools/builtin/computer-use/cross-platform/types.ts`
- `src/core/tools/builtin/computer-use/cross-platform/win.ts`
- `src/core/tools/builtin/content/index.ts`
- `src/core/tools/builtin/custom/claude-skill.ts`
- `src/core/tools/builtin/custom/codex.ts`
- `src/core/tools/builtin/custom/custom-ping.ts`
- `src/core/tools/builtin/custom/fs-list-by-mtime.ts`
- `src/core/tools/builtin/custom/fs-stat.ts`
- `src/core/tools/builtin/custom/index.ts`
- `src/core/tools/builtin/custom/video-remotion-msa.ts`
- `src/core/tools/builtin/dev/github-integration.ts`
- `src/core/tools/builtin/dev/index.ts`
- `src/core/tools/builtin/dev/tools/api-db-tools.ts`
- `src/core/tools/builtin/dev/tools/cicd-audit-refactor-tools.ts`
- `src/core/tools/builtin/document/index.ts`
- `src/core/tools/builtin/document/tools/markdown-to-pdf.ts`
- `src/core/tools/builtin/document/tools/pdf-extract-tables.ts`
- `src/core/tools/builtin/document/tools/pdf-extract-text.ts`
- `src/core/tools/builtin/document/tools/pdf-from-html.ts`
- `src/core/tools/builtin/docx/index.ts`
- `src/core/tools/builtin/docx/tools/create.ts`
- `src/core/tools/builtin/earning/index.ts`
- `src/core/tools/builtin/finance/index.ts`
- `src/core/tools/builtin/fs-list-by-mtime/index.ts`
- `src/core/tools/builtin/fs-list-by-mtime/list-by-mtime.ts`
- `src/core/tools/builtin/fs-stat/index.ts`
- `src/core/tools/builtin/fs-stat/stat.ts`
- `src/core/tools/builtin/git-status/index.ts`
- `src/core/tools/builtin/git-status/status.ts`
- `src/core/tools/builtin/knowledge/index.ts`
- `src/core/tools/builtin/legal/index.ts`
- `src/core/tools/builtin/log-search/index.ts`
- `src/core/tools/builtin/log-search/search.ts`
- `src/core/tools/builtin/marketing/index.ts`
- `src/core/tools/builtin/media/factory-tools.ts`
- `src/core/tools/builtin/media/helpers.ts`
- `src/core/tools/builtin/media/image-tools.ts`
- `src/core/tools/builtin/media/index.ts`
- `src/core/tools/builtin/media/thumbnail-tool.ts`
- `src/core/tools/builtin/media/video-generation.ts`
- `src/core/tools/builtin/media/video-tools.ts`
- `src/core/tools/builtin/meta/auto-optimizer.ts`
- `src/core/tools/builtin/meta/index.ts`
- `src/core/tools/builtin/meta/localizer-tool.ts`
- `src/core/tools/builtin/meta/memory-get.ts`
- `src/core/tools/builtin/meta/memory-query.ts`
- `src/core/tools/builtin/meta/memory-search.ts`
- `src/core/tools/builtin/meta/message-send.ts`
- `src/core/tools/builtin/meta/predictor.ts`
- `src/core/tools/builtin/meta/self-config.ts`
- `src/core/tools/builtin/meta/self-improve.ts`
- `src/core/tools/builtin/meta/self-modify.ts`
- `src/core/tools/builtin/meta/self-test.ts`
- `src/core/tools/builtin/meta/self-update.ts`
- `src/core/tools/builtin/meta/service-control.ts`
- `src/core/tools/builtin/meta/sessions-spawn.ts`
- `src/core/tools/builtin/meta/skill-versioning.ts`
- `src/core/tools/builtin/meta/smart-scheduler.ts`
- `src/core/tools/builtin/meta/social-intel.ts`
- `src/core/tools/builtin/meta/spawn-team.ts`
- `src/core/tools/builtin/meta/sponsor-tool.ts`
- `src/core/tools/builtin/meta/survival-tool.ts`
- `src/core/tools/builtin/meta/swarm.ts`
- `src/core/tools/builtin/meta/synth-bwrap-entry.cjs`
- `src/core/tools/builtin/meta/synth-seccomp-filter.ts`
- `src/core/tools/builtin/meta/task-manager.ts`
- `src/core/tools/builtin/meta/thumbnail-ab-tool.ts`
- `src/core/tools/builtin/meta/tool-creator.ts`
- `src/core/tools/builtin/meta/tool-install.ts`
- `src/core/tools/builtin/meta/tool-search.ts`
- `src/core/tools/builtin/meta/tool-synthesize.ts`
- `src/core/tools/builtin/meta/trend-radar.ts`
- `src/core/tools/builtin/meta/ultra-plan.ts`
- `src/core/tools/builtin/meta/undercover.ts`
- `src/core/tools/builtin/meta/voice-engine.ts`
- `src/core/tools/builtin/meta/youtube-feedback.ts`
- `src/core/tools/builtin/personal/index.ts`
- `src/core/tools/builtin/spreadsheet/index.ts`
- `src/core/tools/builtin/spreadsheet/tools/chart.ts`
- `src/core/tools/builtin/spreadsheet/tools/create.ts`
- `src/core/tools/builtin/spreadsheet/tools/pivot.ts`
- `src/core/tools/builtin/spreadsheet/tools/read.ts`
- `src/core/tools/builtin/spreadsheet/tools/validate.ts`
- `src/core/tools/builtin/superpowers/index.ts`
- `src/core/tools/builtin/system/api-call.ts`
- `src/core/tools/builtin/system/backup-brain.ts`
- `src/core/tools/builtin/system/backup.ts`
- `src/core/tools/builtin/system/credential-manager.ts`
- `src/core/tools/builtin/system/cron-system.ts`
- `src/core/tools/builtin/system/disk.ts`
- `src/core/tools/builtin/system/docker.ts`
- `src/core/tools/builtin/system/exec.ts`
- `src/core/tools/builtin/system/index.ts`
- `src/core/tools/builtin/system/monitor.ts`
- `src/core/tools/builtin/system/network.ts`
- `tests/learning/agent-config-evolver.test.ts`
- `tests/learning/skill-discovery.test.ts`
- `tests/learning/wave10b-activation.test.ts`
- `tests/memory/injection-scanner.test.ts`
- `tests/meta/health-check.test.ts`
- `tests/meta/hot-deploy-selfbuild.test.ts`
- `tests/meta/meta-tools.test.ts`
- `tests/meta/self-modify-symlink.test.ts`
- `tests/meta/self-update-selfbuild.test.ts`
- `tests/meta/synth-seal-metrics.test.ts`
- `tests/meta/synth-seal.test.ts`
- `tests/meta/synth-seccomp.test.ts`
- `tests/operators/operator-loader.test.ts`
- `tests/operators/scheduler.test.ts`
- `tests/outcomes/goal-evaluator.test.ts`
- `tests/outcomes/session-outcome-listener.test.ts`
- `tests/security/discordance-detector.test.ts`
- `tests/security/domain-validator.test.ts`
- `tests/security/injection-detector-queue.test.ts`
- `tests/security/inspection-queue.test.ts`
- `tests/security/key-rotation.test.ts`
- `tests/security/rationalization-monitor-null-queue.test.ts`
- `tests/security/rationalization-monitor.test.ts`
- `tests/security/security-audit.test.ts`
- `tests/security/signer-integration.test.ts`
- `tests/security/signer.test.ts`
- `tests/security/taint-tracker-integration.test.ts`
- `tests/security/taint-tracker.test.ts`
- `tests/security/vault-credentials.test.ts`
- `tests/security/vault.test.ts`
- `tests/self-build/cron-entry.test.ts`
- `tests/self-build/daily-report.test.ts`
