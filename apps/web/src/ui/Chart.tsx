import { useState } from 'react';

export interface BarSeries {
  label: string;
  color: string;
  values: number[];
}

/**
 * Grouped bar chart in plain SVG (no chart library): a handful of months,
 * two series, readable in both themes and both directions.
 */
export function BarChart({ labels, series, format }: { labels: string[]; series: BarSeries[]; format(v: number): string }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 720;
  const H = 240;
  const pad = { top: 16, bottom: 28, left: 8, right: 8 };
  const max = Math.max(1, ...series.flatMap((s) => s.values.map((v) => Math.max(0, v))));
  const nice = niceMax(max);
  const plotH = H - pad.top - pad.bottom;
  const groupW = (W - pad.left - pad.right) / labels.length;
  const barW = Math.min(16, (groupW - 10) / series.length);
  const rtl = typeof document !== 'undefined' && document.dir === 'rtl';
  const x = (i: number) => (rtl ? W - pad.right - (i + 1) * groupW : pad.left + i * groupW);

  return (
    <div style={{ position: 'relative' }}>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img">
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <line key={f} className="grid-line" x1={0} x2={W} y1={pad.top + plotH * (1 - f)} y2={pad.top + plotH * (1 - f)} />
        ))}
        {labels.map((lab, i) => {
          const gx = x(i);
          const inner = series.length * barW + (series.length - 1) * 4;
          return (
            <g key={lab} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={gx} y={0} width={groupW} height={H} fill={hover === i ? 'var(--bg-muted)' : 'transparent'} rx={8} />
              {series.map((s, si) => {
                const v = Math.max(0, s.values[i] ?? 0);
                const h = (v / nice) * plotH;
                const bx = gx + (groupW - inner) / 2 + si * (barW + 4);
                return <rect key={s.label} x={bx} y={pad.top + plotH - h} width={barW} height={Math.max(h, v > 0 ? 2 : 0)} rx={4} fill={s.color} />;
              })}
              <text x={gx + groupW / 2} y={H - 8} textAnchor="middle">
                {lab}
              </text>
            </g>
          );
        })}
      </svg>
      {hover != null && (
        <div
          className="card raised"
          style={{
            position: 'absolute',
            top: 8,
            [rtl ? 'right' : 'left']: `${Math.min(80, ((hover + 0.5) / labels.length) * 100)}%`,
            padding: '8px 12px',
            fontSize: 12.5,
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 4 }}>{labels[hover]}</div>
          {series.map((s) => (
            <div key={s.label} className="row" style={{ gap: 8 }}>
              <i style={{ width: 8, height: 8, borderRadius: 2, background: s.color, display: 'inline-block' }} />
              <span className="muted">{s.label}</span>
              <span className="num" style={{ marginInlineStart: 'auto', fontWeight: 600 }}>
                {format(s.values[hover] ?? 0)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function niceMax(v: number): number {
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / exp;
  const n = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return n * exp;
}

/**
 * One balance per period as columns from a zero baseline (negatives go below it), with a dashed
 * reference line (e.g. the minimum cash). Columns under the reference use the danger colour; the
 * tooltip says so in words, so the state is never colour alone.
 */
export function BalanceChart({
  labels,
  values,
  reference,
  referenceLabel,
  belowLabel,
  format,
  onSelect,
  selected,
}: {
  labels: string[];
  values: number[];
  reference?: number | null;
  referenceLabel?: string;
  belowLabel?: string;
  format(v: number): string;
  onSelect?(i: number): void;
  selected?: number | null;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 720;
  const H = 220;
  const pad = { top: 14, bottom: 26, left: 6, right: 6 };
  const ref = reference ?? null;
  const hi = niceMax(Math.max(1, ...values, ref ?? 0));
  const lo = Math.min(0, ...values) < 0 ? -niceMax(-Math.min(...values)) : 0;
  const plotH = H - pad.top - pad.bottom;
  const y = (v: number) => pad.top + ((hi - v) / (hi - lo)) * plotH;
  const colW = (W - pad.left - pad.right) / Math.max(1, labels.length);
  const barW = Math.max(4, Math.min(28, colW - 8));
  const rtl = typeof document !== 'undefined' && document.dir === 'rtl';
  const x = (i: number) => (rtl ? W - pad.right - (i + 1) * colW : pad.left + i * colW);
  const every = Math.ceil(labels.length / 13);
  const show = hover ?? selected ?? null;
  return (
    <div style={{ position: 'relative' }}>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img">
        {[0, 0.5, 1].map((f) => (
          <line key={f} className="grid-line" x1={0} x2={W} y1={pad.top + plotH * f} y2={pad.top + plotH * f} />
        ))}
        <line x1={0} x2={W} y1={y(0)} y2={y(0)} stroke="var(--border-strong)" strokeWidth={1} />
        {labels.map((lab, i) => {
          const v = values[i] ?? 0;
          const top = Math.min(y(v), y(0));
          const h = Math.max(Math.abs(y(v) - y(0)), v !== 0 ? 2 : 0);
          const below = ref != null && v < ref;
          return (
            <g key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onClick={() => onSelect?.(i)} style={{ cursor: onSelect ? 'pointer' : undefined }}>
              <rect x={x(i)} y={0} width={colW} height={H} fill={hover === i || selected === i ? 'var(--bg-muted)' : 'transparent'} rx={6} />
              <rect x={x(i) + (colW - barW) / 2} y={top} width={barW} height={h} rx={4} fill={below ? 'var(--danger)' : 'var(--primary)'} />
              {i % every === 0 && (
                <text x={x(i) + colW / 2} y={H - 8} textAnchor="middle">
                  {lab}
                </text>
              )}
            </g>
          );
        })}
        {ref != null && ref > 0 && <line x1={0} x2={W} y1={y(ref)} y2={y(ref)} stroke="var(--warning)" strokeWidth={2} strokeDasharray="6 5" />}
      </svg>
      {ref != null && ref > 0 && referenceLabel && (
        <div className="faint" style={{ position: 'absolute', top: `${(y(ref) / H) * 100}%`, insetInlineEnd: 8, transform: 'translateY(-120%)', fontSize: 11.5 }}>
          {referenceLabel}: {format(ref)}
        </div>
      )}
      {show != null && (
        <div
          className="card raised"
          style={{ position: 'absolute', top: 8, [rtl ? 'right' : 'left']: `${Math.min(78, ((show + 0.5) / labels.length) * 100)}%`, padding: '8px 12px', fontSize: 12.5, pointerEvents: 'none', whiteSpace: 'nowrap' }}
        >
          <div style={{ fontWeight: 600, marginBottom: 2 }}>{labels[show]}</div>
          <div className="num" style={{ fontWeight: 600 }}>{format(values[show] ?? 0)}</div>
          {ref != null && (values[show] ?? 0) < ref && belowLabel && <div className="danger-text">⚠ {belowLabel}</div>}
        </div>
      )}
    </div>
  );
}
