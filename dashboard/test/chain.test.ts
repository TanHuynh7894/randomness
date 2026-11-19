// Reads the real contracts on a real anvil, so a change to a contract's ABI fails here. Nothing is mocked.
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestClient,
  createWalletClient,
  encodeAbiParameters,
  http,
  keccak256,
  verifyMessage,
  type Address,
  type EIP1193Provider,
  type Hex,
} from 'viem';
import { foundry } from 'viem/chains';
import { messageFor, publicKey, sign } from '../../node/src/bls';
import { BEACON_ABI, createBeaconReader, createOracleReader, DICE_ABI, makeClient, ORACLE_ABI, readEntries, walletFor } from '../src/chain';
import { createAdminReader } from '../src/admin';
import { commitmentFor, newSecret } from '../src/secrets';
import { errorText } from '../src/format';
import { verifyAnswer } from '../src/verify';

const PORT = 8602;
const URL_ = `http://127.0.0.1:${PORT}`;
const BLS_KEY = 0x2a2a2a2a2a2a2a2an;
const FEE = 10n ** 16n;
const ALICE: Address = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const BOB: Address = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

const artifact = (file: string, name: string) =>
  JSON.parse(readFileSync(new URL(`../../out/${file}/${name}.json`, import.meta.url), 'utf8')) as {
    abi: any;
    bytecode: { object: Hex };
  };
const ORACLE = artifact('RandomnessOracle.sol', 'RandomnessOracle');
const DICE = artifact('DiceRoller.sol', 'DiceRoller');
const BEACON = artifact('RandomnessBeacon.sol', 'RandomnessBeacon');

const client = makeClient(URL_);
const wallet = createWalletClient({ chain: foundry, transport: http(URL_), pollingInterval: 20 });
const test = createTestClient({ chain: foundry, transport: http(URL_), mode: 'anvil' });

let anvil: ChildProcess;

async function send(account: Address, address: Address, abi: any, functionName: string, args: unknown[] = [], value = 0n) {
  const hash = await wallet.writeContract({ account, address, abi, functionName, args, value, gas: 2_000_000n } as any);
  const receipt = await client.waitForTransactionReceipt({ hash, pollingInterval: 20 });
  if (receipt.status !== 'success') throw new Error(`${functionName} reverted`);
  return receipt;
}

async function deploy(art: { abi: any; bytecode: { object: Hex } }, args: unknown[] = []) {
  const hash = await wallet.deployContract({ account: ALICE, abi: art.abi, bytecode: art.bytecode.object, args } as any);
  const receipt = await client.waitForTransactionReceipt({ hash, pollingInterval: 20 });
  return receipt.contractAddress!;
}

beforeAll(async () => {
  anvil = spawn('anvil', ['--port', String(PORT), '--silent'], { stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    try {
      await client.getChainId();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('anvil did not start');
});

afterAll(() => {
  anvil?.kill();
});

describe('oracle reader', () => {
  it('follows requests from pending to answered and expired', async () => {
    const oracle = await deploy(ORACLE, [publicKey(BLS_KEY), BOB, FEE]);
    const dice = await deploy(DICE, [oracle]);
    const read = createOracleReader(client, oracle, dice);

    const empty = await read();
    expect(empty).toMatchObject({ total: 0, fee: FEE, earned: 0n, requests: [] });
    expect(empty.operator.toLowerCase()).toBe(BOB.toLowerCase());
    expect(empty.dice).toEqual([]);

    const first = await send(ALICE, dice, DICE.abi, 'roll', [], FEE);
    await test.mine({ blocks: 1 });
    const pending = await read();
    expect(pending.total).toBe(1);
    expect(pending.balance).toBe(FEE);
    expect(pending.requests[0]).toMatchObject({ id: 1n, status: 1, requestBlock: first.blockNumber });
    expect(pending.requests[0].consumer.toLowerCase()).toBe(dice.toLowerCase());
    expect(pending.requests[0].answer).toBeUndefined();

    const message = messageFor({ chainId: foundry.id, oracle, requestId: 1n, consumer: dice, blockHash: first.blockHash });
    const signature = sign(BLS_KEY, message);
    const answer = await send(BOB, oracle, ORACLE.abi, 'fulfill', [1n, [signature[0], signature[1]]]);

    const done = await read();
    const row = done.requests[0];
    expect(row.status).toBe(2);
    expect(row.answer).toMatchObject({
      callbackOk: true,
      txHash: answer.transactionHash,
      block: answer.blockNumber,
      latencyBlocks: 2,
    });
    expect(row.answer!.randomness).toBe(BigInt(keccak256(encodeAbiParameters([{ type: 'uint256[2]' }], [[signature[0], signature[1]]]))));
    expect(row.answer!.latencySec).toBeGreaterThanOrEqual(0);
    expect(done.earned).toBe(FEE);
    const face = Number(row.answer!.randomness % 6n) + 1;
    expect(done.dice).toEqual([face]);
    expect(row.face).toBe(face);

    await send(ALICE, dice, DICE.abi, 'roll', [], FEE);
    await test.mine({ blocks: 257 });
    await send(ALICE, oracle, ORACLE.abi, 'expire', [2n]);
    const closed = await read();
    expect(closed.requests.map((r) => [r.id, r.status])).toEqual([[2n, 3], [1n, 2]]);
  });

  it('keeps only the newest requests but still reports the true total', async () => {
    const oracle = await deploy(ORACLE, [publicKey(BLS_KEY), BOB, FEE]);
    for (let i = 0; i < 3; i++) await send(ALICE, oracle, ORACLE.abi, 'requestRandomness', [], FEE);
    const snapshot = await createOracleReader(client, oracle, undefined, 2)();
    expect(snapshot.total).toBe(3);
    expect(snapshot.requests.map((r) => r.id)).toEqual([3n, 2n]);
    expect(snapshot.dice).toBeNull();
  });

  it('forgets what it cached when the chain goes backwards', async () => {
    const oracle = await deploy(ORACLE, [publicKey(BLS_KEY), BOB, FEE]);
    const snapshotId = await test.snapshot();
    await send(ALICE, oracle, ORACLE.abi, 'requestRandomness', [], FEE);
    await send(ALICE, oracle, ORACLE.abi, 'requestRandomness', [], FEE);
    const read = createOracleReader(client, oracle);
    expect((await read()).total).toBe(2);
    await test.revert({ id: snapshotId });
    await test.mine({ blocks: 1 });
    expect((await read()).total).toBe(0);
    const again = await send(ALICE, oracle, ORACLE.abi, 'requestRandomness', [], FEE);
    expect((await read()).requests[0].requestBlock).toBe(again.blockNumber);
  });
});

describe('verifyAnswer', () => {
  async function answeredRequest() {
    const oracle = await deploy(ORACLE, [publicKey(BLS_KEY), BOB, FEE]);
    const dice = await deploy(DICE, [oracle]);
    const rolled = await send(ALICE, dice, DICE.abi, 'roll', [], FEE);
    await test.mine({ blocks: 1 });
    const message = messageFor({ chainId: foundry.id, oracle, requestId: 1n, consumer: dice, blockHash: rolled.blockHash });
    const signature = sign(BLS_KEY, message);
    await send(BOB, oracle, ORACLE.abi, 'fulfill', [1n, [signature[0], signature[1]]]);
    const request = (await createOracleReader(client, oracle, dice)()).requests[0];
    return { oracle, dice, request, rolled, message, signature };
  }

  it('confirms a real answer from chain data alone', async () => {
    const { oracle, request, message, signature } = await answeredRequest();
    const result = await verifyAnswer(client, foundry.id, oracle, request);
    expect(result).toMatchObject({ kind: 'checked', message, signature: [signature[0], signature[1]], signatureOk: true, randomnessOk: true });
  });

  it('rejects a result that is not the hash of the signature', async () => {
    const { oracle, request } = await answeredRequest();
    const forged = { ...request, answer: { ...request.answer!, randomness: request.answer!.randomness ^ 1n } };
    expect(await verifyAnswer(client, foundry.id, oracle, forged)).toMatchObject({ signatureOk: true, randomnessOk: false });
  });

  it('rejects a signature made for another request', async () => {
    const { oracle, request } = await answeredRequest();
    const other = { ...request, consumer: ALICE };
    expect(await verifyAnswer(client, foundry.id, oracle, other)).toMatchObject({ signatureOk: false, randomnessOk: true });
  });

  it('does not vouch for a transaction that went to another oracle', async () => {
    const { request } = await answeredRequest();
    const otherOracle = await deploy(ORACLE, [publicKey(BLS_KEY + 1n), BOB, FEE]);
    expect(await verifyAnswer(client, foundry.id, otherOracle, request)).toMatchObject({ kind: 'unreadable' });
  });

  it('says so when the answer came through another contract and its calldata cannot be read', async () => {
    const { oracle, request, rolled } = await answeredRequest();
    const viaOther = { ...request, answer: { ...request.answer!, txHash: rolled.transactionHash } };
    expect(await verifyAnswer(client, foundry.id, oracle, viaOther)).toMatchObject({ kind: 'unreadable' });
  });
});

describe('beacon reader', () => {
  it('reads rounds newest first, with their progress and result', async () => {
    const beacon = await deploy(BEACON);
    const read = createBeaconReader(client, beacon);
    expect(await read()).toMatchObject({ total: 0, rounds: [] });

    await send(ALICE, beacon, BEACON.abi, 'createRound', [60n, 60n, FEE, 2]);
    const secret = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
    const commitment = (who: Address, n: number) =>
      keccak256(
        encodeAbiParameters(
          [{ type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }],
          [BigInt(foundry.id), beacon, 0n, who, secret(n)],
        ),
      );
    await send(ALICE, beacon, BEACON.abi, 'commit', [0n, commitment(ALICE, 1)], FEE);
    await send(BOB, beacon, BEACON.abi, 'commit', [0n, commitment(BOB, 2)], FEE);

    const open = await read();
    expect(open.rounds[0]).toMatchObject({ id: 0n, status: 0, commits: 2, reveals: 0, minParticipants: 2, bond: FEE });
    expect(open.rounds[0].revealEnd - open.rounds[0].commitEnd).toBe(60);
    expect(open.rounds[0].commitEnd).toBeGreaterThanOrEqual(open.headTime);

    await test.increaseTime({ seconds: 61 });
    await test.mine({ blocks: 1 });
    await send(ALICE, beacon, BEACON.abi, 'reveal', [0n, secret(1)]);
    await send(BOB, beacon, BEACON.abi, 'reveal', [0n, secret(2)]);
    await send(ALICE, beacon, BEACON.abi, 'finalize', [0n]);

    await send(ALICE, beacon, BEACON.abi, 'createRound', [60n, 60n, FEE, 2]);
    const closed = await read();
    expect(closed.total).toBe(2);
    expect(closed.rounds.map((r) => r.id)).toEqual([1n, 0n]);
    expect(closed.rounds[1].status).toBe(1);
    expect(closed.rounds[1].randomness).not.toBe(0n);
    expect(closed.rounds[1].randomness).toBe(
      await client.readContract({ address: beacon, abi: BEACON.abi, functionName: 'randomOf', args: [0n] }),
    );
  });
});

describe('walletFor', () => {
  const noDevAccounts = () => ({ ...client, request: async () => [] }) as unknown as typeof client;
  function fakeWallet(chainId: number, calls: string[]) {
    return {
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        calls.push(method);
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [ALICE];
        if (method === 'eth_chainId') return `0x${chainId.toString(16)}`;
        if (method === 'wallet_switchEthereumChain') {
          chainId = Number((params as [{ chainId: string }])[0].chainId);
          return null;
        }
        return client.request({ method, params } as never);
      },
    } as unknown as EIP1193Provider;
  }

  it('offers the unlocked accounts of a dev node and signs and sends through them', async () => {
    const oracle = await deploy(ORACLE, [publicKey(BLS_KEY), BOB, FEE]);
    const dice = await deploy(DICE, [oracle]);
    const wallet = (await walletFor(client, URL_, undefined))!;
    expect(wallet.kind).toBe('dev');
    const accounts = await wallet.accounts();
    expect(accounts.map((a) => a.toLowerCase())).toContain(ALICE.toLowerCase());
    const signer = wallet.signerFor(ALICE);
    const signature = await signer.signMessage('hello');
    expect(await verifyMessage({ address: ALICE, message: 'hello', signature })).toBe(true);
    await signer.write({ address: dice, abi: DICE_ABI, functionName: 'roll', value: FEE });
    expect((await createOracleReader(client, oracle, dice)()).total).toBe(1);
  });

  it('goes through the browser wallet on a node without accounts', async () => {
    const oracle = await deploy(ORACLE, [publicKey(BLS_KEY), BOB, FEE]);
    const dice = await deploy(DICE, [oracle]);
    const calls: string[] = [];
    const wallet = (await walletFor(noDevAccounts(), URL_, fakeWallet(foundry.id, calls), client))!;
    expect(wallet.kind).toBe('wallet');
    await wallet.signerFor(ALICE).write({ address: dice, abi: DICE_ABI, functionName: 'roll', value: FEE });
    expect((await createOracleReader(client, oracle, dice)()).total).toBe(1);
    expect(calls).not.toContain('wallet_switchEthereumChain');
  });

  it('asks the browser wallet to switch when it is on another chain', async () => {
    const oracle = await deploy(ORACLE, [publicKey(BLS_KEY), BOB, FEE]);
    const dice = await deploy(DICE, [oracle]);
    const calls: string[] = [];
    const wallet = (await walletFor(noDevAccounts(), URL_, fakeWallet(1, calls), client))!;
    await wallet.signerFor(ALICE).write({ address: dice, abi: DICE_ABI, functionName: 'roll', value: FEE });
    expect(calls).toContain('wallet_switchEthereumChain');
  });

  it('finds no way to send when the node has no accounts and there is no wallet', async () => {
    expect(await walletFor(noDevAccounts(), URL_, undefined)).toBeNull();
  });

  it('explains a revert in the words of the contract error, without sending anything', async () => {
    const oracle = await deploy(ORACLE, [publicKey(BLS_KEY), BOB, FEE]);
    const signer = (await walletFor(client, URL_, undefined))!.signerFor(ALICE);
    const before = await client.getTransactionCount({ address: ALICE });
    const failure = await signer.write({ address: oracle, abi: ORACLE_ABI, functionName: 'withdraw' }).catch((e) => e);
    expect(errorText(failure)).toBe('Nothing to withdraw yet.');
    expect(await client.getTransactionCount({ address: ALICE })).toBe(before);
  });
});

describe('operator and player actions', () => {
  async function setup() {
    const oracle = await deploy(ORACLE, [publicKey(BLS_KEY), BOB, FEE]);
    const dice = await deploy(DICE, [oracle]);
    const wallet = (await walletFor(client, URL_, undefined))!;
    const roll = await wallet.signerFor(ALICE).write({ address: dice, abi: DICE_ABI, functionName: 'roll', value: FEE });
    return { oracle, dice, wallet, roll };
  }

  it('reads who rolled and whether it was refunded, and pays a refund once', async () => {
    const { oracle, dice, wallet } = await setup();
    const read = createOracleReader(client, oracle, dice);
    expect((await read()).requests[0].player?.toLowerCase()).toBe(ALICE.toLowerCase());
    await test.mine({ blocks: 257 });
    const signer = wallet.signerFor(ALICE);
    await signer.write({ address: dice, abi: DICE_ABI, functionName: 'refund', args: [1n] });
    expect((await read()).requests[0]).toMatchObject({ status: 3, refunded: true });
    const again = await signer.write({ address: dice, abi: DICE_ABI, functionName: 'refund', args: [1n] }).catch((e) => e);
    expect(errorText(again)).toBe('This roll cannot be refunded, or it already was.');
  });

  it('gives the admin the node wallet, the real cost of an answer and a balanced account', async () => {
    const { oracle, dice, roll } = await setup();
    await test.mine({ blocks: 1 });
    const message = messageFor({ chainId: foundry.id, oracle, requestId: 1n, consumer: dice, blockHash: roll.blockHash });
    const signature = sign(BLS_KEY, message);
    const answer = await send(BOB, oracle, ORACLE.abi, 'fulfill', [1n, [signature[0], signature[1]]]);
    // One more request stays open, so the account has a pending fee in it too.
    await send(ALICE, dice, DICE.abi, 'roll', [], FEE);

    const snapshot = await createOracleReader(client, oracle, dice)();
    const admin = await createAdminReader(client, oracle)(snapshot);
    expect(admin.wallets.map((w) => w.address.toLowerCase())).toEqual([BOB.toLowerCase()]);
    expect(admin.wallets[0].balance).toBe(await client.getBalance({ address: BOB }));
    expect(admin.avgCost).toBe(answer.gasUsed * answer.effectiveGasPrice);
    expect(admin.samples).toBe(1);
    expect(admin.publicKey).toEqual([...publicKey(BLS_KEY)]);
    expect(admin.reconciliation).toMatchObject({ ok: true, surplus: 0n, owed: 2n * FEE });
  });

  it('counts refunds waiting in the contract when reconciling', async () => {
    const { oracle, dice } = await setup();
    await test.mine({ blocks: 257 });
    await send(ALICE, oracle, ORACLE.abi, 'expire', [1n]);
    const snapshot = await createOracleReader(client, oracle, dice)();
    const admin = await createAdminReader(client, oracle)(snapshot);
    expect(admin.reconciliation).toMatchObject({ ok: true, surplus: 0n, owed: FEE });
    expect(admin.refunds).toBe(FEE);
  });

  it('will not claim to reconcile when older requests are outside the window', async () => {
    const { oracle, dice, wallet } = await setup();
    await wallet.signerFor(ALICE).write({ address: dice, abi: DICE_ABI, functionName: 'roll', value: FEE });
    const snapshot = await createOracleReader(client, oracle, dice, 1)();
    expect((await createAdminReader(client, oracle)(snapshot)).reconciliation).toBeNull();
  });
});

describe('beacon through the wallet', () => {
  it('runs a whole round with secrets made here, which the contract accepts', async () => {
    const beacon = await deploy(BEACON);
    const wallet = (await walletFor(client, URL_, undefined))!;
    const [alice, bob] = [wallet.signerFor(ALICE), wallet.signerFor(BOB)];
    const write = (signer: typeof alice, functionName: string, args: unknown[], value?: bigint) =>
      signer.write({ address: beacon, abi: BEACON_ABI, functionName, args, value } as never);

    await write(alice, 'createRound', [60n, 60n, FEE, 2]);
    const secrets = [newSecret(), newSecret()];
    expect(secrets[0]).not.toBe(secrets[1]);
    await write(alice, 'commit', [0n, commitmentFor(foundry.id, beacon, 0n, ALICE, secrets[0])], FEE);
    await write(bob, 'commit', [0n, commitmentFor(foundry.id, beacon, 0n, BOB, secrets[1])], FEE);

    const rounds = (await createBeaconReader(client, beacon)()).rounds;
    const [mine] = await readEntries(client, beacon, rounds, ALICE);
    expect(mine).toMatchObject({ committed: true, revealed: false, claimed: false });

    await test.increaseTime({ seconds: 61 });
    await test.mine({ blocks: 1 });
    await write(alice, 'reveal', [0n, secrets[0]]);
    await write(bob, 'reveal', [0n, secrets[1]]);
    await write(alice, 'finalize', [0n]);
    await write(alice, 'claim', [0n]);

    const [closed] = (await createBeaconReader(client, beacon)()).rounds;
    expect(closed.status).toBe(1);
    expect((await readEntries(client, beacon, [closed], ALICE))[0]).toMatchObject({ revealed: true, claimed: true });
    const twice = await write(alice, 'claim', [0n]).catch((e) => e);
    expect(errorText(twice)).toBe('Nothing to claim from this round.');
  });

  it('refuses a wrong secret with a readable reason', async () => {
    const beacon = await deploy(BEACON);
    const alice = (await walletFor(client, URL_, undefined))!.signerFor(ALICE);
    await alice.write({ address: beacon, abi: BEACON_ABI, functionName: 'createRound', args: [60n, 60n, FEE, 2] });
    await alice.write({ address: beacon, abi: BEACON_ABI, functionName: 'commit', args: [0n, commitmentFor(foundry.id, beacon, 0n, ALICE, newSecret())], value: FEE });
    await test.increaseTime({ seconds: 61 });
    await test.mine({ blocks: 1 });
    const failure = await alice.write({ address: beacon, abi: BEACON_ABI, functionName: 'reveal', args: [0n, newSecret()] }).catch((e) => e);
    expect(errorText(failure)).toBe('The secret does not match what this wallet committed.');
  });
});
