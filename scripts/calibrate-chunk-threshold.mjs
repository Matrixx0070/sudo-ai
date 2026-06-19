/**
 * Calibrate the #7 chunk-contradiction cosine threshold against REAL embeddings.
 *
 * Usage: PROVIDER=ollama|gemini|openai node scripts/calibrate-chunk-threshold.mjs
 *   ollama (default) → local nomic-embed-text (no quota)
 *   gemini           → gemini-embedding-001 (needs GEMINI_API_KEY)
 *   openai           → text-embedding-3-small (needs OPENAI_API_KEY w/ quota)
 * The threshold is MODEL-SPECIFIC — calibrate against the model the deployment
 * actually wires into the detector, then set SUDO_CHUNK_CONTRADICT_SIM to match.
 *
 * The threshold gates STAGE 1 of the detector: a candidate clears it iff it is
 * "about the same subject" as the incoming chunk, and only then is the (costly)
 * LLM opposition judge consulted. So a good threshold must:
 *   - ADMIT same-subject pairs — BOTH contradictions ("prefers tabs" vs
 *     "prefers spaces") AND restatements ("prefers spaces" / "likes spaces"),
 *     because both must reach the judge for it to rule;
 *   - REJECT unrelated pairs (different subject) to save judge calls.
 *
 * We embed a labeled set, compute cosine per pair, then sweep thresholds and
 * report the separation. Chunk texts mimic what compaction-flush stores
 * (role-prefixed, preference/config/decision sentences).
 */

// Provider selectable via env (see header). The cosine threshold is
// MODEL-SPECIFIC, so calibrate against whichever model the deployment will use.
const PROVIDER = process.env.PROVIDER ?? 'ollama';
const MODEL = PROVIDER === 'openai' ? 'text-embedding-3-small' : 'nomic-embed-text';
const URL = 'https://api.openai.com/v1/embeddings';
const OLLAMA = (process.env.OLLAMA_EMBED_URL ?? 'http://localhost:11434') + '/api/embeddings';

// Each group = one subject with a base, a contradiction, and a restatement.
const GROUPS = [
  {
    base:       '[User] I prefer indenting code with spaces, not tabs.',
    contradict: '[User] Actually I want all indentation done with tabs from now on.',
    restate:    '[User] My preference is spaces for indentation rather than tabs.',
  },
  {
    base:       '[AI] The production database for this project is PostgreSQL.',
    contradict: '[AI] We migrated the production database to MySQL.',
    restate:    '[AI] Prod runs on Postgres as its primary datastore.',
  },
  {
    base:       '[User] Deploy the service to the us-east-1 region.',
    contradict: '[User] Change the deployment region to eu-west-1 instead.',
    restate:    '[User] The service should be deployed in the US East (us-east-1) region.',
  },
  {
    base:       '[AI] The default reasoning model is Opus for this agent.',
    contradict: '[AI] We switched the default reasoning model to Sonnet.',
    restate:    '[AI] By default the agent reasons with the Opus model.',
  },
  {
    base:       '[User] Send me notifications over Telegram.',
    contradict: '[User] Stop using Telegram, send notifications via SMS now.',
    restate:    '[User] I want to be notified through Telegram.',
  },
  {
    base:       '[AI] The build runs tests before compiling in CI.',
    contradict: '[AI] CI now compiles first and runs tests after the build.',
    restate:    '[AI] In CI the test step executes prior to the build step.',
  },
  {
    base:       '[User] Keep the memory contradiction flag turned off by default.',
    contradict: '[User] Enable the memory contradiction flag by default.',
    restate:    '[User] The contradiction-resolution flag should default to off.',
  },
  {
    base:       '[AI] API requests time out after 30 seconds.',
    contradict: '[AI] The API request timeout was raised to 120 seconds.',
    restate:    '[AI] Requests to the API have a 30s timeout limit.',
  },
  {
    base:       '[User] The project name is sudo-ai.',
    contradict: '[User] We renamed the project from sudo-ai to mind-agent.',
    restate:    '[User] This codebase is called sudo-ai.',
  },
  {
    base:       '[AI] Logs are written in JSON format.',
    contradict: '[AI] We switched logging from JSON to plain text lines.',
    restate:    '[AI] The logger emits structured JSON log entries.',
  },
  {
    base:       '[User] Run the daemon under PM2.',
    contradict: '[User] Drop PM2 and run the daemon directly under systemd.',
    restate:    '[User] The process manager for the daemon is PM2.',
  },
  {
    base:       '[AI] The sandbox blocks all network egress by default.',
    contradict: '[AI] The sandbox now allows open network egress by default.',
    restate:    '[AI] By default the sandbox denies outbound network access.',
  },
  {
    base:       '[User] Use two-space indentation in the YAML files.',
    contradict: '[User] Switch the YAML files to four-space indentation.',
    restate:    '[User] YAML should be indented with two spaces.',
  },
  {
    base:       '[AI] The cache TTL is five minutes.',
    contradict: '[AI] We increased the cache TTL from five minutes to one hour.',
    restate:    '[AI] Cached entries live for 5 minutes before expiring.',
  },
];

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function embedAll(texts) {
  if (PROVIDER === 'openai') {
    const res = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model: MODEL, input: texts, encoding_format: 'float' }),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
    const json = await res.json();
    const sorted = [...json.data].sort((a, b) => a.index - b.index);
    return sorted.map((d) => Float32Array.from(d.embedding));
  }
  if (PROVIDER === 'gemini') {
    const model = 'gemini-embedding-001';
    const out = [];
    for (const t of texts) {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${process.env.GEMINI_API_KEY}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: `models/${model}`, content: { parts: [{ text: t }] } }) },
      );
      if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
      const json = await res.json();
      out.push(Float32Array.from(json.embedding.values));
    }
    return out;
  }
  // Ollama: one prompt per request.
  const out = [];
  for (const t of texts) {
    const res = await fetch(OLLAMA, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, prompt: t }),
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
    const json = await res.json();
    out.push(Float32Array.from(json.embedding));
  }
  return out;
}

function pct(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
  return s[i];
}
const fmt = (x) => x.toFixed(4);

async function main() {
  // Unique texts → embed once.
  const texts = [];
  for (const g of GROUPS) { texts.push(g.base, g.contradict, g.restate); }
  const vecs = await embedAll(texts);
  const vmap = new Map(texts.map((t, i) => [t, vecs[i]]));

  const contradiction = [], restatement = [], unrelated = [];
  for (const g of GROUPS) {
    contradiction.push(cosine(vmap.get(g.base), vmap.get(g.contradict)));
    restatement.push(cosine(vmap.get(g.base), vmap.get(g.restate)));
  }
  // Unrelated: every base vs every OTHER group's base/contradict.
  for (let i = 0; i < GROUPS.length; i++) {
    for (let j = 0; j < GROUPS.length; j++) {
      if (i === j) continue;
      unrelated.push(cosine(vmap.get(GROUPS[i].base), vmap.get(GROUPS[j].base)));
    }
  }

  const sameSubject = [...contradiction, ...restatement]; // must clear threshold

  const stats = (name, arr) => `${name.padEnd(13)} n=${String(arr.length).padStart(3)}  min=${fmt(Math.min(...arr))}  p10=${fmt(pct(arr, 10))}  median=${fmt(pct(arr, 50))}  max=${fmt(Math.max(...arr))}`;
  console.log(`\n=== Cosine distributions (${PROVIDER}: ${MODEL}) ===`);
  console.log(stats('contradiction', contradiction));
  console.log(stats('restatement', restatement));
  console.log(stats('same-subject', sameSubject));
  console.log(stats('unrelated', unrelated));

  console.log('\n=== Threshold sweep ===');
  console.log('thr     same-recall   unrelated-FP   note');
  let best = null;
  for (let t = 0.20; t <= 0.95001; t += 0.01) {
    const recall = sameSubject.filter((s) => s >= t).length / sameSubject.length;
    const fp = unrelated.filter((s) => s >= t).length / unrelated.length;
    // Objective: admit all same-subject (recall=1) while minimizing false positives.
    const score = recall - fp;
    if (recall >= 0.999 && (best === null || fp < best.fp - 1e-9)) best = { t, recall, fp, score };
  }
  for (let t = 0.20; t <= 0.95001; t += 0.05) {
    const recall = sameSubject.filter((s) => s >= t).length / sameSubject.length;
    const fp = unrelated.filter((s) => s >= t).length / unrelated.length;
    console.log(`${t.toFixed(2)}    ${(recall * 100).toFixed(1).padStart(6)}%      ${(fp * 100).toFixed(1).padStart(6)}%`);
  }

  // Recommended: keep full same-subject recall, then back off below the
  // worst-case same-subject similarity by a small margin for unseen phrasings.
  const minSame = Math.min(...sameSubject);
  const maxUnrel = Math.max(...unrelated);
  console.log('\n=== Recommendation ===');
  console.log(`min same-subject cosine   = ${fmt(minSame)}`);
  console.log(`max unrelated cosine      = ${fmt(maxUnrel)}`);
  console.log(`separation gap            = ${fmt(minSame - maxUnrel)}`);
  if (best) console.log(`lowest-FP @ recall=100%   = ${fmt(best.t)} (unrelated FP ${(best.fp * 100).toFixed(1)}%)`);
  // A safe operating point sits in the gap, nearer the unrelated ceiling so
  // paraphrases we didn't sample still clear it. Round to 2 dp.
  const mid = (minSame + maxUnrel) / 2;
  console.log(`gap midpoint              = ${fmt(mid)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
