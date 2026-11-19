// Runs the node against a real anvil and the real contracts. Nothing here is mocked.
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  keccak256,
  encodeAbiParameters,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { publicKey } from '../src/bls';
import { createOracleNode, type OracleNode } from '../src/oracle-node';

const PORT = 8600;
const URL_ = `http://127.0.0.1:${PORT}`;
const DEPLOYER = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const OPERATOR_KEY: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const OPERATOR = privateKeyToAccount(OPERATOR_KEY);
const BLS_KEY = 0x2a2a2a2a2a2a2a2an;
const FEE = 10n ** 16n;
const STUCK_MS = 1_000;

const artifact = (file: string, name: string) =>
  JSON.parse(readFileSync(new URL(`../../out/${file}/${name}.json`, import.meta.url), 'utf8')) as {
    abi: any;
    bytecode: { object: Hex };
  };
const ORACLE = artifact('RandomnessOracle.sol', 'RandomnessOracle');
const DICE = artifact('DiceRoller.sol', 'DiceRoller');

const pub = createPublicClient({ chain: foundry, transport: http(URL_), pollingInterval: 20 });
const wallet = createWalletClient({ chain: foundry, transport: http(URL_), account: DEPLOYER, pollingInterval: 20 });
const test = createTestClient({ chain: foundry, transport: http(URL_), mode: 'anvil' });

let anvil: ChildProcess;
let oracle: Address;
let dice: Address;
let clock = 0;
let logs: string[] = [];

const makeNode = (blsKey = BLS_KEY, client: typeof pub = pub, maxFeePerGasCap?: bigint): OracleNode =>
  createOracleNode({
    client,
    maxFeePerGasCap,
    account: OPERATOR,
    chainId: foundry.id,
    oracle,
    blsKey,
    stuckAfterMs: STUCK_MS,
    now: () => clock,
    log: (m) => {
      logs.push(m);
      if (process.env.NODE_LOG) console.log(m);
    },
  });

async function deploy(abi: any, bytecode: Hex, args: unknown[]) {
  const hash = await wallet.deployContract({ abi, bytecode, args });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  return receipt.contractAddress!;
}

async function roll(): Promise<bigint> {
  const hash = await wallet.writeContract({ address: dice, abi: DICE.abi, functionName: 'roll', value: FEE });
  await pub.waitForTransactionReceipt({ hash });
  return pub.readContract({ address: oracle, abi: ORACLE.abi, functionName: 'requestCount' }) as Promise<bigint>;
}

const statusOf = (id: bigint) =>
  pub.readContract({ address: oracle, abi: ORACLE.abi, functionName: 'statusOf', args: [id] }) as Promise<number>;
const rollOf = (id: bigint) =>
  pub.readContract({ address: dice, abi: DICE.abi, functionName: 'rolls', args: [id] }) as Promise<
    [Address, number, boolean]
  >;
const sent = (blockTag: 'latest' | 'pending' = 'latest') =>
  pub.getTransactionCount({ address: OPERATOR.address, blockTag });

/** Anvil mines just after accepting a transaction, so wait for the answers and require that they succeeded. */
async function answerAll(node: OracleNode = makeNode()) {
  await node.tick();
  for (const { hashes } of node.inFlight()) {
    const receipt = await pub.waitForTransactionReceipt({ hash: hashes[hashes.length - 1] });
    expect(receipt.status).toBe('success');
  }
  return node;
}

const PENDING = 1;
const FULFILLED = 2;

beforeAll(async () => {
  anvil = spawn('anvil', ['--port', String(PORT), '--silent'], { stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    try {
      await pub.getBlockNumber();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error('anvil did not start');
});

afterAll(() => {
  anvil?.kill();
});

beforeEach(async () => {
  await test.setAutomine(true);
  logs = [];
  clock = 0;
  oracle = await deploy(ORACLE.abi, ORACLE.bytecode.object, [publicKey(BLS_KEY), OPERATOR.address, FEE]);
  dice = await deploy(DICE.abi, DICE.bytecode.object, [oracle]);
});

describe('answering', () => {
  it('answers a request with a signature the contract accepts', async () => {
    const id = await roll();
    await answerAll();

    expect(await statusOf(id)).toBe(FULFILLED);
    const [player, result] = await rollOf(id);
    expect(player).toBe(DEPLOYER.address);
    expect(result).toBeGreaterThanOrEqual(1);
    expect(result).toBeLessThanOrEqual(6);
    const value = (await pub.readContract({
      address: oracle,
      abi: ORACLE.abi,
      functionName: 'randomnessOf',
      args: [id],
    })) as bigint;
    expect(Number(value % 6n) + 1).toBe(result);
  });

  it('answers several requests from one tick', async () => {
    const ids = [await roll(), await roll(), await roll()];
    await answerAll();
    for (const id of ids) expect(await statusOf(id)).toBe(FULFILLED);
  });

  it('sends nothing for a request already answered', async () => {
    await roll();
    const node = await answerAll();
    const before = await sent();
    await node.tick();
    await makeNode().tick();
    expect(await sent('pending')).toBe(before);
    expect(logs.join('\n')).not.toContain('skipped');
  });

  it('picks up requests from before a restart with no saved state', async () => {
    const id = await roll();
    await test.mine({ blocks: 50 });
    await answerAll();
    expect(await statusOf(id)).toBe(FULFILLED);
  });

  it('answers when the next block is the last one in the window', async () => {
    const id = await roll();
    await test.mine({ blocks: 255 });
    await answerAll();
    expect(await statusOf(id)).toBe(FULFILLED);
  });

  it('sends nothing once the next block would be outside the window', async () => {
    const id = await roll();
    await test.mine({ blocks: 256 });
    const before = await sent();
    await makeNode().tick();
    expect(await sent('pending')).toBe(before);
    expect(await statusOf(id)).toBe(PENDING);
    expect(logs.join('\n')).not.toContain('skipped');
  });

  it('never sends when its key does not match the contract', async () => {
    const id = await roll();
    const before = await sent();
    await makeNode(BLS_KEY + 1n).tick();
    expect(await sent('pending')).toBe(before);
    expect(await statusOf(id)).toBe(PENDING);
    expect(logs.join('\n')).toContain('skipped');
  });

  it('checks the key against the chain before starting', async () => {
    await expect(makeNode().assertKeyMatches()).resolves.toBeUndefined();
    await expect(makeNode(BLS_KEY + 1n).assertKeyMatches()).rejects.toThrow(/does not match/);
  });
});

describe('stuck transactions', () => {
  const mineAll = () => test.mine({ blocks: 1 });

  it('does not wait for one transaction before answering the next request', async () => {
    const a = await roll();
    const node = makeNode();
    await test.setAutomine(false);
    await node.tick();
    expect(await sent('pending')).toBe((await sent()) + 1);

    // A second request arrives while the first answer is unmined.
    const hash = await wallet.writeContract({ address: dice, abi: DICE.abi, functionName: 'roll', value: FEE });
    await mineAll();
    await pub.waitForTransactionReceipt({ hash });
    const b = (await pub.readContract({ address: oracle, abi: ORACLE.abi, functionName: 'requestCount' })) as bigint;
    expect(b).toBe(a + 1n);

    await node.tick();
    await mineAll();
    await node.tick();
    expect(await statusOf(a)).toBe(FULFILLED);
    expect(await statusOf(b)).toBe(FULFILLED);
  });

  it('replaces a stuck transaction at the same nonce with higher fees', async () => {
    const id = await roll();
    const nonce = await sent();
    const node = makeNode();
    await test.setAutomine(false);
    await node.tick();
    const [first] = node.inFlight();
    expect(first.nonce).toBe(nonce);

    await node.tick();
    expect(node.inFlight()[0].hashes).toHaveLength(1);

    clock += STUCK_MS + 1;
    await node.tick();
    const [second] = node.inFlight();
    expect(second.nonce).toBe(nonce);
    expect(second.hashes).toHaveLength(2);
    expect(second.acknowledged).toBe(true); // accepted the first time, not after a rejection
    expect(second.maxFeePerGas).toBeGreaterThan(first.maxFeePerGas);
    expect(second.maxPriorityFeePerGas).toBeGreaterThan(first.maxPriorityFeePerGas);
    expect(await sent('pending')).toBe(nonce + 1);

    await mineAll();
    await node.tick();
    expect(await statusOf(id)).toBe(FULFILLED);
    expect(await sent()).toBe(nonce + 1);
    expect(node.inFlight()).toHaveLength(0);
  });

  it('does not prepare a second answer while one is in flight', async () => {
    await roll();
    let estimates = 0;
    const counting = {
      ...pub,
      estimateContractGas: (args: any) => {
        estimates++;
        return pub.estimateContractGas(args);
      },
    } as typeof pub;
    const node = makeNode(BLS_KEY, counting);
    await test.setAutomine(false);
    await node.tick();
    await node.tick();
    expect(estimates).toBe(1);
  });

  it('stops tracking when an older version is the one that got mined', async () => {
    await roll();
    let minedHash: Hex | undefined;
    const client = {
      ...pub,
      getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
        if (hash === minedHash) return { status: 'success' };
        const e = new Error('not found');
        e.name = 'TransactionReceiptNotFoundError';
        throw e;
      },
    } as unknown as typeof pub;
    const node = makeNode(BLS_KEY, client);
    await test.setAutomine(false);
    await node.tick();
    clock += STUCK_MS + 1;
    await node.tick();
    const [{ hashes }] = node.inFlight();
    expect(hashes).toHaveLength(2);

    minedHash = hashes[0];
    await node.tick();
    expect(node.inFlight().filter((e) => e.hashes.includes(hashes[0]))).toHaveLength(0);
  });

  it('clears a transaction left pending by an earlier run before answering', async () => {
    const id = await roll();
    await test.setAutomine(false);
    const earlier = makeNode();
    await earlier.tick();
    const nonce = earlier.inFlight()[0].nonce;

    const restarted = makeNode();
    await restarted.reconcile();
    await mineAll();
    expect(await sent()).toBe(nonce + 1);
    expect(await sent('pending')).toBe(nonce + 1);
    expect(await statusOf(id)).toBe(PENDING); // the old answer was replaced, not mined

    await restarted.tick();
    await mineAll();
    await restarted.tick();
    expect(await statusOf(id)).toBe(FULFILLED);
  });

  it('keeps going after the node is told its nonce is already used', async () => {
    const id = await roll();
    const node = makeNode();
    await test.setAutomine(false);
    await node.tick();
    const [entry] = node.inFlight();

    // Something else with this key took the nonce, so the tracked transaction can never be mined.
    await test.dropTransaction({ hash: entry.hashes[0] });
    const operator = createWalletClient({ chain: foundry, transport: http(URL_), account: OPERATOR });
    await operator.sendTransaction({ to: OPERATOR.address, value: 0n, nonce: entry.nonce });
    await mineAll();

    clock += STUCK_MS + 1;
    await node.tick();
    expect(node.inFlight().every((e) => e.nonce !== entry.nonce)).toBe(true);
    await mineAll();
    await node.tick();
    expect(await statusOf(id)).toBe(FULFILLED);
  });
});

describe('unreliable broadcasts', () => {
  /** A client whose next sendRawTransaction fails, either after the node accepted it or before. */
  function flaky(mode: 'accepted' | 'rejected') {
    let armed = true;
    return {
      ...pub,
      sendRawTransaction: async (args: any) => {
        if (!armed) return pub.sendRawTransaction(args);
        armed = false;
        if (mode === 'accepted') await pub.sendRawTransaction(args);
        throw new Error('HTTP request timed out');
      },
    } as typeof pub;
  }
  const mineAll = () => test.mine({ blocks: 1 });

  it.each(['accepted', 'rejected'] as const)('stays at one nonce when the response is lost (%s)', async (mode) => {
    const id = await roll();
    const nonce = await sent();
    const node = makeNode(BLS_KEY, flaky(mode));
    await test.setAutomine(false);

    await node.tick();
    const [entry] = node.inFlight();
    expect(entry.nonce).toBe(nonce);
    expect(await sent('pending')).toBe(mode === 'accepted' ? nonce + 1 : nonce);

    await node.tick();
    expect(node.inFlight()).toHaveLength(1);
    expect(node.inFlight()[0].hashes).toEqual(entry.hashes);
    expect(await sent('pending')).toBe(nonce + 1);

    await mineAll();
    await node.tick();
    expect(await statusOf(id)).toBe(FULFILLED);
    expect(await sent()).toBe(nonce + 1);
    expect(node.inFlight()).toHaveLength(0);
  });

  /** A client that refuses every broadcast with this message until told otherwise. */
  function refusing(message: string) {
    const state = { refuse: true };
    const client = {
      ...pub,
      sendRawTransaction: async (args: any) => {
        if (state.refuse) throw new Error(message);
        return pub.sendRawTransaction(args);
      },
    } as typeof pub;
    return { client, state };
  }

  it('raises fees at once when refused for being below the base fee', async () => {
    await roll();
    const { client } = refusing('max fee per gas less than block base fee');
    const node = makeNode(BLS_KEY, client);
    await test.setAutomine(false);
    await node.tick();
    const [first] = node.inFlight();
    await node.tick();
    const [second] = node.inFlight();
    expect(second.nonce).toBe(first.nonce);
    expect(second.maxFeePerGas).toBeGreaterThan(first.maxFeePerGas);
  });

  it('keeps the same bytes for an unexplained refusal, then raises fees once it has waited too long', async () => {
    const id = await roll();
    const { client, state } = refusing('internal error');
    const node = makeNode(BLS_KEY, client);
    await test.setAutomine(false);
    await node.tick();
    const [first] = node.inFlight();

    // A retry partway through must not restart the wait.
    clock += STUCK_MS - 100;
    await node.tick();
    expect(node.inFlight()[0].hashes).toEqual(first.hashes);

    clock += 101;
    await node.tick();
    const [second] = node.inFlight();
    expect(second.nonce).toBe(first.nonce);
    expect(second.maxFeePerGas).toBeGreaterThan(first.maxFeePerGas);

    state.refuse = false;
    await node.tick();
    expect(node.inFlight()[0].acknowledged).toBe(true);
    await test.mine({ blocks: 1 });
    await node.tick();
    expect(await statusOf(id)).toBe(FULFILLED);
  });

  it('does not throw out of a tick when a broadcast fails', async () => {
    await roll();
    await expect(makeNode(BLS_KEY, flaky('rejected')).tick()).resolves.toBeUndefined();
  });
});

describe('restart with transactions left pending', () => {
  const mineAll = () => test.mine({ blocks: 1 });

  /** Leaves a pending answer whose fees have been bumped well above what a new estimate would give. */
  async function expensiveLeftover() {
    const id = await roll();
    await test.setAutomine(false);
    const earlier = makeNode();
    await earlier.tick();
    for (let i = 0; i < 10; i++) {
      clock += STUCK_MS + 1;
      await earlier.tick();
    }
    return { id, nonce: earlier.inFlight()[0].nonce };
  }

  it('keeps raising fees until a rejected replacement is accepted', async () => {
    const { id, nonce } = await expensiveLeftover();
    const restarted = makeNode();
    await expect(restarted.reconcile()).resolves.toBeUndefined();
    expect(logs.join('\n')).toContain('underpriced');

    for (let i = 0; i < 20 && !restarted.inFlight()[0]?.acknowledged; i++) await restarted.tick();
    const [entry] = restarted.inFlight();
    expect(entry.acknowledged).toBe(true);
    expect(entry.nonce).toBe(nonce);
    expect(entry.requestId).toBeUndefined();

    // The clearing transaction took the old nonce, and the same ticks answered again at the next one.
    await mineAll();
    const clearing = await pub.getTransactionReceipt({ hash: entry.hashes[entry.hashes.length - 1] });
    expect(clearing.to?.toLowerCase()).toBe(OPERATOR.address.toLowerCase());
    expect(await sent()).toBe(nonce + 2);
    expect(await statusOf(id)).toBe(FULFILLED);
  });

  it('tracks and replaces a clearing transaction like any other', async () => {
    const id = await roll();
    await test.setAutomine(false);
    const earlier = makeNode();
    await earlier.tick();

    const restarted = makeNode();
    await restarted.reconcile();
    const [clearing] = restarted.inFlight();
    expect(clearing.nonce).toBe(earlier.inFlight()[0].nonce);
    expect(clearing.requestId).toBeUndefined();

    clock += STUCK_MS + 1;
    await restarted.tick();
    const entry = restarted.inFlight().find((e) => e.nonce === clearing.nonce)!;
    expect(entry.hashes).toHaveLength(2);
    expect(entry.maxFeePerGas).toBeGreaterThan(clearing.maxFeePerGas);

    await mineAll();
    await restarted.tick();
    expect(restarted.inFlight().some((e) => e.nonce === clearing.nonce)).toBe(false);
    await mineAll();
    await restarted.tick();
    expect(await statusOf(id)).toBe(FULFILLED);
  });

  it('never raises fees above the cap', async () => {
    await roll();
    const { maxFeePerGas } = await pub.estimateFeesPerGas();
    const cap = maxFeePerGas * 3n;
    const node = makeNode(BLS_KEY, pub, cap);
    await test.setAutomine(false);
    await node.tick();
    for (let i = 0; i < 12; i++) {
      clock += STUCK_MS + 1;
      await node.tick();
      const [entry] = node.inFlight();
      expect(entry.maxFeePerGas).toBeLessThanOrEqual(cap);
      expect(entry.maxPriorityFeePerGas).toBeLessThanOrEqual(cap);
    }
  });
});

describe('message', () => {
  it('uses the same encoding as the contract', async () => {
    const id = await roll();
    const receipt = await pub.getBlock({ blockTag: 'latest' });
    const expected = keccak256(
      encodeAbiParameters(
        [{ type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }],
        [BigInt(foundry.id), oracle, id, dice, receipt.hash],
      ),
    );
    await test.mine({ blocks: 1 });
    expect(await pub.readContract({ address: oracle, abi: ORACLE.abi, functionName: 'messageOf', args: [id] })).toBe(
      expected,
    );
  });
});
