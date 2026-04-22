# SUDO-AI v3 Brain Module Analysis

## 1. File List with Line Counts

- `src/core/brain/brain.ts` - 403 lines (Core Brain class)
- `src/core/brain/costs.ts` - 95 lines (Cost estimation)
- `src/core/brain/failover.ts` - 258 lines (Model failover system)
- `src/core/brain/index.ts` - 60 lines (Barrel exports)
- `src/core/brain/moods.ts` - 156 lines (Mood definitions)
- `src/core/brain/personas.ts` - 218 lines (Persona definitions)
- `src/core/brain/providers.ts` - 177 lines (Provider factories)
- `src/core/brain/system-prompt.ts` - 258 lines (System prompt assembly)
- `src/core/brain/types.ts` - 140 lines (Type definitions)

**Total: 1,765 lines**

## 2. Exported Classes and Functions

### Core Classes
- **`Brain`** (brain.ts): Central LLM interface. Manages persona/mood, failover, system prompt assembly, streaming and non-streaming calls using Vercel AI SDK.
  - `setPersona()`, `setMood()`
  - `call(request)`: Main LLM invocation with failover
  - `stream(request)`: Streaming generator
  - `getSystemPrompt()`: Assembles prompt
  - `getFailoverStatus()`

- **`ModelFailover`** (failover.ts): Manages model profiles, cooldowns, error categorization and selection priority.

### Key Functions
- **costs.ts**:
  - `estimateCost(modelId, promptTokens, outputTokens)`: Calculates USD cost
  - `buildTokenUsage(modelId, raw)`: Normalizes usage data

- **moods.ts**:
  - `getMood(mood)`, `listMoods()`
  - `getMoodSystemBlock(mood)`, `getMoodTemperatureDelta(mood)`

- **personas.ts**:
  - `getPersona(persona)`, `listPersonas()`
  - `getPersonaSystemBlock(persona)`, `getPersonaTemperature(persona)`

- **providers.ts**:
  - `getProvider(name)`, `getModel(modelString)`
  - `listAvailableProviders()`, `getEnvKeyForProvider(name)`

- **system-prompt.ts**:
  - `readWorkspaceFile(name)`: Safe workspace file reader
  - `assembleSystemPrompt(options)`: Builds comprehensive system prompt from SOUL.md, AGENTS.md etc.

- **index.ts**: Re-exports all public API

## 3. Dependencies

**External Packages:**
- `ai` (Vercel AI SDK): `generateText`, `streamText`, `tool`, `jsonSchema`
- `@ai-sdk/xai`, `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`

**Internal:**
- `../shared/logger.js`
- `../shared/errors.js` (LLMError, categorizeError)
- `../shared/constants.js`
- `./types.js`, cross-module within brain/

**Node Built-ins:**
- `fs/promises`, `path`

## 4. Architecture Diagram (ASCII)

```
                  index.ts (barrel)
                       |
        +--------------+--------------+
        |                             |
   Brain.ts (main)               types.ts
        |
        +-- uses --> ModelFailover (failover.ts)
        |
        +-- uses --> getModel / getProvider (providers.ts)
        |
        +-- uses --> assembleSystemPrompt (system-prompt.ts)
        |               |
        |               +-- reads: SOUL.md, AGENTS.md, USER.md...
        |               +-- uses: getPersonaSystemBlock, getMoodSystemBlock
        |
        +-- uses --> getPersonaTemperature (personas.ts)
        +-- uses --> getMoodTemperatureDelta (moods.ts)
        +-- uses --> buildTokenUsage / estimateCost (costs.ts)
        
Key Data Flow:
Brain.call() --> failover.getNextProfile() --> providers.getModel() --> 
  system-prompt.assembleSystemPrompt() --> Vercel AI SDK (generateText/streamText)
```

## 5. Potential Improvements & Issues Noticed

**Strengths:**
- Excellent modular separation (persona/mood/failover/costs)
- Robust error handling and failover with categorized cooldowns
- Comprehensive system prompt assembly from workspace files
- Strong TypeScript usage with clear interfaces

**Issues/Potential Improvements:**
1. **Large brain.ts file (403 lines)**: Could be split into brain-core.ts, message-converters.ts, streaming.ts
2. **Hardcoded model rates in costs.ts**: Consider loading from external config or API for dynamic pricing
3. **Truncated tool call handling**: Some edge cases in toSDKMessages and extractToolCalls may need more defensive code
4. **No caching for system prompt**: assembleSystemPrompt reads files every call — add memoization for repeated calls
5. **Missing unit tests**: No test files visible in brain/ directory
6. **Temperature clamping**: resolveTemperature clamps but could log when overriding user-provided temp
7. **Provider cache**: Good lazy init but no invalidation mechanism if env changes at runtime
8. **Error messages**: Some LLMError messages could include more context for debugging

**Recommendations:**
- Add JSDoc to all public methods
- Implement prompt caching layer
- Add integration tests for failover scenarios
- Consider extracting tool schema handling to separate utility

**Overall Quality:** High. Well-architected for production autonomous AI operation with proper separation of concerns.
