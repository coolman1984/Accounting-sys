import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { CalendarRange, CheckCircle2, Gauge, Plus, RefreshCw, Trash2 } from 'lucide-react';
import type { WebModule } from '../../core/registry';
import { api } from '../../core/api';
import { useApi, useApiMutation, useDate, useErrorText } from '../../core/hooks';
import { useI18n } from '../../core/i18n';
import { useSession } from '../../core/session';
import { formatMonth, todayIso } from '../../core/format';
import { PageHeader, Loading, EmptyState, ErrorBlock } from '../../ui/Page';
import { DataGrid, type Column } from '../../ui/DataGrid';
import { Button } from '../../ui/Button';
import { Card, CardHeader } from '../../ui/Card';
import { Badge, type Tone } from '../../ui/Badge';
import { Dialog, useConfirm } from '../../ui/Dialog';
import { DecimalInput, Field, Input } from '../../ui/Field';
import { Money } from '../../ui/Money';
import { Qty } from '../../ui/Stock';
import { useToast } from '../../ui/Toast';
import { QTY_SCALE } from '../../core/format';

const TONE: Record<string, Tone> = { draft: 'neutral', approved: 'green', superseded: 'amber' };
const pct = (bp: number | null | undefined) => (bp == null ? '—' : `${(bp / 100).toFixed(bp % 100 ? 1 : 0)}%`);
const CONSTRAINT: Record<string, Tone> = { none: 'neutral', capacity: 'amber', material: 'red', both: 'red' };

function NewCycleDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const toast = useToast();
  const errText = useErrorText();
  const [period, setPeriod] = useState(todayIso().slice(0, 7));
  const make = useApiMutation(() => api.post<{ id: number }>('/sop/cycles', { period }));
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('sop.newCycle')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={make.isPending} onClick={() => make.mutate(undefined, { onSuccess: (r) => (onClose(), navigate(`/sop/cycles/${r.id}`)), onError: (e) => toast.error(errText(e)) })}>{t('common.save')}</Button>
        </>
      }
    >
      <Field label={t('sop.period')} hint={t('sop.periodHint')}><Input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} /></Field>
    </Dialog>
  );
}

/** The monthly sales-and-operations cycles: each holds versions of the demand plan, one of them approved. */
function CyclesPage() {
  const { t, locale } = useI18n();
  const { can } = useSession();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const { data, isLoading } = useApi<any[]>('/sop/cycles');
  const columns = useMemo<Column<any>[]>(
    () => [
      { id: 'period', header: t('sop.period'), pinned: true, value: (r) => r.period, render: (r) => <strong>{formatMonth(r.period, locale)}</strong> },
      { id: 'name', header: t('common.name'), value: (r) => r.name },
      { id: 'months', header: t('sop.horizon'), type: 'number', value: (r) => r.months },
      { id: 'versions', header: t('sop.versions'), type: 'number', value: (r) => r.versions },
      { id: 'approved', header: t('sop.approvedVersion'), type: 'number', value: (r) => r.approved_version ?? 0, render: (r) => (r.approved_version ? <Badge tone="green">v{r.approved_version}</Badge> : <span className="faint">—</span>) },
    ],
    [t, locale],
  );
  return (
    <div className="page">
      <PageHeader
        title={t('sop.title')}
        subtitle={t('sop.subtitle')}
        actions={
          <>
            <Link to="/kpi" className="btn"><Gauge /> {t('sop.kpiTitle')}</Link>
            {can('sop.plans.write') && <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>{t('sop.newCycle')}</Button>}
          </>
        }
      />
      <DataGrid
        id="sop-cycles"
        rows={data}
        loading={isLoading}
        columns={columns}
        rowKey={(r) => r.id}
        onRowClick={(r) => navigate(`/sop/cycles/${r.id}`)}
        exportName={t('sop.title')}
        empty={<EmptyState icon={<CalendarRange size={22} />} title={t('sop.none')} text={t('sop.noneText')} />}
      />
      <NewCycleDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

function CyclePage() {
  const { id } = useParams();
  const { t, locale } = useI18n();
  const date = useDate();
  const { can } = useSession();
  const toast = useToast();
  const errText = useErrorText();
  const { data: c, isLoading, error } = useApi<any>(`/sop/cycles/${id}`);
  const act = useApiMutation((fn: () => Promise<unknown>) => fn());
  if (isLoading) return <Loading />;
  if (error || !c) return <ErrorBlock message={errText(error)} />;
  return (
    <div className="page">
      <PageHeader
        crumbs={[{ to: '/sop', label: t('sop.title') }]}
        title={c.name}
        subtitle={`${formatMonth(c.period, locale)} · ${t('sop.horizonMonths', { n: c.months })}`}
        actions={can('sop.plans.write') && (
          <Button variant="primary" icon={<Plus />} loading={act.isPending} onClick={() => act.mutate(() => api.post(`/sop/cycles/${c.id}/versions`, { baselineMonths: 3 }), { onSuccess: () => toast.success(t('common.saved')), onError: (e) => toast.error(errText(e)) })}>{t('sop.newVersion')}</Button>
        )}
      />
      <Card className="table-card">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('sop.version')}</th>
                <th>{t('common.status')}</th>
                <th className="end">{t('sop.totalQty')}</th>
                <th className="end">{t('sop.totalValue')}</th>
                <th>{t('sop.approvedBy')}</th>
                <th>{t('common.date')}</th>
              </tr>
            </thead>
            <tbody>
              {c.versions.map((v: any) => (
                <tr key={v.id}>
                  <td><Link to={`/sop/versions/${v.id}`} style={{ fontWeight: 550 }}>v{v.version_no}</Link></td>
                  <td><Badge tone={TONE[v.status] ?? 'neutral'}>{t('sop.status.' + v.status)}</Badge></td>
                  <td className="end"><Qty v={v.total_qty} /></td>
                  <td className="end"><Money v={v.total_amount} /></td>
                  <td className="muted">{v.approved_by_name ?? '—'}</td>
                  <td className="muted">{date(v.approved_at ?? v.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

/** One version of the plan: demand by item and month against what manufacturing says it can supply, with the gap in quantity and money. */
function VersionPage() {
  const { id } = useParams();
  const { t, pick, locale } = useI18n();
  const { can } = useSession();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const toast = useToast();
  const errText = useErrorText();
  const { data: v, isLoading, error } = useApi<any>(`/sop/versions/${id}`);
  const { data: cmp } = useApi<any>(`/sop/versions/${id}/comparison`);
  const { data: exec } = useApi<any>(`/sop/versions/${id}/executive`);
  const act = useApiMutation((fn: () => Promise<unknown>) => fn());
  const [edit, setEdit] = useState<Record<string, number | null>>({});
  if (isLoading) return <Loading />;
  if (error || !v) return <ErrorBlock message={errText(error)} />;
  const draft = v.status === 'draft';
  const run = (fn: () => Promise<unknown>, msg: string, after?: () => void) => act.mutate(fn, { onSuccess: () => (toast.success(msg), after?.()), onError: (x) => toast.error(errText(x)) });
  const cellOf = (itemId: number, m: string) => cmp?.rows.find((r: any) => r.item_id === itemId)?.cells.find((x: any) => x.month === m);
  const saveOverrides = () => {
    const lines = Object.entries(edit).map(([k, qty]) => { const [itemId, month] = k.split(':'); return { itemId: Number(itemId), month, qty: qty ?? null }; });
    run(() => api.put(`/sop/versions/${v.id}/lines`, { lines }), t('common.saved'), () => setEdit({}));
  };
  return (
    <div className="page">
      <PageHeader
        crumbs={[{ to: '/sop', label: t('sop.title') }, { to: `/sop/cycles/${v.cycle_id}`, label: v.cycle.name }]}
        title={`${v.cycle.name} · v${v.version_no}`}
        badge={<Badge tone={TONE[v.status] ?? 'neutral'}>{t('sop.status.' + v.status)}</Badge>}
        actions={
          <>
            {draft && can('sop.plans.write') && (
              <>
                <Button icon={<Trash2 />} variant="danger" onClick={async () => { if ((await confirm({ title: t('common.areYouSure'), danger: true, confirmLabel: t('common.delete') })).ok) run(() => api.del(`/sop/versions/${v.id}`), t('common.deleted'), () => navigate(`/sop/cycles/${v.cycle_id}`)); }}>{t('common.delete')}</Button>
                <Button icon={<RefreshCw />} onClick={() => run(() => api.post(`/sop/versions/${v.id}/refresh`), t('sop.refreshed'))}>{t('sop.refresh')}</Button>
                {Object.keys(edit).length > 0 && <Button variant="primary" loading={act.isPending} onClick={saveOverrides}>{t('common.save')}</Button>}
              </>
            )}
            {draft && can('sop.plans.approve') && <Button variant="primary" icon={<CheckCircle2 />} onClick={() => run(() => api.post(`/sop/versions/${v.id}/approve`), t('sop.approvedDone'))}>{t('sop.approve')}</Button>}
          </>
        }
      />
      <div className="stack" style={{ '--gap': '20px' } as React.CSSProperties}>
        {exec && (
          <Card pad>
            <div className="grid-4">
              <div><div className="label">{t('sop.demandValue')}</div><Money v={exec.totals.demand_value} /></div>
              <div><div className="label">{t('sop.budgetValue')}</div><Money v={exec.totals.budget_value} /></div>
              <div><div className="label">{t('sop.supplyGap')}</div><Money v={exec.totals.supply_gap_value} tone /></div>
              <div><div className="label">{t('sop.noSupply')}</div><span className="num">{exec.demand_without_supply_plan}</span></div>
            </div>
            {exec.top_constraints?.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div className="label">{t('sop.topConstraints')}</div>
                <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
                  {exec.top_constraints.slice(0, 6).map((c: any) => <Badge key={`${c.sku}${c.month}`} tone={CONSTRAINT[c.constraint] ?? 'amber'}>{c.sku} · {c.month} · {t('sop.constraint.' + c.constraint)}</Badge>)}
                </div>
              </div>
            )}
          </Card>
        )}
        <Card className="table-card">
          <CardHeader title={t('sop.planGrid')} sub={t('sop.planGridHint')} />
          <div className="table-wrap" style={{ overflowX: 'auto' }}>
            <table className="table table-compact">
              <thead>
                <tr>
                  <th style={{ minWidth: 220 }}>{t('docs.item')}</th>
                  <th style={{ minWidth: 80 }} />
                  {v.months.map((m: string) => <th key={m} className="end" style={{ minWidth: 110 }}>{formatMonth(m, locale)}</th>)}
                  <th className="end" style={{ minWidth: 120 }}>{t('common.total')}</th>
                </tr>
              </thead>
              <tbody>
                {v.rows.map((r: any) => (
                  <>
                    <tr key={`${r.item_id}-d`}>
                      <td rowSpan={3}>{pick(r.name_en, r.name_ar)} <span className="faint" style={{ fontSize: 12 }}>{r.sku}</span></td>
                      <td className="muted">{t('sop.demand')}</td>
                      {r.cells.map((c: any) => {
                        const key = `${r.item_id}:${c.month}`;
                        return (
                          <td key={c.month} className="end">
                            {draft && can('sop.plans.write') ? (
                              <DecimalInput trim scale={QTY_SCALE} value={key in edit ? edit[key] : c.override_qty ?? c.qty} onChange={(x) => setEdit((e) => ({ ...e, [key]: x }))} />
                            ) : (
                              <span className="num" style={{ fontWeight: 550 }}>{<Qty v={c.qty} />}</span>
                            )}
                          </td>
                        );
                      })}
                      <td className="end"><Qty v={r.qty} /></td>
                    </tr>
                    <tr key={`${r.item_id}-s`}>
                      <td className="muted">{t('sop.supply')}</td>
                      {v.months.map((m: string) => {
                        const x = cellOf(r.item_id, m);
                        return <td key={m} className="end">{x?.supply_known ? <><Qty v={x.supply_qty} /> {x.constraint !== 'none' && <Badge tone={CONSTRAINT[x.constraint]}>{t('sop.constraint.' + x.constraint)}</Badge>}</> : <span className="faint">—</span>}</td>;
                      })}
                      <td />
                    </tr>
                    <tr key={`${r.item_id}-g`}>
                      <td className="muted">{t('sop.gap')}</td>
                      {v.months.map((m: string) => {
                        const x = cellOf(r.item_id, m);
                        return <td key={m} className="end">{x?.supply_known ? <Qty v={x.gap_qty} signed tone /> : <span className="faint">—</span>}</td>;
                      })}
                      <td />
                    </tr>
                  </>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={2}>{t('sop.totalValue')}</td>
                  {v.totals.map((x: any) => <td key={x.month} className="end"><Money v={x.amount} /></td>)}
                  <td className="end"><Money v={v.totals.reduce((s: number, x: any) => s + x.amount, 0)} /></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}

/** The KPI pack of a month: delivery service, forecast accuracy against the plan approved the month before, and revenue against plan. */
function KpiPage() {
  const { t } = useI18n();
  const [month, setMonth] = useState(todayIso().slice(0, 7));
  const { data, isLoading, error } = useApi<any>('/kpi/pack', { month });
  const errText = useErrorText();
  const items = useMemo<Column<any>[]>(
    () => [
      { id: 'sku', header: t('docs.item'), pinned: true, value: (r) => r.sku },
      { id: 'plan', header: t('sop.planQty'), type: 'qty', total: true, value: (r) => r.plan_qty, render: (r) => <Qty v={r.plan_qty} /> },
      { id: 'actual', header: t('sop.actualQty'), type: 'qty', total: true, value: (r) => r.actual_qty, render: (r) => <Qty v={r.actual_qty} /> },
      { id: 'error', header: t('sop.errorQty'), type: 'qty', total: true, value: (r) => r.error_qty, render: (r) => <Qty v={r.error_qty} signed tone /> },
    ],
    [t],
  );
  return (
    <div className="page">
      <PageHeader title={t('sop.kpiTitle')} subtitle={t('sop.kpiSub')} actions={<Field label={t('sop.period')}><Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></Field>} />
      {isLoading ? <Loading /> : error || !data ? <ErrorBlock message={errText(error)} /> : (
        <div className="stack" style={{ '--gap': '20px' } as React.CSSProperties}>
          <div className="grid-4">
            <Card pad><div className="label">{t('sd.otdPromised')}</div><div style={{ fontSize: 26, fontWeight: 600 }}>{pct(data.service.otd_bp)}</div><div className="faint">{t('sop.linesMeasured', { n: data.service.lines_measured })}</div></Card>
            <Card pad><div className="label">{t('sd.otifPromised')}</div><div style={{ fontSize: 26, fontWeight: 600 }}>{pct(data.service.otif_bp)}</div></Card>
            <Card pad><div className="label">{t('sd.fillRate')}</div><div style={{ fontSize: 26, fontWeight: 600 }}>{pct(data.service.fill_rate_bp)}</div></Card>
            <Card pad><div className="label">{t('sop.forecastAccuracy')}</div><div style={{ fontSize: 26, fontWeight: 600 }}>{pct(data.forecast?.accuracy_bp)}</div><div className="faint">{t('sop.bias')}: {pct(data.forecast?.bias_bp)}</div></Card>
          </div>
          <Card pad>
            <div className="label">{t('sop.revenueVsPlan')}</div>
            <Money v={data.revenue_vs_plan} tone />
            {data.forecast?.basis && <div className="faint" style={{ marginTop: 6 }}>{t('sop.basis', { period: data.forecast.basis.period, lag: data.forecast.basis.lag_months })}</div>}
          </Card>
          <DataGrid id="kpi-items" rows={data.items} loading={false} columns={items} rowKey={(r) => r.item_id} exportName={t('sop.kpiTitle')} />
        </div>
      )}
    </div>
  );
}

export const sopModule: WebModule = {
  id: 'sop',
  nav: [
    { to: '/sop', label: 'sop.title', icon: CalendarRange, section: 'insights', order: 5, perm: 'sop.plans.read', app: 'sop' },
    { to: '/kpi', label: 'sop.kpiTitle', icon: Gauge, section: 'insights', order: 6, perm: 'sop.plans.read', app: 'sop' },
  ],
  routes: [
    { path: '/sop', element: <CyclesPage />, perm: 'sop.plans.read', app: 'sop' },
    { path: '/sop/cycles/:id', element: <CyclePage />, perm: 'sop.plans.read', app: 'sop' },
    { path: '/sop/versions/:id', element: <VersionPage />, perm: 'sop.plans.read', app: 'sop' },
    { path: '/kpi', element: <KpiPage />, perm: 'sop.plans.read', app: 'sop' },
  ],
  commands: [
    { id: 'go-sop', label: 'sop.title', icon: CalendarRange, group: 'navigate', to: '/sop', perm: 'sop.plans.read', app: 'sop', keywords: 'sales operations planning demand plan خطة الطلب التخطيط' },
    { id: 'go-kpi', label: 'sop.kpiTitle', icon: Gauge, group: 'navigate', to: '/kpi', perm: 'sop.plans.read', app: 'sop', keywords: 'kpi otif forecast accuracy مؤشرات الأداء' },
  ],
};
