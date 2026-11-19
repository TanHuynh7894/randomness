import { useId, useState, type ReactNode } from 'react';

/** Plain-language meanings for the words a visitor cannot be expected to know. */
export const GLOSSARY = {
  block: 'One page of the chain’s ledger. The local chain makes a block every second; real networks take a few seconds.',
  oracle: 'A service that brings outside data into contracts. Here it is a random number, with proof the contract checks itself.',
  bls: 'A kind of digital signature. Each message has exactly one valid signature, so the node cannot retry to pick a result.',
  callback: 'The oracle calls your contract back to deliver the number. If that call fails, the number is still stored to fetch later.',
  window: 'The node must answer within 256 blocks. After that it cannot answer, and the fee is refunded.',
  commit: 'Join: submit a locked secret number (only its fingerprint) together with a deposit.',
  reveal: 'Reveal: publish the secret you submitted. The contract checks it matches the fingerprint from when you joined.',
  finalize: 'Finalize: compute the result from the revealed numbers. Anyone can do it, not only participants.',
  bond: 'Deposit. Reveal on time and you get it all back. Skip the reveal and you lose it, so nobody can wreck a round for free.',
  operator: 'The person who runs the oracle node. Answer fees are withdrawn to this wallet.',
  sign: 'Sign a message to prove you hold the wallet. No transaction, no fee.',
} as const;

/** A word with its meaning one hover or tab away. The meaning is also read out to screen readers. */
export function Term({ k, children }: { k: keyof typeof GLOSSARY; children: ReactNode }) {
  const id = useId();
  return (
    <span className="term" tabIndex={0} aria-describedby={id}>
      {children}
      <span className="term-tip" role="tooltip" id={id}>{GLOSSARY[k]}</span>
    </span>
  );
}

export interface Step {
  title: ReactNode;
  text: ReactNode;
}

const hiddenKey = (id: string) => `randomness:intro:${id}`;

/**
 * What a page is for, in one sentence, and how it works in a few numbered steps. A returning visitor can fold the
 * steps away; the sentence stays, so the page never loses its label.
 */
export function Intro({ id, title, lead, steps, children }: { id: string; title: string; lead: ReactNode; steps?: Step[]; children?: ReactNode }) {
  const [folded, setFolded] = useState(() => localStorage.getItem(hiddenKey(id)) === '1');
  const fold = (value: boolean) => {
    setFolded(value);
    if (value) localStorage.setItem(hiddenKey(id), '1');
    else localStorage.removeItem(hiddenKey(id));
  };
  return (
    <section className="intro" aria-labelledby={`${id}-title`}>
      <div className="intro-head">
        <h2 id={`${id}-title`}>{title}</h2>
        {steps && (
          <button type="button" className="intro-toggle" aria-expanded={!folded} onClick={() => fold(!folded)}>
            {folded ? 'HOW IT WORKS' : 'HIDE GUIDE'}
          </button>
        )}
      </div>
      <p className="intro-lead">{lead}</p>
      {steps && !folded && (
        <ol className="flow">
          {steps.map((s, i) => (
            <li key={i}>
              <span className="flow-n">{i + 1}</span>
              <b>{s.title}</b>
              <span>{s.text}</span>
            </li>
          ))}
        </ol>
      )}
      {children && <div className="intro-actions">{children}</div>}
    </section>
  );
}
