import { useEffect, useRef, useState } from 'react';
import { useApp } from '../app-context';
import { diceCounts, filterRequests, matchesSearch, oracleHealth, summarize, type Health, type OracleRequest, type RequestFilter } from '../derive';
import { amount, duration, explorerAddress, latency, number, shortHex, uintHex, plural } from '../format';
import { BlockTape } from './BlockTape';
import { ColumnChart, type Column } from './charts';
import { Band, Fingerprint, HexValue, Kpi, Loading, NotConfigured, StaleBand } from './common';
import { Intro, Term } from './guide';
import { EntropyWall } from './EntropyWall';
import { Inspector } from './Inspector';
import { RequestsTable } from './RequestsTable';
import { RollButton } from './RollButton';

const LATENCY_COLUMNS = 30;
/** Below this, a lopsided histogram says nothing about the randomness. */
const SMALL_SAMPLE = 60;
export const LIMIT = 200;

const HEALTH_TEXT: Record<Health['code'], (n: number) => [string, string]> = {
  idle: () => ['No requests yet', ''],
  ok: () => ['Every request has been handled', ''],
  waiting: (n) => [`${plural(n, 'request')} waiting for the node`, ''],
  slow: (n) => [`${plural(n, 'request')} waiting unusually long`, 'Check that the node is running and its wallet can still pay for gas.'],
  overdue: (n) => [`${plural(n, 'request')} past 256 blocks`, 'They can no longer be answered. Anyone can call expire() to close them and refund the caller.'],
  expiring: (n) => [`${plural(n, 'request')} about to expire`, 'Fewer than 32 blocks left to answer. If the node has stopped, restart it now.'],
};

const FILTERS: [RequestFilter, string][] = [['all', 'All'], ['open', 'Waiting'], ['fulfilled', 'Answered'], ['expired', 'Expired']];

/** The newest answer, large: what a visitor came to see, and the way into checking it. */
function Latest({ request: r, now, onOpen }: { request: OracleRequest; now: number; onOpen(): void }) {
  const a = r.answer!;
  return (
    <div className="latest">
      {r.face ? <span className="die" aria-label={`Face ${r.face}`}>{r.face}</span> : <Fingerprint value={a.randomness} className="fp-large" />}
      <div className="latest-body">
        <p className="latest-label">Latest result · request #{r.id.toString()}</p>
        <p className="latest-hex" title={uintHex(a.randomness)}>{shortHex(uintHex(a.randomness))}</p>
        <p className="muted">{r.face ? `The die shows ${r.face}. ` : ''}Answered in {latency(a.latencySec)}, {duration(now - r.requestTime - a.latencySec)} ago.</p>
      </div>
      <button type="button" className="button-quiet latest-open" onClick={onOpen}>VIEW AND VERIFY</button>
    </div>
  );
}

export function OracleSection() {
  const { client, oracle, dice, chainId, nowSec, oracleData: data, oracleError: error } = useApp();
  const [filter, setFilter] = useState<RequestFilter>('all');
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<bigint | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement).matches?.('input, textarea');
      if (e.key === '/' && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  if (!oracle) return <NotConfigured name="oracle" variable="VITE_ORACLE_ADDRESS" />;
  if (!data) return error ? <StaleBand error={error} hasData={false} /> : <Loading label="Reading the oracle" />;

  const now = Math.max(nowSec, data.headTime);
  const s = summarize(data.requests, data.head);
  const health = oracleHealth(data.requests, data.head, now);
  const [title, detail] = HEALTH_TEXT[health.code](health.count);
  const explorer = chainId !== undefined ? explorerAddress(chainId, oracle) : undefined;
  const count: Record<RequestFilter, number> = { all: data.requests.length, open: s.pending + s.overdue, fulfilled: s.fulfilled, expired: s.expired };
  const visible = filterRequests(data.requests, data.head, filter).filter((r) => matchesSearch(r, search));
  const pickedRequest = data.requests.find((r) => r.id === picked);

  const answered = data.requests.filter((r) => r.answer).slice(0, LATENCY_COLUMNS).reverse();
  const latencies = answered.map((r) => r.answer!.latencySec);
  const latencyColumns: Column[] = answered.map((r) => ({
    key: r.id.toString(),
    label: `#${r.id}`,
    value: r.answer!.latencySec,
    tip: <><strong>Request #{r.id.toString()}</strong><br />{latency(r.answer!.latencySec)} · {plural(r.answer!.latencyBlocks, 'block')}</>,
  }));
  const counts = data.dice ? diceCounts(data.dice) : [];
  const rolls = data.dice?.length ?? 0;
  const diceColumns: Column[] = counts.map((n, i) => ({
    key: String(i + 1),
    label: String(i + 1),
    value: n,
    tip: <><strong>Face {i + 1}</strong><br />{number(n)} times · {rolls ? Math.round((n / rolls) * 100) : 0}%</>,
  }));

  const latest = data.requests.find((r) => r.answer);

  return (
    <>
      <StaleBand error={error} hasData />
      <Intro
        id="oracle"
        title="Random numbers on request"
        lead={<>Your contract pays a fee and asks for a random number. The <Term k="oracle">oracle</Term> returns it with a signature, and the contract checks the signature before using it. Nobody, not even the node operator, can pick the result.</>}
        steps={[
          { title: 'Send a request', text: <>Your contract calls the oracle with a {amount(data.fee, chainId)} fee.</> },
          { title: 'The node signs', text: <>The node signs the request with its <Term k="bls">BLS</Term> key, usually within 1–2 <Term k="block">blocks</Term>.</> },
          { title: 'The contract checks it', text: 'A wrong signature is rejected. The random number is derived from the signature itself.' },
          { title: 'Delivery', text: <>The oracle <Term k="callback">calls back</Term> your contract with the number.</> },
        ]}
      >
        {dice && <RollButton dice={dice} fee={data.fee} />}
        {dice && <span className="muted">Try it now with the sample dice contract.</span>}
      </Intro>

      {/* Health is a claim about now. Old data can't back it, and the stale band is already on screen. */}
      {!error && health.level !== 'good' && <Band tone={health.level === 'critical' ? 'bad' : 'warn'} title={title}>{detail}</Band>}

      {latest && <Latest request={latest} now={now} onOpen={() => setPicked(latest.id)} />}

      <dl className="kpis kpis-4">
        <Kpi label="Answered" value={s.answeredShare === null ? '–' : `${Math.round(s.answeredShare * 100)}%`} note={`${number(s.fulfilled)} answered · ${number(s.expired + s.overdue)} missed`} />
        <Kpi label="Answer time" value={s.medianLatencySec === null ? '–' : latency(s.medianLatencySec)} note="Median" spark={latencies} />
        <Kpi label="Waiting for an answer" value={number(s.pending)} note={s.callbackFailures ? `${plural(s.callbackFailures, 'failed callback')}` : !error && health.level === 'good' ? <span className="ok-dot">{title}</span> : undefined} />
        <Kpi label="Fee per request" value={amount(data.fee, chainId)} note={`${plural(data.total, 'request')} so far`} />
      </dl>

      <div className="head">
        <h2>Request history</h2>
        <input ref={searchRef} className="search" type="search" id="request-search" value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="Search ID, address, tx (/)" aria-label="Search by request ID, address, transaction hash or random number" />
        <div className="seg" role="group" aria-label="Filter by status">
          {FILTERS.map(([key, label]) => (
            <button key={key} type="button" className={filter === key ? 'is-on' : ''} aria-pressed={filter === key} onClick={() => setFilter(key)}>
              {label} <small>{number(count[key])}</small>
            </button>
          ))}
        </div>
      </div>
      <p className="head-note">Click a row to see each step and check the signature yourself. A request must be answered within <Term k="window">256 blocks</Term>.</p>
      {data.total > LIMIT && <p className="muted">The table and numbers cover the latest {number(LIMIT)} requests.</p>}

      {visible.length > 0 ? (
        <RequestsTable requests={visible} head={data.head} nowSec={now} chainId={chainId} showFace={Boolean(dice)}
          showConsumer={!dice || data.requests.some((r) => r.consumer.toLowerCase() !== dice.toLowerCase())} onPick={setPicked} />
      ) : (
        <div className="empty">{data.requests.length === 0 ? <>No requests yet. Try a roll, or call <code>requestRandomness()</code> from your contract.</> : 'No requests match this filter.'}</div>
      )}

      <div className="head">
        <h2>Statistics</h2>
        <p className="head-note">To check by eye that the results have no pattern.</p>
      </div>
      {data.requests.some((r) => r.answer) && <EntropyWall requests={data.requests} head={data.head} onPick={setPicked} />}

      <div className="charts">
        <figure>
          <figcaption><h3>Answer time</h3><p>Seconds, latest {number(answered.length)} answers. Lower is faster.</p></figcaption>
          {answered.length === 0 ? <div className="empty">No answers yet.</div> : (
            <ColumnChart description={`Answer time of the latest ${answered.length} requests, median ${latency(s.medianLatencySec ?? 0)}. Details are in the request table.`} columns={latencyColumns} labelEvery={Math.ceil(answered.length / 6)} />
          )}
        </figure>
        {data.dice && (
          <figure>
            <figcaption>
              <h3>Dice distribution</h3>
              <p>{plural(rolls, 'roll')}. Red line: {number(Math.round((rolls / 6) * 10) / 10)} per face if spread evenly.{rolls < SMALL_SAMPLE && ' The sample is still small, so big gaps are normal.'}</p>
            </figcaption>
            {rolls === 0 ? <div className="empty">No rolls yet.</div> : (
              <ColumnChart description={`Times each face came up: ${counts.map((n, i) => `face ${i + 1}: ${n}`).join(', ')}.`} columns={diceColumns} labelAll reference={rolls / 6} />
            )}
          </figure>
        )}
      </div>

      <figure className="tape-figure">
        <figcaption><h3>Activity by block</h3><p>Each cell is one <Term k="block">block</Term>, newest on the right.</p></figcaption>
        <BlockTape requests={data.requests} head={data.head} />
      </figure>

      <dl className="facts">
        <div><dt>CONTRACT ORACLE</dt><dd>{explorer ? <a className="hex" href={explorer} target="_blank" rel="noreferrer">{oracle}</a> : <HexValue value={oracle} label="oracle address" />}</dd></div>
        <div><dt><Term k="operator">OPERATOR</Term></dt><dd><HexValue value={data.operator} label="operator address" /></dd></div>
        <div><dt>LATEST BLOCK</dt><dd>{duration(now - data.headTime)} ago</dd></div>
      </dl>

      {pickedRequest && <Inspector key={pickedRequest.id.toString()} request={pickedRequest} head={data.head} client={client} oracle={oracle} chainId={chainId} onClose={() => setPicked(null)} />}
    </>
  );
}
