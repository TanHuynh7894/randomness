import { describe, expect, it } from 'vitest';
import {
  beaconPhase,
  blockTape,
  matchesSearch,
  seatCells,
  activitySeries,
  adminAlerts,
  beaconActions,
  claimState,
  consumerStats,
  parseRoundForm,
  reconcile,
  rollActions,
  diceCounts,
  filterRequests,
  fingerprint,
  lockedBond,
  median,
  niceMax,
  oracleHealth,
  requestState,
  summarize,
  type OracleRequest,
  type BeaconRound,
} from '../src/derive';

const consumer = '0x0000000000000000000000000000000000000001' as const;
const req = (over: Partial<OracleRequest>): OracleRequest => ({
  id: 1n,
  consumer,
  requestBlock: 1000n,
  requestTime: 5000,
  status: 1,
  ...over,
});
const answered = (latencySec: number, callbackOk = true): Partial<OracleRequest> => ({
  status: 2,
  answer: { randomness: 7n, callbackOk, txHash: '0xabc', block: 1002n, latencySec, latencyBlocks: 2 },
});

describe('requestState', () => {
  it('counts the blocks an answer can still land in', () => {
    // An answer lands in head + 1 at the earliest and must be at most 256 blocks after the request.
    expect(requestState(req({}), 1000n)).toEqual({ state: 'pending', blocksLeft: 256 });
    expect(requestState(req({}), 1255n)).toEqual({ state: 'pending', blocksLeft: 1 });
  });

  it('calls a still-pending request overdue once no answer can land', () => {
    expect(requestState(req({}), 1256n)).toEqual({ state: 'overdue', blocksLeft: 0 });
    expect(requestState(req({}), 9999n)).toEqual({ state: 'overdue', blocksLeft: 0 });
  });

  it('follows the chain for closed requests', () => {
    expect(requestState(req({ status: 2 }), 9999n).state).toBe('fulfilled');
    expect(requestState(req({ status: 3 }), 9999n).state).toBe('expired');
  });
});

describe('summarize', () => {
  it('counts each state and leaves open requests out of the answered share', () => {
    const s = summarize(
      [
        req(answered(2)),
        req(answered(4, false)),
        req(answered(30)),
        req({ status: 3 }),
        req({ requestBlock: 1n, status: 1 }), // overdue
        req({ requestBlock: 1999n }), // pending
      ],
      2000n,
    );
    expect(s).toMatchObject({ pending: 1, overdue: 1, fulfilled: 3, expired: 1, callbackFailures: 1 });
    expect(s.medianLatencySec).toBe(4);
    expect(s.answeredShare).toBeCloseTo(3 / 5);
  });

  it('has no share or latency before anything is closed', () => {
    const s = summarize([req({})], 1000n);
    expect(s.answeredShare).toBeNull();
    expect(s.medianLatencySec).toBeNull();
  });
});

describe('median', () => {
  it('handles empty, odd and even lists without relying on input order', () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe('oracleHealth', () => {
  const now = 5001;

  it('is idle with nothing requested and good when everything is answered', () => {
    expect(oracleHealth([], 1000n, now).code).toBe('idle');
    expect(oracleHealth([req(answered(2))], 1000n, now).code).toBe('ok');
  });

  it('stays good while a fresh request is waiting', () => {
    expect(oracleHealth([req({})], 1002n, now)).toMatchObject({ level: 'good', code: 'waiting', count: 1 });
  });

  it('warns about a request that has waited too many blocks', () => {
    expect(oracleHealth([req({})], 1011n, now)).toMatchObject({ level: 'warning', code: 'slow', count: 1 });
  });

  it('warns on wall-clock age too, because a quiet Avalanche chain makes no blocks', () => {
    expect(oracleHealth([req({})], 1000n, 5061)).toMatchObject({ level: 'warning', code: 'slow' });
  });

  it('is critical when a request is close to expiring, ahead of any other finding', () => {
    const list = [req({}), req({ requestBlock: 1n })];
    expect(oracleHealth(list, 1230n, now)).toMatchObject({ level: 'critical', code: 'expiring', count: 1 });
  });

  it('warns about overdue requests that only need closing', () => {
    expect(oracleHealth([req({})], 1300n, now)).toMatchObject({ level: 'warning', code: 'overdue', count: 1 });
  });
});

describe('diceCounts', () => {
  it('buckets faces and ignores unsettled rolls', () => {
    expect(diceCounts([1, 1, 6, 0, 3])).toEqual([2, 0, 1, 0, 0, 1]);
  });
});

describe('niceMax', () => {
  it('rounds an axis maximum up to a clean number', () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(3)).toBe(4);
    expect(niceMax(7)).toBe(8);
    expect(niceMax(12)).toBe(20);
    expect(niceMax(130)).toBe(200);
  });
});

const round = (over: Partial<BeaconRound>): BeaconRound => ({
  id: 0n,
  creator: consumer,
  commitEnd: 100,
  revealEnd: 200,
  minParticipants: 2,
  commits: 2,
  reveals: 0,
  status: 0,
  bond: 10n,
  randomness: 0n,
  ...over,
});

describe('beaconPhase', () => {
  it('follows the contract boundaries, which are inclusive at each deadline', () => {
    expect(beaconPhase(round({}), 100)).toBe('commit');
    expect(beaconPhase(round({}), 101)).toBe('reveal');
    expect(beaconPhase(round({}), 200)).toBe('reveal');
    expect(beaconPhase(round({}), 201)).toBe('finalizable');
  });

  it('can finalize early once everyone who committed has revealed', () => {
    expect(beaconPhase(round({ reveals: 2 }), 101)).toBe('finalizable');
    expect(beaconPhase(round({ commits: 0 }), 101)).toBe('finalizable');
  });

  it('reports closed rounds whatever the time', () => {
    expect(beaconPhase(round({ status: 1 }), 0)).toBe('finalized');
    expect(beaconPhase(round({ status: 2 }), 0)).toBe('failed');
  });
});

describe('lockedBond', () => {
  it('locks the bond of each withholder in a failed round', () => {
    expect(lockedBond(round({ status: 2, commits: 3, reveals: 1 }))).toBe(20n);
  });

  it('locks nothing when the round missed its minimum, because everyone is refunded', () => {
    expect(lockedBond(round({ status: 2, commits: 1, reveals: 0 }))).toBe(0n);
  });

  it('locks nothing while the round is open or after it succeeds', () => {
    expect(lockedBond(round({ status: 0, commits: 3, reveals: 1 }))).toBe(0n);
    expect(lockedBond(round({ status: 1, commits: 2, reveals: 2 }))).toBe(0n);
  });
});

describe('fingerprint', () => {
  it('gives one level per 16-bit word, most significant first', () => {
    const levels = fingerprint(0xffffn << 240n);
    expect(levels).toHaveLength(16);
    expect(levels[0]).toBe(1);
    expect(levels.slice(1).every((v) => v === 0)).toBe(true);
    expect(fingerprint(0xffffn)[15]).toBe(1);
  });

  it('stays within 0 to 1 at both ends of the range', () => {
    expect(fingerprint(0n).every((v) => v === 0)).toBe(true);
    expect(fingerprint((1n << 256n) - 1n).every((v) => v === 1)).toBe(true);
  });

  it('differs when only a low bit differs in a word', () => {
    expect(fingerprint(1n)[15]).toBeGreaterThan(fingerprint(0n)[15]);
  });
});

describe('filterRequests', () => {
  const list = [
    req({ id: 1n, ...answered(1) }),
    req({ id: 2n, status: 3 }),
    req({ id: 3n, requestBlock: 1n }), // overdue at head 1000
    req({ id: 4n, requestBlock: 999n }), // pending at head 1000
  ];
  const ids = (filter: Parameters<typeof filterRequests>[2]) => filterRequests(list, 1000n, filter).map((r) => r.id);

  it('keeps everything for all', () => expect(ids('all')).toEqual([1n, 2n, 3n, 4n]));
  it('counts overdue requests as still open, because the chain still says pending', () => expect(ids('open')).toEqual([3n, 4n]));
  it('separates answered and expired', () => {
    expect(ids('fulfilled')).toEqual([1n]);
    expect(ids('expired')).toEqual([2n]);
  });
});

describe('activitySeries', () => {
  it('has nothing to draw without requests', () => expect(activitySeries([], 100n, 4)).toEqual([]));

  it('splits the blocks from the oldest request to the head evenly, oldest first', () => {
    const list = [req({ requestBlock: 0n }), req({ requestBlock: 1n }), req({ requestBlock: 50n }), req({ requestBlock: 100n })];
    expect(activitySeries(list, 100n, 4)).toEqual([2, 1, 0, 1]);
  });

  it('counts every request exactly once, however few blocks there are', () => {
    const list = [req({ requestBlock: 100n }), req({ requestBlock: 100n })];
    expect(activitySeries(list, 100n, 4).reduce((a, b) => a + b, 0)).toBe(2);
  });
});

describe('matchesSearch', () => {
  const r = req({ id: 42n, ...answered(1) });
  it('matches everything on an empty query', () => expect(matchesSearch(r, '  ')).toBe(true));
  it('finds an id with or without the hash sign', () => {
    expect(matchesSearch(r, '42')).toBe(true);
    expect(matchesSearch(r, '#42')).toBe(true);
    expect(matchesSearch(r, '43')).toBe(false);
  });
  it('finds a consumer, a tx hash or a result, ignoring case', () => {
    expect(matchesSearch(r, consumer.toUpperCase().replace('0X', '0x'))).toBe(true);
    expect(matchesSearch(r, '0xABC')).toBe(true);
    expect(matchesSearch(r, '0x0000000000000000000000000000000000000000000000000000000000000007')).toBe(true);
  });
});

describe('blockTape', () => {
  it('ends at the head and marks what happened in each block', () => {
    const list = [req({ requestBlock: 98n, ...answered(1) })]; // answered() lands in block 1002
    list[0].answer!.block = 99n;
    expect(blockTape(list, 100n, 3)).toEqual([
      { block: 98n, requested: 1, answered: 0 },
      { block: 99n, requested: 0, answered: 1 },
      { block: 100n, requested: 0, answered: 0 },
    ]);
  });

  it('is shorter than asked on a young chain', () => {
    expect(blockTape([], 1n, 5).map((b) => b.block)).toEqual([0n, 1n]);
  });
});

describe('seatCells', () => {
  it('draws one cell per seat, with the minimum counted as seats still to fill', () => {
    expect(seatCells(round({ commits: 1, reveals: 0, minParticipants: 3 }))).toEqual({ revealed: 0, committed: 1, empty: 2, hidden: 0 });
    expect(seatCells(round({ commits: 3, reveals: 2, minParticipants: 2 }))).toEqual({ revealed: 2, committed: 1, empty: 0, hidden: 0 });
  });

  it('never draws more than the cap, because anyone can create a round asking for 4 billion participants', () => {
    const cells = seatCells(round({ commits: 0, reveals: 0, minParticipants: 4_294_967_295 }), 32);
    expect(cells.revealed + cells.committed + cells.empty).toBe(32);
    expect(cells.hidden).toBe(4_294_967_295 - 32);
  });

  it('fills the cap with real progress first', () => {
    expect(seatCells(round({ commits: 40, reveals: 35, minParticipants: 2 }), 32)).toEqual({ revealed: 32, committed: 0, empty: 0, hidden: 8 });
  });
});

const ME = '0x00000000000000000000000000000000000000aa' as const;
const entry = (over = {}) => ({ commitment: '0x00' as const, committed: true, revealed: false, claimed: false, ...over });

describe('claimState', () => {
  it('waits while the round is open', () => expect(claimState(round({}), entry())).toBe('open'));
  it('has nothing for someone who never committed', () => expect(claimState(round({ status: 2 }), entry({ committed: false }))).toBe('none'));
  it('pays back whoever revealed', () => expect(claimState(round({ status: 1, reveals: 2 }), entry({ revealed: true }))).toBe('claimable'));
  it('forfeits the bond of a withholder once the round reached its minimum', () => {
    expect(claimState(round({ status: 2, commits: 2, reveals: 1 }), entry())).toBe('forfeited');
  });
  it('refunds a non-revealer when the round missed its minimum', () => {
    expect(claimState(round({ status: 2, commits: 1, minParticipants: 2 }), entry())).toBe('claimable');
  });
  it('remembers a finished claim', () => expect(claimState(round({ status: 1 }), entry({ revealed: true, claimed: true }))).toBe('claimed'));
});

describe('beaconActions', () => {
  it('offers commit only before the deadline, and only once', () => {
    expect(beaconActions(round({}), entry({ committed: false }), 100).commit).toBe(true);
    expect(beaconActions(round({}), entry({ committed: false }), 101).commit).toBe(false);
    expect(beaconActions(round({}), entry(), 100).commit).toBe(false);
  });
  it('offers reveal only inside its window, to someone who committed and has not revealed', () => {
    expect(beaconActions(round({}), entry(), 101).reveal).toBe(true);
    expect(beaconActions(round({}), entry(), 100).reveal).toBe(false);
    expect(beaconActions(round({}), entry(), 201).reveal).toBe(false);
    expect(beaconActions(round({}), entry({ revealed: true }), 101).reveal).toBe(false);
    expect(beaconActions(round({}), entry({ committed: false }), 101).reveal).toBe(false);
  });
  it('offers finalize to anyone once the round allows it', () => {
    expect(beaconActions(round({}), null, 201).finalize).toBe(true);
    expect(beaconActions(round({}), null, 150).finalize).toBe(false);
    expect(beaconActions(round({ status: 1 }), null, 300).finalize).toBe(false);
  });
});

describe('rollActions', () => {
  const roll = (over: Partial<OracleRequest>) => req({ player: ME, ...over });
  it('offers settle only for an answered roll with no result, the failed-callback case', () => {
    expect(rollActions(roll({ ...answered(1) }), 1000n).settle).toBe(true);
    expect(rollActions(roll({ ...answered(1), face: 3 }), 1000n).settle).toBe(false);
    expect(rollActions(roll({}), 1000n).settle).toBe(false);
  });
  it('offers refund once the request can no longer be answered, and only once', () => {
    expect(rollActions(roll({}), 1000n).refund).toBe(false);
    expect(rollActions(roll({}), 1256n).refund).toBe(true);
    expect(rollActions(roll({ status: 3 }), 1300n).refund).toBe(true);
    expect(rollActions(roll({ status: 3, refunded: true }), 1300n).refund).toBe(false);
  });
});

describe('consumerStats', () => {
  it('counts only requests from that contract, whatever the address case', () => {
    const other = '0x0000000000000000000000000000000000000002' as const;
    const list = [req({ ...answered(2) }), req({ ...answered(4, false) }), req({ status: 3 }), req({ requestBlock: 999n }), req({ consumer: other })];
    expect(consumerStats(list, 1000n, consumer.toUpperCase().replace('0X', '0x') as typeof consumer)).toEqual({
      total: 4, answered: 2, open: 1, expired: 1, callbackFailures: 1, medianLatencySec: 3,
    });
  });
});

describe('reconcile', () => {
  it('balances when the contract holds exactly what it owes', () => {
    expect(reconcile({ balance: 100n, earned: 50n, refunds: 20n, pending: 3, fee: 10n })).toEqual({ owed: 100n, surplus: 0n, ok: true });
  });
  it('tolerates a surplus, since anyone can force ether into a contract', () => {
    expect(reconcile({ balance: 105n, earned: 50n, refunds: 20n, pending: 3, fee: 10n })).toMatchObject({ surplus: 5n, ok: true });
  });
  it('flags a shortfall', () => {
    expect(reconcile({ balance: 99n, earned: 50n, refunds: 20n, pending: 3, fee: 10n })).toMatchObject({ surplus: -1n, ok: false });
  });
});

describe('adminAlerts', () => {
  const base = { health: { level: 'good', code: 'ok', count: 0 } as const, fee: 100n, avgCost: 50n, walletBalance: 10_000n, callbackFailures: 0, reconcileOk: true as boolean | null };
  const codes = (over = {}) => adminAlerts({ ...base, ...over }).map((a) => a.code);
  it('is quiet when all is well', () => expect(codes()).toEqual([]));
  it('warns when an answer costs more than the fee earns', () => expect(codes({ avgCost: 101n })).toEqual(['fee-below-cost']));
  it('warns when the node wallet can pay for few answers, and more loudly when it cannot pay for one', () => {
    expect(adminAlerts({ ...base, walletBalance: 450n })[0]).toMatchObject({ code: 'gas-low', level: 'warning' });
    expect(adminAlerts({ ...base, walletBalance: 49n })[0]).toMatchObject({ code: 'gas-out', level: 'critical' });
  });
  it('stays silent on gas before any answer gives a cost to compare with', () => {
    expect(codes({ avgCost: null, walletBalance: 0n })).toEqual([]);
  });
  it('passes on node health, a shortfall and failed callbacks', () => {
    expect(codes({ health: { level: 'critical', code: 'expiring', count: 2 } })).toEqual(['node-expiring']);
    expect(codes({ reconcileOk: false })).toEqual(['shortfall']);
    expect(codes({ callbackFailures: 2 })).toEqual(['callback-failures']);
  });
  it('does not call an unknown reconciliation a shortfall', () => expect(codes({ reconcileOk: null })).toEqual([]));
  it('lists the worst first', () => {
    expect(adminAlerts({ ...base, callbackFailures: 1, reconcileOk: false }).map((a) => a.level)).toEqual(['critical', 'warning']);
  });
});

describe('parseRoundForm', () => {
  const good = { commitMinutes: '10', revealMinutes: '5', bond: '0.1', minParticipants: '2' };
  it('turns the form into contract arguments', () => {
    expect(parseRoundForm(good)).toEqual({ ok: true, args: [600n, 300n, 100000000000000000n, 2] });
  });
  it.each([
    [{ commitMinutes: '0' }, 'commit'],
    [{ revealMinutes: '-1' }, 'reveal'],
    [{ commitMinutes: 'abc' }, 'commit'],
    [{ bond: '0' }, 'bond'],
    [{ bond: 'x' }, 'bond'],
    [{ minParticipants: '1' }, 'minParticipants'],
    [{ minParticipants: '1.5' }, 'minParticipants'],
    [{ minParticipants: '4294967296' }, 'minParticipants'],
  ])('rejects %j', (over, field) => {
    expect(parseRoundForm({ ...good, ...over })).toEqual({ ok: false, field });
  });
});
