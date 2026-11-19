// Finds unanswered requests on chain, signs them and submits. Holds no durable state: a request older than
// 256 blocks can no longer be answered, so scanning that far back after a restart finds everything that matters.
import {
  encodeFunctionData,
  keccak256,
  parseAbi,
  parseGwei,
  type Address,
  type Hex,
  type LocalAccount,
  type PublicClient,
} from 'viem';
import { messageFor, publicKey, sign } from './bls';

export const ORACLE_ABI = parseAbi([
  'event RandomnessRequested(uint256 indexed requestId, address indexed consumer)',
  'function statusOf(uint256 requestId) view returns (uint8)',
  'function fulfill(uint256 requestId, uint256[2] signature)',
  'function publicKey() view returns (uint256[4])',
]);

const STATUS_PENDING = 1;
const WINDOW = 256n;
const FEE_BUMP_PERCENT = 125n;
const GAS_MARGIN_PERCENT = 130n;
const DEFAULT_MAX_FEE = parseGwei('500');

/** One transaction slot of this account. A nonce is tracked from before its first broadcast until it is mined. */
export interface InFlight {
  nonce: number;
  /** Absent for a transaction that only clears a nonce left pending by an earlier run. */
  requestId?: bigint;
  to: Address;
  data?: Hex;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  /** Every version signed for this nonce. Any of them can be the one that gets mined. */
  hashes: Hex[];
  /** False until a node has confirmed it holds the current version. */
  acknowledged: boolean;
  /** When these fees were chosen. Not reset by retries, or a refused transaction would never be raised. */
  feesSetAt: number;
}

export interface OracleNodeDeps {
  client: PublicClient;
  account: LocalAccount;
  chainId: number;
  oracle: Address;
  blsKey: bigint;
  stuckAfterMs: number;
  /** Fees are never raised above this, in wei per gas. */
  maxFeePerGasCap?: bigint;
  now?: () => number;
  log?: (message: string) => void;
}

export interface OracleNode {
  /** Fails if this key is not the one the contract was deployed with. */
  assertKeyMatches(): Promise<void>;
  /** Run once at startup: replaces whatever an earlier run left pending, so it cannot block new answers. */
  reconcile(): Promise<void>;
  /** Run repeatedly, never concurrently. */
  tick(): Promise<void>;
  inFlight(): readonly InFlight[];
}

const failedWith = (e: unknown, pattern: RegExp) => pattern.test(String((e as Error).message));
/** viem puts the node's own words in `details`. The first line of its message is only a generic heading. */
const reason = (e: unknown) => (e as { details?: string }).details ?? String((e as Error).message).split('\n')[0];
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const max = (a: bigint, b: bigint) => (a > b ? a : b);

export function createOracleNode(deps: OracleNodeDeps): OracleNode {
  const { client, account, chainId, oracle, blsKey, stuckAfterMs } = deps;
  const cap = deps.maxFeePerGasCap ?? DEFAULT_MAX_FEE;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const tracked = new Map<number, InFlight>();
  let nextNonce = -1;

  const bumped = (v: bigint) => (v * FEE_BUMP_PERCENT) / 100n + 1n;

  function setFees(entry: InFlight, maxFeePerGas: bigint, maxPriorityFeePerGas: bigint) {
    entry.maxFeePerGas = min(maxFeePerGas, cap);
    entry.maxPriorityFeePerGas = min(maxPriorityFeePerGas, entry.maxFeePerGas);
    entry.feesSetAt = now();
  }

  async function marketFees() {
    const { maxFeePerGas, maxPriorityFeePerGas } = await client.estimateFeesPerGas();
    return { maxFeePerGas: maxFeePerGas * 2n, maxPriorityFeePerGas };
  }

  /**
   * Signs the entry's current fields and sends. The hash is recorded first, because a failed call does not mean the
   * transaction was refused. Signing is deterministic, so a retry with the same fees sends the same bytes.
   */
  async function broadcast(entry: InFlight) {
    const { to, data, gas, nonce, maxFeePerGas, maxPriorityFeePerGas } = entry;
    const raw = await account.signTransaction!({
      to,
      data,
      gas,
      nonce,
      maxFeePerGas,
      maxPriorityFeePerGas,
      chainId,
      type: 'eip1559',
      value: 0n,
    });
    const hash = keccak256(raw);
    if (!entry.hashes.includes(hash)) entry.hashes.push(hash);
    entry.acknowledged = false;
    try {
      await client.sendRawTransaction({ serializedTransaction: raw });
      entry.acknowledged = true;
      log(`sent nonce ${nonce}${entry.requestId === undefined ? ' (clearing)' : ` for request ${entry.requestId}`}: ${hash}`);
    } catch (e) {
      if (failedWith(e, /already known|already imported|known transaction/i)) {
        entry.acknowledged = true;
      } else if (failedWith(e, /nonce (is )?too low|nonce.*already/i)) {
        // None of our versions had a receipt, so something else used the nonce. The next scan decides what's next.
        tracked.delete(nonce);
        log(`nonce ${nonce} was used elsewhere, stopped tracking it`);
      } else {
        if (failedWith(e, /underpriced|base fee|fee cap/i)) setFees(entry, bumped(maxFeePerGas), bumped(maxPriorityFeePerGas));
        log(`nonce ${nonce} not accepted yet: ${reason(e)}`);
      }
    }
  }

  async function hasReceipt(hash: Hex) {
    try {
      await client.getTransactionReceipt({ hash });
      return true;
    } catch (e) {
      if ((e as Error).name === 'TransactionReceiptNotFoundError') return false;
      throw e;
    }
  }

  /** Clears finished nonces, raises fees on the ones waiting too long, and retries the ones no node has confirmed. */
  async function trackInFlight() {
    for (const entry of [...tracked.values()].sort((a, b) => a.nonce - b.nonce)) {
      let mined = false;
      for (const hash of entry.hashes) {
        if (await hasReceipt(hash)) {
          mined = true;
          break;
        }
      }
      if (mined) {
        tracked.delete(entry.nonce);
      } else if (now() - entry.feesSetAt > stuckAfterMs) {
        const market = await marketFees();
        setFees(
          entry,
          max(bumped(entry.maxFeePerGas), market.maxFeePerGas),
          max(bumped(entry.maxPriorityFeePerGas), market.maxPriorityFeePerGas),
        );
        await broadcast(entry);
      } else if (!entry.acknowledged) {
        await broadcast(entry);
      }
    }
  }

  async function submit(fields: Pick<InFlight, 'nonce' | 'requestId' | 'to' | 'data' | 'gas'>, fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }) {
    const entry: InFlight = { ...fields, ...fees, hashes: [], acknowledged: false, feesSetAt: now() };
    setFees(entry, fees.maxFeePerGas, fees.maxPriorityFeePerGas);
    tracked.set(entry.nonce, entry);
    nextNonce = Math.max(nextNonce, entry.nonce + 1);
    await broadcast(entry);
  }

  async function answer(requestId: bigint, consumer: Address, blockHash: Hex) {
    const signature = sign(blsKey, messageFor({ chainId, oracle, requestId, consumer, blockHash }));
    const args = [requestId, [signature[0], signature[1]]] as const;

    let gas: bigint;
    try {
      gas = await client.estimateContractGas({
        address: oracle,
        abi: ORACLE_ABI,
        functionName: 'fulfill',
        args,
        account,
      });
    } catch (e) {
      // Wrong key, a reorg, or someone else answered first. Sending would only burn gas.
      log(`skipped request ${requestId}: ${reason(e)}`);
      return;
    }

    const fees = await marketFees();
    const chainNonce = await client.getTransactionCount({ address: account.address, blockTag: 'pending' });
    await submit(
      {
        nonce: Math.max(nextNonce, chainNonce),
        requestId,
        to: oracle,
        data: encodeFunctionData({ abi: ORACLE_ABI, functionName: 'fulfill', args }),
        gas: (gas * GAS_MARGIN_PERCENT) / 100n,
      },
      fees,
    );
  }

  return {
    async assertKeyMatches() {
      const onChain = await client.readContract({ address: oracle, abi: ORACLE_ABI, functionName: 'publicKey' });
      const mine = publicKey(blsKey);
      if (onChain.some((word, i) => word !== mine[i])) {
        throw new Error('The BLS key does not match the public key of this oracle');
      }
    },

    async reconcile() {
      const latest = await client.getTransactionCount({ address: account.address, blockTag: 'latest' });
      const pending = await client.getTransactionCount({ address: account.address, blockTag: 'pending' });
      if (pending === latest) return;

      // The fees of what is pending are unknown, so start high. If still refused, each retry raises them further.
      const market = await marketFees();
      for (let nonce = latest; nonce < pending; nonce++) {
        await submit(
          { nonce, to: account.address, gas: 21_000n },
          { maxFeePerGas: market.maxFeePerGas * 4n, maxPriorityFeePerGas: bumped(market.maxPriorityFeePerGas) * 4n },
        );
      }
    },

    async tick() {
      await trackInFlight();

      // viem caches this for the polling interval by default, which would make the head stale.
      const head = await client.getBlockNumber({ cacheTime: 0 });
      // An answer lands in head + 1 at the earliest, and must be within 256 blocks of its request's block.
      const fromBlock = head + 1n > WINDOW ? head + 1n - WINDOW : 0n;
      const requests = await client.getContractEvents({
        address: oracle,
        abi: ORACLE_ABI,
        eventName: 'RandomnessRequested',
        fromBlock,
        toBlock: head,
      });

      const answering = new Set([...tracked.values()].map((e) => e.requestId));
      for (const { args, blockHash } of requests) {
        const requestId = args.requestId!;
        if (answering.has(requestId)) continue;
        const status = await client.readContract({
          address: oracle,
          abi: ORACLE_ABI,
          functionName: 'statusOf',
          args: [requestId],
        });
        if (status !== STATUS_PENDING) continue;
        await answer(requestId, args.consumer!, blockHash);
      }
    },

    inFlight: () => [...tracked.values()].map((e) => ({ ...e, hashes: [...e.hashes] })),
  };
}
