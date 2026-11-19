import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { useApp } from '../app-context';
import { fingerprint } from '../derive';
import { errorText, shortHex } from '../format';

export type Tone = 'ok' | 'bad' | 'warn' | 'wait' | 'info';

/** State reads from the word, so it never depends on color alone. */
export function Chip({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`chip chip-${tone}`}>{children}</span>;
}

/** A 256-bit value drawn as 16 cells, one per 16-bit word. Equal values look equal, and that is all it claims. */
export const Fingerprint = memo(function Fingerprint({ value, className = '' }: { value: bigint; className?: string }) {
  return (
    <span className={`fp ${className}`} aria-hidden="true">
      {fingerprint(value).map((level, i) => <i key={i} style={{ opacity: 0.1 + level * 0.9, animationDelay: `${i * 18}ms` }} />)}
    </span>
  );
});

export function Spark({ values }: { values: readonly number[] }) {
  if (values.length < 2) return null;
  const top = Math.max(...values, 1);
  const points = values.map((v, i) => [(i / (values.length - 1)) * 72 + 1, 24 - (v / top) * 21] as const);
  const [x, y] = points[points.length - 1];
  return (
    <svg className="spark" viewBox="0 0 76 26" aria-hidden="true">
      <polyline points={points.map((p) => p.join(',')).join(' ')} />
      <circle cx={x} cy={y} r="2.2" />
    </svg>
  );
}

export function Kpi({ label, value, note, spark }: { label: string; value: ReactNode; note?: ReactNode; spark?: readonly number[] }) {
  return (
    <div className="kpi">
      <dt>{label}</dt>
      <dd className="kpi-value">{value}</dd>
      {spark && <dd className="kpi-spark"><Spark values={spark} /></dd>}
      {note && <dd className="kpi-note">{note}</dd>}
    </div>
  );
}

/**
 * Copies text and reports the outcome. A browser can refuse the clipboard, and Chrome leaves the call pending while
 * the page lacks focus instead of failing it, so a call that has not finished within a second counts as failed.
 */
export function useCopy(text: string) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = async () => {
    try {
      await Promise.race([
        navigator.clipboard.writeText(text),
        new Promise((_, reject) => setTimeout(() => reject(new Error('clipboard timeout')), 1_000)),
      ]);
      setState('copied');
    } catch {
      setState('failed');
    }
    setTimeout(() => setState('idle'), 1_500);
  };
  return { state, copy };
}

export const COPY_TEXT = { copied: 'COPIED', failed: 'COPY FAILED' } as const;

/** A long hex value, shortened unless `full`. Clicking copies all of it. */
export function HexValue({ value, label, full }: { value: string; label: string; full?: boolean }) {
  const { state, copy } = useCopy(value);
  return (
    <button type="button" className="hex" title={value} aria-label={`Copy ${label}: ${value}`} onClick={(e) => { e.stopPropagation(); void copy(); }}>
      {state !== 'idle' ? COPY_TEXT[state] : full ? value : shortHex(value)}
    </button>
  );
}

export function Band({ tone, title, children }: { tone: 'warn' | 'bad'; title: ReactNode; children?: ReactNode }) {
  return (
    <div className={`band band-${tone}`} role={tone === 'bad' ? 'alert' : 'status'}>
      <strong>{title}</strong>
      {children && <span>{children}</span>}
    </div>
  );
}

/** The last read failed. What is on screen may be old, so say so instead of showing it as current. */
export function StaleBand({ error, hasData }: { error: unknown; hasData: boolean }) {
  if (!error) return null;
  return (
    <Band tone="bad" title={hasData ? 'Cannot read the chain; the numbers below may be out of date' : 'Cannot read the contract'}>
      {errorText(error)} {!hasData && 'Check that the contract address and the RPC are on the same network.'}
    </Band>
  );
}

export function NotConfigured({ name, variable }: { name: string; variable: string }) {
  return <div className="empty">{name} is not configured. Set <code>{variable}</code> in <code>dashboard/.env.local</code> and restart.</div>;
}

export function Loading({ label }: { label: string }) {
  return <div className="skeleton" aria-busy="true" aria-label={label} />;
}

/** A side panel. A native modal dialog, so focus stays inside, Esc closes it and focus returns afterwards. */
export function Sheet({ title, chip, onClose, children }: { title: ReactNode; chip?: ReactNode; onClose(): void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    // No close() on cleanup: its close event would reach onClose, and unmounting removes the dialog anyway.
    if (!ref.current!.open) ref.current!.showModal();
  }, []);
  return (
    <dialog ref={ref} className="inspector" aria-labelledby="sheet-title" onClose={onClose} onClick={(e) => { if (e.target === ref.current) onClose(); }}>
      <div className="inspector-in">
        <header className="inspector-head">
          <h2 id="sheet-title">{title}</h2>
          {chip}
          <button type="button" className="button-quiet" onClick={onClose}>CLOSE</button>
        </header>
        {children}
      </div>
    </dialog>
  );
}

/** Sends something and reports back in place. A refusal stays on screen, so the reason can be read. */
export function TxButton({ label, action, quiet, disabled, onDone }: { label: string; action(): Promise<unknown>; quiet?: boolean; disabled?: boolean; onDone?(): void }) {
  const { refresh } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await action();
      refresh();
      onDone?.();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="tx">
      <button type="button" className={quiet ? 'button-quiet' : 'button'} disabled={busy || disabled} onClick={(e) => { e.stopPropagation(); void run(); }}>
        {busy ? 'SENDING…' : label}
      </button>
      {error && <span className="tx-error" role="alert">{error}</span>}
    </span>
  );
}

export function LoginPrompt({ children }: { children: ReactNode }) {
  const { openLogin } = useApp();
  return (
    <div className="empty empty-action">
      <span>{children}</span>
      <button type="button" className="button" onClick={openLogin}>SIGN IN</button>
    </div>
  );
}
