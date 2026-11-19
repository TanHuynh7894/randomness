import { useCallback, useState } from 'react';
import type { Hex } from 'viem';
import { useApp } from '../app-context';
import { BEACON_ABI, readEntries } from '../chain';
import { beaconActions, beaconPhase, claimState, lockedBond, type BeaconPhase, type BeaconRound, type ClaimState } from '../derive';
import { amount, duration, number, uintHex } from '../format';
import { usePoll } from '../hooks';
import { commitmentFor, secretForCommit, storedSecret } from '../secrets';
import { Chip, HexValue, LoginPrompt, Sheet, TxButton, type Tone } from './common';

export const BEACON_PHASE: Record<BeaconPhase, [Tone, string]> = {
  commit: ['wait', 'OPEN TO JOIN'],
  reveal: ['wait', 'REVEALING'],
  finalizable: ['warn', 'READY TO FINALIZE'],
  finalized: ['ok', 'HAS RESULT'],
  failed: ['bad', 'FAILED'],
};

export const CLAIM_TEXT: Record<ClaimState, string> = {
  open: 'Held in the round',
  none: 'None',
  claimable: 'Ready to claim',
  claimed: 'Claimed back',
  forfeited: 'Lost, not revealed',
};

const ORDER: BeaconPhase[] = ['commit', 'reveal', 'finalizable', 'finalized'];

/** The four stages of a round, with the current one marked, so the panel says where the round is before what to do. */
function Stages({ phase, r, now }: { phase: BeaconPhase; r: BeaconRound; now: number }) {
  const at = phase === 'failed' ? 3 : ORDER.indexOf(phase);
  const stages = [
    ['Join', phase === 'commit' ? `${duration(r.commitEnd - now)} left. Submit a secret number and a deposit.` : `Joined: ${number(r.commits)}.`],
    ['Reveal', phase === 'reveal' ? `${duration(r.revealEnd - now)} left. Participants publish their numbers.` : at > 1 ? `Revealed: ${number(r.reveals)} of ${number(r.commits)}.` : 'Starts when joining closes.'],
    ['Finalize', at === 2 ? 'Anyone can press it.' : at > 2 ? 'Finalized.' : 'After the reveals.'],
    [phase === 'failed' ? 'Round failed' : 'Result', phase === 'failed' ? 'Too few people, or someone did not reveal.' : 'Everyone who revealed gets their deposit back.'],
  ];
  return (
    <ol className="steps">
      {stages.map(([title, text], i) => (
        <li key={title} className={i < at || (i === 3 && phase === 'finalized') ? 'is-done' : i === 3 && phase === 'failed' ? 'is-failed' : i === at ? 'is-current' : ''}>
          <b>{title}</b>
          <span>{text}</span>
        </li>
      ))}
    </ol>
  );
}

const isSecret = (v: string): v is Hex => /^0x[0-9a-fA-F]{64}$/.test(v.trim());

function SecretBackup({ secret }: { secret: Hex }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="band band-warn">
      <strong>Back up your secret for this round</strong>
      <span>The secret is stored only in this browser. Lose it before revealing and you lose your deposit; anyone who has it knows your contribution in advance.</span>
      {shown ? <HexValue value={secret} label="secret" full /> : <button type="button" className="button-quiet" onClick={() => setShown(true)}>SHOW SECRET</button>}
    </div>
  );
}

type Entry = Parameters<typeof claimState>[1];

function guidance(phase: BeaconPhase, entry: Entry, can: ReturnType<typeof beaconActions>, r: BeaconRound, now: number): string {
  if (!entry) return 'Reading your wallet’s status…';
  if (can.commit) return 'Press join: the page makes a secret number, saves it in this browser, then sends its fingerprint with your deposit.';
  if (can.reveal) return `Time to reveal. Press it before time runs out (${duration(r.revealEnd - now)} left) or you lose your deposit.`;
  if (can.finalize) return r.reveals === r.commits ? 'Everyone has revealed. Press finalize to compute the result; anyone can do it.' : 'Reveal time is over. Press finalize to close the round; anyone can do it.';
  if (can.claim) return 'The round is closed. Press to get your deposit back.';
  if (phase === 'commit' && entry.committed) return `You joined. Come back when joining closes (${duration(r.commitEnd - now)} left) to reveal.`;
  if (phase === 'commit') return 'The round is taking people.';
  if ((phase === 'reveal' || phase === 'finalizable') && entry.revealed) return 'You revealed. Wait for the others, then finalize.';
  if (!entry.committed) return phase === 'finalized' || phase === 'failed' ? 'This wallet did not join this round.' : 'Joining this round has closed.';
  return 'Nothing left to do.';
}

export function RoundPanel({ round: r, onClose }: { round: BeaconRound; onClose(): void }) {
  const { client, beacon, chainId, nowSec, beaconData, signer, session } = useApp();
  const me = session?.address;
  const read = useCallback(async () => (await readEntries(client, beacon!, [r], me!))[0], [client, beacon, r, me]);
  const { data: entry, refresh } = usePoll(me ? read : undefined, 3_000);
  const [typedSecret, setTypedSecret] = useState('');

  const now = Math.max(nowSec, beaconData?.headTime ?? 0);
  const phase = beaconPhase(r, now);
  const can = beaconActions(r, entry ?? null, now);
  const [tone, text] = BEACON_PHASE[phase];
  const saved = me && chainId !== undefined ? storedSecret(chainId, beacon!, r.id, me) : null;
  const secret = saved ?? (isSecret(typedSecret) ? (typedSecret.trim() as Hex) : null);
  const call = (functionName: string, args: readonly unknown[], value?: bigint) =>
    signer!.write({ address: beacon!, abi: BEACON_ABI, functionName, args, value });
  const locked = lockedBond(r);

  return (
    <Sheet title={`Round ${r.id}`} chip={<Chip tone={tone}>{text}</Chip>} onClose={onClose}>
      <dl className="ledger">
        <div><dt>Deposit each</dt><dd>{amount(r.bond, chainId)}</dd></div>
        <div><dt>Joined / minimum</dt><dd>{number(r.commits)} / {number(r.minParticipants)}</dd></div>
        {locked > 0n && <div><dt>Deposits lost</dt><dd>{amount(locked, chainId)}</dd></div>}
      </dl>

      {phase === 'finalized' && <div className="inspector-value"><HexValue value={uintHex(r.randomness)} label="round random number" full /></div>}

      <Stages phase={phase} r={r} now={now} />

      {!signer || !me ? <LoginPrompt>Sign in with your wallet to join this round.</LoginPrompt> : (
        <section className="verify">
          <h3>What to do now</h3>
          <p>{guidance(phase, entry ?? null, can, r, now)}</p>
          {entry?.committed && <p className="muted">Your deposit: {CLAIM_TEXT[claimState(r, entry)].toLowerCase()}.</p>}

          {can.commit && entry && (
            <TxButton label={`JOIN · DEPOSIT ${amount(r.bond, chainId)}`} action={async () => {
              // Written down before sending, so a commit that lands can always be revealed.
              const { secret: fresh } = secretForCommit(chainId!, beacon!, r.id, me);
              await call('commit', [r.id, commitmentFor(chainId!, beacon!, r.id, me, fresh)], r.bond);
              refresh();
            }} />
          )}
          {can.reveal && (
            <>
              {!saved && (
                <div className="field">
                  <label htmlFor="round-secret">This browser does not have your secret for this round. Paste your backup:</label>
                  <input id="round-secret" className="search" autoComplete="off" value={typedSecret} onChange={(e) => setTypedSecret(e.target.value)} placeholder="0x…" />
                </div>
              )}
              <TxButton label="REVEAL SECRET" disabled={!secret} action={async () => { await call('reveal', [r.id, secret]); refresh(); }} />
            </>
          )}
          {can.finalize && <TxButton label="FINALIZE" action={() => call('finalize', [r.id])} />}
          {can.claim && <TxButton label={`GET DEPOSIT BACK ${amount(r.bond, chainId)}`} action={async () => { await call('claim', [r.id]); refresh(); }} />}
          {saved && entry?.committed && !entry.revealed && r.status === 0 && <SecretBackup secret={saved} />}
        </section>
      )}
    </Sheet>
  );
}
