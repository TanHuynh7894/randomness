import { useCallback, useMemo } from 'react';
import { createAdminReader } from '../admin';
import { useApp } from '../app-context';
import { ORACLE_ABI } from '../chain';
import { adminAlerts, EXPIRY_BLOCKS, oracleHealth, requestState, summarize, type AdminAlert } from '../derive';
import { amount, duration, number, shortHex, plural } from '../format';
import { usePoll } from '../hooks';
import { Band, Chip, HexValue, Kpi, Loading, LoginPrompt, NotConfigured, TxButton } from './common';

const ALERT_TEXT: Record<AdminAlert['code'], (a: AdminAlert) => [string, string]> = {
  'node-expiring': (a) => [`${plural(a.count!, 'request')} about to expire`, 'Fewer than 32 blocks left to answer. If the node has stopped, restart it now.'],
  'node-slow': (a) => [`${plural(a.count!, 'request')} waiting unusually long`, 'Check that the node is running and its wallet has enough gas.'],
  'node-overdue': (a) => [`${plural(a.count!, 'overdue request')} not closed`, 'Close them in the queue below to refund the callers.'],
  shortfall: () => ['The contract holds less than it owes', 'This should never happen. Stop withdrawing and check the contract.'],
  'gas-out': () => ['The node wallet cannot pay for one more answer', 'Top it up now, or requests will expire.'],
  'gas-low': () => ['The node wallet is low on gas', 'Enough for fewer than 10 answers.'],
  'fee-below-cost': () => ['Each answer loses money', 'Gas costs more than the fee. The fee is fixed in the contract; changing it needs a new deployment.'],
  'callback-failures': (a) => [`${plural(a.count!, 'failed callback')}`, 'Results are still stored on the oracle. The caller needs to settle or fix its callback.'],
};

function Reconciliation({ owed, surplus, ok, balance, earned, refunds, pendingFees, chainId }: { owed: bigint; surplus: bigint; ok: boolean; balance: bigint; earned: bigint; refunds: bigint; pendingFees: bigint; chainId?: number }) {
  const row = (label: string, value: bigint, strong?: boolean) => (
    <div className={strong ? 'ledger-total' : ''}><dt>{label}</dt><dd>{amount(value, chainId)}</dd></div>
  );
  return (
    <dl className="ledger">
      {row('Fees earned, not withdrawn', earned)}
      {row('Fees of open requests', pendingFees)}
      {row('Refunds waiting', refunds)}
      {row('Total owed', owed, true)}
      {row('Contract balance', balance, true)}
      <div><dt>Verdict</dt><dd><Chip tone={ok ? 'ok' : 'bad'}>{ok ? (surplus > 0n ? 'BALANCED, SURPLUS' : 'BALANCED') : 'SHORT'}</Chip></dd></div>
    </dl>
  );
}

export function AdminView() {
  const { client, oracle, oracleData: data, chainId, nowSec, signer, isOperator, session } = useApp();
  const reader = useMemo(() => (oracle ? createAdminReader(client, oracle) : undefined), [client, oracle]);
  const read = useCallback(() => reader!(data!), [reader, data]);
  const admin = usePoll(reader && data && isOperator ? read : undefined, 10_000);

  if (!oracle) return <NotConfigured name="oracle" variable="VITE_ORACLE_ADDRESS" />;
  if (!session) return <LoginPrompt>Admin is for the oracle's operator. Sign in with the operator wallet to enter.</LoginPrompt>;
  if (!data) return <Loading label="Reading the oracle" />;
  if (!isOperator) {
    return <Band tone="warn" title="This wallet is not the operator">Signed in as {shortHex(session.address)}. The oracle's operator is {shortHex(data.operator)}, fixed at deployment.</Band>;
  }
  if (!admin.data) return admin.error ? <Band tone="bad" title="Cannot read admin data">{String(admin.error)}</Band> : <Loading label="Reading admin data" />;

  const a = admin.data;
  const now = Math.max(nowSec, data.headTime);
  const s = summarize(data.requests, data.head);
  const health = oracleHealth(data.requests, data.head, now);
  const walletBalance = a.wallets.reduce((sum, w) => sum + w.balance, 0n);
  const alerts = adminAlerts({ health, fee: data.fee, avgCost: a.avgCost, walletBalance, callbackFailures: s.callbackFailures, reconcileOk: a.reconciliation?.ok ?? null });
  const open = data.requests.filter((r) => r.status === 1);
  const lastAnswer = a.wallets[0]?.lastAnswerTime;

  return (
    <>
      {alerts.map((alert) => {
        const [title, detail] = ALERT_TEXT[alert.code](alert);
        return <Band key={alert.code} tone={alert.level === 'critical' ? 'bad' : 'warn'} title={title}>{detail}</Band>;
      })}
      <dl className="kpis">
        <Kpi label="Fees to withdraw" value={amount(data.earned, chainId)} note={`Goes to ${shortHex(data.operator)}`} />
        <Kpi label="Fees earned" value={amount(BigInt(s.fulfilled) * data.fee, chainId)} note={`${plural(s.fulfilled, 'answer')}`} />
        <Kpi label="Cost per answer" value={a.avgCost === null ? '–' : amount(a.avgCost, chainId)} note={a.samples ? `Over the latest ${plural(a.samples, 'answer')}` : 'No answers yet'} />
        <Kpi label="Profit per answer" value={a.avgCost === null ? '–' : (a.avgCost > data.fee ? `-${amount(a.avgCost - data.fee, chainId)}` : amount(data.fee - a.avgCost, chainId))} note={`Fee ${amount(data.fee, chainId)}`} />
        <Kpi label="Last answer" value={lastAnswer ? `${duration(now - lastAnswer)} ago` : '–'} note={`Open: ${number(open.length)}`} />
      </dl>

      <div className="head">
        <h2>Withdraw fees</h2>
        <p className="head-note">Anyone can call it, but the money always goes to the operator wallet.</p>
        <span className="head-end"><TxButton label={`WITHDRAW ${amount(data.earned, chainId)}`} disabled={data.earned === 0n} action={() => signer!.write({ address: oracle, abi: ORACLE_ABI, functionName: 'withdraw' })} /></span>
      </div>

      <div className="split">
        <section className="panel">
          <h2>Queue</h2>
          {open.length === 0 ? <div className="empty">No open requests.</div> : (
            <div className="table-scroll" tabIndex={0} role="region" aria-label="Open requests">
              <table>
                <thead><tr><th className="num">ID</th><th>Status</th><th className="num">Sent at block</th><th>Action</th></tr></thead>
                <tbody>
                  {open.map((r) => {
                    const { state, blocksLeft } = requestState(r, data.head);
                    return (
                      <tr key={r.id.toString()} className="no-pick">
                        <td className="num">{r.id.toString()}</td>
                        <td>{state === 'overdue' ? <Chip tone="warn">OVERDUE</Chip> : <Chip tone={blocksLeft <= 32 ? 'bad' : 'wait'}>WAITING · {plural(blocksLeft, 'block').toUpperCase()} LEFT</Chip>}</td>
                        <td className="num">{number(Number(r.requestBlock))}</td>
                        <td>{state === 'overdue' ? <TxButton quiet label="CLOSE AND REFUND" action={() => signer!.write({ address: oracle, abi: ORACLE_ABI, functionName: 'expire', args: [r.id] })} /> : <span className="muted">Waiting for node</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="panel">
          <h2>Books</h2>
          {a.reconciliation ? (
            <Reconciliation {...a.reconciliation} balance={data.balance} earned={data.earned} refunds={a.refunds} pendingFees={BigInt(open.length) * data.fee} chainId={chainId} />
          ) : <div className="empty">Some older requests are outside what is loaded, so the books cannot be checked from this page.</div>}
        </section>
      </div>

      <section className="panel">
        <h2>Node wallet</h2>
        <p className="muted">Taken from recent answer transactions. The node reports to nobody, so this page works out its state from the chain.</p>
        {a.wallets.length === 0 ? <div className="empty">No answers yet, so the node wallet is unknown.</div> : (
          <div className="table-scroll" tabIndex={0} role="region" aria-label="Node wallet">
            <table>
              <thead><tr><th>Address</th><th className="num">Balance</th><th className="num">Enough for</th><th>Last answer</th></tr></thead>
              <tbody>
                {a.wallets.map((w) => (
                  <tr key={w.address} className="no-pick">
                    <td><HexValue value={w.address} label="node wallet address" /></td>
                    <td className="num">{amount(w.balance, chainId)}</td>
                    <td className="num">{a.avgCost && a.avgCost > 0n ? `${plural(w.balance / a.avgCost, 'answer')}` : '–'}</td>
                    <td>{duration(now - w.lastAnswerTime)} ago</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <h2>Configuration</h2>
        <p className="muted">The contract has no owner. The fee, operator and key cannot change; changing them needs a new contract.</p>
        <dl className="facts facts-col">
          <div><dt>CONTRACT</dt><dd><HexValue value={oracle} label="oracle address" /></dd></div>
          <div><dt>FEE</dt><dd>{amount(data.fee, chainId)}</dd></div>
          <div><dt>GAS CALLBACK</dt><dd>{number(Number(a.callbackGas))}</dd></div>
          <div><dt>ANSWER WINDOW</dt><dd>{EXPIRY_BLOCKS.toString()} blocks</dd></div>
          <div><dt>PUBLIC KEY</dt><dd>{a.publicKey.map((w, i) => <HexValue key={i} value={`0x${w.toString(16).padStart(64, '0')}`} label={`public key, part ${i + 1}`} />)}</dd></div>
        </dl>
      </section>
    </>
  );
}
