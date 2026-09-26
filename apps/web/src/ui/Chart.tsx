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
