import { useState } from 'react';
import { useApp } from '../app-context';
import { BEACON_ABI } from '../chain';
import { parseRoundForm, type RoundForm } from '../derive';
import { Sheet, TxButton } from './common';

const PROBLEM = {
  commit: 'Join time must be a whole number of minutes, above 0.',
  reveal: 'Reveal time must be a whole number of minutes, above 0.',
  bond: 'The deposit must be a number above 0.',
  minParticipants: 'The minimum must be a whole number, 2 or more.',
};

const FIELDS: [keyof RoundForm, string, string][] = [
  ['commitMinutes', 'Join time (minutes)', 'During this time people submit a secret number and a deposit.'],
  ['revealMinutes', 'Reveal time (minutes)', 'Then everyone publishes their number. Miss it and you lose your deposit.'],
  ['bond', 'Deposit per person', 'Should be more than anyone could win by wrecking the round.'],
  ['minParticipants', 'Minimum people', 'With too few people the round fails and everyone is refunded.'],
];

export function CreateRound({ onClose }: { onClose(): void }) {
  const { beacon, signer } = useApp();
  const [form, setForm] = useState<RoundForm>({ commitMinutes: '10', revealMinutes: '10', bond: '0.01', minParticipants: '2' });
  const parsed = parseRoundForm(form);

  return (
    <Sheet title="New round" onClose={onClose}>
      <div className="form">
        {FIELDS.map(([key, label, hint]) => (
          <div className="field" key={key}>
            <label htmlFor={`round-${key}`}>{label}</label>
            <input id={`round-${key}`} className="search" inputMode="decimal" autoComplete="off" value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
            {hint && <small>{hint}</small>}
          </div>
        ))}
      </div>
      {!parsed.ok && <p className="tx-error" role="alert">{PROBLEM[parsed.field]}</p>}
      <TxButton label="CREATE ROUND" disabled={!parsed.ok} onDone={onClose} action={() => signer!.write({ address: beacon!, abi: BEACON_ABI, functionName: 'createRound', args: parsed.ok ? parsed.args : [] })} />
    </Sheet>
  );
}
