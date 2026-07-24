/**
 * @file scripts/nft-mint-cli.mts
 * @description Minimal, standalone CLI for the "Grok-described NFT mint" flow.
 *
 * Deliberately minimal (see the session's assessment): it does the ONE thing the
 * $30 seat makes free — generate the NFT description via `generateContentSeat`
 * (grok-4.5, seat lane, no metered spend) — assembles metadata, writes an audit
 * log line for EVERY action, and then either:
 *   - DRY RUN (default): prints the exact on-chain call it WOULD make. No money.
 *   - --broadcast: performs the real mint via ethers (lazy-loaded; not a repo dep).
 *
 * The mint step spends real ETH and holds a private key, so it is gated:
 * --broadcast AND --yes AND the three env creds AND a per-tx gas ceiling are all
 * required, mirroring the draft-then-approve rule. ethers is imported lazily so
 * this file adds no dependency to the agent; if you --broadcast without it
 * installed you get an actionable error.
 *
 * Run:
 *   node --import tsx scripts/nft-mint-cli.mts --prompt "a neon phoenix" --to 0xABC…
 *   # add --broadcast --yes --token-uri ipfs://… to actually mint (needs env creds)
 *
 * Env for --broadcast: RPC_URL, PRIVATE_KEY, CONTRACT_ADDRESS, and MINT_FN_SIG
 * (e.g. "mint(address,string)"); the mint is called with [to, tokenUri].
 * Audit log path: NFT_MINT_LOG (default ./nft-mint-log.jsonl).
 */
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { generateContentSeat, GROK_SEAT_TEXT_MODEL } from '../src/llm/grok-seat-generate.js';

const LOG_PATH = process.env['NFT_MINT_LOG'] ?? path.join(process.cwd(), 'nft-mint-log.jsonl');

/** Append one JSONL audit line. Secrets (keys) are NEVER passed in here. */
function logEvent(event: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
  appendFileSync(LOG_PATH, line + '\n');
  console.log(`[log] ${line}`);
}

interface MintArgs {
  prompt: string;
  to?: string;
  quantity: string;
  model: string;
  name: string;
  system: string;
  image?: string;
  pin?: boolean;
  broadcast?: boolean;
  yes?: boolean;
  tokenUri?: string;
  maxGasGwei: string;
}

async function run(args: MintArgs): Promise<void> {
  const quantity = Number.parseInt(args.quantity, 10);
  if (!Number.isInteger(quantity) || quantity < 1) throw new Error(`--quantity must be a positive integer (got ${args.quantity})`);

  // 1) FREE: generate the description on the seat lane (grok-4.5).
  const description = await generateContentSeat(args.prompt, { model: args.model, system: args.system });
  logEvent({ action: 'generate', model: args.model, prompt: args.prompt, chars: description.length });

  // 2) Assemble the metadata JSON (the grok description IS the token's metadata).
  const metadata: Record<string, unknown> = {
    name: args.name,
    description,
    attributes: [{ trait_type: 'prompt', value: args.prompt }],
    createdAt: new Date().toISOString(),
  };
  if (args.image !== undefined && args.image !== '') metadata['image'] = args.image;

  // tokenURI: an explicit --token-uri wins (e.g. a pre-pinned ipfs:// URI);
  // otherwise embed the metadata inline as a self-describing data: URI so the
  // grok description lives on-chain with no external pin/gateway dependency.
  const tokenUri =
    args.tokenUri ?? `data:application/json;base64,${Buffer.from(JSON.stringify(metadata)).toString('base64')}`;

  // 3) DRY RUN by default — show exactly what would happen, spend nothing.
  if (!args.broadcast) {
    console.log('\n=== DRY RUN (no broadcast) ===');
    console.log('metadata:', JSON.stringify(metadata, null, 2));
    console.log('tokenURI:', tokenUri.length > 120 ? `${tokenUri.slice(0, 120)}… (${tokenUri.length} chars)` : tokenUri);
    if (args.pin && !args.tokenUri) console.log('(--pin: on broadcast this metadata is pinned to IPFS via Pinata and the ipfs:// URI is minted instead)');
    console.log(`would mint ${quantity}× to ${args.to ?? '<--to required for broadcast>'} via ${process.env['MINT_FN_SIG'] ?? 'mint(address,string)'}`);
    logEvent({ action: 'dry-run', to: args.to ?? null, quantity, name: args.name, tokenUriKind: args.tokenUri ? 'explicit' : 'data-uri' });
    console.log('\nAdd --broadcast --yes (+ env creds) to mint for real.');
    return;
  }

  // 4) BROADCAST — real ETH. Every guard must pass.
  if (args.yes !== true) throw new Error('refusing to broadcast without --yes (safety gate)');
  const rpcUrl = requireEnv('RPC_URL');
  const privateKey = requireEnv('PRIVATE_KEY');
  const contractAddress = requireEnv('CONTRACT_ADDRESS');
  const mintFnSig = process.env['MINT_FN_SIG'] ?? 'mint(address,string)';
  if (!args.to) throw new Error('--to <address> is required to broadcast');
  const maxGasGwei = Number.parseFloat(args.maxGasGwei);
  if (!Number.isFinite(maxGasGwei) || maxGasGwei <= 0) throw new Error(`--max-gas-gwei must be a positive number (got ${args.maxGasGwei})`);

  // Lazy-load ethers so this file is not a repo dependency.
  let ethers: typeof import('ethers');
  try {
    ({ ethers } = (await import('ethers')) as unknown as { ethers: typeof import('ethers') });
  } catch {
    throw new Error("ethers is not installed. In your project run: npm i ethers  (this repo intentionally does not depend on it)");
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);
  const contract = new ethers.Contract(contractAddress, [`function ${mintFnSig}`], wallet);

  // Gas ceiling guard — refuse if the network's fee exceeds the operator's cap.
  const fee = await provider.getFeeData();
  const gasPrice = fee.gasPrice ?? 0n;
  const capWei = BigInt(Math.round(maxGasGwei * 1e9));
  if (gasPrice > capWei) {
    logEvent({ action: 'abort-gas', gasPriceGwei: Number(gasPrice) / 1e9, capGwei: maxGasGwei });
    throw new Error(`gas price ${Number(gasPrice) / 1e9} gwei exceeds --max-gas-gwei ${maxGasGwei} — aborting`);
  }

  // Pin to real IPFS when requested (unless an explicit --token-uri already given).
  let mintUri = tokenUri;
  let uriKind = args.tokenUri ? 'explicit' : 'data-uri';
  if (args.pin && args.tokenUri === undefined) {
    const cid = await pinToPinata(metadata, args.name);
    mintUri = `ipfs://${cid}`;
    uriKind = 'ipfs-pinned';
    logEvent({ action: 'pinned', service: 'pinata', cid, uri: mintUri });
    console.log('pinned metadata to IPFS:', mintUri);
  }

  const fnName = mintFnSig.slice(0, mintFnSig.indexOf('('));
  logEvent({ action: 'broadcast-start', to: args.to, contract: contractAddress, fn: fnName, quantity, gasPriceGwei: Number(gasPrice) / 1e9, tokenUriKind: uriKind, uriLen: mintUri.length });
  for (let i = 0; i < quantity; i++) {
    const tx = await (contract[fnName] as (...a: unknown[]) => Promise<{ hash: string; wait: () => Promise<unknown> }>)(args.to, mintUri);
    await tx.wait();
    logEvent({ action: 'mint', index: i + 1, of: quantity, txHash: tx.hash });
    console.log(`minted ${i + 1}/${quantity}: ${tx.hash}`);
  }
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') throw new Error(`missing required env ${name}`);
  return v;
}

/** Pin a JSON metadata object to IPFS via Pinata; returns the CID. JWT from PINATA_JWT (never logged). */
async function pinToPinata(metadata: Record<string, unknown>, name: string): Promise<string> {
  const jwt = requireEnv('PINATA_JWT');
  const res = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ pinataContent: metadata, pinataMetadata: { name } }),
  });
  if (!res.ok) throw new Error(`Pinata pin failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { IpfsHash?: string };
  if (!j.IpfsHash) throw new Error('Pinata response missing IpfsHash');
  return j.IpfsHash;
}

const program = new Command();
program
  .name('nft-mint-cli')
  .description('Generate an NFT description on the Grok seat (free) and mint it (dry-run by default).')
  .requiredOption('--prompt <text>', 'prompt for the Grok-generated description')
  .option('--name <name>', 'NFT name', 'Untitled')
  .option('--to <address>', 'recipient wallet (required for --broadcast)')
  .option('--quantity <n>', 'how many to mint', '1')
  .option('--model <alias>', 'seat model alias', GROK_SEAT_TEXT_MODEL)
  .option(
    '--system <text>',
    'instruction constraining the output',
    'You write NFT descriptions. Reply with ONE vivid paragraph (max 60 words) describing the artwork. Output only the description — no code, no markup, no preamble.',
  )
  .option('--image <url>', 'optional image URL added to the metadata')
  .option('--pin', 'pin metadata to IPFS via Pinata (needs PINATA_JWT env) and mint the ipfs:// URI')
  .option('--token-uri <uri>', 'override metadata URI (e.g. a pre-pinned ipfs://…); default embeds the description as a data: URI')
  .option('--broadcast', 'actually send the mint tx (spends real ETH)')
  .option('--yes', 'confirm broadcast (required with --broadcast)')
  .option('--max-gas-gwei <gwei>', 'refuse to broadcast above this gas price', '50')
  .action((opts: MintArgs) =>
    run(opts).catch((err: unknown) => {
      logEvent({ action: 'error', message: (err as Error).message });
      console.error('FAILED:', (err as Error).message);
      process.exit(1);
    }),
  );
program.parseAsync(process.argv);
