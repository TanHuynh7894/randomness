import { blockTape, type OracleRequest } from '../derive';
import { number } from '../format';

const WIDTH = 128;

/** The newest blocks scrolling past, so a glance shows the chain moving and when the oracle acted. */
export function BlockTape({ requests, head }: { requests: readonly OracleRequest[]; head: bigint }) {
  const tape = blockTape(requests, head, WIDTH);
  return (
    <div className="tape" role="img" aria-label={`Last ${tape.length} blocks, newest is block ${number(Number(head))}`}>
      <div className="tape-cells">
        {tape.map((b) => (
          <i
            key={b.block.toString()}
            className={b.requested ? 'is-request' : b.answered ? 'is-answer' : ''}
            title={`Block ${b.block}: ${b.requested} requests, ${b.answered} answers`}
          />
        ))}
      </div>
      <p className="tape-key" aria-hidden="true">
        <span><i className="is-request" />Request</span>
        <span><i className="is-answer" />Answer</span>
      </p>
    </div>
  );
}
