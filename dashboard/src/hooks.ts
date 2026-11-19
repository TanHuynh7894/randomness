import { useCallback, useEffect, useRef, useState } from 'react';

const POLL_MS = 3_000;

export interface Polled<T> {
  /** The last good result. It stays when a later read fails, and `error` says it may be stale. */
  data?: T;
  error?: unknown;
  refresh(): void;
}

/** Runs `read` repeatedly, never concurrently, and not while the tab is hidden. */
export function usePoll<T>(read: (() => Promise<T>) | undefined, intervalMs = POLL_MS): Polled<T> {
  const [state, setState] = useState<{ data?: T; error?: unknown }>({});
  const wake = useRef<() => void>(() => {});

  useEffect(() => {
    if (!read) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const run = async () => {
      clearTimeout(timer);
      if (!document.hidden) {
        try {
          const data = await read();
          if (!stopped) setState({ data });
        } catch (error) {
          if (!stopped) setState((s) => ({ data: s.data, error }));
        }
      }
      if (!stopped) timer = setTimeout(run, intervalMs);
    };
    wake.current = () => void run();
    void run();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [read, intervalMs]);

  const refresh = useCallback(() => wake.current(), []);
  return { ...state, refresh };
}

/** Wall-clock seconds, ticking so that relative times stay current between reads. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() / 1000), 1_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

export const VIEWS = ['oracle', 'beacon', 'account', 'developer', 'admin'] as const;
export type View = (typeof VIEWS)[number];

/** The open view lives in the address, so a link or a reload lands on the same one. */
export function useView(): [View, (view: View) => void] {
  const read = (): View => VIEWS.find((v) => location.hash === `#${v}`) ?? 'oracle';
  const [view, setView] = useState(read);
  useEffect(() => {
    const onChange = () => setView(read());
    addEventListener('hashchange', onChange);
    return () => removeEventListener('hashchange', onChange);
  }, []);
  return [view, (next) => { location.hash = next; }];
}
