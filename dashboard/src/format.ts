import { BaseError, ContractFunctionRevertedError, formatEther, type Hex } from 'viem';

const EXPLORER: Record<number, string> = { 43113: 'https://testnet.snowtrace.io', 43114: 'https://snowtrace.io' };
const CHAIN_NAME: Record<number, string> = { 31337: 'Anvil (local)', 43113: 'Avalanche Fuji', 43114: 'Avalanche C-Chain' };

/** A local copy of a public chain: it keeps the chain's ID, but its transactions never reach the public explorer. */
const LOCAL_FORK = import.meta.env.VITE_LOCAL_FORK === '1';
const explorer = (id: number) => (LOCAL_FORK ? undefined : EXPLORER[id]);

export const chainName = (id: number) => `${CHAIN_NAME[id] ?? `Chain ${id}`}${LOCAL_FORK ? ' (local fork)' : ''}`;
export const explorerTx = (id: number, hash: Hex) => (explorer(id) ? `${explorer(id)}/tx/${hash}` : undefined);
export const explorerAddress = (id: number, address: string) => (explorer(id) ? `${explorer(id)}/address/${address}` : undefined);

export const shortHex = (hex: string) => (hex.length <= 14 ? hex : `${hex.slice(0, 8)}…${hex.slice(-6)}`);
export const uintHex = (value: bigint): Hex => `0x${value.toString(16).padStart(64, '0')}`;
export const number = (value: number) => value.toLocaleString('en-US');
/** "1 block", "3 blocks". */
export const plural = (n: number | bigint, word: string) => `${number(Number(n))} ${word}${Number(n) === 1 ? '' : 's'}`;

/** Amounts are shown in AVAX on every chain, including the local devnet, which mirrors the C-Chain's 18 decimals. */
export function amount(wei: bigint, _chainId?: number): string {
  const [whole, fraction = ''] = formatEther(wei).split('.');
  const trimmed = fraction.slice(0, 4).replace(/0+$/, '');
  const shown = wei > 0n && whole === '0' && !trimmed ? '<0.0001' : trimmed ? `${whole}.${trimmed}` : whole;
  return `${shown} AVAX`;
}

export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}

export const latency = (seconds: number) => `${number(Math.round(seconds * 10) / 10)}s`;

const CONTRACT_ERRORS: Record<string, string> = {
  NothingToWithdraw: 'Nothing to withdraw yet.',
  NotRefundable: 'This roll cannot be refunded, or it already was.',
  NotPending: 'This request is already closed.',
  OutsideWindow: 'Too early: the request is still inside its 256-block window.',
  NotFulfilled: 'The oracle has no result for this request yet.',
  WrongFee: 'The amount sent is not exactly the oracle fee.',
  TransferFailed: 'The money could not be sent to the receiving address.',
  BadParams: 'The round settings are not valid.',
  WrongPhase: 'The round is not in the right step for this.',
  WrongBond: 'The deposit sent does not match the round.',
  AlreadyCommitted: 'This wallet has already joined this round.',
  NotCommitted: 'This wallet has not joined this round.',
  AlreadyRevealed: 'This wallet has already revealed.',
  BadReveal: 'The secret does not match what this wallet committed.',
  AlreadyFinalized: 'This round is already finalized.',
  NotFinalized: 'This round is not finalized yet.',
  NothingToClaim: 'Nothing to claim from this round.',
};

/** The contract's reason in plain words when there is one. The full message of a failed call runs to many lines. */
export function errorText(e: unknown): string {
  if (e instanceof BaseError) {
    const reverted = e.walk((inner) => inner instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    const name = reverted?.data?.errorName;
    if (name && CONTRACT_ERRORS[name]) return CONTRACT_ERRORS[name];
    const code = (e.walk((inner) => typeof (inner as { code?: unknown }).code === 'number') as { code?: number } | null)?.code;
    if (code === 4001) return 'You declined in your wallet.';
    return e.shortMessage;
  }
  if ((e as { code?: number })?.code === 4001) return 'You declined in your wallet.';
  return String((e as Error).message ?? e).split('\n')[0];
}
