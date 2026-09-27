import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Activity, AlertTriangle, ArrowDownRight, ArrowUpRight, CheckCircle2, Gauge, Info, LineChart, Settings2, ShieldAlert, Target } from 'lucide-react';
import type { WebModule } from '../../core/registry';
import { useApi, useApiMutation, useErrorText, useMoney } from '../../core/hooks';
import { useI18n } from '../../core/i18n';
import { useSession } from '../../core/session';
import { api } from '../../core/api';
import { PageHeader, Loading } from '../../ui/Page';
import { Button } from '../../ui/Button';
import { Card, CardHeader } from '../../ui/Card';
import { Badge } from '../../ui/Badge';
import { Dialog } from '../../ui/Dialog';
import { DecimalInput, Field } from '../../ui/Field';
import { useToast } from '../../ui/Toast';
import { BarChart } from '../../ui/Chart';
import { PeriodControls, usePeriod } from '../../ui/Report';

type Unit = 'x' | 'pct' | 'days' | 'money' | 'score';
type Status = 'good' | 'watch' | 'risk' | 'info' | 'na';
interface Ratio {
  key: string;
  group: string;
  unit: Unit;
  value: number | null;
  previous?: number | null;
  annualized?: number | null;
  status: Status;
  reason?: string;
}
interface Finding {
  key: string;
  severity: 'risk' | 'watch' | 'good';
  params?: Record<string, number | string>;
}
interface Analysis {
  from: string;
  to: string;
  compare: { from: string; to: string } | null;
  snapshot: Record<string, any>;
  ratios: Ratio[];
  dupont: { netMargin: number; assetTurnover: number; equityMultiplier: number; roe: number; taxBurden: number | null; interestBurden: number | null; ebitMargin: number } | null;
  previousDupont: Analysis['dupont'];
  zScore: { z: number; x1: number; x2: number; x3: number; x4: number; zone: 'safe' | 'grey' | 'distress' } | null;
  findings: Finding[];
  dataQuality: { key: string; params?: Record<string, number | string> }[];
}

const GROUPS = ['liquidity', 'solvency', 'activity', 'profitability', 'cashflow', 'leverage', 'market'] as const;
/** For trend arrows: does a higher value mean better? */
const LOWER_IS_BETTER = new Set(['debtRatio', 'debtToEquity', 'longTermDebtToEquity', 'equityMultiplier', 'debtToCapital', 'dso', 'dio', 'operatingCycle', 'cashConversionCycle', 'accrualsRatio', 'dol', 'dfl', 'dtl']);

function useFormat() {
  const { fmt } = useMoney();
  const { t } = useI18n();
  return (unit: Unit, v: number | null | undefined) => {
    if (v == null || !Number.isFinite(v)) return '—';
    if (unit === 'money') return fmt(Math.round(v));
    if (unit === 'pct') return `${(v * 100).toFixed(1)}%`;
    if (unit === 'days') return t('analysis.days', { n: Math.round(v) });
    if (unit === 'x') return `${v.toFixed(2)}×`;
    return v.toFixed(2);
  };
}

const StatusDot = ({ s }: { s: Status }) => <span className={`dot dot-${s}`} aria-hidden />;

function RatioRow({ r }: { r: Ratio }) {
  const { t } = useI18n();
  const f = useFormat();
  const [open, setOpen] = useState(false);
  const change = r.value != null && r.previous != null ? (r.annualized ?? r.value) - r.previous : null;
  const better = change == null || change === 0 ? null : LOWER_IS_BETTER.has(r.key) ? change < 0 : change > 0;
  return (
    <>
      <tr className="clickable" onClick={() => setOpen((o) => !o)}>
        <td style={{ width: 18 }}>
          <StatusDot s={r.status} />
        </td>
        <td>
          <div style={{ fontWeight: 550 }}>{t(`analysis.ratios.${r.key}.name`)}</div>
        </td>
        <td className="end num" style={{ fontWeight: 600 }}>
          {r.value == null ? <span className="faint" style={{ fontWeight: 400 }}>{t('analysis.na')}</span> : f(r.unit, r.value)}
          {r.annualized != null && r.value != null && (
            <div className="faint" style={{ fontSize: 11.5, fontWeight: 400 }}>
              {t('analysis.annualized')}: {f(r.unit, r.annualized)}
            </div>
          )}
        </td>
        <td className="end num faint" style={{ width: 120 }}>
          {r.previous != null && (
            <span className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
              {f(r.unit, r.previous)}
              {better != null && (better ? <ArrowUpRight size={14} className="success-text" /> : <ArrowDownRight size={14} className="danger-text" />)}
            </span>
          )}
        </td>
      </tr>
      {open && (
        <tr className="ratio-detail">
          <td />
          <td colSpan={3}>
            {r.reason && <div className="warning-text" style={{ marginBottom: 4 }}>{t(`analysis.reasons.${r.reason}`)}</div>}
            <div>{t(`analysis.ratios.${r.key}.meaning`)}</div>
            <div className="faint num" style={{ marginTop: 4, fontSize: 12 }}>
              = {t(`analysis.ratios.${r.key}.formula`)}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function SettingsDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const { t } = useI18n();
  const { scale } = useMoney();
  const toast = useToast();
  const errText = useErrorText();
  const { data } = useApi<{ sharesOutstanding: number | null; sharePrice: number | null; preferredDividends: number }>(open ? '/analysis/settings' : null);
  const [f, setF] = useState({ sharesOutstanding: null as number | null, sharePrice: null as number | null, preferredDividends: 0 as number | null });
  useEffect(() => {
    if (data) setF(data);
  }, [data]);
  const save = useApiMutation(() => api.put('/analysis/settings', { ...f, preferredDividends: f.preferredDividends ?? 0 }));
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('analysis.settings')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined, { onSuccess: () => (toast.success(t('common.saved')), onClose()), onError: (e) => toast.error(errText(e)) })}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="stack">
        <p className="muted" style={{ margin: 0 }}>{t('analysis.settingsHint')}</p>
        <Field label={t('analysis.shares')}>
          <DecimalInput scale={0} value={f.sharesOutstanding} onChange={(v) => setF({ ...f, sharesOutstanding: v })} />
        </Field>
        <Field label={t('analysis.sharePrice')}>
          <DecimalInput scale={scale} value={f.sharePrice} onChange={(v) => setF({ ...f, sharePrice: v })} />
        </Field>
        <Field label={t('analysis.preferredDividends')}>
          <DecimalInput scale={scale} value={f.preferredDividends} onChange={(v) => setF({ ...f, preferredDividends: v })} />
        </Field>
      </div>
    </Dialog>
  );
}

/** Findings are sentences with numbers in them; money params are formatted as money. */
function useFindingText() {
  const { t } = useI18n();
  const { fmt } = useMoney();
  const MONEY = new Set(['amount', 'breakEven', 'gap']);
  return (key: string, params?: Record<string, number | string>) => {
    const p: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(params ?? {})) p[k] = MONEY.has(k) && typeof v === 'number' && key !== 'financingCustomers' ? fmt(v) : v;
    return t(`analysis.findings.${key}`, p);
  };
}

function HealthPage() {
  const { t } = useI18n();
  const { can } = useSession();
  const { from, to, set } = usePeriod();
  const { data, isLoading } = useApi<Analysis>('/analysis', { from, to });
  const [settings, setSettings] = useState(false);
  const text = useFindingText();
  const f = useFormat();
  const { fmt } = useMoney();
  const counts = useMemo(() => {
    const c = { good: 0, watch: 0, risk: 0 };
    for (const r of data?.ratios ?? []) if (r.status in c) c[r.status as keyof typeof c]++;
    return c;
  }, [data]);

  return (
    <div className="page">
      <PageHeader
        title={t('analysis.title')}
        subtitle={t('analysis.subtitle')}
        actions={
          <>
            <Link to="/analysis/break-even" className="btn">
              <Target /> {t('analysis.breakEven')}
            </Link>
            <Link to="/analysis/trend" className="btn">
              <LineChart /> {t('analysis.trend')}
            </Link>
            {can('analysis.settings.manage') && <Button icon={<Settings2 />} iconOnly title={t('analysis.settings')} onClick={() => setSettings(true)} />}
          </>
        }
      />
      <div className="row" style={{ marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
        <PeriodControls from={from} to={to} onChange={(a, b) => set({ from: a, to: b })} />
        {data?.compare && (
          <span className="faint" style={{ fontSize: 12.5 }}>
            {t('analysis.comparedWith', { from: data.compare.from, to: data.compare.to })}
          </span>
        )}
      </div>
      {isLoading || !data ? (
        <Loading />
      ) : (
        <div className="stack" style={{ '--gap': '16px' } as React.CSSProperties}>
          <div className="analysis-top">
            <Card pad className="health-score">
              <div className="faint" style={{ fontSize: 12.5 }}>{t('analysis.overall')}</div>
              {data.zScore ? (
                <>
                  <div className={`zone zone-${data.zScore.zone}`}>{t(`analysis.zones.${data.zScore.zone}`)}</div>
                  <div className="faint num" style={{ fontSize: 12 }}>
                    {t('analysis.zScore')}: {data.zScore.z.toFixed(2)}
                  </div>
                </>
              ) : (
                <div className="zone">{t('analysis.na')}</div>
              )}
              <div className="row" style={{ gap: 12, marginTop: 10 }}>
                <span className="row" style={{ gap: 4 }}>
                  <StatusDot s="good" /> {counts.good}
                </span>
                <span className="row" style={{ gap: 4 }}>
                  <StatusDot s="watch" /> {counts.watch}
                </span>
                <span className="row" style={{ gap: 4 }}>
                  <StatusDot s="risk" /> {counts.risk}
                </span>
              </div>
            </Card>
            <Card className="findings">
              <CardHeader title={t('analysis.notes')} sub={t('analysis.notesSub')} icon={<Activity size={18} className="muted" />} />
              <ul>
                {data.findings.length === 0 && <li className="muted">{t('analysis.noFindings')}</li>}
                {data.findings.map((x) => (
                  <li key={x.key} className={`finding finding-${x.severity}`}>
                    {x.severity === 'risk' ? <ShieldAlert size={17} /> : x.severity === 'watch' ? <AlertTriangle size={17} /> : <CheckCircle2 size={17} />}
                    <span>{text(x.key, x.params)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          </div>

          {data.dataQuality.length > 0 && (
            <div className="notice">
              <Info />
              <div>
                <strong>{t('analysis.qualityTitle')}</strong>
                <ul style={{ margin: '4px 0 0', paddingInlineStart: 18 }}>
                  {data.dataQuality.map((q) => (
                    <li key={q.key}>{t(`analysis.quality.${q.key}`, q.params?.amount != null ? { amount: fmt(Number(q.params.amount)) } : undefined)}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {data.dupont && (
            <Card pad>
              <CardHeader title={t('analysis.dupont')} sub={t('analysis.dupontSub')} />
              <div className="dupont">
                <div>
                  <span>{t('analysis.ratios.netMargin.name')}</span>
                  <strong>{f('pct', data.dupont.netMargin)}</strong>
                </div>
                <b>×</b>
                <div>
                  <span>{t('analysis.ratios.assetTurnover.name')}</span>
                  <strong>{f('x', data.dupont.assetTurnover)}</strong>
                </div>
                <b>×</b>
                <div>
                  <span>{t('analysis.ratios.equityMultiplier.name')}</span>
                  <strong>{f('x', data.dupont.equityMultiplier)}</strong>
                </div>
                <b>=</b>
                <div className="dupont-result">
                  <span>{t('analysis.ratios.roe.name')}</span>
                  <strong>{f('pct', data.dupont.roe)}</strong>
                </div>
              </div>
              <div className="faint" style={{ fontSize: 12.5, marginTop: 8 }}>
                {t('analysis.dupont5', {
                  tax: data.dupont.taxBurden == null ? '—' : f('pct', data.dupont.taxBurden),
                  interest: data.dupont.interestBurden == null ? '—' : f('pct', data.dupont.interestBurden),
                  ebit: f('pct', data.dupont.ebitMargin),
                })}
              </div>
            </Card>
          )}

          <div className="ratio-groups">
            {GROUPS.map((g) => {
              const list = data.ratios.filter((r) => r.group === g);
              if (!list.length) return null;
              return (
                <Card key={g}>
                  <CardHeader title={t(`analysis.groups.${g}`)} sub={t(`analysis.groupsHint.${g}`)} />
                  <table className="table table-compact ratio-table">
                    <thead>
                      <tr>
                        <th />
                        <th />
                        <th className="end">{t('analysis.thisPeriod')}</th>
                        <th className="end">{data.compare ? t('analysis.previousPeriod') : ''}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {list.map((r) => (
                        <RatioRow key={r.key} r={r} />
                      ))}
                    </tbody>
                  </table>
                </Card>
              );
            })}
          </div>
          <p className="faint" style={{ fontSize: 12 }}>{t('analysis.disclaimer')}</p>
        </div>
      )}
      <SettingsDialog open={settings} onClose={() => setSettings(false)} />
    </div>
  );
}

// ------------------------------------------------------------ break-even

function BreakEvenPage() {
  const { t } = useI18n();
  const { fmt, scale } = useMoney();
  const { from, to, set } = usePeriod();
  const [w, setW] = useState({ targetProfit: 0 as number | null, price: 0 as number | null, volume: 0 as number | null, fixed: 0 as number | null });
  const { data } = useApi<any>('/analysis/break-even', { from, to, targetProfit: w.targetProfit ?? 0, priceChangeBp: w.price ?? 0, volumeChangeBp: w.volume ?? 0, fixedChange: w.fixed ?? 0 });
  const bar = (v: number, max: number) => `${Math.max(0, Math.min(100, (v / max) * 100))}%`;
  const max = data ? Math.max(data.revenue, data.breakEven ?? 0, data.scenario.revenue, 1) : 1;
  return (
    <div className="page">
      <PageHeader crumbs={[{ to: '/analysis', label: t('analysis.title') }]} title={t('analysis.breakEven')} subtitle={t('analysis.breakEvenSub')} />
      <div className="row" style={{ marginBottom: 16 }}>
        <PeriodControls from={from} to={to} onChange={(a, b) => set({ from: a, to: b })} />
      </div>
      {!data ? (
        <Loading />
      ) : (
        <div className="grid-2" style={{ alignItems: 'start', gap: 16 }}>
          <Card pad>
            <CardHeader title={t('analysis.costStructure')} sub={t('analysis.costStructureSub')} />
            <table className="table table-compact">
              <tbody>
                <tr><td>{t('reports.revenue')}</td><td className="end num">{fmt(data.revenue)}</td></tr>
                <tr><td>{t('analysis.variableCosts')}</td><td className="end num">{fmt(-data.variableCosts)}</td></tr>
                <tr className="total-row"><td>{t('analysis.ratios.contributionMargin.name')} ({(data.contributionMarginRatio * 100).toFixed(1)}%)</td><td className="end num">{fmt(data.contributionMargin)}</td></tr>
                <tr><td>{t('analysis.fixedCosts')}</td><td className="end num">{fmt(-data.fixedCosts)}</td></tr>
                <tr className="grand-row"><td>{t('reports.operatingProfit')}</td><td className="end num">{fmt(data.operatingProfit)}</td></tr>
              </tbody>
            </table>
            <div className="be-bars">
              <div><span>{t('reports.revenue')}</span><i style={{ width: bar(data.revenue, max) }} /></div>
              {data.breakEven != null && <div className="be"><span>{t('analysis.ratios.breakEvenRevenue.name')}: {fmt(data.breakEven)}</span><i style={{ width: bar(data.breakEven, max) }} /></div>}
              {data.targetRevenue != null && (w.targetProfit ?? 0) > 0 && <div className="target"><span>{t('analysis.targetRevenue')}: {fmt(data.targetRevenue)}</span><i style={{ width: bar(data.targetRevenue, max) }} /></div>}
            </div>
            <p className="faint" style={{ fontSize: 12.5 }}>
              {t('analysis.costBehaviourHint')} <Link to="/accounts">{t('nav.chartOfAccounts')}</Link>
            </p>
          </Card>
          <Card pad>
            <CardHeader title={t('analysis.whatIf')} sub={t('analysis.whatIfSub')} />
            <div className="grid-2">
              <Field label={t('analysis.targetProfit')}>
                <DecimalInput scale={scale} value={w.targetProfit} onChange={(v) => setW({ ...w, targetProfit: v })} />
              </Field>
              <Field label={t('analysis.fixedChange')}>
                <DecimalInput scale={scale} allowNegative value={w.fixed} onChange={(v) => setW({ ...w, fixed: v })} />
              </Field>
              <Field label={t('analysis.priceChange')}>
                <DecimalInput scale={2} trim allowNegative value={w.price} onChange={(v) => setW({ ...w, price: v })} />
              </Field>
              <Field label={t('analysis.volumeChange')}>
                <DecimalInput scale={2} trim allowNegative value={w.volume} onChange={(v) => setW({ ...w, volume: v })} />
              </Field>
            </div>
            <table className="table table-compact" style={{ marginTop: 12 }}>
              <tbody>
                <tr><td>{t('reports.revenue')}</td><td className="end num">{fmt(data.scenario.revenue)}</td></tr>
                <tr><td>{t('analysis.variableCosts')}</td><td className="end num">{fmt(-data.scenario.variableCosts)}</td></tr>
                <tr><td>{t('analysis.fixedCosts')}</td><td className="end num">{fmt(-data.scenario.fixedCosts)}</td></tr>
                <tr className="grand-row">
                  <td>{t('reports.operatingProfit')}</td>
                  <td className={`end num ${data.scenario.operatingProfit >= data.operatingProfit ? 'success-text' : 'danger-text'}`}>{fmt(data.scenario.operatingProfit)}</td>
                </tr>
                <tr><td>{t('analysis.ratios.breakEvenRevenue.name')}</td><td className="end num">{data.scenario.breakEven == null ? '—' : fmt(data.scenario.breakEven)}</td></tr>
              </tbody>
            </table>
          </Card>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- trend

function TrendPage() {
  const { t, locale } = useI18n();
  const { fmt } = useMoney();
  const f = useFormat();
  const { data } = useApi<any[]>('/analysis/trend', { months: 12 });
  return (
    <div className="page">
      <PageHeader crumbs={[{ to: '/analysis', label: t('analysis.title') }]} title={t('analysis.trend')} subtitle={t('analysis.trendSub')} />
      {!data ? (
        <Loading />
      ) : (
        <div className="stack" style={{ '--gap': '16px' } as React.CSSProperties}>
          <Card pad>
            <BarChart
              labels={data.map((r) => new Date(r.month + '-01').toLocaleDateString(locale === 'ar' ? 'ar-EG' : 'en', { month: 'short' }))}
              series={[
                { label: t('reports.revenue'), color: 'var(--line-blue)', values: data.map((r) => r.revenue) },
                { label: t('reports.netProfit'), color: 'var(--line-teal)', values: data.map((r) => Math.max(r.netProfit, 0)) },
                { label: t('analysis.cashFlowOps'), color: 'var(--line-amber)', values: data.map((r) => Math.max(r.operatingCashFlow, 0)) },
              ]}
              format={(v) => fmt(v)}
            />
          </Card>
          <Card>
            <div className="table-wrap">
              <table className="table table-compact">
                <thead>
                  <tr>
                    <th />
                    {data.map((r) => (
                      <th key={r.month} className="end">{r.month}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(
                    [
                      ['grossMargin', 'pct'],
                      ['netMargin', 'pct'],
                      ['currentRatio', 'x'],
                      ['dso', 'days'],
                      ['cashConversionCycle', 'days'],
                    ] as const
                  ).map(([k, u]) => (
                    <tr key={k}>
                      <td className="nowrap">{t(`analysis.ratios.${k}.name`)}</td>
                      {data.map((r) => (
                        <td key={r.month} className="end num">{f(u, r[k])}</td>
                      ))}
                    </tr>
                  ))}
                  <tr>
                    <td className="nowrap">{t('analysis.cash')}</td>
                    {data.map((r) => (
                      <td key={r.month} className="end num">{fmt(r.cash)}</td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

export const analysisModule: WebModule = {
  id: 'analysis',
  nav: [
    { to: '/analysis', label: 'analysis.title', icon: Gauge, section: 'insights', order: 5, perm: 'analysis.reports.read', app: 'analysis', end: true },
    { to: '/analysis/break-even', label: 'analysis.breakEven', icon: Target, section: 'insights', order: 6, perm: 'analysis.reports.read', app: 'analysis' },
    { to: '/analysis/trend', label: 'analysis.trend', icon: LineChart, section: 'insights', order: 7, perm: 'analysis.reports.read', app: 'analysis' },
  ],
  routes: [
    { path: '/analysis', element: <HealthPage /> },
    { path: '/analysis/break-even', element: <BreakEvenPage /> },
    { path: '/analysis/trend', element: <TrendPage /> },
  ],
  commands: [
    { id: 'go-analysis', label: 'analysis.title', icon: Gauge, group: 'navigate', to: '/analysis', perm: 'analysis.reports.read', app: 'analysis', keywords: 'ratios analysis health نسب مالية تحليل صحة' },
    { id: 'go-breakeven', label: 'analysis.breakEven', icon: Target, group: 'navigate', to: '/analysis/break-even', perm: 'analysis.reports.read', app: 'analysis', keywords: 'break even cvp تعادل' },
  ],
  reports: [
    { to: '/analysis', group: 'reports.groups.analysis', title: 'analysis.title', desc: 'analysis.subtitle', icon: Gauge, color: 'var(--line-purple)', perm: 'analysis.reports.read', app: 'analysis' },
    { to: '/analysis/break-even', group: 'reports.groups.analysis', title: 'analysis.breakEven', desc: 'analysis.breakEvenSub', icon: Target, color: 'var(--line-pink)', perm: 'analysis.reports.read', app: 'analysis' },
  ],
};
