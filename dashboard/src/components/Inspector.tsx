import { useState } from 'react';
import type { Address, PublicClient } from 'viem';
import { EXPIRY_BLOCKS, requestState, type OracleRequest } from '../derive';
import { errorText, explorerTx, latency, number, uintHex, plural } from '../format';
import type { Verification } from '../verify';
import { Chip, Fingerprint, HexValue, Sheet } from './common';
import { requestChip } from './RequestsTable';

function Steps({ r, head }: { r: OracleRequest; head: bigint }) {
  const { state, blocksLeft } = requestState(r, head);
  const a = r.answer;
  const steps: { done: boolean; failed?: boolean; title: string; detail: string }[] = [
    { done: true, title: 'Request sent', detail: `Block ${number(Number(r.requestBlock))}. The message is tied to this block’s hash, which nobody knew when it was sent.` },
    {
      done: Boolean(a) || r.status === 2,
      failed: state === 'overdue' || state === 'expired',
      title: 'Node signs with BLS',
      detail: a ? `Each message has exactly one valid signature, so the operator has no other result to pick.`
        : state === 'pending' ? `Waiting, ${plural(blocksLeft, 'block')} left.` : 'The node did not answer within 256 blocks.',
    },
    { done: Boolean(a), title: 'Contract checks the signature', detail: a ? `Valid pairing at block ${number(Number(a.block))}, after ${latency(a.latencySec)}.` : 'Not yet.' },
    {
      done: Boolean(a),
      failed: a ? !a.callbackOk : false,
      title: 'Callback to the caller',
      detail: a ? (a.callbackOk ? 'The caller contract received the result.' : 'The callback failed. The result is still stored on the oracle and the caller can read it.') : 'Not yet.',
    },
  ];
  return (
    <ol className="steps">
      {steps.map((s) => (
        <li key={s.title} className={s.failed ? 'is-failed' : s.done ? 'is-done' : ''}>
          <b>{s.title}</b>
          <span>{s.detail}</span>
        </li>
      ))}
    </ol>
  );
}

function Verify({ client, chainId, oracle, request }: { client: PublicClient; chainId?: number; oracle: Address; request: OracleRequest }) {
  const [state, setState] = useState<{ busy?: boolean; result?: Verification; error?: string }>({});
  const run = async () => {
    setState({ busy: true });
    try {
      // Loaded only when asked for: the pairing code is most of the page's weight.
      const { verifyAnswer } = await import('../verify');
      // Let "computing" paint first. The pairing holds the main thread for a moment.
      await new Promise((resolve) => setTimeout(resolve, 30));
      setState({ result: await verifyAnswer(client, chainId!, oracle, request) });
    } catch (e) {
      setState({ error: errorText(e) });
    }
  };
  const { result } = state;
  return (
    <section className="verify" aria-live="polite">
      <h3>Check it yourself</h3>
      <p>Your browser redoes the contract’s check, so you don’t have to trust the operator. The inputs come from the connected RPC.</p>
      <button type="button" className="button" disabled={state.busy || chainId === undefined} onClick={run}>
        {state.busy ? 'COMPUTING PAIRING…' : result ? 'CHECK AGAIN' : 'CHECK BLS SIGNATURE'}
      </button>
      {state.error && <p className="verify-error">{state.error}</p>}
      {result?.kind === 'unreadable' && (
        <p className="verify-note">Cannot read the signature: this answer was not sent straight to the oracle, so the signature is not in the calldata. The contract still checked it.</p>
      )}
      {result?.kind === 'checked' && (
        <ul className="checks">
          <li><Chip tone="ok">COMPUTED</Chip><span>Message from chain ID, oracle, ID, caller and block hash</span><HexValue value={result.message} label="message" /></li>
          <li><Chip tone={result.signatureOk ? 'ok' : 'bad'}>{result.signatureOk ? 'VALID' : 'INVALID'}</Chip><span>The signature matches the oracle’s public key (BN254 pairing)</span><HexValue value={`0x${result.signature[0].toString(16)}`} label="signature, x coordinate" /></li>
          <li><Chip tone={result.randomnessOk ? 'ok' : 'bad'}>{result.randomnessOk ? 'MATCH' : 'MISMATCH'}</Chip><span>keccak256 of the signature equals the published random number</span></li>
          <li className="checks-time">Done in {number(Math.round(result.ms))} ms on this device</li>
        </ul>
      )}
    </section>
  );
}

interface Props {
  request: OracleRequest;
  head: bigint;
  client: PublicClient;
  oracle: Address;
  chainId?: number;
  onClose(): void;
}

export function Inspector({ request: r, head, client, oracle, chainId, onClose }: Props) {
  const [tone, text] = requestChip(r, head);
  const used = r.answer ? r.answer.latencyBlocks : Math.min(Number(head - r.requestBlock), 256);
  const link = r.answer && chainId !== undefined ? explorerTx(chainId, r.answer.txHash) : undefined;

  return (
    <Sheet title={`Request #${r.id}`} chip={<Chip tone={tone}>{text}</Chip>} onClose={onClose}>
        {r.answer ? (
          <div className="inspector-value">
            {r.face !== undefined && <span className="die" aria-label={`Face ${r.face}`}>{r.face}</span>}
            <Fingerprint value={r.answer.randomness} className="fp-large" />
            <HexValue value={uintHex(r.answer.randomness)} label="random number" full />
          </div>
        ) : <p className="muted">This request has no result yet.</p>}

        <Steps r={r} head={head} />

        <div className="window">
          <p><span>Answer window</span><b>{number(used)} / {EXPIRY_BLOCKS.toString()} blocks</b></p>
          <div className="window-bar" aria-hidden="true"><i style={{ width: `${Math.max((used / 256) * 100, 0.6)}%` }} /></div>
        </div>

        {r.answer && <Verify key={r.id.toString()} client={client} chainId={chainId} oracle={oracle} request={r} />}

        <dl className="facts facts-col">
          <div><dt>Caller contract</dt><dd><HexValue value={r.consumer} label="caller contract address" /></dd></div>
          {r.answer && <div><dt>Callback tx</dt><dd>{link ? <a className="hex" href={link} target="_blank" rel="noreferrer">{r.answer.txHash}</a> : <HexValue value={r.answer.txHash} label="transaction hash" />}</dd></div>}
        </dl>
    </Sheet>
  );
}
