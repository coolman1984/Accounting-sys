import { useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { Link } from 'react-router';
import { Download, Printer } from 'lucide-react';
import { useI18n } from '../core/i18n';
import { useMoney } from '../core/hooks';
import { addDaysIso, todayIso } from '../core/format';
import { Button } from './Button';
import { PageHeader } from './Page';
import { Money } from './Money';

export interface StatementRow {
  id: number;
  code: string;
  name_en: string;
  name_ar: string;
  amount: number;
  compare?: number;
}

/** Common period presets. */
export function presets(t: (k: string) => string) {
  const now = todayIso();
  const y = Number(now.slice(0, 4));
  const m = Number(now.slice(5, 7));
  const pad = (n: number) => String(n).padStart(2, '0');
  const monthEnd = (yy: number, mm: number) => new Date(Date.UTC(yy, mm, 0)).toISOString().slice(0, 10);
  const q = Math.floor((m - 1) / 3);
  const lm = m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 };
  return [
    { id: 'thisMonth', label: t('reportsPeriods.thisMonth'), from: `${y}-${pad(m)}-01`, to: monthEnd(y, m) },
    { id: 'lastMonth', label: t('reportsPeriods.lastMonth'), from: `${lm.y}-${pad(lm.m)}-01`, to: monthEnd(lm.y, lm.m) },
    { id: 'thisQuarter', label: t('reportsPeriods.thisQuarter'), from: `${y}-${pad(q * 3 + 1)}-01`, to: monthEnd(y, q * 3 + 3) },
    { id: 'thisYear', label: t('reportsPeriods.thisYear'), from: `${y}-01-01`, to: `${y}-12-31` },
    { id: 'lastYear', label: t('reportsPeriods.lastYear'), from: `${y - 1}-01-01`, to: `${y - 1}-12-31` },
  ];
}

/** Period state kept in the URL so reports are shareable and survive refresh. */
export function usePeriod(defaultPreset = 'thisYear') {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const p = presets(t).find((x) => x.id === defaultPreset)!;
  const from = params.get('from') ?? p.from;
  const to = params.get('to') ?? p.to;
  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === '') next.delete(k);
      else next.set(k, v);
    }
    setParams(next, { replace: true });
  };
  return { from, to, params, set };
}

/** The period of equal length just before [from, to]. */
export function previousPeriod(from: string, to: string) {
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
  const pTo = addDaysIso(from, -1);
  return { from: addDaysIso(pTo, -days), to: pTo };
}

export function PeriodControls({ from, to, onChange }: { from: string; to: string; onChange(from: string, to: string): void }) {
  const { t } = useI18n();
  const list = presets(t);
  const current = list.find((p) => p.from === from && p.to === to)?.id ?? '';
  return (
    <div className="row wrap">
      <select
        className="select"
        style={{ width: 'auto' }}
        value={current}
        onChange={(e) => {
          const p = list.find((x) => x.id === e.target.value);
          if (p) onChange(p.from, p.to);
        }}
      >
        <option value="">{t('reportsPeriods.custom')}</option>
        {list.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
      <input className="input" type="date" style={{ width: 'auto' }} value={from} onChange={(e) => onChange(e.target.value, to)} aria-label={t('common.from')} />
      <span className="faint">→</span>
      <input className="input" type="date" style={{ width: 'auto' }} value={to} onChange={(e) => onChange(from, e.target.value)} aria-label={t('common.to')} />
    </div>
  );
}

export function ReportFrame({
  title,
  subtitle,
  controls,
  onExport,
  children,
  badge,
}: {
  title: string;
  subtitle?: ReactNode;
  controls?: ReactNode;
  onExport?(): void;
  children: ReactNode;
  badge?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div className="page">
      <PageHeader
        crumbs={[{ to: '/reports', label: t('reports.title') }]}
        title={title}
        subtitle={subtitle}
        badge={badge}
        actions={
          <>
            {onExport && (
              <Button icon={<Download />} onClick={onExport}>
                {t('common.exportCsv')}
              </Button>
            )}
            <Button icon={<Printer />} onClick={() => window.print()}>
              {t('common.print')}
            </Button>
          </>
        }
      />
      {controls && <div className="toolbar no-print">{controls}</div>}
      {children}
    </div>
  );
}

/** A statement section: account rows + subtotal line. */
export function Section({
  title,
  rows,
  total,
  compareTotal,
  showCompare,
  from,
  to,
}: {
  title: string;
  rows: StatementRow[];
  total: number;
  compareTotal?: number | null;
  showCompare?: boolean;
  from?: string;
  to?: string;
}) {
  const { pick, t } = useI18n();
  return (
    <>
      <tr className="group-row">
        <td colSpan={showCompare ? 3 : 2}>{title}</td>
      </tr>
      {rows.map((r) => (
        <tr key={r.id}>
          <td style={{ paddingInlineStart: 34 }}>
            <Link to={`/reports/general-ledger?accountId=${r.id}${from ? `&from=${from}` : ''}${to ? `&to=${to}` : ''}`}>
              <span className="num faint" style={{ marginInlineEnd: 10 }}>
                {r.code}
              </span>
              {pick(r.name_en, r.name_ar)}
            </Link>
          </td>
          <td className="end">
            <Money v={r.amount} parens />
          </td>
          {showCompare && (
            <td className="end muted">
              <Money v={r.compare ?? 0} parens />
            </td>
          )}
        </tr>
      ))}
      <tr className="total-row">
        <td className="muted" style={{ fontWeight: 600 }}>
          {t('common.total')}
        </td>
        <td className="end">
          <Money v={total} parens />
        </td>
        {showCompare && (
          <td className="end muted">
            <Money v={compareTotal ?? 0} parens />
          </td>
        )}
      </tr>
    </>
  );
}

export function TotalLine({ label, value, compare, showCompare, grand }: { label: string; value: number; compare?: number | null; showCompare?: boolean; grand?: boolean }) {
  return (
    <tr className={grand ? 'grand-row' : 'total-row'}>
      <td>{label}</td>
      <td className="end">
        <Money v={value} parens />
      </td>
      {showCompare && (
        <td className="end">
          <Money v={compare ?? 0} parens />
        </td>
      )}
    </tr>
  );
}

export function useToggle(initial = false): [boolean, () => void] {
  const [v, setV] = useState(initial);
  return [v, () => setV((x) => !x)];
}

export function useCsvMoney() {
  const { scale } = useMoney();
  return (v: number) => {
    const neg = v < 0;
    const abs = String(Math.abs(v)).padStart(scale + 1, '0');
    const s = scale ? `${abs.slice(0, -scale)}.${abs.slice(-scale)}` : abs;
    return neg ? '-' + s : s;
  };
}
