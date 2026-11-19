import { useCallback, useMemo, useState } from 'react';
import { useApp } from '../app-context';
import { DICE_ABI, ORACLE_ABI, readEntries } from '../chain';
import { beaconPhase, claimState, requestState, rollActions, type BeaconRound } from '../derive';
import { amount, duration, latency, number, uintHex } from '../format';
import { usePoll } from '../hooks';
import { BEACON_PHASE, CLAIM_TEXT, RoundPanel } from './RoundPanel';
import { Chip, HexValue, Kpi, Loading, LoginPrompt, TxButton } from './common';
import { requestChip } from './RequestsTable';

export function AccountView() {
  const { client, oracle, dice, beacon, oracleData, beaconData, chainId, nowSec, signer, session } = useApp();
  const [picked, setPicked] = useState<bigint | null>(null);
  const me = session?.address;

  const rounds = beaconData?.rounds;
  const read = useCallback(async () => {
    const [balance, refund, entries] = await Promise.all([
      client.getBalance({ address: me! }),
      oracle ? client.readContract({ address: oracle, abi: ORACLE_ABI, functionName: 'refunds', args: [me!] }) : 0n,
      beacon && rounds ? readEntries(client, beacon, rounds, me!) : [],
    ]);
    return { balance, refund, entries };
  }, [client, oracle, beacon, rounds, me]);
  const { data, error } = usePoll(me ? read : undefined, 5_000);

  const lower = me?.toLowerCase();
  const mine = useMemo(
    () => (oracleData?.requests ?? []).filter((r) => r.player?.toLowerCase() === lower || r.consumer.toLowerCase() === lower),
    [oracleData, lower],
  );

  if (!me || !signer) return <LoginPrompt>Sign in with your wallet to see your rolls, refunds and Beacon rounds.</LoginPrompt>;
  if (!data) return error ? <div className="empty">Cannot read wallet data: {String(error)}</div> : <Loading label="Reading your account" />;

  const head = oracleData?.head ?? 0n;
  const now = Math.max(nowSec, oracleData?.headTime ?? 0, beaconData?.headTime ?? 0);
  const myRounds = (rounds ?? []).map((r, i) => ({ r, e: data.entries[i] })).filter((x) => x.e?.committed);
  const refundable = mine.filter((r) => r.player?.toLowerCase() === lower && rollActions(r, head).refund).length;
  const pickedRound = rounds?.find((r: BeaconRound) => r.id === picked);

  return (
    <>
      <dl className="kpis kpis-4">
        <Kpi label="Wallet balance" value={amount(data.balance, chainId)} />
        <Kpi label="My requests" value={number(mine.length)} note={refundable ? `${number(refundable)} refundable` : undefined} />
        <Kpi label="Refunds to withdraw" value={amount(data.refund, chainId)} note="Fees returned when your own oracle requests expired" />
        <Kpi label="Beacon rounds joined" value={number(myRounds.length)} />
      </dl>

      {data.refund > 0n && oracle && (
        <div className="head">
          <h2>Refunds waiting</h2>
          <span className="head-end"><TxButton label={`WITHDRAW ${amount(data.refund, chainId)}`} action={() => signer.write({ address: oracle, abi: ORACLE_ABI, functionName: 'withdrawRefund', args: [me, data.refund] })} /></span>
        </div>
      )}

      <section className="panel">
        <h2>My requests</h2>
        {mine.length === 0 ? <div className="empty">This wallet has no requests yet. Go to Oracle to try a roll.</div> : (
          <div className="table-scroll" tabIndex={0} role="region" aria-label="My requests">
            <table>
              <thead><tr><th className="num">ID</th><th>Status</th><th className="num">Die face</th><th>Random number</th><th className="num">Answered in</th><th>Sent</th><th>Action</th></tr></thead>
              <tbody>
                {mine.map((r) => {
                  const [tone, text] = requestChip(r, head);
                  const can = rollActions(r, head);
                  const isRoll = Boolean(r.player && dice);
                  const closed = requestState(r, head).state === 'expired';
                  return (
                    <tr key={r.id.toString()} className="no-pick">
                      <td className="num">{r.id.toString()}</td>
                      <td><Chip tone={tone}>{r.refunded ? 'REFUNDED' : text}</Chip></td>
                      <td className="num">{r.face ?? '–'}</td>
                      <td>{r.answer ? <HexValue value={uintHex(r.answer.randomness)} label="random number" /> : '–'}</td>
                      <td className="num">{r.answer ? latency(r.answer.latencySec) : '–'}</td>
                      <td>{duration(now - r.requestTime)} ago</td>
                      <td>
                        {isRoll && can.settle && <TxButton quiet label="FINISH ROLL" action={() => signer.write({ address: dice!, abi: DICE_ABI, functionName: 'settle', args: [r.id] })} />}
                        {isRoll && can.refund && <TxButton quiet label={closed ? 'GET FEE BACK' : 'CLOSE AND GET FEE BACK'} action={() => signer.write({ address: dice!, abi: DICE_ABI, functionName: 'refund', args: [r.id] })} />}
                        {!(isRoll && (can.settle || can.refund)) && <span className="muted">–</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {beacon && (
        <section className="panel">
          <h2>My Beacon rounds</h2>
          {myRounds.length === 0 ? <div className="empty">This wallet has not joined any round. Go to Beacon to join one.</div> : (
            <div className="table-scroll" tabIndex={0} role="region" aria-label="My Beacon rounds">
              <table>
                <thead><tr><th className="num">Round</th><th>Status</th><th>You</th><th>Deposit</th><th>Details</th></tr></thead>
                <tbody>
                  {myRounds.map(({ r, e }) => {
                    const [tone, text] = BEACON_PHASE[beaconPhase(r, now)];
                    return (
                      <tr key={r.id.toString()} className="no-pick">
                        <td className="num">{r.id.toString()}</td>
                        <td><Chip tone={tone}>{text}</Chip></td>
                        <td>{e.revealed ? 'Revealed' : 'Joined, not revealed'}</td>
                        <td>{CLAIM_TEXT[claimState(r, e)]}</td>
                        <td><button type="button" className="button-quiet" onClick={() => setPicked(r.id)}>OPEN ROUND {r.id.toString()}</button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
      {pickedRound && <RoundPanel round={pickedRound} onClose={() => setPicked(null)} />}
    </>
  );
}
