// What the dashboard concludes from chain data. Pure, so every rule here is tested without a chain.
import { parseEther, type Address, type Hex } from 'viem';

/** RandomnessOracle.EXPIRY_BLOCKS */
export const EXPIRY_BLOCKS = 256n;
/** Below this many blocks left, a waiting request is about to be lost. */
const EXPIRING_BLOCKS = 32;
const SLOW_BLOCKS = 10n;
/** Avalanche makes no blocks on a quiet chain, so a dead node may not show up in block counts at all. */
const SLOW_SECONDS = 60;

export interface OracleAnswer {
  randomness: bigint;
  callbackOk: boolean;
  txHash: Hex;
  block: bigint;
  latencySec: number;
  latencyBlocks: number;
}

export interface OracleRequest {
  id: bigint;
  consumer: Address;
  requestBlock: bigint;
  requestTime: number;
  /** RandomnessOracle.Status: 1 pending, 2 fulfilled, 3 expired. */
  status: number;
  /** Absent until the answer's log has been read. */
  answer?: OracleAnswer;
  /** The dice face, when the consumer is the configured dice contract and the roll has settled. */
  face?: number;
  /** Who rolled, when the consumer is the configured dice contract. */
  player?: Address;
  refunded?: boolean;
}

export interface BeaconRound {
  id: bigint;
  creator: Address;
  commitEnd: number;
  revealEnd: number;
  minParticipants: number;
  commits: number;
  reveals: number;
  /** RandomnessBeacon.Status: 0 open, 1 finalized, 2 failed. */
  status: number;
  bond: bigint;
  randomness: bigint;
}

export type RequestStateName = 'pending' | 'overdue' | 'fulfilled' | 'expired';

export function requestState(r: Pick<OracleRequest, 'status' | 'requestBlock'>, head: bigint): { state: RequestStateName; blocksLeft: number } {
  if (r.status === 2) return { state: 'fulfilled', blocksLeft: 0 };
  if (r.status === 3) return { state: 'expired', blocksLeft: 0 };
  // An answer lands in head + 1 at the earliest and must be at most EXPIRY_BLOCKS after the request.
  const left = r.requestBlock + EXPIRY_BLOCKS - head;
  return left > 0n ? { state: 'pending', blocksLeft: Number(left) } : { state: 'overdue', blocksLeft: 0 };
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function summarize(requests: readonly OracleRequest[], head: bigint) {
  const count = { pending: 0, overdue: 0, fulfilled: 0, expired: 0 };
  for (const r of requests) count[requestState(r, head).state]++;
  const answers = requests.flatMap((r) => (r.answer ? [r.answer] : []));
  const closed = count.fulfilled + count.expired + count.overdue;
  return {
    ...count,
    /** Share of the requests that are past waiting and got an answer. */
    answeredShare: closed === 0 ? null : count.fulfilled / closed,
    medianLatencySec: median(answers.map((a) => a.latencySec)),
    callbackFailures: answers.filter((a) => !a.callbackOk).length,
  };
}

export type HealthCode = 'idle' | 'ok' | 'waiting' | 'slow' | 'overdue' | 'expiring';
export interface Health {
  level: 'good' | 'warning' | 'critical';
  code: HealthCode;
  count: number;
}

export function oracleHealth(requests: readonly OracleRequest[], head: bigint, nowSec: number): Health {
  if (requests.length === 0) return { level: 'good', code: 'idle', count: 0 };
  const open = requests.filter((r) => r.status === 1).map((r) => ({ r, ...requestState(r, head) }));
  const waiting = open.filter((o) => o.state === 'pending');

  const expiring = waiting.filter((o) => o.blocksLeft <= EXPIRING_BLOCKS).length;
  if (expiring > 0) return { level: 'critical', code: 'expiring', count: expiring };

  const slow = waiting.filter((o) => head - o.r.requestBlock > SLOW_BLOCKS || nowSec - o.r.requestTime > SLOW_SECONDS).length;
  if (slow > 0) return { level: 'warning', code: 'slow', count: slow };

  const overdue = open.length - waiting.length;
  if (overdue > 0) return { level: 'warning', code: 'overdue', count: overdue };

  return waiting.length > 0 ? { level: 'good', code: 'waiting', count: waiting.length } : { level: 'good', code: 'ok', count: 0 };
}

export function diceCounts(results: readonly number[]): number[] {
  const counts = [0, 0, 0, 0, 0, 0];
  for (const face of results) if (face >= 1 && face <= 6) counts[face - 1]++;
  return counts;
}

/** The next clean number at or above `value`, for the top of a chart axis. */
export function niceMax(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 4, 5, 8, 10].find((s) => s * magnitude >= value) ?? 10;
  return step * magnitude;
}

export type BeaconPhase = 'commit' | 'reveal' | 'finalizable' | 'finalized' | 'failed';

export function beaconPhase(r: BeaconRound, nowSec: number): BeaconPhase {
  if (r.status === 1) return 'finalized';
  if (r.status === 2) return 'failed';
  if (nowSec <= r.commitEnd) return 'commit';
  if (r.reveals === r.commits || nowSec > r.revealEnd) return 'finalizable';
  return 'reveal';
}

/** Bonds nobody can ever withdraw: those of withholders in a round that reached its minimum and then failed. */
export function lockedBond(r: BeaconRound): bigint {
  if (r.status !== 2 || r.commits < r.minParticipants) return 0n;
  return BigInt(r.commits - r.reveals) * r.bond;
}

/** The value drawn, one level per 16-bit word, most significant first. Nothing here is decoration. */
export function fingerprint(value: bigint): number[] {
  const levels: number[] = [];
  for (let word = 15n; word >= 0n; word--) levels.push(Number((value >> (word * 16n)) & 0xffffn) / 0xffff);
  return levels;
}

export type RequestFilter = 'all' | 'open' | 'fulfilled' | 'expired';

export function filterRequests(requests: readonly OracleRequest[], head: bigint, filter: RequestFilter): OracleRequest[] {
  if (filter === 'all') return [...requests];
  return requests.filter((r) => {
    const { state } = requestState(r, head);
    return filter === 'open' ? state === 'pending' || state === 'overdue' : state === filter;
  });
}

export function matchesSearch(r: OracleRequest, query: string): boolean {
  const q = query.trim().toLowerCase().replace(/^#/, '');
  if (!q) return true;
  if (r.id.toString() === q) return true;
  const randomness = r.answer ? `0x${r.answer.randomness.toString(16).padStart(64, '0')}` : '';
  return [r.consumer, r.answer?.txHash ?? '', randomness].some((text) => q.startsWith('0x') && text.toLowerCase().includes(q));
}

/** Requests per equal stretch of blocks, from the oldest request to the head, oldest first. */
export function activitySeries(requests: readonly OracleRequest[], head: bigint, buckets: number): number[] {
  if (requests.length === 0) return [];
  const oldest = requests.reduce((min, r) => (r.requestBlock < min ? r.requestBlock : min), head);
  const span = head - oldest + 1n;
  const series = new Array<number>(buckets).fill(0);
  for (const r of requests) series[Number(((r.requestBlock - oldest) * BigInt(buckets)) / span)]++;
  return series;
}

export interface TapeBlock {
  block: bigint;
  requested: number;
  answered: number;
}

/** The newest blocks, oldest first, with what the oracle did in each. */
export function blockTape(requests: readonly OracleRequest[], head: bigint, width: number): TapeBlock[] {
  const first = head + 1n > BigInt(width) ? head + 1n - BigInt(width) : 0n;
  const tape: TapeBlock[] = [];
  for (let block = first; block <= head; block++) tape.push({ block, requested: 0, answered: 0 });
  for (const r of requests) {
    if (r.requestBlock >= first && r.requestBlock <= head) tape[Number(r.requestBlock - first)].requested++;
    if (r.answer && r.answer.block >= first && r.answer.block <= head) tape[Number(r.answer.block - first)].answered++;
  }
  return tape;
}

/** What to draw for a round's participants. Bounded, since minParticipants is whatever a round's creator chose. */
export function seatCells(r: BeaconRound, max = 32) {
  const seats = Math.max(r.commits, r.minParticipants);
  const revealed = Math.min(r.reveals, max);
  const committed = Math.min(r.commits - r.reveals, max - revealed);
  const empty = Math.min(seats - r.commits, max - revealed - committed);
  return { revealed, committed, empty, hidden: seats - revealed - committed - empty };
}

export interface BeaconEntry {
  commitment: Hex;
  committed: boolean;
  revealed: boolean;
  claimed: boolean;
}

export type ClaimState = 'open' | 'none' | 'claimable' | 'claimed' | 'forfeited';

/** Mirrors RandomnessBeacon.claim. */
export function claimState(r: BeaconRound, e: BeaconEntry | null): ClaimState {
  if (r.status === 0) return 'open';
  if (!e?.committed) return 'none';
  if (e.claimed) return 'claimed';
  return !e.revealed && r.commits >= r.minParticipants ? 'forfeited' : 'claimable';
}

/** What the contract would accept now. The chain's next block may differ by a moment, and the send re-checks. */
export function beaconActions(r: BeaconRound, e: BeaconEntry | null, nowSec: number) {
  const open = r.status === 0;
  return {
    commit: open && nowSec <= r.commitEnd && !e?.committed,
    reveal: open && nowSec > r.commitEnd && nowSec <= r.revealEnd && Boolean(e?.committed) && !e?.revealed,
    finalize: beaconPhase(r, nowSec) === 'finalizable',
    claim: claimState(r, e) === 'claimable',
  };
}

export function rollActions(r: OracleRequest, head: bigint) {
  const { state } = requestState(r, head);
  return {
    /** The callback failed, so the roll has no face yet. */
    settle: state === 'fulfilled' && Boolean(r.answer) && r.face === undefined,
    refund: (state === 'overdue' || state === 'expired') && !r.refunded,
  };
}

export function consumerStats(requests: readonly OracleRequest[], head: bigint, consumerAddress: Address) {
  const mine = requests.filter((r) => r.consumer.toLowerCase() === consumerAddress.toLowerCase());
  const s = summarize(mine, head);
  return {
    total: mine.length,
    answered: s.fulfilled,
    open: s.pending + s.overdue,
    expired: s.expired,
    callbackFailures: s.callbackFailures,
    medianLatencySec: s.medianLatencySec,
  };
}

/** The oracle owes its earned fees, the refunds it credited, and the fee of every request still open. */
export function reconcile(a: { balance: bigint; earned: bigint; refunds: bigint; pending: number; fee: bigint }) {
  const owed = a.earned + a.refunds + BigInt(a.pending) * a.fee;
  const surplus = a.balance - owed;
  return { owed, surplus, ok: surplus >= 0n };
}

/** Below this many answers' worth of gas, the node needs topping up. */
const LOW_GAS_ANSWERS = 10n;

export interface AdminAlert {
  level: 'warning' | 'critical';
  code: 'node-expiring' | 'node-slow' | 'node-overdue' | 'shortfall' | 'gas-out' | 'gas-low' | 'fee-below-cost' | 'callback-failures';
  count?: number;
}

export function adminAlerts(a: {
  health: Health;
  fee: bigint;
  /** Null until an answer gives a cost to compare with. */
  avgCost: bigint | null;
  walletBalance: bigint;
  callbackFailures: number;
  /** Null when the window does not cover every request, so nothing can be said. */
  reconcileOk: boolean | null;
}): AdminAlert[] {
  const alerts: AdminAlert[] = [];
  if (a.health.code === 'expiring') alerts.push({ level: 'critical', code: 'node-expiring', count: a.health.count });
  if (a.health.code === 'slow') alerts.push({ level: 'warning', code: 'node-slow', count: a.health.count });
  if (a.health.code === 'overdue') alerts.push({ level: 'warning', code: 'node-overdue', count: a.health.count });
  if (a.reconcileOk === false) alerts.push({ level: 'critical', code: 'shortfall' });
  if (a.avgCost !== null) {
    if (a.walletBalance < a.avgCost) alerts.push({ level: 'critical', code: 'gas-out' });
    else if (a.walletBalance < a.avgCost * LOW_GAS_ANSWERS) alerts.push({ level: 'warning', code: 'gas-low' });
    if (a.avgCost > a.fee) alerts.push({ level: 'warning', code: 'fee-below-cost' });
  }
  if (a.callbackFailures > 0) alerts.push({ level: 'warning', code: 'callback-failures', count: a.callbackFailures });
  return alerts.sort((x, y) => Number(y.level === 'critical') - Number(x.level === 'critical'));
}

export type RoundForm = Record<'commitMinutes' | 'revealMinutes' | 'bond' | 'minParticipants', string>;
const WHOLE = /^\d+$/;
const UINT32_MAX = 4_294_967_295;

export function parseRoundForm(f: RoundForm):
  | { ok: true; args: readonly [bigint, bigint, bigint, number] }
  | { ok: false; field: 'commit' | 'reveal' | 'bond' | 'minParticipants' } {
  if (!WHOLE.test(f.commitMinutes) || BigInt(f.commitMinutes) === 0n) return { ok: false, field: 'commit' };
  if (!WHOLE.test(f.revealMinutes) || BigInt(f.revealMinutes) === 0n) return { ok: false, field: 'reveal' };
  let bond: bigint;
  try {
    bond = parseEther(f.bond.trim() as `${number}`);
  } catch {
    return { ok: false, field: 'bond' };
  }
  if (bond <= 0n) return { ok: false, field: 'bond' };
  const min = Number(f.minParticipants);
  if (!WHOLE.test(f.minParticipants) || min < 2 || min > UINT32_MAX) return { ok: false, field: 'minParticipants' };
  return { ok: true, args: [BigInt(f.commitMinutes) * 60n, BigInt(f.revealMinutes) * 60n, bond, min] };
}
