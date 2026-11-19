// Reads contract state over plain JSON-RPC. Works on any EVM node: no indexer, and no Multicall3, which anvil lacks.
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  parseAbi,
  type Abi,
  type Address,
  type EIP1193Provider,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from 'viem';
import { EXPIRY_BLOCKS, type BeaconEntry, type BeaconRound, type OracleRequest } from './derive';

export const ORACLE_ABI = parseAbi([
  'event RandomnessFulfilled(uint256 indexed requestId, uint256 randomness, bool callbackOk)',
  'function requestCount() view returns (uint256)',
  'function requests(uint256) view returns (address consumer, uint64 requestBlock, uint8 status)',
  'function fee() view returns (uint256)',
  'function operator() view returns (address)',
  'function earned() view returns (uint256)',
  'function publicKey() view returns (uint256[4])',
  'function fulfill(uint256 requestId, uint256[2] signature)',
  'function withdraw()',
  'function expire(uint256 requestId)',
  'function refunds(address) view returns (uint256)',
  'function withdrawRefund(address to, uint256 amount)',
  'function CALLBACK_GAS() view returns (uint256)',
  'error WrongFee()',
  'error NotPending()',
  'error OutsideWindow()',
  'error NothingToWithdraw()',
  'error TransferFailed()',
]);
export const DICE_ABI = parseAbi([
  'function roll() payable returns (uint256)',
  'function rolls(uint256) view returns (address player, uint8 result, bool refunded)',
  'function settle(uint256 requestId)',
  'function refund(uint256 requestId)',
  'error NotRefundable()',
  'error NotFulfilled()',
  'error OutsideWindow()',
]);
export const BEACON_ABI = parseAbi([
  'function roundCount() view returns (uint256)',
  'function rounds(uint256) view returns (address creator, uint64 commitEnd, uint64 revealEnd, uint32 minParticipants, uint32 commits, uint32 reveals, uint8 status, uint256 bond, uint256 accumulator, uint256 randomness)',
  'function entries(uint256, address) view returns (bytes32 commitment, bool committed, bool revealed, bool claimed)',
  'function createRound(uint64 commitDuration, uint64 revealDuration, uint256 bond, uint32 minParticipants) returns (uint256)',
  'function commit(uint256 roundId, bytes32 commitment) payable',
  'function reveal(uint256 roundId, bytes32 secret)',
  'function finalize(uint256 roundId)',
  'function claim(uint256 roundId)',
  'error BadParams()',
  'error WrongPhase()',
  'error WrongBond()',
  'error AlreadyCommitted()',
  'error NotCommitted()',
  'error AlreadyRevealed()',
  'error BadReveal()',
  'error AlreadyFinalized()',
  'error NotFinalized()',
  'error NothingToClaim()',
  'error TransferFailed()',
]);

export const makeClient = (rpcUrl: string): PublicClient =>
  createPublicClient({ transport: http(rpcUrl, { batch: true, timeout: 8_000 }) });

export interface OracleSnapshot {
  head: bigint;
  headTime: number;
  total: number;
  fee: bigint;
  operator: Address;
  earned: bigint;
  balance: bigint;
  /** Newest first, and at most the reader's limit. */
  requests: OracleRequest[];
  /** Settled faces of the loaded rolls, or null when no dice contract is configured. */
  dice: number[] | null;
}

export interface BeaconSnapshot {
  head: bigint;
  headTime: number;
  total: number;
  /** Newest first, and at most the reader's limit. */
  rounds: BeaconRound[];
}

interface Roll {
  player: Address;
  face: number;
  refunded: boolean;
}

const newestIds = (total: bigint, first: bigint, limit: number) => {
  const ids: bigint[] = [];
  for (let id = total - 1n + first; id >= first && ids.length < limit; id--) ids.push(id);
  return ids;
};

/** Closed requests never change, so each is read once. Everything is forgotten if the chain goes backwards. */
export function createOracleReader(client: PublicClient, oracle: Address, dice?: Address, limit = 200) {
  const contract = { address: oracle, abi: ORACLE_ABI } as const;
  let closed = new Map<bigint, OracleRequest>();
  let settledRolls = new Map<bigint, Roll>();
  let blockTimes = new Map<bigint, number>();
  let lastHead = 0n;

  const blockTime = async (number: bigint) => {
    let time = blockTimes.get(number);
    if (time === undefined) {
      time = Number((await client.getBlock({ blockNumber: number })).timestamp);
      blockTimes.set(number, time);
    }
    return time;
  };

  async function readRequest(id: bigint, head: bigint): Promise<OracleRequest> {
    const cached = closed.get(id);
    if (cached) return cached;
    const [consumer, requestBlock, status] = await client.readContract({ ...contract, functionName: 'requests', args: [id] });
    const request: OracleRequest = { id, consumer, requestBlock, status, requestTime: await blockTime(requestBlock) };

    if (status === 2) {
      const lastPossible = requestBlock + EXPIRY_BLOCKS;
      const [log] = await client.getContractEvents({
        ...contract,
        eventName: 'RandomnessFulfilled',
        args: { requestId: id },
        fromBlock: requestBlock + 1n,
        toBlock: lastPossible < head ? lastPossible : head,
      });
      // A node behind a load balancer may not have the log yet. Leave it uncached and look again next time.
      if (!log) return request;
      request.answer = {
        randomness: log.args.randomness!,
        callbackOk: log.args.callbackOk!,
        txHash: log.transactionHash,
        block: log.blockNumber,
        latencySec: (await blockTime(log.blockNumber)) - request.requestTime,
        latencyBlocks: Number(log.blockNumber - requestBlock),
      };
    }
    if (status !== 1) closed.set(id, request);
    return request;
  }

  async function readRoll(r: OracleRequest): Promise<Roll> {
    const known = settledRolls.get(r.id);
    if (known) return known;
    const [player, face, refunded] = await client.readContract({ address: dice!, abi: DICE_ABI, functionName: 'rolls', args: [r.id] });
    const roll = { player, face, refunded };
    // A roll can settle or be refunded only once. Until then, read it again.
    if (face !== 0 || refunded) settledRolls.set(r.id, roll);
    return roll;
  }

  return async function read(): Promise<OracleSnapshot> {
    const [total, fee, operator, earned, balance] = await Promise.all([
      client.readContract({ ...contract, functionName: 'requestCount' }),
      client.readContract({ ...contract, functionName: 'fee' }),
      client.readContract({ ...contract, functionName: 'operator' }),
      client.readContract({ ...contract, functionName: 'earned' }),
      client.getBalance({ address: oracle }),
    ]);
    // Read after the state above, so every answer that state mentions is at or below this head.
    const latest = await client.getBlock({ blockTag: 'latest' });
    if (latest.number < lastHead) {
      closed = new Map();
      settledRolls = new Map();
      blockTimes = new Map();
    }
    lastHead = latest.number;

    const requests = await Promise.all(newestIds(total, 1n, limit).map((id) => readRequest(id, latest.number)));
    const rolls = dice ? requests.filter((r) => r.consumer.toLowerCase() === dice.toLowerCase()) : [];
    const results = await Promise.all(rolls.map(readRoll));
    const rollOf = new Map(rolls.map((r, i) => [r.id, results[i]]));

    return {
      head: latest.number,
      headTime: Number(latest.timestamp),
      total: Number(total),
      fee,
      operator,
      earned,
      balance,
      requests: requests.map((r) => {
        const roll = rollOf.get(r.id);
        return roll ? { ...r, player: roll.player, refunded: roll.refunded, face: roll.face || undefined } : r;
      }),
      dice: dice ? results.map((roll) => roll.face).filter((face) => face !== 0) : null,
    };
  };
}

/** Closed rounds never change, so each is read once. Everything is forgotten if the chain goes backwards. */
export function createBeaconReader(client: PublicClient, beacon: Address, limit = 50) {
  const contract = { address: beacon, abi: BEACON_ABI } as const;
  let closed = new Map<bigint, BeaconRound>();
  let lastHead = 0n;

  async function readRound(id: bigint): Promise<BeaconRound> {
    const cached = closed.get(id);
    if (cached) return cached;
    const [creator, commitEnd, revealEnd, minParticipants, commits, reveals, status, bond, , randomness] =
      await client.readContract({ ...contract, functionName: 'rounds', args: [id] });
    const round: BeaconRound = {
      id,
      creator,
      commitEnd: Number(commitEnd),
      revealEnd: Number(revealEnd),
      minParticipants,
      commits,
      reveals,
      status,
      bond,
      randomness,
    };
    if (status !== 0) closed.set(id, round);
    return round;
  }

  return async function read(): Promise<BeaconSnapshot> {
    const [total, latest] = await Promise.all([
      client.readContract({ ...contract, functionName: 'roundCount' }),
      client.getBlock({ blockTag: 'latest' }),
    ]);
    if (latest.number < lastHead) closed = new Map();
    lastHead = latest.number;
    return {
      head: latest.number,
      headTime: Number(latest.timestamp),
      total: Number(total),
      rounds: await Promise.all(newestIds(total, 0n, limit).map(readRound)),
    };
  };
}

export async function readEntries(client: PublicClient, beacon: Address, rounds: readonly BeaconRound[], who: Address): Promise<BeaconEntry[]> {
  return Promise.all(
    rounds.map(async (r) => {
      const [commitment, committed, revealed, claimed] = await client.readContract({ address: beacon, abi: BEACON_ABI, functionName: 'entries', args: [r.id, who] });
      return { commitment, committed, revealed, claimed };
    }),
  );
}

/** Any contract call. Typed by the ABIs above where it is written, and checked by the chain when it is sent. */
export interface ContractCall {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
}

export interface Signer {
  address: Address;
  signMessage(message: string): Promise<Hex>;
  /** Simulates first, so a call that would revert costs nothing, then sends and waits for it to be mined. */
  write(call: ContractCall): Promise<TransactionReceipt>;
}

export interface Wallet {
  /** 'dev': accounts unlocked on the node itself, so anvil needs no extension. 'wallet': the browser's wallet. */
  kind: 'dev' | 'wallet';
  accounts(): Promise<Address[]>;
  signerFor(address: Address): Signer;
}

/** `reader` reads the chain when `client` stands in for a node with no accounts. */
export async function walletFor(client: PublicClient, rpcUrl: string, injected: EIP1193Provider | undefined, reader: PublicClient = client): Promise<Wallet | null> {
  // Public nodes refuse this or return nothing. Only a dev node hands out accounts.
  const request = client.request as unknown as (args: { method: string }) => Promise<Address[]>;
  const devAccounts = await request({ method: 'eth_accounts' }).catch((): Address[] => []);
  if (devAccounts.length === 0 && !injected) return null;

  const kind = devAccounts.length > 0 ? 'dev' : 'wallet';
  const wallet = createWalletClient({ transport: kind === 'dev' ? http(rpcUrl) : custom(injected!) });

  const write = async (address: Address, call: ContractCall) => {
    if (kind === 'wallet') {
      const chainId = await reader.getChainId();
      if ((await wallet.getChainId()) !== chainId) await wallet.switchChain({ id: chainId });
    }
    const { request: prepared } = await reader.simulateContract({ ...call, account: address } as never) as { request: Record<string, unknown> };
    const hash = await wallet.writeContract({ ...prepared, account: address, chain: null } as never);
    const receipt = await reader.waitForTransactionReceipt({ hash, pollingInterval: 300 });
    if (receipt.status !== 'success') throw new Error(`The ${call.functionName} transaction reverted.`);
    return receipt;
  };

  return {
    kind,
    accounts: async () => (kind === 'dev' ? devAccounts : wallet.requestAddresses().then((a) => [...a])),
    signerFor: (address) => ({
      address,
      signMessage: (message) => wallet.signMessage({ account: address, message }),
      write: (call) => write(address, call),
    }),
  };
}
