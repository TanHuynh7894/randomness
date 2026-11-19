// What only an operator needs. Everything here is derived from public chain data.
import type { Address, Hex, PublicClient } from 'viem';
import { ORACLE_ABI, type OracleSnapshot } from './chain';
import { reconcile } from './derive';

/** Answers sampled for gas cost. Each is read once. */
const SAMPLES = 20;

export interface NodeWallet {
  address: Address;
  balance: bigint;
  lastAnswerTime: number;
}

export interface AdminSnapshot {
  /** Accounts that sent recent answers, newest first. Found from the chain, since the node reports to nothing. */
  wallets: NodeWallet[];
  /** Average cost of an answer in wei, or null before there is one. */
  avgCost: bigint | null;
  samples: number;
  refunds: bigint;
  /** Null when older requests are outside the loaded window, so the books can't be checked from here. */
  reconciliation: ReturnType<typeof reconcile> | null;
  publicKey: bigint[];
  callbackGas: bigint;
}

export function createAdminReader(client: PublicClient, oracle: Address) {
  const seen = new Map<Hex, { from: Address; cost: bigint }>();

  async function readTx(hash: Hex) {
    const known = seen.get(hash);
    if (known) return known;
    const [tx, receipt] = await Promise.all([client.getTransaction({ hash }), client.getTransactionReceipt({ hash })]);
    const entry = { from: tx.from, cost: receipt.gasUsed * receipt.effectiveGasPrice };
    seen.set(hash, entry);
    return entry;
  }

  return async function read(snapshot: OracleSnapshot): Promise<AdminSnapshot> {
    const answered = snapshot.requests.filter((r) => r.answer).slice(0, SAMPLES);
    const txs = await Promise.all(answered.map((r) => readTx(r.answer!.txHash)));

    const lastAnswer = new Map<string, { address: Address; time: number }>();
    txs.forEach((tx, i) => {
      const id = tx.from.toLowerCase();
      if (!lastAnswer.has(id)) lastAnswer.set(id, { address: tx.from, time: answered[i].requestTime + answered[i].answer!.latencySec });
    });
    const wallets = await Promise.all(
      [...lastAnswer.values()].map(async ({ address, time }) => ({ address, lastAnswerTime: time, balance: await client.getBalance({ address }) })),
    );

    const consumers = [...new Set(snapshot.requests.map((r) => r.consumer))];
    const owedRefunds = await Promise.all(consumers.map((c) => client.readContract({ address: oracle, abi: ORACLE_ABI, functionName: 'refunds', args: [c] })));
    const refunds = owedRefunds.reduce((sum, v) => sum + v, 0n);

    const [publicKey, callbackGas] = await Promise.all([
      client.readContract({ address: oracle, abi: ORACLE_ABI, functionName: 'publicKey' }),
      client.readContract({ address: oracle, abi: ORACLE_ABI, functionName: 'CALLBACK_GAS' }),
    ]);

    return {
      wallets,
      avgCost: txs.length ? txs.reduce((sum, t) => sum + t.cost, 0n) / BigInt(txs.length) : null,
      samples: txs.length,
      refunds,
      reconciliation: snapshot.requests.length === snapshot.total
        ? reconcile({ balance: snapshot.balance, earned: snapshot.earned, refunds, pending: snapshot.requests.filter((r) => r.status === 1).length, fee: snapshot.fee })
        : null,
      publicKey: [...publicKey],
      callbackGas,
    };
  };
}
