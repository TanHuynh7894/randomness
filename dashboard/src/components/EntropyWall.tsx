import { memo, useState } from 'react';
import { requestState, type OracleRequest } from '../derive';
import { shortHex, uintHex, plural } from '../format';
import { Fingerprint } from './common';

const COLUMNS = 72;

function describe(r: OracleRequest, head: bigint) {
  const { state, blocksLeft } = requestState(r, head);
  if (r.answer) return `#${r.id}${r.face ? ` · face ${r.face}` : ''} · ${shortHex(uintHex(r.answer.randomness))}`;
  if (state === 'pending') return `#${r.id} · waiting, ${plural(blocksLeft, 'block')} left`;
  if (state === 'overdue') return `#${r.id} · overdue`;
  return `#${r.id} · expired, no result`;
}

const Column = memo(function Column({ r, newest, onPick, onHover }: { r: OracleRequest; newest: boolean; onPick(): void; onHover(): void }) {
  const kind = r.answer ? 'is-answered' : r.status === 1 ? 'is-open' : 'is-expired';
  return (
    <button type="button" tabIndex={-1} className={`wall-col ${kind}${newest ? ' is-newest' : ''}`} onClick={onPick} onMouseEnter={onHover}>
      {r.answer && <Fingerprint value={r.answer.randomness} />}
    </button>
  );
});

interface Props {
  /** Newest first. */
  requests: readonly OracleRequest[];
  head: bigint;
  onPick(id: bigint): void;
}

/**
 * Every answer as one column, drawn from its own value. Mouse only: each column is also a row of the table below,
 * and that is where the keyboard and screen readers go.
 */
export function EntropyWall({ requests, head, onPick }: Props) {
  const [hover, setHover] = useState<bigint | null>(null);
  const shown = requests.slice(0, COLUMNS).reverse();
  const newest = requests.find((r) => r.answer)?.id;
  const focus = requests.find((r) => r.id === hover) ?? requests.find((r) => r.answer) ?? requests[0];

  return (
    <figure className="wall">
      <figcaption>
        <h3>Entropy wall</h3>
        <p>Each column is one random number, split into 16 cells; a brighter cell means a larger value. Truly random numbers look like noise, with no stripes or repeated patches. Click a column for details.</p>
        <p className="wall-focus">{focus ? describe(focus, head) : 'No results yet'}</p>
      </figcaption>
      <div className="wall-grid" aria-hidden="true" onMouseLeave={() => setHover(null)}>
        {Array.from({ length: Math.max(0, COLUMNS - shown.length) }, (_, i) => <span key={i} className="wall-col is-empty" />)}
        {shown.map((r) => (
          <Column key={r.id.toString()} r={r} newest={r.id === newest} onPick={() => onPick(r.id)} onHover={() => setHover(r.id)} />
        ))}
      </div>
    </figure>
  );
}
