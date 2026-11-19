import { useState } from 'react';
import { requestState, type OracleRequest } from '../derive';
import { duration, explorerTx, latency, number, shortHex, uintHex, plural } from '../format';
import { Chip, Fingerprint, HexValue, type Tone } from './common';

const PAGE = 15;

export function requestChip(r: OracleRequest, head: bigint): [Tone, string] {
  const { state, blocksLeft } = requestState(r, head);
  if (state === 'pending') return [blocksLeft <= 32 ? 'warn' : 'wait', 'WAITING'];
  if (state === 'overdue') return ['warn', 'OVERDUE'];
  if (state === 'expired') return ['bad', 'EXPIRED, CLOSED'];
  return r.answer && !r.answer.callbackOk ? ['warn', 'CALLBACK FAILED'] : ['ok', 'ANSWERED'];
}

/** One line under the chip, saying what the state means for the caller. */
export function requestNote(r: OracleRequest, head: bigint): string {
  const { state, blocksLeft } = requestState(r, head);
  if (state === 'pending') return `${plural(blocksLeft, 'block')} left to answer`;
  if (state === 'overdue') return 'past 256 blocks, waiting for refund';
  if (state === 'expired') return 'fee refunded';
  return r.answer && !r.answer.callbackOk ? 'result stored, can be fetched' : '';
}

interface Props {
  requests: OracleRequest[];
  head: bigint;
  nowSec: number;
  chainId?: number;
  showFace: boolean;
  showConsumer: boolean;
  onPick(id: bigint): void;
}

export function RequestsTable({ requests, head, nowSec, chainId, showFace, showConsumer, onPick }: Props) {
  const [shown, setShown] = useState(PAGE);
  const page = requests.slice(0, shown);
  const chip = (r: OracleRequest) => {
    const [tone, text] = requestChip(r, head);
    const note = requestNote(r, head);
    return <span className="status"><Chip tone={tone}>{text}</Chip>{note && <small>{note}</small>}</span>;
  };

  return (
    <>
      <div className="table-scroll desktop-only" tabIndex={0} role="region" aria-label="Requests">
        <table>
          <thead>
            <tr>
              <th className="num">ID</th>
              <th>Status</th>
              <th>Random number</th>
              {showFace && <th className="num">Die face</th>}
              {showConsumer && <th>Caller contract</th>}
              <th className="num">Answered in</th>
              <th>Sent</th>
              <th>Answer tx</th>
            </tr>
          </thead>
          <tbody>
            {page.map((r) => {
              const link = r.answer && chainId !== undefined ? explorerTx(chainId, r.answer.txHash) : undefined;
              return (
                <tr key={r.id.toString()} onClick={() => onPick(r.id)}>
                  <td className="num"><button type="button" className="row-open" aria-label={`Open request ${r.id}`} onClick={(e) => { e.stopPropagation(); onPick(r.id); }}>{r.id.toString()}</button></td>
                  <td>{chip(r)}</td>
                  <td>{r.answer ? <span className="outcome"><Fingerprint value={r.answer.randomness} /><HexValue value={uintHex(r.answer.randomness)} label="random number" /></span> : <span className="muted">none yet</span>}</td>
                  {showFace && <td className="num">{r.face ?? '–'}</td>}
                  {showConsumer && <td><HexValue value={r.consumer} label="caller contract address" /></td>}
                  <td className="num">{r.answer ? `${latency(r.answer.latencySec)} · ${plural(r.answer.latencyBlocks, 'block')}` : '–'}</td>
                  <td>{duration(nowSec - r.requestTime)} ago</td>
                  <td>
                    {r.answer ? (
                      link ? <a className="hex" href={link} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{shortHex(r.answer.txHash)}</a>
                        : <HexValue value={r.answer.txHash} label="transaction hash" />
                    ) : '–'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <ul className="cards mobile-only">
        {page.map((r) => (
          <li key={r.id.toString()}>
            <button type="button" className="card" onClick={() => onPick(r.id)}>
              <span className="card-title">#{r.id.toString()}{r.face ? ` · face ${r.face}` : ''}</span>
              {chip(r)}
              {r.answer && <Fingerprint value={r.answer.randomness} />}
              <span className="card-hex">{r.answer ? shortHex(uintHex(r.answer.randomness)) : 'No result yet'}</span>
              <span className="card-meta">{r.answer ? `${latency(r.answer.latencySec)} · ` : ''}{duration(nowSec - r.requestTime)} ago</span>
            </button>
          </li>
        ))}
      </ul>

      {requests.length > shown && (
        <button type="button" className="button-quiet" onClick={() => setShown((n) => n + PAGE)}>
          SHOW MORE ({number(requests.length - shown)})
        </button>
      )}
    </>
  );
}
