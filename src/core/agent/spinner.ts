export const SPINNER_VERBS: readonly string[] = [
  'Thinking','Processing','Computing','Analyzing','Reasoning','Calculating','Evaluating',
  'Considering','Deliberating','Synthesizing','Investigating','Researching','Exploring',
  'Examining','Inspecting','Diagnosing','Architecting','Designing','Planning','Strategizing',
  'Optimizing','Refactoring','Debugging','Tracing','Profiling','Compiling','Building',
  'Assembling','Linking','Bootstrapping','Initializing','Configuring','Calibrating',
  'Tuning','Adjusting','Querying','Fetching','Loading','Parsing','Decoding','Encoding',
  'Transforming','Converting','Mapping','Reducing','Filtering','Sorting','Indexing',
  'Caching','Persisting','Connecting','Authenticating','Authorizing','Validating',
  'Verifying','Scanning','Monitoring','Tracking','Observing','Measuring','Predicting',
  'Forecasting','Projecting','Simulating','Modeling','Generating','Creating','Crafting',
  'Writing','Composing','Editing','Reviewing','Proofreading','Revising','Polishing',
  'Deploying','Publishing','Releasing','Shipping','Launching','Testing','Checking',
  'Asserting','Confirming','Summarizing','Condensing','Abstracting','Distilling',
  'Extracting','Correlating','Comparing','Contrasting','Differentiating','Matching',
  'Routing','Dispatching','Scheduling','Queuing','Throttling','Negotiating','Handshaking',
  'Syncing','Merging','Reconciling','Contemplating','Pondering','Musing','Reflecting',
  'Meditating','Imagining','Envisioning','Conceptualizing','Brainstorming','Ideating',
  'Deducing','Inferring','Hypothesizing','Theorizing','Postulating','Classifying',
  'Categorizing','Organizing','Structuring','Arranging','Translating','Interpreting',
  'Transcribing','Annotating','Labeling','Warming up','Priming','Preloading','Wrangling',
  'Juggling','Orchestrating','Coordinating','Synchronizing','Evolving','Adapting',
  'Learning','Improving','Growing','Remembering','Recalling','Retrieving','Seeking',
  'Dreaming','Consolidating','Integrating','Harmonizing','Balancing','Awakening',
  'Activating','Energizing','Mobilizing','Engaging','Channeling','Focusing',
  'Concentrating','Honing','Sharpening','Manifesting','Materializing','Realizing',
  'Executing','Actuating','Compressing','Compacting','Pruning','Cleaning','Securing',
  'Encrypting','Signing','Sealing','Introspecting','Innovating',
  'Pioneering','Discovering','Unlocking','Deciphering','Illuminating',
  'Weaving','Resonating','Amplifying','Elevating',
  'Transcending','Crystallizing','Solidifying','Grounding',
  'Auditing','Benchmarking','Streaming','Serializing','Deserializing',
  'Interpolating','Extrapolating','Normalizing','Denormalizing','Aggregating',
  'Partitioning','Sharding','Replicating','Checkpointing','Snapshotting',
] as const;

// Compile-time length check via a type-level assertion would require const generics.
// Runtime guard: log a warning if count drifts below 187 during development.
if (SPINNER_VERBS.length < 187) {
  // eslint-disable-next-line no-console
  console.warn(`[spinner] SPINNER_VERBS has ${SPINNER_VERBS.length} entries, expected at least 187`);
}

export function getSpinnerVerb(index?: number): string {
  if (index !== undefined) return SPINNER_VERBS[Math.abs(index) % SPINNER_VERBS.length] as string;
  return SPINNER_VERBS[Math.floor(Math.random() * SPINNER_VERBS.length)] as string;
}

export function spinnerSequence(count: number): string[] {
  const shuffled = [...SPINNER_VERBS].sort(() => Math.random() - 0.5);
  const result: string[] = [];
  while (result.length < count) result.push(...shuffled.slice(0, count - result.length));
  return result.slice(0, count);
}
