import { useState } from 'react';
import { useApp } from '../app-context';
import { beaconPhase, lockedBond, seatCells, type BeaconPhase, type BeaconRound } from '../derive';
import { amount, duration, number, uintHex } from '../format';
import { Chip, Fingerprint, HexValue, Kpi, Loading, NotConfigured, StaleBand } from './common';
import { CreateRound } from './CreateRound';
import { Intro, Term } from './guide';
import { BEACON_PHASE as PHASE, RoundPanel } from './RoundPanel';

/** One square per participant: outlined for a commit, filled once they revealed. Empty ones are still needed. */
function Seats({ r }: { r: BeaconRound }) {
  const { revealed, committed, empty, hidden } = seatCells(r);
  const cell = (count: number, className: string) => Array.from({ length: count }, (_, i) => <i key={`${className}${i}`} className={className} />);
  return (
    <span className="seats" role="img" aria-label={`${number(r.commits)} joined, ${number(r.reveals)} revealed, at least ${number(r.minParticipants)} needed`}>
      {cell(revealed, 'is-revealed')}{cell(committed, 'is-committed')}{cell(empty, '')}
      {hidden > 0 && <small>+{number(hidden)}</small>}
    </span>
  );
}

/** The tick is the end of commit, the marker the chain time. The contract keeps no start time, so the commit side is drawn as long as the reveal side. */
function Timeline({ r, now, phase }: { r: BeaconRound; now: number; phase: BeaconPhase }) {
  if (phase === 'finalized' || phase === 'failed') return <span className="muted">Closed</span>;
  const start = r.commitEnd - Math.max(r.revealEnd - r.commitEnd, 1);
  const span = r.revealEnd - start;
  const split = ((r.commitEnd - start) / span) * 100;
  const left = Math.min(100, Math.max(0, ((now - start) / span) * 100));
  const until = phase === 'commit' ? r.commitEnd : r.revealEnd;
  return (
    <span className="timeline">
      <span className="timeline-bar" aria-hidden="true"><i style={{ left: `${split}%` }} className="timeline-split" /><i style={{ left: `${left}%` }} className="timeline-now" /></span>
      <span>{nextStep(r, phase, now, until)}</span>
    </span>
  );
}

/** What happens next in the round, as a sentence anyone can act on. */
function nextStep(r: BeaconRound, phase: BeaconPhase, now: number, until: number): string {
  if (phase === 'commit') return `${duration(until - now)} left to join`;
  if (phase === 'reveal') return `${duration(until - now)} left to reveal`;
  return r.reveals === r.commits && now <= r.revealEnd ? 'Everyone revealed, ready to finalize' : 'Time is up, ready to finalize';
}

function Outcome({ r, phase, chainId }: { r: BeaconRound; phase: BeaconPhase; chainId?: number }) {
  if (phase === 'finalized') return <span className="outcome"><Fingerprint value={r.randomness} /><HexValue value={uintHex(r.randomness)} label="random number" /></span>;
  if (phase !== 'failed') return <>–</>;
  const locked = lockedBond(r);
  return <>{locked > 0n ? `Someone did not reveal, ${amount(locked, chainId)} deposit lost` : 'Not enough people, deposits refunded'}</>;
}

export function BeaconSection() {
  const { beacon, chainId, nowSec, beaconData: data, beaconError: error, signer, openLogin } = useApp();
  const [picked, setPicked] = useState<bigint | null>(null);
  const [creating, setCreating] = useState(false);

  if (!beacon) return <NotConfigured name="beacon" variable="VITE_BEACON_ADDRESS" />;
  if (!data) return error ? <StaleBand error={error} hasData={false} /> : <Loading label="Reading the beacon" />;
  const now = Math.max(nowSec, data.headTime);
  const phases = data.rounds.map((r) => beaconPhase(r, now));
  const count = (...names: BeaconPhase[]) => phases.filter((p) => names.includes(p)).length;
  const locked = data.rounds.reduce((sum, r) => sum + lockedBond(r), 0n);
  const pickedRound = data.rounds.find((r) => r.id === picked);

  return (
    <>
      <StaleBand error={error} hasData />
      <Intro
        id="beacon"
        title="A group draw, no node needed"
        lead={<>Everyone adds a secret number. The result mixes all of them, so as long as one person keeps their secret, nobody can predict it. Anyone who does not reveal on time loses their <Term k="bond">deposit</Term>.</>}
        steps={[
          { title: 'Join', text: <>The page makes a secret number and sends only its fingerprint, with a deposit (<Term k="commit">commit</Term>).</> },
          { title: 'Reveal', text: <>When joining closes, everyone publishes their number (<Term k="reveal">reveal</Term>).</> },
          { title: 'Finalize', text: <>Anyone can press it (<Term k="finalize">finalize</Term>). With enough people and every number revealed, there is a result.</> },
          { title: 'Get your deposit back', text: 'Everyone who revealed gets the full deposit back. If the round is short of people, everyone is refunded.' },
        ]}
      >
        <button type="button" className="button" onClick={signer ? () => setCreating(true) : openLogin}>{signer ? 'NEW ROUND' : 'SIGN IN TO CREATE A ROUND'}</button>
        <span className="muted">Or open a round below that is still taking people.</span>
      </Intro>

      <dl className="kpis">
        <Kpi label="Rounds" value={number(data.total)} />
        <Kpi label="In progress" value={number(count('commit', 'reveal', 'finalizable'))} />
        <Kpi label="With a result" value={number(count('finalized'))} />
        <Kpi label="Failed" value={number(count('failed'))} />
        <Kpi label="Deposits lost" value={amount(locked, chainId)} note="From people who did not reveal" />
      </dl>
      {data.total > data.rounds.length && <p className="muted">Numbers cover the latest {number(data.rounds.length)} rounds, except the round count.</p>}

      <div className="head">
        <h2>Rounds</h2>
        <p className="head-note legend"><span><i className="is-committed" />joined</span><span><i className="is-revealed" />revealed</span><span><i />seat still open</span></p>
      </div>
      {data.rounds.length === 0 ? (
        <div className="empty">No rounds yet. Press NEW ROUND above to start one.</div>
      ) : (
        <div className="table-scroll" tabIndex={0} role="region" aria-label="Rounds">
          <table>
            <thead><tr><th className="num">Round</th><th>Status</th><th>Next step</th><th>Participants</th><th className="num">Deposit each</th><th>Result</th></tr></thead>
            <tbody>
              {data.rounds.map((r, i) => (
                <tr key={r.id.toString()} onClick={() => setPicked(r.id)}>
                  <td className="num"><button type="button" className="row-open" aria-label={`Open round ${r.id}`} onClick={(e) => { e.stopPropagation(); setPicked(r.id); }}>{r.id.toString()}</button></td>
                  <td><Chip tone={PHASE[phases[i]][0]}>{PHASE[phases[i]][1]}</Chip></td>
                  <td><Timeline r={r} now={now} phase={phases[i]} /></td>
                  <td><Seats r={r} /> <span className="seats-text">{number(r.reveals)} revealed / {number(r.commits)} joined · need {number(r.minParticipants)}</span></td>
                  <td className="num">{amount(r.bond, chainId)}</td>
                  <td><Outcome r={r} phase={phases[i]} chainId={chainId} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <dl className="facts"><div><dt>CONTRACT BEACON</dt><dd><HexValue value={beacon} label="beacon address" /></dd></div></dl>
      {pickedRound && <RoundPanel round={pickedRound} onClose={() => setPicked(null)} />}
      {creating && <CreateRound onClose={() => setCreating(false)} />}
    </>
  );
}
