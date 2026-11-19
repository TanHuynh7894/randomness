import { useState, type ReactNode } from 'react';
import { niceMax } from '../derive';
import { number } from '../format';

export interface Column {
  key: string;
  label: string;
  value: number;
  tip: ReactNode;
}

interface Props {
  /** Read out in place of the plot. The table beside each chart holds the same values. */
  description: string;
  columns: Column[];
  /** Print the value on top of each column. Only for a few columns: otherwise it is noise. */
  labelAll?: boolean;
  /** A reference level, drawn as a line across the plot. The caption says what it means. */
  reference?: number;
  /** Print the x label only on every nth column, so that dense charts stay readable. */
  labelEvery?: number;
}

export function ColumnChart({ description, columns, labelAll, reference, labelEvery = 1 }: Props) {
  const [hover, setHover] = useState<string | null>(null);
  const top = niceMax(Math.max(reference ?? 0, ...columns.map((c) => c.value)));
  const ticks = [top, top / 2, 0];
  const percent = (v: number) => `${(v / top) * 100}%`;
  const hovered = columns.findIndex((c) => c.key === hover);

  return (
    <div className="chart" role="img" aria-label={description}>
      <div className="chart-axis" aria-hidden="true">
        {ticks.map((t) => <span key={t}>{number(t)}</span>)}
      </div>
      <div className="chart-body" aria-hidden="true">
        <div className="chart-plot" onMouseLeave={() => setHover(null)}>
          {ticks.map((t) => <i key={t} className="chart-grid" style={{ bottom: percent(t) }} />)}
          {reference !== undefined && <i className="chart-reference" style={{ bottom: percent(reference) }} />}
          {columns.map((c) => (
            <div key={c.key} className={`chart-band${hover === c.key ? ' is-hover' : ''}`} onMouseEnter={() => setHover(c.key)}>
              <div className="chart-column" style={{ height: percent(c.value) }}>
                {labelAll && <span className="chart-value">{number(c.value)}</span>}
              </div>
            </div>
          ))}
          {hovered >= 0 && (
            <div
              className="chart-tip"
              style={{
                left: `${((hovered + 0.5) / columns.length) * 100}%`,
                transform: hovered > columns.length / 2 ? 'translateX(-100%)' : undefined,
              }}
            >
              {columns[hovered].tip}
            </div>
          )}
        </div>
        <div className="chart-labels">
          {columns.map((c, i) => <span key={c.key}>{(columns.length - 1 - i) % labelEvery === 0 ? c.label : ''}</span>)}
        </div>
      </div>
    </div>
  );
}
