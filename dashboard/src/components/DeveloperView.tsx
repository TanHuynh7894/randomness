import { useState } from 'react';
import { isAddress, type Address } from 'viem';
import { useApp } from '../app-context';
import { consumerStats } from '../derive';
import { amount, latency, number } from '../format';
import { consumerSnippet } from '../snippet';
import { Chip, COPY_TEXT, HexValue, Loading, NotConfigured, useCopy } from './common';

const key = (chainId: number) => `randomness:contracts:${chainId}`;

function load(chainId: number): Address[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key(chainId)) ?? '[]');
    return Array.isArray(stored) ? stored.filter((a): a is Address => typeof a === 'string' && isAddress(a)) : [];
  } catch {
    return [];
  }
}

function Copy({ text, label }: { text: string; label: string }) {
  const { state, copy } = useCopy(text);
  return <button type="button" className="button-quiet" onClick={() => void copy()}>{state !== 'idle' ? COPY_TEXT[state] : label}</button>;
}

export function DeveloperView() {
  const { client, oracle, dice, oracleData: data, chainId, rpcUrl } = useApp();
  const [stored, setStored] = useState<Address[] | null>(null);
  const [input, setInput] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [noCode, setNoCode] = useState<Address[]>([]);

  if (!oracle) return <NotConfigured name="oracle" variable="VITE_ORACLE_ADDRESS" />;
  if (!data || chainId === undefined) return <Loading label="Reading the oracle" />;
  const list = stored ?? load(chainId);

  const save = (next: Address[]) => {
    setStored(next);
    try {
      localStorage.setItem(key(chainId), JSON.stringify(next));
    } catch {
      // Stays for this visit only.
    }
  };
  const add = async () => {
    const value = input.trim();
    if (!isAddress(value)) return setProblem('This is not a valid address.');
    if (list.some((a) => a.toLowerCase() === value.toLowerCase())) return setProblem('This address is already on the list.');
    setProblem(null);
    setInput('');
    save([...list, value]);
    const code = await client.getCode({ address: value }).catch(() => undefined);
    if (!code) setNoCode((c) => [...c, value]);
  };

  const command = `cast send ${dice ?? '<CONTRACT>'} '${dice ? 'roll()' : 'play()'}' --value ${data.fee} --rpc-url ${rpcUrl} --private-key <KEY>`;

  return (
    <>
      <section className="panel">
        <h2>My contracts</h2>
        <p className="muted">This list is kept only in your browser. Numbers cover the requests currently loaded.</p>
        <form className="inline-form" onSubmit={(e) => { e.preventDefault(); void add(); }}>
          <label htmlFor="consumer-address" className="sr-only">Contract address</label>
          <input id="consumer-address" className="search" autoComplete="off" spellCheck={false} value={input} onChange={(e) => setInput(e.target.value)} placeholder="Contract address, 0x…" />
          <button type="submit" className="button">ADD</button>
        </form>
        {problem && <p className="tx-error" role="alert">{problem}</p>}
        {list.length === 0 ? <div className="empty">No contracts yet. Add your contract address to see its numbers.</div> : (
          <div className="table-scroll" tabIndex={0} role="region" aria-label="My contracts">
            <table>
              <thead><tr><th>Contract</th><th className="num">Requests</th><th className="num">Answered</th><th className="num">Waiting</th><th className="num">Expired</th><th className="num">Failed callbacks</th><th className="num">Answer time</th><th /></tr></thead>
              <tbody>
                {list.map((a) => {
                  const s = consumerStats(data.requests, data.head, a);
                  return (
                    <tr key={a} className="no-pick">
                      <td><HexValue value={a} label="contract address" /> {noCode.includes(a) && <Chip tone="warn">NO CODE</Chip>}</td>
                      <td className="num">{number(s.total)}</td>
                      <td className="num">{number(s.answered)}</td>
                      <td className="num">{number(s.open)}</td>
                      <td className="num">{number(s.expired)}</td>
                      <td className="num">{number(s.callbackFailures)}</td>
                      <td className="num">{s.medianLatencySec === null ? '–' : latency(s.medianLatencySec)}</td>
                      <td><button type="button" className="button-quiet" aria-label={`Remove ${a} from the list`} onClick={() => save(list.filter((x) => x !== a))}>REMOVE</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="head head-flush">
          <h2>Add it to your contract</h2>
          <span className="head-end"><Copy text={consumerSnippet(oracle)} label="COPY CODE" /></span>
        </div>
        <p className="muted">This sample already has the oracle address for the connected network. The fee is {amount(data.fee, chainId)} per request.</p>
        <pre className="code" tabIndex={0}><code>{consumerSnippet(oracle)}</code></pre>
      </section>

      <section className="panel">
        <div className="head head-flush">
          <h2>Try it from the command line</h2>
          <span className="head-end"><Copy text={command} label="COPY COMMAND" /></span>
        </div>
        <pre className="code" tabIndex={0}><code>{command}</code></pre>
      </section>
    </>
  );
}
