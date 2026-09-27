import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { AlertTriangle, CalendarClock, Lightbulb, Pencil, Plus, Settings2, Trash2, Wallet } from 'lucide-react';
import type { WebModule } from '../../core/registry';
import { useApi, useApiMutation, useErrorText, useMoney } from '../../core/hooks';
import { useI18n } from '../../core/i18n';
import { useSession } from '../../core/session';
import { api } from '../../core/api';
import { formatDate, todayIso } from '../../core/format';
import { PageHeader, Loading, EmptyState } from '../../ui/Page';
import { Button } from '../../ui/Button';
import { Card, CardHeader } from '../../ui/Card';
import { Badge } from '../../ui/Badge';
import { Dialog, useConfirm } from '../../ui/Dialog';
import { Checkbox, DecimalInput, Field, Input, Select, Textarea } from '../../ui/Field';
import { useToast } from '../../ui/Toast';
import { BalanceChart } from '../../ui/Chart';
import { DataGrid, type Column } from '../../ui/DataGrid';

type Source = 'receivables' | 'payables' | 'orders' | 'planned' | 'booked';
const SOURCES: Source[] = ['receivables', 'payables', 'orders', 'planned', 'booked'];
const CATEGORIES = ['payroll', 'rent', 'tax', 'loan', 'capex', 'owner', 'utilities', 'other'] as const;

interface Flow {
  date: string;
  amount: number;
  source: Source;
  label: string;
  ref?: string | null;
  dueDate?: string | null;
}
interface Period {
  from: string;
  to: string;
  opening: number;
  inflow: number;
  outflow: number;
  net: number;
  closing: number;
  bySource: Record<Source, number>;
  flows: Flow[];
  belowMinimum: boolean;
}
interface Forecast {
  asOf: string;
  granularity: 'week' | 'month';
  settings: { minCash: number; useHabits: boolean; doubtfulDays: number };
  accounts: { id: number; code: string; name_en: string; name_ar: string; balance: number }[];
  opening: number;
  closing: number;
  buckets: Period[];
  lowest: { index: number; balance: number } | null;
  firstShortfall: number | null;
  fundingNeed: number;
  beyond: number;
  totals: Record<Source, number>;
  atRisk: { party: string; number: string | null; dueDate: string; amount: number; daysOverdue: number }[];
  atRiskTotal: number;
}
interface PlanItem {
  id: number;
  name: string;
  direction: 'in' | 'out';
  category: string;
  amount: number;
  start_date: string;
  repeat: 'once' | 'weekly' | 'monthly' | 'quarterly' | 'yearly';
  end_date: string | null;
  is_active: number;
  notes: string | null;
}

function usePeriodLabel() {
  const { locale } = useI18n();
  return (p: { from: string }, g: 'week' | 'month') =>
    g === 'month'
      ? new Date(p.from + 'T00:00:00').toLocaleDateString(locale === 'ar' ? 'ar-EG' : 'en', { month: 'short', year: '2-digit' })
      : new Date(p.from + 'T00:00:00').toLocaleDateString(locale === 'ar' ? 'ar-EG' : 'en', { day: 'numeric', month: 'short' });
}

// -------------------------------------------------------------- settings

function SettingsDialog({ open, onClose, current }: { open: boolean; onClose(): void; current: Forecast['settings'] }) {
  const { t } = useI18n();
  const { scale } = useMoney();
  const toast = useToast();
  const errText = useErrorText();
  const [f, setF] = useState(current);
  useEffect(() => {
    if (open) setF(current);
  }, [open, current]);
  const save = useApiMutation(() => api.put('/cashflow/settings', { minCash: f.minCash ?? 0, useHabits: f.useHabits, doubtfulDays: f.doubtfulDays ?? 0 }));
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('cashflow.settings')}
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
        <Field label={t('cashflow.minCash')} hint={t('cashflow.minCashHint')}>
          <DecimalInput scale={scale} value={f.minCash} onChange={(v) => setF({ ...f, minCash: v ?? 0 })} />
        </Field>
        <Checkbox label={t('cashflow.useHabits')} checked={f.useHabits} onChange={(v) => setF({ ...f, useHabits: v })} />
        <p className="faint" style={{ fontSize: 12.5, margin: '-6px 0 0' }}>{t('cashflow.useHabitsHint')}</p>
        <Field label={t('cashflow.doubtfulDays')} hint={t('cashflow.doubtfulDaysHint')}>
          <DecimalInput scale={0} trim value={f.doubtfulDays} onChange={(v) => setF({ ...f, doubtfulDays: v ?? 0 })} />
        </Field>
      </div>
    </Dialog>
  );
}

// -------------------------------------------------------------- forecast

function ForecastPage() {
  const { t, pick, locale } = useI18n();
  const { fmt } = useMoney();
  const { can } = useSession();
  const label = usePeriodLabel();
  const [granularity, setGranularity] = useState<'week' | 'month'>('week');
  const [exclude, setExclude] = useState<Source[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { data: f, isLoading } = useApi<Forecast>('/cashflow/forecast', { granularity, exclude: exclude.join(',') || undefined });
  useEffect(() => setSelected(null), [granularity]);
  if (isLoading || !f) return <Loading />;
  const labels = f.buckets.map((b) => label(b, f.granularity));
  const sel = selected != null ? f.buckets[selected] : null;
  const shortfall = f.firstShortfall != null ? f.buckets[f.firstShortfall] : null;
  const lowest = f.lowest ? f.buckets[f.lowest.index] : null;
  const sourcesShown = SOURCES.filter((s) => !exclude.includes(s));

  return (
    <div className="page">
      <PageHeader
        title={t('cashflow.title')}
        subtitle={t('cashflow.subtitle')}
        actions={
          <>
            <Link to="/cashflow/plan" className="btn">
              <CalendarClock /> {t('cashflow.plan')}
            </Link>
            {can('cashflow.plan.write') && (
              <Button icon={<Settings2 />} onClick={() => setSettingsOpen(true)}>
                {t('cashflow.settings')}
              </Button>
            )}
          </>
        }
      />
      <div className="row" style={{ gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <div className="segmented">
          <button aria-pressed={granularity === 'week'} onClick={() => setGranularity('week')}>
            {t('cashflow.weeks')}
          </button>
          <button aria-pressed={granularity === 'month'} onClick={() => setGranularity('month')}>
            {t('cashflow.months')}
          </button>
        </div>
        <div className="row" style={{ gap: 14, flexWrap: 'wrap' }}>
          {SOURCES.map((s) => (
            <Checkbox key={s} label={t('cashflow.sources.' + s)} checked={!exclude.includes(s)} onChange={(on) => setExclude((x) => (on ? x.filter((y) => y !== s) : [...x, s]))} />
          ))}
        </div>
      </div>

      <div className="kpi-strip">
        <div>
          <span>{t('cashflow.cashToday')}</span>
          <strong>{fmt(f.opening)}</strong>
          <small className="faint">{t('cashflow.accountsCount', { n: f.accounts.length })}</small>
        </div>
        <div>
          <span>{t('cashflow.lowest')}</span>
          <strong className={lowest && f.lowest!.balance < f.settings.minCash ? 'danger-text' : undefined}>{f.lowest ? fmt(f.lowest.balance) : '—'}</strong>
          {lowest && <small className="faint">{t('cashflow.around', { date: formatDate(lowest.to, locale) })}</small>}
        </div>
        <div>
          <span>{t('cashflow.endBalance')}</span>
          <strong>{fmt(f.closing)}</strong>
          <small className="faint">{formatDate(f.buckets.at(-1)!.to, locale)}</small>
        </div>
        <div>
          <span>{t('cashflow.fundingNeed')}</span>
          <strong className={f.fundingNeed > 0 ? 'danger-text' : 'success-text'}>{f.fundingNeed > 0 ? fmt(f.fundingNeed) : t('cashflow.none')}</strong>
          <small className="faint">{t('cashflow.toKeep', { amount: fmt(f.settings.minCash) })}</small>
        </div>
      </div>

      {shortfall ? (
        <div className="notice danger" style={{ marginBottom: 16 }}>
          <AlertTriangle />
          <div>
            <strong>{t('cashflow.shortfallTitle', { date: formatDate(shortfall.from, locale) })}</strong>
            <div>{t('cashflow.shortfallText', { amount: fmt(f.fundingNeed) })}</div>
          </div>
        </div>
      ) : (
        <div className="notice success" style={{ marginBottom: 16 }}>
          <Wallet />
          <div>{t('cashflow.okText')}</div>
        </div>
      )}

      <Card>
        <CardHeader title={t('cashflow.balanceChart')} sub={t('cashflow.balanceChartSub')} />
        <div style={{ padding: '0 14px 12px' }}>
          <BalanceChart
            labels={labels}
            values={f.buckets.map((b) => b.closing)}
            reference={f.settings.minCash}
            referenceLabel={t('cashflow.minCash')}
            belowLabel={t('cashflow.belowMin')}
            format={fmt}
            selected={selected}
            onSelect={(i) => setSelected(i === selected ? null : i)}
          />
        </div>
      </Card>

      <Card>
        <div className="table-wrap cash-table">
          <table className="table table-compact">
            <thead>
              <tr>
                <th />
                {labels.map((l, i) => (
                  <th key={i} className={`end clickable ${selected === i ? 'selected' : ''}`} onClick={() => setSelected(i === selected ? null : i)}>
                    {l}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{t('cashflow.opening')}</td>
                {f.buckets.map((b, i) => (
                  <td key={i} className="end num faint">
                    {fmt(b.opening)}
                  </td>
                ))}
              </tr>
              {sourcesShown.map((s) => (
                <tr key={s}>
                  <td>{t('cashflow.sources.' + s)}</td>
                  {f.buckets.map((b, i) => (
                    <td key={i} className={`end num ${b.bySource[s] < 0 ? 'danger-text' : ''}`}>
                      {b.bySource[s] ? fmt(b.bySource[s]) : <span className="faint">—</span>}
                    </td>
                  ))}
                </tr>
              ))}
              <tr className="group-row">
                <td>{t('cashflow.net')}</td>
                {f.buckets.map((b, i) => (
                  <td key={i} className={`end num ${b.net < 0 ? 'danger-text' : 'success-text'}`}>
                    {fmt(b.net)}
                  </td>
                ))}
              </tr>
              <tr className="grand-row">
                <td>{t('cashflow.closing')}</td>
                {f.buckets.map((b, i) => (
                  <td key={i} className={`end num nowrap ${b.belowMinimum ? 'danger-text' : ''}`}>
                    {b.belowMinimum && <span title={t('cashflow.belowMin')}>⚠ </span>}
                    {fmt(b.closing)}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
        <p className="faint" style={{ fontSize: 12.5, padding: '0 14px 12px', margin: 0 }}>
          {t('cashflow.tableHint')}
          {f.beyond !== 0 && ' ' + t('cashflow.beyond', { amount: fmt(f.beyond) })}
        </p>
      </Card>

      {sel && (
        <Card>
          <CardHeader title={t('cashflow.periodDetail', { from: formatDate(sel.from, locale), to: formatDate(sel.to, locale) })} sub={`${t('cashflow.net')}: ${fmt(sel.net)}`} />
          {sel.flows.length === 0 ? (
            <EmptyState title={t('cashflow.noFlows')} />
          ) : (
            <div className="table-wrap">
              <table className="table table-compact">
                <thead>
                  <tr>
                    <th>{t('common.date')}</th>
                    <th>{t('cashflow.source')}</th>
                    <th>{t('common.description')}</th>
                    <th>{t('cashflow.dueDate')}</th>
                    <th className="end">{t('common.amount')}</th>
                  </tr>
                </thead>
                <tbody>
                  {sel.flows.map((x, i) => (
                    <tr key={i}>
                      <td className="nowrap">{formatDate(x.date, locale)}</td>
                      <td>
                        <Badge plain tone={x.amount > 0 ? 'green' : 'red'}>
                          {t('cashflow.sources.' + x.source)}
                        </Badge>
                      </td>
                      <td>{x.label}</td>
                      <td className="nowrap faint">
                        {x.dueDate && x.dueDate !== x.date ? formatDate(x.dueDate, locale) : ''}
                        {x.dueDate && x.dueDate < f.asOf && <Badge plain tone="amber">{t('cashflow.overdue')}</Badge>}
                      </td>
                      <td className={`end num ${x.amount < 0 ? 'danger-text' : 'success-text'}`}>{fmt(x.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      <div className="grid-2">
        <Card>
          <CardHeader title={t('cashflow.cashAccounts')} />
          <table className="table table-compact">
            <tbody>
              {f.accounts.map((a) => (
                <tr key={a.id}>
                  <td>
                    <span className="num faint" style={{ marginInlineEnd: 8 }}>
                      {a.code}
                    </span>
                    {pick(a.name_en, a.name_ar)}
                  </td>
                  <td className="end num">{fmt(a.balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Card>
          <CardHeader title={t('cashflow.atRisk')} sub={t('cashflow.atRiskSub', { days: f.settings.doubtfulDays })} />
          {f.atRisk.length === 0 ? (
            <EmptyState title={t('cashflow.noRisk')} />
          ) : (
            <table className="table table-compact">
              <tbody>
                {f.atRisk.slice(0, 8).map((r, i) => (
                  <tr key={i}>
                    <td>
                      {r.party} <span className="faint">{r.number}</span>
                    </td>
                    <td className="faint nowrap">{t('cashflow.daysLate', { n: r.daysOverdue })}</td>
                    <td className="end num">{fmt(r.amount)}</td>
                  </tr>
                ))}
                <tr className="grand-row">
                  <td colSpan={2}>{t('common.total')}</td>
                  <td className="end num">{fmt(f.atRiskTotal)}</td>
                </tr>
              </tbody>
            </table>
          )}
        </Card>
      </div>
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} current={f.settings} />
    </div>
  );
}

// ------------------------------------------------------------------ plan

type PlanForm = { name: string; direction: 'in' | 'out'; category: string; amount: number | null; startDate: string; repeat: PlanItem['repeat']; endDate: string; isActive: boolean; notes: string };
const emptyPlan = (): PlanForm => ({ name: '', direction: 'out', category: 'payroll', amount: null, startDate: todayIso(), repeat: 'monthly', endDate: '', isActive: true, notes: '' });

function PlanDialog({ open, onClose, item, preset }: { open: boolean; onClose(): void; item: PlanItem | null; preset: Partial<PlanForm> | null }) {
  const { t } = useI18n();
  const { scale } = useMoney();
  const toast = useToast();
  const errText = useErrorText();
  const [f, setF] = useState<PlanForm>(emptyPlan());
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!open) return;
    setErr('');
    setF(
      item
        ? { name: item.name, direction: item.direction, category: item.category, amount: item.amount, startDate: item.start_date, repeat: item.repeat, endDate: item.end_date ?? '', isActive: !!item.is_active, notes: item.notes ?? '' }
        : { ...emptyPlan(), ...preset },
    );
  }, [open, item, preset]);
  const save = useApiMutation(() => {
    const body = { ...f, endDate: f.endDate || null, notes: f.notes || null };
    return item ? api.put(`/cashflow/plan/${item.id}`, body) : api.post('/cashflow/plan', body);
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={item ? t('cashflow.editPlan') : t('cashflow.newPlan')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined, { onSuccess: () => (toast.success(t('common.saved')), onClose()), onError: (e) => setErr(errText(e)) })}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="grid-2">
          <Field label={t('common.name')}>
            <Input value={f.name} autoFocus onChange={(e) => setF({ ...f, name: e.target.value })} />
          </Field>
          <Field label={t('cashflow.category')}>
            <Select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {t('cashflow.categories.' + c)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grid-2">
          <Field label={t('cashflow.direction')}>
            <div className="segmented">
              <button type="button" aria-pressed={f.direction === 'in'} onClick={() => setF({ ...f, direction: 'in' })}>
                {t('cashflow.in')}
              </button>
              <button type="button" aria-pressed={f.direction === 'out'} onClick={() => setF({ ...f, direction: 'out' })}>
                {t('cashflow.out')}
              </button>
            </div>
          </Field>
          <Field label={t('common.amount')}>
            <DecimalInput scale={scale} value={f.amount} onChange={(v) => setF({ ...f, amount: v })} />
          </Field>
        </div>
        <div className="grid-3">
          <Field label={t('cashflow.repeat')}>
            <Select value={f.repeat} onChange={(e) => setF({ ...f, repeat: e.target.value as PlanForm['repeat'] })}>
              {(['once', 'weekly', 'monthly', 'quarterly', 'yearly'] as const).map((r) => (
                <option key={r} value={r}>
                  {t('cashflow.repeats.' + r)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={f.repeat === 'once' ? t('common.date') : t('cashflow.firstDate')}>
            <Input type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} />
          </Field>
          {f.repeat !== 'once' && (
            <Field label={t('cashflow.endDate')} hint={t('cashflow.endDateHint')}>
              <Input type="date" value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} />
            </Field>
          )}
        </div>
        <Field label={t('common.notes')}>
          <Textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </Field>
        <Checkbox label={t('cashflow.active')} checked={f.isActive} onChange={(v) => setF({ ...f, isActive: v })} />
        {err && <p className="danger-text">{err}</p>}
      </div>
    </Dialog>
  );
}

function PlanPage() {
  const { t, pick, locale } = useI18n();
  const { fmt } = useMoney();
  const { can } = useSession();
  const toast = useToast();
  const errText = useErrorText();
  const confirm = useConfirm();
  const { data, isLoading } = useApi<PlanItem[]>('/cashflow/plan');
  const writable = can('cashflow.plan.write');
  const { data: suggestions } = useApi<{ account_id: number; code: string; name_en: string; name_ar: string; monthly: number }[]>(writable ? '/cashflow/suggestions' : null);
  const [editing, setEditing] = useState<{ item: PlanItem | null; preset: Partial<PlanForm> | null } | null>(null);
  const del = useApiMutation((id: number) => api.del(`/cashflow/plan/${id}`));
  const columns = useMemo<Column<PlanItem>[]>(
    () => [
      { id: 'name', header: t('common.name'), pinned: true, value: (p) => p.name, render: (p) => <strong className={p.is_active ? undefined : 'faint'}>{p.name}</strong> },
      { id: 'category', header: t('cashflow.category'), type: 'enum', value: (p) => p.category, format: (v) => t('cashflow.categories.' + v) },
      {
        id: 'direction',
        header: t('cashflow.direction'),
        type: 'enum',
        value: (p) => p.direction,
        format: (v) => t('cashflow.' + v),
        render: (p) => <Badge tone={p.direction === 'in' ? 'green' : 'red'}>{t('cashflow.' + p.direction)}</Badge>,
      },
      { id: 'amount', header: t('common.amount'), type: 'number', value: (p) => p.amount, render: (p) => <span className="num">{fmt(p.amount)}</span> },
      { id: 'repeat', header: t('cashflow.repeat'), type: 'enum', value: (p) => p.repeat, format: (v) => t('cashflow.repeats.' + v) },
      { id: 'start', header: t('cashflow.firstDate'), type: 'date', value: (p) => p.start_date, render: (p) => formatDate(p.start_date, locale) },
      { id: 'end', header: t('cashflow.endDate'), type: 'date', value: (p) => p.end_date, render: (p) => (p.end_date ? formatDate(p.end_date, locale) : <span className="faint">—</span>) },
      {
        id: 'actions',
        header: '',
        value: () => null,
        render: (p) =>
          writable && (
            <span className="row" style={{ gap: 2 }} onClick={(e) => e.stopPropagation()}>
              <Button size="sm" variant="ghost" iconOnly icon={<Pencil />} onClick={() => setEditing({ item: p, preset: null })} />
              <Button
                size="sm"
                variant="ghost"
                iconOnly
                icon={<Trash2 />}
                onClick={async () => {
                  if ((await confirm({ title: t('cashflow.deletePlan'), danger: true, confirmLabel: t('common.delete') })).ok)
                    del.mutate(p.id, { onSuccess: () => toast.success(t('common.deleted')), onError: (e) => toast.error(errText(e)) });
                }}
              />
            </span>
          ),
      },
    ],
    [t, fmt, locale, writable, confirm, del, toast, errText],
  );
  return (
    <div className="page">
      <PageHeader
        crumbs={[{ to: '/cashflow', label: t('cashflow.title') }]}
        title={t('cashflow.plan')}
        subtitle={t('cashflow.planSub')}
        actions={
          writable && (
            <Button variant="primary" icon={<Plus />} onClick={() => setEditing({ item: null, preset: null })}>
              {t('cashflow.newPlan')}
            </Button>
          )
        }
      />
      {writable && suggestions && suggestions.length > 0 && (
        <div className="notice" style={{ marginBottom: 16 }}>
          <Lightbulb />
          <div style={{ flex: 1 }}>
            <strong>{t('cashflow.suggestTitle')}</strong>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
              {suggestions.map((s) => (
                <Button
                  key={s.account_id}
                  size="sm"
                  icon={<Plus />}
                  onClick={() => setEditing({ item: null, preset: { name: pick(s.name_en, s.name_ar), direction: 'out', category: 'other', amount: s.monthly, repeat: 'monthly' } })}
                >
                  {pick(s.name_en, s.name_ar)} · {fmt(s.monthly)}
                </Button>
              ))}
            </div>
          </div>
        </div>
      )}
      <DataGrid
        id="cash-plan"
        rows={data}
        loading={isLoading}
        columns={columns}
        rowKey={(p) => p.id}
        onRowClick={writable ? (p) => setEditing({ item: p, preset: null }) : undefined}
        exportName={t('cashflow.plan')}
        empty={<EmptyState icon={<CalendarClock size={22} />} title={t('cashflow.noPlan')} text={t('cashflow.noPlanText')} />}
      />
      <PlanDialog open={!!editing} onClose={() => setEditing(null)} item={editing?.item ?? null} preset={editing?.preset ?? null} />
    </div>
  );
}

export const cashflowModule: WebModule = {
  id: 'cashflow',
  nav: [{ to: '/cashflow', label: 'cashflow.title', icon: Wallet, section: 'treasury', order: 60, perm: 'cashflow.forecast.read', app: 'cashflow' }],
  routes: [
    { path: '/cashflow', element: <ForecastPage /> },
    { path: '/cashflow/plan', element: <PlanPage /> },
  ],
  commands: [{ id: 'go-cashflow', label: 'cashflow.title', icon: Wallet, group: 'navigate', to: '/cashflow', perm: 'cashflow.forecast.read', app: 'cashflow', keywords: 'cash forecast liquidity سيولة توقعات نقدية' }],
  reports: [{ to: '/cashflow', group: 'reports.groups.analysis', title: 'cashflow.title', desc: 'cashflow.subtitle', icon: Wallet, color: 'var(--line-teal)', perm: 'cashflow.forecast.read', app: 'cashflow' }],
};
