import { createPublicClient, http, parseGwei, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createOracleNode } from './oracle-node';

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

const client = createPublicClient({ transport: http(env('RPC_URL'), { timeout: 8_000 }) });
const node = createOracleNode({
  client,
  account: privateKeyToAccount(env('ORACLE_TX_KEY') as Hex),
  chainId: await client.getChainId(),
  oracle: env('ORACLE_ADDRESS') as Address,
  blsKey: BigInt(env('ORACLE_BLS_KEY')),
  stuckAfterMs: Number(env('STUCK_MS', '30000')),
  maxFeePerGasCap: parseGwei(env('MAX_FEE_GWEI', '500')),
  log: (message) => console.log(new Date().toISOString(), message),
});
const pollMs = Number(env('POLL_MS', '2000'));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

await node.assertKeyMatches();
for (;;) {
  try {
    await node.reconcile();
    break;
  } catch (e) {
    console.error(new Date().toISOString(), 'reconcile failed:', (e as Error).message.split('\n')[0]);
    await sleep(pollMs);
  }
}
console.log('oracle node running');

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => (stopping = true));

while (!stopping) {
  try {
    await node.tick();
  } catch (e) {
    // Usually an RPC hiccup. Everything is read back from the chain on the next tick.
    console.error(new Date().toISOString(), 'tick failed:', (e as Error).message.split('\n')[0]);
  }
  await sleep(pollMs);
}
