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

  // 2) Assemble metadata (the on-chain/off-chain JSON the token points at).
  const metadata = {
    name: args.name,
    description,
    attributes: [{ trait_type: 'prompt', value: args.prompt }],
    createdAt: new Date().toISOString(),
  };

  // 3) DRY RUN by default — show exactly what would happen, spend nothing.
  if (!args.broadcast) {
    console.log('\n=== DRY RUN (no broadcast) ===');
    console.log('metadata:', JSON.stringify(metadata, null, 2));
    console.log(`would mint ${quantity}× to ${args.to ?? '<--to required for broadcast>'} via ${process.env['MINT_FN_SIG'] ?? 'mint(address,string)'}`);
    logEvent({ action: 'dry-run', to: args.to ?? null, quantity, name: args.name });
    console.log('\nAdd --broadcast --yes (and env creds + --token-uri) to mint for real.');
    return;
  }

  // 4) BROADCAST — real ETH. Every guard must pass.
  if (args.yes !== true) throw new Error('refusing to broadcast without --yes (safety gate)');
  const rpcUrl = requireEnv('RPC_URL');
  const privateKey = requireEnv('PRIVATE_KEY');
  const contractAddress = requireEnv('CONTRACT_ADDRESS');
  const mintFnSig = process.env['MINT_FN_SIG'] ?? 'mint(address,string)';
  if (!args.to) throw new Error('--to <address> is required to broadcast');
  if (!args.tokenUri) throw new Error('--token-uri <uri> is required to broadcast (upload the metadata first, e.g. to IPFS)');
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

  const fnName = mintFnSig.slice(0, mintFnSig.indexOf('('));
  logEvent({ action: 'broadcast-start', to: args.to, contract: contractAddress, fn: fnName, quantity, gasPriceGwei: Number(gasPrice) / 1e9 });
  for (let i = 0; i < quantity; i++) {
    const tx = await (contract[fnName] as (...a: unknown[]) => Promise<{ hash: string; wait: () => Promise<unknown> }>)(args.to, args.tokenUri);
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
  .option('--token-uri <uri>', 'metadata URI to mint (required for --broadcast)')
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
